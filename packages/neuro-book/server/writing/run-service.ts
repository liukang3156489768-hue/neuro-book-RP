import type {OperationActor} from "@notnotype/nb-history";
import {
    MemoryDefinitionRegistry, WorkflowRunner, type AgentPort, type Clock, type IdGenerator, type JsonValue, type RunStatus, type RunView,
    type SessionPort, type WorkflowRunState, type WorkflowValue,
} from "@notnotype/nb-workflow";
import type {ReadyProjectSessionRef} from "nbook/server/workspace-files/project-session-types";
import type {WritingRunProgressDto, WritingRunSummaryDto} from "nbook/shared/dto/writing.dto";
import {resolveWorkspacePath} from "nbook/server/workspace-files/workspace-files";
import {WritingError} from "./prose-binding";
import type {RewriteTarget} from "./rewrite";
import {editReadyProseBody} from "./host";
import {askRole, projectChapterRun, projectRewriteRun, type RunProgressSource} from "./run-progress";
import {writingRewriteWorkflow, type RewriteRunArgs, type RewriteRunResult} from "./rewrite-workflow";
import {FileValueStore, FileWorkflowBackend, WRITING_RUNS_ROOT} from "./run-store";
import {createWritingActivityExecutor, fromJsonValue, toJsonValue, type WriterPromptResolver} from "./workflow-activities";
import {writingChapterWorkflow, type WritingMode, type WritingProgress, type WritingRunArgs, type WritingRunResult} from "./writing-workflow";

/**
 * 模型调用失败时按 writing.collaboration 重试一次。首次调用可能已在会话里追加了用户消息，
 * 重试仍从同一游标开始，失败的那次留在旁支上，不影响后续上下文。用户停止时不重试。
 */
export function retryOnceAgentPort(port: AgentPort): AgentPort {
    return {
        profileInfo: (profileKey) => port.profileInfo(profileKey),
        async invoke(sessionId, fromLeaf, options) {
            try {
                return await port.invoke(sessionId, fromLeaf, options);
            } catch (error) {
                if (options.signal?.aborted) throw error;
                return await port.invoke(sessionId, fromLeaf, options);
            }
        },
    };
}

type RunSummaryBase = Readonly<{
    runId: string;
    chapterEntryId: string;
    status: RunStatus;
    /** 已保存运行记录但不在本进程中执行，说明进程曾在运行中退出，续写时按记录恢复。 */
    interrupted: boolean;
    /** 只有失败原因；停止由 status 表达，Kernel 的取消文本不给用户和主创看。 */
    error: string | null;
    createdAt: string;
}>;

export type ChapterRunSummary = RunSummaryBase & Readonly<{
    kind: "chapter";
    task: WritingRunArgs["task"];
    mode: WritingMode;
    progress: WritingProgress | null;
    result: WritingRunResult | null;
}>;

export type RewriteRunSummary = RunSummaryBase & Readonly<{
    kind: "rewrite";
    target: RewriteTarget;
    requirement: string;
    result: RewriteRunResult | null;
}>;

/** 整章写作与局部改写共用章节锁与运行记录目录，按 kind 区分。 */
export type WritingRunSummary = ChapterRunSummary | RewriteRunSummary;

const WORKFLOWS = [writingChapterWorkflow, writingRewriteWorkflow];
const WORKFLOW_KEYS: ReadonlySet<string> = new Set(WORKFLOWS.map(({key}) => key));

const runError = (state: WorkflowRunState) => (state.status === "cancelled" ? null : state.error ?? null);

type RunArgs = Readonly<{kind: "chapter"; args: WritingRunArgs}> | Readonly<{kind: "rewrite"; args: RewriteRunArgs}>;

export type WritingRunServiceOptions = Readonly<{
    ready: ReadyProjectSessionRef;
    actor: OperationActor;
    sessions: SessionPort;
    agents: AgentPort;
    resolveWriterPrompt?: WriterPromptResolver;
    clock?: Clock;
    ids?: IdGenerator;
}>;

/** run 保留发起参数：begin 同步返回 runId，运行记录稍后才落盘，这段时间里进度和列表按它显示。 */
type LiveRun = Readonly<{run: RunArgs; done: Promise<RunView>}>;

/**
 * 一个项目的写作运行入口：同一章同时只允许一次写作或改写，停止后按检查点续写，
 * 进程中断后按运行记录恢复。
 */
