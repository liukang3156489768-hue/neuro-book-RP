import type {ExtractionTask, ExtractionUnit} from "nbook/shared/dto/inspiration-extraction-task.dto";
import {ExtractionFatalError} from "./errors";
import {callWithRepair} from "./repair";
import {applyTaskPatch, markUnitSkipped, resetUnitForRetry} from "./task-model";
import type {
    ExtractionModelPort,
    ExtractionPipeline,
    ExtractionTaskPatch,
    ExtractionTaskStore,
    ExtractionUnitContext,
} from "./types";

export type ExtractionLog = (event: string, data: Record<string, unknown>) => void;

export type ExtractionRunDeps = Readonly<{
    store: ExtractionTaskStore;
    pipeline: ExtractionPipeline;
    model: ExtractionModelPort;
    /** 来源与启动时记录的哈希不一致（或不可读）时抛错。 */
    verifySource: (source: ExtractionTask["source"]) => Promise<void>;
    now: () => Date;
    log: ExtractionLog;
}>;

const ERROR_SUMMARY_MAX_CHARACTERS = 500;

/** 单元错误摘要：只保留可诊断的一行信息，不记录提示词或模型原文。 */
function summarizeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const flat = message.replace(/\s+/gu, " ").trim() || "未知错误";
    return flat.length > ERROR_SUMMARY_MAX_CHARACTERS ? `${flat.slice(0, ERROR_SUMMARY_MAX_CHARACTERS)}……` : flat;
}

/**
 * 一个任务的活动执行者：持有任务的内存真值，串行执行单元，并把每次状态变化写入存储。
 * “存在 ExtractionRun”就是“运行中有活动执行者”；run 结束后任务只剩持久化记录。
 *
 * 取消语义：取消会中止正在进行的模型调用，该单元回到等待（成果只有写入完成的单元才保留，
 * 因此流水线的 `execute` 必须能整体重做）。项目关闭（生命周期信号）与取消的区别只在最终状态：
 * 取消落盘为“已取消”，项目关闭落盘为“已中断”（关闭时存储通常已拒绝写入，磁盘上保留的“运行中”
 * 由读取方推导为“已中断”）。
 */
export class ExtractionRun {
    private readonly task: ExtractionTask;
    private readonly cancelController = new AbortController();
    private cancelRequested = false;
    /** 循环已决定终止；此后外部变更必须改走“非活动任务”路径。 */
    private finished = false;
    private writeChain: Promise<void> = Promise.resolve();

    constructor(task: ExtractionTask, private readonly deps: ExtractionRunDeps) {
        this.task = structuredClone(task);
    }

    get taskId(): string {
        return this.task.id;
    }

    /** 循环尚未作出终止决定，变更仍会被循环看到。 */
    get accepting(): boolean {
        return !this.finished;
    }

    snapshot(): ExtractionTask {
        return structuredClone(this.task);
    }

    /** 停止调度新的模型调用并中止进行中的调用。可重复调用。 */
    cancel(): void {
        this.cancelRequested = true;
        this.cancelController.abort(new Error("提取任务已取消"));
    }

    /** 把失败或已跳过的单元重置为等待，只重做该单元；重试次数清零。 */
    async retryUnit(unitId: string): Promise<void> {
        resetUnitForRetry(this.task, unitId);
        await this.persist();
    }

    /** 明确放弃一个失败单元，让依赖它的后续汇总按已完成部分继续。 */
    async skipUnit(unitId: string): Promise<void> {
        markUnitSkipped(this.task, unitId);
        await this.persist();
    }

    /** 在让出事件循环前处理整批，运行中单元及点击后新出现的失败都不在本批范围。 */
    async changeFailedUnits(action: "retry" | "skip", unitIds: readonly string[]): Promise<void> {
        const selected = new Set(unitIds);
        for (const unit of this.task.units) {
            if (unit.status !== "failed" || !selected.has(unit.id)) continue;
            if (action === "retry") resetUnitForRetry(this.task, unit.id);
            else markUnitSkipped(this.task, unit.id);
        }
        await this.persist();
    }

    /** 永不 reject：所有结局都落成任务状态。`lifecycleSignal` 是项目生命周期信号。 */
    async execute(lifecycleSignal: AbortSignal): Promise<void> {
        const signal = AbortSignal.any([lifecycleSignal, this.cancelController.signal]);
        try {
            await this.verify();
            this.task.status = "running";
            this.task.awaitingInput = null;
            this.task.stopReason = null;
            await this.persist();
            await this.loop(signal);
        } catch (error) {
            this.finished = true;
            this.recordStop(error, lifecycleSignal);
            try {
                await this.persist();
            } catch (persistError) {
                // 项目关闭时 mutation gate 已拒绝写入属预期：磁盘上的“运行中”会被读取方推导为“已中断”。
                this.deps.log("inspiration.extraction.finalPersistFailed", {taskId: this.task.id, status: this.task.status, error: summarizeError(persistError)});
            }
        } finally {
            this.finished = true;
        }
    }

