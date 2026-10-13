import {randomUUID} from "node:crypto";
import {
    ExtractionTaskSchema,
    type ExtractionProgress,
    type ExtractionSourceRef,
    type ExtractionTask,
    type ExtractionTaskKind,
    type JsonRecord,
} from "nbook/shared/dto/inspiration-extraction-task.dto";
import {ExtractionTaskError} from "./errors";
import {summarizeExtractionProgress} from "./progress";
import {ExtractionRun, type ExtractionLog} from "./run";
import {applyTaskPatch, createUnit, markUnitSkipped, normalizeInactiveTask, resetUnitForRetry} from "./task-model";
import type {ExtractionModelPort, ExtractionPipeline, ExtractionTaskStore} from "./types";

/**
 * 把一次长生命周期运行交给宿主。必须同步调用 `body`（或在宿主拒绝时同步抛错），`body` 永不 reject，
 * 其 Promise 在任务运行结束时 settle；宿主在项目关闭时中止传给 `body` 的信号并等待该 Promise。
 * 生产实现见 `runtime.ts`（`startReadyProjectOperation`）。
 */
export type ExtractionLaunch = (body: (lifecycleSignal: AbortSignal) => Promise<void>) => void;

export type ExtractionManagerDeps = Readonly<{
    store: ExtractionTaskStore;
    model: ExtractionModelPort;
    verifySource: (source: ExtractionSourceRef) => Promise<void>;
    /** 按种类取得流水线；未注册时抛 `ExtractionTaskError("PIPELINE_UNREGISTERED")`。 */
    resolvePipeline: (kind: ExtractionTaskKind) => ExtractionPipeline;
    launch: ExtractionLaunch;
    now?: () => Date;
    newId?: () => string;
    log?: ExtractionLog;
    capturePromptSnapshot?: () => Promise<string>;
}>;

export type StartExtractionInput = Readonly<{
    kind: ExtractionTaskKind;
    source: ExtractionSourceRef;
    params: JsonRecord;
    modelKey?: string;
}>;

const KIND_LABEL: Record<ExtractionTaskKind, string> = {outline: "大纲", material: "素材"};

/**
 * 一个项目 generation 内的提取任务控制面：唯一性、生命周期、读时归一化与对活动执行者的转发。
 * 一个实例对应一个 ready Project generation（见 `runtime.ts`），因此“有无活动执行者”就等于
 * “本进程本次打开内是否有 ExtractionRun”；任务记录里的“运行中”本身不能证明任何事。
 */
export class ExtractionTaskManager {
    private readonly runs = new Map<string, ExtractionRun>();
    private readonly idle = new Map<string, Promise<void>>();
    private readonly runKeys = new Map<string, string>();
    /** 已通过冲突检查、尚未注册 run 的启动（跨越 verify / prepare 的 await）。 */
    private readonly reservations = new Set<string>();
    private readonly locks = new Map<string, Promise<unknown>>();
    private readonly now: () => Date;
    private readonly log: ExtractionLog;

    constructor(private readonly deps: ExtractionManagerDeps) {
        this.now = deps.now ?? (() => new Date());
        this.log = deps.log ?? (() => undefined);
    }

    /**
     * 创建并启动任务。同一来源同一种类已有运行中任务时抛 `CONFLICT`，且不会调用 `prepare`
     * （因此不会产生第二份提取方案）。流水线的 `prepare` 失败时不创建任务。
     */
    async start(input: StartExtractionInput): Promise<ExtractionTask> {
        const key = occupancyKey(input.kind, input.source);
        this.reserve(key, input.kind);
        try {
            await this.verifyOrThrow(input.source);
            const promptSnapshotId = await this.deps.capturePromptSnapshot?.();
            const pipeline = this.deps.resolvePipeline(input.kind);
            const prepared = await pipeline.prepare({params: input.params, source: input.source});
            const timestamp = this.now().toISOString();
            const task = ExtractionTaskSchema.parse({
                version: 1, id: (this.deps.newId ?? randomUUID)(), kind: input.kind, source: input.source,
                modelKey: input.modelKey ?? null, params: input.params, state: prepared.state ?? {},
                ...(promptSnapshotId ? {promptSnapshotId} : {}),
                status: "running", awaitingInput: null, stopReason: null,
                units: prepared.units.map(createUnit), createdAt: timestamp, updatedAt: timestamp,
            });
            await this.deps.store.write(task);
            return this.launchRun(task, pipeline);
        } finally {
            this.reservations.delete(key);
        }
    }

    /**
     * 取消：停止调度新的模型调用并中止进行中的调用，已写入成果保留。
     * 对已取消的任务幂等；已完成或部分失败的任务没有可取消的内容。等待态与已中断态（无活动执行者）
     * 直接落盘为已取消，即“放弃”。
     */
    cancel(taskId: string): Promise<ExtractionTask> {
        return this.withTaskLock(taskId, async () => {
            const run = this.runs.get(taskId);
            if (run) {
                run.cancel();
                await this.idle.get(taskId);
                return this.requireTask(taskId);
            }
            const task = await this.requireTask(taskId);
            if (task.status === "cancelled") return task;
            if (task.status === "completed" || task.status === "partial-failed") {
                throw new ExtractionTaskError("INVALID_STATE", "任务已经结束，无需取消");
            }
            const cancelled: ExtractionTask = {...task, status: "cancelled", awaitingInput: null, stopReason: null, updatedAt: this.now().toISOString()};
            await this.deps.store.write(cancelled);
            return cancelled;
        });
    }