export class WritingRunService {
    private readonly backend: FileWorkflowBackend;
    private readonly values: FileValueStore;
    private readonly runner: WorkflowRunner;
    /** Runner 不公开执行中的 Run，本进程执行中的运行由这里记录，用于章节锁和识别中断。 */
    private readonly live = new Map<string, LiveRun>();
    /** 章节锁的检查与发起之间不能被同章的另一次请求插入。 */
    private readonly chapterQueues = new Map<string, Promise<unknown>>();

    constructor(private readonly options: WritingRunServiceOptions) {
        const directory = resolveWorkspacePath(options.ready.workspace.root, WRITING_RUNS_ROOT);
        this.backend = new FileWorkflowBackend(directory);
        this.values = new FileValueStore(directory);
        this.runner = new WorkflowRunner({sessions: options.sessions, agents: retryOnceAgentPort(options.agents)}, {}, {
            backend: this.backend,
            values: this.values,
            definitions: new MemoryDefinitionRegistry(WORKFLOWS),
            activities: createWritingActivityExecutor(options.ready, options.actor, options.resolveWriterPrompt),
            ...(options.clock === undefined ? {} : {clock: options.clock}),
            ...(options.ids === undefined ? {} : {ids: options.ids}),
        });
    }

    /** 新写或整章重写。 */
    start(input: Readonly<{chapterEntryId: string; task: "new" | "rewrite"; mode: WritingMode; ownerSessionId?: number; reusePlan?: boolean}>): Promise<ChapterRunSummary> {
        return this.withChapter(input.chapterEntryId, async () => {
            await this.assertChapterIdle(input.chapterEntryId);
            const previous = input.task === "rewrite" && input.reusePlan !== false
                ? (await this.listChapterRuns(input.chapterEntryId)).reverse().find((run): run is ChapterRunSummary =>
                    run.kind === "chapter" && (run.progress?.plan.scenes.length ?? 0) > 0)
                : undefined;
            return this.launchChapter({chapterEntryId: input.chapterEntryId, task: input.task, mode: input.mode,
                ...(input.ownerSessionId === undefined ? {} : {ownerSessionId: input.ownerSessionId}),
                ...(previous?.progress ? {resume: {...previous.progress, passed: 0, replaceBody: true}} : {})});
        });
    }

    /** 正文删改与写作共用章节锁，不能在生成或等待确认期间直接变更正文。 */
    editProse(input: Readonly<{chapterEntryId: string; baseHash: string; target?: RewriteTarget; replacement: string}>) {
        return this.withChapter(input.chapterEntryId, async () => {
            await this.assertChapterIdle(input.chapterEntryId);
            return editReadyProseBody(this.options.ready, input, this.options.actor);
        });
    }

    /** 局部改写；目标无法定位等领域失败在运行结果里返回，不在这里抛出。 */
    startRewrite(input: RewriteRunArgs): Promise<RewriteRunSummary> {
        return this.withChapter(input.chapterEntryId, async () => {
            await this.assertChapterIdle(input.chapterEntryId);
            const {runId, done} = this.runner.begin(writingRewriteWorkflow, toJsonValue(input));
            this.track(runId, {kind: "rewrite", args: input}, done);
            return {kind: "rewrite", runId, chapterEntryId: input.chapterEntryId, target: input.target, requirement: input.requirement,
                status: "running", interrupted: false, result: null, error: null, createdAt: ""};
        });
    }