    private async loop(signal: AbortSignal): Promise<void> {
        for (;;) {
            signal.throwIfAborted();
            const unit = this.nextReadyUnit();
            if (unit) {
                await this.runUnit(unit, signal);
                continue;
            }
            const settlement = this.deps.pipeline.settle(this.snapshot());
            if (settlement.kind === "continue") {
                if (!settlement.patch.appendUnits?.length) throw new Error("流水线声明继续，但没有追加任何单元");
                applyTaskPatch(this.task, settlement.patch);
                await this.persist();
                continue;
            }
            // 落盘期间会让出事件循环：先同步关闭变更入口，迟到的重试／跳过请求才会改走非活动任务路径，
            // 而不是改了一个循环已不会再看的单元。
            this.finished = true;
            if (settlement.kind === "awaiting-input") {
                this.task.status = "awaiting-input";
                this.task.awaitingInput = settlement.reason;
            } else {
                const unfinished = this.task.units.filter(unit => unit.status === "pending" || unit.status === "running");
                const failed = this.task.units.some(unit => unit.status === "failed");
                if (unfinished.length > 0 && !failed) {
                    // 没有失败却仍有未完成单元，说明 readyUnits 与 settle 的依赖判断不一致，不能静默标为完成。
                    throw new Error(`流水线没有可执行的单元，但仍有 ${unfinished.length} 个单元未完成（${unfinished[0]!.id}）`);
                }
                this.task.status = failed ? "partial-failed" : "completed";
                this.task.awaitingInput = null;
            }
            await this.persist();
            return;
        }
    }

    private nextReadyUnit(): ExtractionUnit | undefined {
        for (const candidate of this.deps.pipeline.readyUnits(this.snapshot())) {
            const live = this.task.units.find(unit => unit.id === candidate.id);
            if (!live) throw new Error(`流水线返回了不存在的单元：${candidate.id}`);
            if (live.status === "pending") return live;
        }
        return undefined;
    }

    private async runUnit(live: ExtractionUnit, signal: AbortSignal): Promise<void> {
        live.status = "running";
        live.attempts = 0;
        live.error = null;
        await this.persist();
        const context: ExtractionUnitContext = {
            task: this.snapshot(),
            signal,
            generate: request => callWithRepair({
                model: this.deps.model,
                signal,
                system: request.system,
                prompt: request.prompt,
                purposeId: request.purposeId,
                variables: request.variables,
                promptSnapshotId: this.task.promptSnapshotId,
                validate: request.validate,
                modelKey: this.task.modelKey ?? undefined,
                metadata: {taskId: this.task.id, unitId: live.id, purposeId: request.purposeId, ...request.metadata},
                beforeCall: async () => {
                    await this.verify();
                    live.attempts += 1;
                },
            }),
        };
        let patch: ExtractionTaskPatch | void;
        try {
            patch = await this.deps.pipeline.execute(structuredClone(live), context);
        } catch (error) {
            if (signal.aborted || error instanceof ExtractionFatalError) {
                // 取消、项目关闭和任务级错误不是单元自身的失败：单元回到等待，等任务继续时整体重做。
                live.status = "pending";
                throw error;
            }
            live.status = "failed";
            live.error = summarizeError(error);
            this.deps.log("inspiration.extraction.unitFailed", {taskId: this.task.id, unitId: live.id, step: live.step, attempts: live.attempts, error: live.error});
            await this.persist();
            return;
        }
        live.status = "done";
        live.error = null;
        if (patch) applyTaskPatch(this.task, patch);
        await this.persist();
    }

    /** 每次模型调用前与启动时复核来源；变化是任务级错误，不让每个单元各自失败。 */
    private async verify(): Promise<void> {
        try {
            await this.deps.verifySource(this.task.source);
        } catch (error) {
            throw new ExtractionFatalError("source-changed", `作品来源已变化或不可读，任务不能继续：${summarizeError(error)}`, {cause: error});
        }
    }

    private recordStop(error: unknown, lifecycleSignal: AbortSignal): void {
        for (const unit of this.task.units) {
            if (unit.status === "running") unit.status = "pending";
        }
        this.task.awaitingInput = null;
        if (error instanceof ExtractionFatalError) {
            this.task.status = "interrupted";
            this.task.stopReason = {code: error.reason, message: summarizeError(error)};
        } else if (this.cancelRequested && this.cancelController.signal.aborted) {
            this.task.status = "cancelled";
            this.task.stopReason = null;
        } else if (lifecycleSignal.aborted) {
            this.task.status = "interrupted";
            this.task.stopReason = null;
        } else {
            this.deps.log("inspiration.extraction.runFailed", {taskId: this.task.id, error: summarizeError(error)});
            this.task.status = "interrupted";
            this.task.stopReason = {code: "unexpected", message: summarizeError(error)};
        }
    }

    /** 快照后串行写入：并发的状态变化按调用顺序落盘，写入失败只让本次 persist reject，不毒化后续写入。 */
    private persist(): Promise<void> {
        this.task.updatedAt = this.deps.now().toISOString();
        const snapshot = structuredClone(this.task);
        const write = this.writeChain.then(() => this.deps.store.write(snapshot));
        this.writeChain = write.catch(() => undefined);
        return write;
    }
}