    /** 从未完成单元继续已取消、已中断或部分失败的任务；失败单元不会自动重做（用 `retryUnit`）。 */
    resume(taskId: string): Promise<ExtractionTask> {
        return this.withTaskLock(taskId, async () => {
            const task = await this.inactiveTask(taskId);
            if (task.status === "awaiting-input") throw new ExtractionTaskError("INVALID_STATE", "任务正在等待人工输入，请提供输入后继续");
            if (task.status === "completed") throw new ExtractionTaskError("INVALID_STATE", "任务已经完成");
            return this.restart(task);
        });
    }

    /** 为 `awaiting-input` 的任务提供人工输入（归类结果等），由流水线校验并转成单元与状态，然后继续。 */
    provideInput(taskId: string, input: unknown): Promise<ExtractionTask> {
        return this.withTaskLock(taskId, async () => {
            const task = await this.inactiveTask(taskId);
            if (task.status !== "awaiting-input") throw new ExtractionTaskError("INVALID_STATE", "任务当前不在等待人工输入");
            const pipeline = this.deps.resolvePipeline(task.kind);
            if (!pipeline.acceptInput) throw new ExtractionTaskError("INVALID_STATE", `${KIND_LABEL[task.kind]}提取流水线不接受人工输入`);
            applyTaskPatch(task, pipeline.acceptInput(structuredClone(task), input));
            return this.restart(task);
        });
    }

    /**
     * 只重做一个失败（或已跳过）的单元，重试计数清零，不触碰已完成单元。
     * 任务在运行、等待输入或部分失败时可用；已取消／已中断的任务先 `resume`，避免一次重试顺带重做其他等待单元。
     */
    retryUnit(taskId: string, unitId: string): Promise<ExtractionTask> {
        return this.mutateUnit(taskId, unitId, run => run.retryUnit(unitId), resetUnitForRetry);
    }

    /** 明确跳过失败单元，让依赖它的汇总按已完成部分继续。 */
    skipUnit(taskId: string, unitId: string): Promise<ExtractionTask> {
        return this.mutateUnit(taskId, unitId, run => run.skipUnit(unitId), markUnitSkipped);
    }

    /** 客户端传入点击时的失败项快照；迟到请求不修改已恢复、正在运行或新出现的失败项。 */
    changeFailedUnits(taskId: string, action: "retry" | "skip", unitIds: readonly string[]): Promise<ExtractionTask> {
        return this.withTaskLock(taskId, async () => {
            const run = this.runs.get(taskId);
            const task = run?.accepting ? run.snapshot() : await this.inactiveTask(taskId);
            const selected = new Set(unitIds);
            if ([...selected].some(id => !task.units.some(unit => unit.id === id))) {
                throw new ExtractionTaskError("NOT_FOUND", "批量操作包含不存在的提取单元，请刷新任务");
            }
            const failed = task.units.filter(unit => unit.status === "failed" && selected.has(unit.id));
            if (!failed.length) return task;
            if (run?.accepting) {
                await run.changeFailedUnits(action, failed.map(unit => unit.id));
                return run.snapshot();
            }
            if (task.status !== "awaiting-input" && task.status !== "partial-failed") {
                throw new ExtractionTaskError("INVALID_STATE", "任务已停止或已结束，请先继续任务");
            }
            for (const unit of failed) {
                if (action === "retry") resetUnitForRetry(task, unit.id);
                else markUnitSkipped(task, unit.id);
            }
            return this.restart(task);
        });
    }

    /** 当前任务视图：有活动执行者读内存真值，否则读存储并把“运行中”归一化为“已中断”。 */
    get(taskId: string): Promise<ExtractionTask> {
        return this.requireTask(taskId);
    }

    async list(filter: Readonly<{kind?: ExtractionTaskKind; sourcePath?: string}> = {}): Promise<ExtractionTask[]> {
        const stored = await this.deps.store.list();
        return stored
            .filter(task => (!filter.kind || task.kind === filter.kind) && (!filter.sourcePath || task.source.path === filter.sourcePath))
            .map(task => this.runs.get(task.id)?.snapshot() ?? normalizeInactiveTask(task));
    }

    /** 删除任务及其所有未写入 lorebook 的中间产物；活动任务先中止并等待落盘收尾。 */
    remove(taskId: string): Promise<void> {
        return this.withTaskLock(taskId, async () => {
            const run = this.runs.get(taskId);
            if (run) {
                run.cancel();
                await this.idle.get(taskId);
            } else if (!(await this.deps.store.read(taskId))) {
                throw new ExtractionTaskError("NOT_FOUND", "提取任务不存在或已被移除");
            }
            await this.deps.store.remove(taskId);
        });
    }