    /**
     * 续写本章：
     * - 最近一次运行（整章或改写）进程中断或调用失败：按运行记录重放，已完成的步骤不重复执行；
     * - 否则取最近一次整章写作，新开一次运行，从检查点记录的第一个未通过场景开始。
     */
    continue(input: Readonly<{chapterEntryId: string; mode?: WritingMode}>): Promise<WritingRunSummary> {
        return this.withChapter(input.chapterEntryId, async () => {
            this.assertNotLive(input.chapterEntryId);
            const latest = await this.latestState(input.chapterEntryId);
            if (latest === null) throw new WritingError("RUN_NOT_FOUND", "该章还没有写作运行，请先发起写作");
            const summary = await this.summarize(latest);
            if (!this.isCurrentDefinition(latest)) {
                await this.closeLegacyRun(latest);
                if (summary.kind === "rewrite") {
                    const previous = await this.argsOf(latest);
                    if (previous.kind !== "rewrite") throw new Error("改写运行身份不一致");
                    const {runId, done} = this.runner.begin(writingRewriteWorkflow, toJsonValue(previous.args));
                    this.track(runId, previous, done);
                    return {kind: "rewrite", runId, chapterEntryId: previous.args.chapterEntryId, target: previous.args.target,
                        requirement: previous.args.requirement, status: "running", interrupted: false, result: null, error: null, createdAt: ""};
                }
            } else if (summary.interrupted || summary.status === "failed") {
                this.track(summary.runId, await this.argsOf(latest), this.runner.rerun(summary.runId));
                return {...summary, status: "running", interrupted: false};
            }
            if (this.isCurrentDefinition(latest)) this.assertIdle(latest);
            const chapterRun = await this.latestState(input.chapterEntryId, writingChapterWorkflow.key);
            const previous = chapterRun === null ? null : await this.summarize(chapterRun);
            if (chapterRun === null || previous?.kind !== "chapter") throw new WritingError("RUN_NOT_FOUND", "该章还没有整章写作运行，请先发起写作");
            const previousArgs = await this.argsOf(chapterRun);
            return this.launchChapter({chapterEntryId: input.chapterEntryId, task: "continue", mode: input.mode ?? previous.mode,
                ...(previousArgs.args.ownerSessionId === undefined ? {} : {ownerSessionId: previousArgs.args.ownerSessionId}),
                ...(previous.progress === null ? {} : {resume: previous.progress})});
        });
    }

    /**
     * 停止：取消正在进行的调用，等到运行记录转为终态再返回。
     * 中断的运行不在本进程执行，取消只能记下请求；按记录重放到下一步即转为已取消，不产生新的调用。
     */
    async stop(runId: string): Promise<WritingRunSummary> {
        const state = await this.requireState(runId);
        if (!this.isCurrentDefinition(state)) {
            await this.closeLegacyRun(state);
            return this.summarize(await this.requireState(runId));
        }
        const interrupted = state.status === "running" && !this.live.has(runId);
        await this.runner.cancel(runId);
        if (interrupted) await this.runner.rerun(runId).catch(() => undefined);
        return this.settle(runId);
    }

    /**
     * 应答场景规划的核对与确认，或改写的替换确认；key 来自运行记录中的待应答项，须一次答全。
     * 用户从界面只能应答交给用户的项；主创核对由主创判断，界面不代答。
     */
    async answer(runId: string, answers: Readonly<Record<string, JsonValue>>, answerer: "lead" | "user" = "lead"): Promise<WritingRunSummary> {
        const state = await this.requireState(runId);
        if (!this.isCurrentDefinition(state)) throw new WritingError("RUN_ANSWER_INVALID", "写作流程已更新，请先停止旧运行，再续写以重新补充与审核资料");
        if (state.status !== "waiting" || state.pendingAsks.length === 0 || this.live.has(runId)) {
            throw new WritingError("RUN_ANSWER_INVALID", "该运行当前没有等待应答的项");
        }
        if (answerer === "user" && state.pendingAsks.some(({spec}) => askRole(spec.title) === "lead-review")) {
            throw new WritingError("RUN_ANSWER_INVALID", "场景规划正在等待主创核对，不能由用户应答");
        }
        const missing = state.pendingAsks.filter(({key}) => answers[key] === undefined);
        if (missing.length > 0) throw new WritingError("RUN_ANSWER_INVALID", `缺少应答：${missing.map(({spec}) => spec.title).join("、")}`);
        this.track(runId, await this.argsOf(state), this.runner.resume(runId, {...answers}));
        return this.summarize(await this.requireState(runId));
    }

    async view(runId: string): Promise<RunView> {
        return await this.runner.loadView(runId);
    }

    /** 进度卡片的数据，见 run-progress.ts。 */
    async progress(runId: string): Promise<WritingRunProgressDto> {
        const state = await this.backend.loadRun(runId);
        const live = this.live.get(runId);
        if (state === null) {
            if (live === undefined) throw new WritingError("RUN_NOT_FOUND", `写作运行不存在：${runId}`);
            return this.project({summary: this.startingSummary(runId, live.run), phase: null, logs: [], pendingAsks: [], records: [],
                checkpoint: null, result: null}, live.run);
        }
        const run = await this.argsOf(state);
        const records = await Promise.all(state.journal.filter(({path}) => path === "root").sort((a, b) => a.seq - b.seq)
            .map(async ({kind, params, result}) => ({kind, params: params === undefined ? null : JSON.parse(params) as JsonValue,
                result: await this.decode(result)})));
        const source: RunProgressSource = {
            summary: this.summaryDto(state, run),
            phase: state.progress?.phase ?? null,
            logs: state.logs,
            pendingAsks: state.pendingAsks,
            records,
            checkpoint: state.checkpoint === null ? null : await this.decode(state.checkpoint),
            result: state.result === undefined ? null : await this.decode(state.result),
        };
        return this.project(source, run);
    }