    async progress(taskId: string): Promise<ExtractionProgress> {
        return summarizeExtractionProgress(await this.requireTask(taskId));
    }

    /** 等待所有活动执行者结束；测试与进程收尾使用。 */
    async whenIdle(): Promise<void> {
        while (this.idle.size > 0) await Promise.all([...this.idle.values()]);
    }

    private async requireTask(taskId: string): Promise<ExtractionTask> {
        const live = this.runs.get(taskId);
        if (live) return live.snapshot();
        const stored = await this.deps.store.read(taskId);
        if (!stored) throw new ExtractionTaskError("NOT_FOUND", "提取任务不存在或已被移除");
        // 读存储期间 run 可能刚好注册：以内存真值为准。
        return this.runs.get(taskId)?.snapshot() ?? normalizeInactiveTask(stored);
    }

    /** 取得没有活动执行者的任务；刚作出终止决定、尚未落盘完的执行者先等它结束，避免读到旧记录。 */
    private async inactiveTask(taskId: string): Promise<ExtractionTask> {
        const run = this.runs.get(taskId);
        if (run?.accepting) throw new ExtractionTaskError("INVALID_STATE", "任务正在运行");
        if (run) await this.idle.get(taskId);
        return this.requireTask(taskId);
    }

    private mutateUnit(
        taskId: string,
        unitId: string,
        onLive: (run: ExtractionRun) => Promise<void>,
        onStored: (task: ExtractionTask, unitId: string) => void,
    ): Promise<ExtractionTask> {
        return this.withTaskLock(taskId, async () => {
            const run = this.runs.get(taskId);
            if (run?.accepting) {
                await onLive(run);
                return run.snapshot();
            }
            const task = await this.inactiveTask(taskId);
            if (task.status !== "awaiting-input" && task.status !== "partial-failed") {
                throw new ExtractionTaskError("INVALID_STATE", "任务已停止或已结束，请先继续任务");
            }
            onStored(task, unitId);
            return this.restart(task);
        });
    }

    /** 把非活动任务重新置为运行并启动执行者。先复核来源与唯一性，再落盘，失败时不改变存储记录。 */
    private async restart(task: ExtractionTask): Promise<ExtractionTask> {
        const key = occupancyKey(task.kind, task.source);
        this.reserve(key, task.kind);
        try {
            await this.verifyOrThrow(task.source);
            const pipeline = this.deps.resolvePipeline(task.kind);
            const next: ExtractionTask = {
                ...task, status: "running", awaitingInput: null, stopReason: null,
                units: task.units.map(unit => unit.status === "running" ? {...unit, status: "pending"} : unit),
            };
            return this.launchRun(next, pipeline);
        } finally {
            this.reservations.delete(key);
        }
    }

    private reserve(key: string, kind: ExtractionTaskKind): void {
        const holder = this.runKeys.get(key);
        if (holder !== undefined || this.reservations.has(key)) {
            throw new ExtractionTaskError("CONFLICT", `该作品已有运行中的${KIND_LABEL[kind]}提取任务${holder ? `（${holder}）` : ""}，请等待结束或先取消`);
        }
        this.reservations.add(key);
    }

    private async verifyOrThrow(source: ExtractionSourceRef): Promise<void> {
        try {
            await this.deps.verifySource(source);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new ExtractionTaskError("SOURCE_CHANGED", `作品来源已变化或不可读，不能开始或继续该任务：${reason}`, {cause: error});
        }
    }

    /** 同步登记 run 并交给宿主；宿主同步拒绝（项目未打开）时撤销登记并抛出，不留下无人持有的任务。 */
    private launchRun(task: ExtractionTask, pipeline: ExtractionPipeline): ExtractionTask {
        const run = new ExtractionRun(task, {
            store: this.deps.store, pipeline, model: this.deps.model, verifySource: this.deps.verifySource,
            now: this.now, log: this.log,
        });
        const key = occupancyKey(task.kind, task.source);
        let finish!: () => void;
        const idle = new Promise<void>(resolve => { finish = resolve; });
        this.runs.set(task.id, run);
        this.runKeys.set(key, task.id);
        this.idle.set(task.id, idle);
        const release = () => {
            this.runs.delete(task.id);
            this.runKeys.delete(key);
            this.idle.delete(task.id);
            finish();
        };
        try {
            this.deps.launch(async lifecycleSignal => {
                try {
                    await run.execute(lifecycleSignal);
                } finally {
                    release();
                }
            });
        } catch (error) {
            release();
            throw error;
        }
        return run.snapshot();
    }

    private withTaskLock<T>(taskId: string, action: () => Promise<T>): Promise<T> {
        const result = (this.locks.get(taskId) ?? Promise.resolve()).catch(() => undefined).then(action);
        const tail = result.catch(() => undefined);
        this.locks.set(taskId, tail);
        void tail.then(() => {
            if (this.locks.get(taskId) === tail) this.locks.delete(taskId);
        });
        return result;
    }
}

function occupancyKey(kind: ExtractionTaskKind, source: ExtractionSourceRef): string {
    return `${kind}\u0000${source.path}`;
}