    private project(source: RunProgressSource, run: RunArgs): WritingRunProgressDto {
        return run.kind === "rewrite" ? projectRewriteRun(source, run.args) : projectChapterRun(source, run.args);
    }

    private startingSummary(runId: string, run: RunArgs): WritingRunSummaryDto {
        return {runId, kind: run.kind, chapterEntryId: run.args.chapterEntryId, status: "running", interrupted: false, error: null,
            createdAt: "", updatedAt: ""};
    }

    /** 本章的运行，按发起先后排列。 */
    async chapterRunSummaries(chapterEntryId: string): Promise<WritingRunSummaryDto[]> {
        return (await this.runSummaries()).filter((summary) => summary.chapterEntryId === chapterEntryId);
    }

    /** 各章运行中或等待应答的运行；界面据此锁定正文编辑器。 */
    async activeRunSummaries(): Promise<WritingRunSummaryDto[]> {
        return (await this.runSummaries()).filter((summary) => summary.status === "running" || summary.status === "waiting");
    }

    private async runSummaries(): Promise<WritingRunSummaryDto[]> {
        const states = (await this.backend.listRuns()).filter((state) => WORKFLOW_KEYS.has(state.definition.key));
        const summaries = await Promise.all(states.map(async (state) => this.summaryDto(state, await this.argsOf(state))));
        const saved = new Set(states.map(({runId}) => runId));
        const starting = [...this.live].filter(([runId]) => !saved.has(runId)).map(([runId, {run}]) => this.startingSummary(runId, run));
        return [...summaries, ...starting];
    }

    async listChapterRuns(chapterEntryId: string): Promise<WritingRunSummary[]> {
        const states = (await this.backend.listRuns()).filter((state) => WORKFLOW_KEYS.has(state.definition.key));
        const summaries = await Promise.all(states.map((state) => this.summarize(state)));
        return summaries.filter((summary) => summary.chapterEntryId === chapterEntryId);
    }

    /** 等待本进程中正在执行的一段结束（完成、停止、等待应答或失败）。 */
    async settle(runId: string): Promise<WritingRunSummary> {
        await this.live.get(runId)?.done.catch(() => undefined);
        return this.summarize(await this.requireState(runId));
    }

    private withChapter<T>(chapterEntryId: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.chapterQueues.get(chapterEntryId) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(operation);
        this.chapterQueues.set(chapterEntryId, next);
        void next.finally(() => {
            if (this.chapterQueues.get(chapterEntryId) === next) this.chapterQueues.delete(chapterEntryId);
        }).catch(() => undefined);
        return next;
    }

    private launchChapter(args: WritingRunArgs): ChapterRunSummary {
        const {runId, done} = this.runner.begin(writingChapterWorkflow, toJsonValue(args));
        this.track(runId, {kind: "chapter", args}, done);
        return {kind: "chapter", runId, chapterEntryId: args.chapterEntryId, task: args.task, mode: args.mode, status: "running",
            interrupted: false, progress: args.resume ?? null, result: null, error: null, createdAt: ""};
    }

    private track(runId: string, run: RunArgs, done: Promise<RunView>): void {
        const entry = {run, done};
        this.live.set(runId, entry);
        void done.catch(() => undefined).finally(() => {
            if (this.live.get(runId) === entry) this.live.delete(runId);
        });
    }

    /** 同一章同一时间只有一次写作或改写。 */
    private async assertChapterIdle(chapterEntryId: string): Promise<void> {
        this.assertNotLive(chapterEntryId);
        const latest = await this.latestState(chapterEntryId);
        if (latest !== null) this.assertIdle(latest);
    }

    /** 本进程正在执行的运行；刚发起时运行记录可能尚未落盘，不能只看记录。 */
    private assertNotLive(chapterEntryId: string): void {
        for (const [runId, live] of this.live) {
            if (live.run.args.chapterEntryId === chapterEntryId) throw new WritingError("RUN_ACTIVE", `该章已有一次写作或改写运行（${runId}）正在执行`);
        }
    }

    private assertIdle(state: WorkflowRunState): void {
        if (state.status === "running" || state.status === "waiting") {
            const what = state.status === "running" ? "上次运行中断，请续写或停止"
                : state.definition.key === writingRewriteWorkflow.key ? "正在等待确认替换" : "正在等待核对场景规划";
            throw new WritingError("RUN_ACTIVE", `该章已有一次运行（${state.runId}）${what}`);
        }
    }

    /** listRuns 按创建先后排列；不传 key 时整章写作与改写一起算。 */
    private async latestState(chapterEntryId: string, key?: string): Promise<WorkflowRunState | null> {
        const states = (await this.backend.listRuns()).filter((state) =>
            key === undefined ? WORKFLOW_KEYS.has(state.definition.key) : state.definition.key === key);
        let latest: WorkflowRunState | null = null;
        for (const state of states) {
            if ((await this.argsOf(state)).args.chapterEntryId === chapterEntryId) latest = state;
        }
        return latest;
    }

    private async requireState(runId: string): Promise<WorkflowRunState> {
        const state = await this.backend.loadRun(runId);
        if (state === null) throw new WritingError("RUN_NOT_FOUND", `写作运行不存在：${runId}`);
        return state;
    }

    private isCurrentDefinition(state: WorkflowRunState): boolean {
        return WORKFLOWS.some(definition => definition.key === state.definition.key && definition.manifestHash === state.definition.manifestHash);
    }

    /** Obsolete journals cannot be replayed with different steps; retire them without invoking any models. */
    private async closeLegacyRun(state: WorkflowRunState): Promise<void> {
        if (this.live.has(state.runId)) throw new WritingError("RUN_ACTIVE", "旧运行仍在执行，请等待停止完成");
        if (state.status === "completed" || state.status === "cancelled") return;
        for (const record of state.journal) {
            if (record.kind !== "agents.create" || !record.params || !record.result) continue;
            const init: unknown = JSON.parse(record.params);
            const result = await this.decode(record.result);
            if (init && typeof init === "object" && "ephemeral" in init && init.ephemeral === true
                && result && typeof result === "object" && !Array.isArray(result) && typeof result.sessionId === "number") {
                await this.options.sessions.archive(result.sessionId);
            }
        }
        const now = (this.options.clock?.now() ?? new Date()).toISOString();
        await this.backend.saveRun({...state, status: "cancelled", cancelRequestedAt: state.cancelRequestedAt ?? now,
            pendingAsks: [], pendingWaits: [], updatedAt: now, error: "旧写作流程已停止，请按新流程继续"}, state.revision);
    }

    private async decode(value: WorkflowValue): Promise<JsonValue> {
        return value.kind === "inline" ? value.value : await this.values.get(value.ref);
    }

    private async argsOf(state: WorkflowRunState): Promise<RunArgs> {
        const value = await this.decode(state.input);
        return state.definition.key === writingRewriteWorkflow.key
            ? {kind: "rewrite", args: fromJsonValue<RewriteRunArgs>(value)}
            : {kind: "chapter", args: fromJsonValue<WritingRunArgs>(value)};
    }

    private summaryDto(state: WorkflowRunState, run: RunArgs): WritingRunSummaryDto {
        return {runId: state.runId, kind: run.kind, chapterEntryId: run.args.chapterEntryId, status: state.status,
            interrupted: state.status === "running" && !this.live.has(state.runId), error: runError(state),
            createdAt: state.createdAt, updatedAt: state.updatedAt};
    }

    private async summarize(state: WorkflowRunState): Promise<WritingRunSummary> {
        const run = await this.argsOf(state);
        const base: RunSummaryBase = {
            runId: state.runId,
            chapterEntryId: run.args.chapterEntryId,
            status: state.status,
            interrupted: state.status === "running" && !this.live.has(state.runId),
            error: runError(state),
            createdAt: state.createdAt,
        };
        const result = state.result === undefined ? null : await this.decode(state.result);
        if (run.kind === "rewrite") {
            return {...base, kind: "rewrite", target: run.args.target, requirement: run.args.requirement,
                result: result === null ? null : fromJsonValue<RewriteRunResult>(result)};
        }
        return {
            ...base,
            kind: "chapter",
            task: run.args.task,
            mode: run.args.mode,
            progress: state.checkpoint === null ? null : fromJsonValue<WritingProgress>(await this.decode(state.checkpoint)),
            result: result === null ? null : fromJsonValue<WritingRunResult>(result),
        };
    }
}
