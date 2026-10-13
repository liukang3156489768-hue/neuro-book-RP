import type {OperationActor} from "@notnotype/nb-history";
import type {ActivityExecutionRequest, ActivityExecutor, AgentWorkflowContext, JsonValue} from "@notnotype/nb-workflow";
import {sameWriterChapterBasis, type WriterChapterBasis} from "nbook/server/outline/writer-context";
import type {ReadyProjectSessionRef} from "nbook/server/workspace-files/project-session-types";
import type {WritingIssueDraft, WritingIssueRegistrar} from "nbook/shared/dto/writing.dto";
import {chapterReferencePaths} from "./assistant-scope";
import {
    readReadyAssistantFiles, readReadyWritingIssues, readReadyWritingRunFacts, recheckReadyWritingIssues, registerReadyWritingIssues,
    replaceReadyProseParagraphs, writeReadyProseBody, writeReadyProseSource, type WritingRunFacts,
} from "./host";
import {countWords, meetsWordLowerBound, type WritingStyle} from "./materials";
import {locateRewrite, type LocatedRewrite, type ParagraphRange, type RewriteTarget} from "./rewrite";
import {hasActiveBlockingDrafts} from "./issues";
import {currentChapterBasis, proseBodyHash, WritingError} from "./prose-binding";
import {buildChapterMaterials, type ChapterMaterials} from "./scenes";
import {
    materialSourceHash, renderScenePrompt, validateRewritePlan, validateScenePlan, type PlannedScene, type RewritePlan, type ScenePlan, type WriterPrompt,
} from "./structures";

export type WritingTask = "new" | "continue" | "rewrite";

type Changed = Readonly<{status: "changed"; issues: readonly WritingIssueDraft[]}>;
type Unavailable = Readonly<{status: "unavailable"; message: string}>;

export type PrepareOutput =
    | Readonly<{
        ok: true;
        planId: string;
        basis: WriterChapterBasis;
        materials: ChapterMaterials;
        referencePaths: readonly string[];
        /** 程序发现的问题，由写作工作流登记。 */
        issues: readonly WritingIssueDraft[];
        proseHash: string;
        acceptedProse: string;
        previousEnding: string | null;
    }>
    | Readonly<{
        ok: false;
        reason: "unavailable" | "not-writable" | "style" | "has-prose" | "blocking-issue";
        message: string;
        issues: readonly WritingIssueDraft[];
    }>;

export type ValidatePlanOutput =
    | Readonly<{status: "valid"; plan: ScenePlan; issues: readonly WritingIssueDraft[]}>
    | Readonly<{status: "invalid"; errors: readonly string[]}>
    | Changed
    | Unavailable;

export type SceneContextOutput =
    | Readonly<{status: "ready"; prompt: WriterPrompt; proseHash: string}>
    | Readonly<{status: "source-unreadable"; issues: readonly WritingIssueDraft[]}>
    | Changed
    | Unavailable;

export type AcceptSceneOutput =
    | Readonly<{status: "written" | "unchanged"; hash: string}>
    | Readonly<{status: "conflict"}>
    | Readonly<{status: "failed"; message: string}>;

export type RunHint = Readonly<{id: string; code: string; message: string}>;

export type FinishOutput =
    | Readonly<{
        status: "done";
        words: number;
        /** 细纲总览的整章目标字数；withinTarget 表示整章字数不少于它的 70%。 */
        targetWords: number;
        withinTarget: boolean;
        /** 本次运行登记且仍未处理的提示问题；读取失败时为 null，原因见 hintsError。 */
        hints: readonly RunHint[] | null;
        hintsError: string | null;
    }>
    | Changed
    | Readonly<{status: "failed"; message: string}>;

export type Outcome = Readonly<{ok: true}> | Readonly<{ok: false; message: string}>;

/** 助手改写时参考的本章指导；章节不可写（无交接）或细纲结构不完整时为 null，助手只依据 lorebook/。 */
export type RewriteGuidance = Readonly<{chapterGuidance: ChapterMaterials["chapterGuidance"]; materials?: ChapterMaterials; planId?: string}>;

export type PrepareRewriteOutput =
    | Readonly<{
        ok: true;
        located: LocatedRewrite;
        style: WritingStyle;
        guidance: RewriteGuidance | null;
        referencePaths: readonly string[];
        /** 助手登记问题时可指向的条目：本章章节大纲与细纲。 */
        entryIds: readonly string[];
    }>
    | Readonly<{ok: false; reason: "unavailable" | "style" | "no-prose" | "target"; message: string}>;

export type ValidateRewritePlanOutput =
    | Readonly<{status: "valid"; plan: RewritePlan}>
    | Readonly<{status: "invalid"; errors: readonly string[]}>
    | Unavailable;

export type ReplaceRewriteOutput =
    | Readonly<{status: "replaced" | "unchanged"; hash: string}>
    | Readonly<{status: "target-changed" | "failed"; message: string}>;

type Chapter = Readonly<{chapterEntryId: string}>;
type Planned = Chapter & Readonly<{planId: string; basis: WriterChapterBasis}>;

/** 每个 Activity 的输入输出；工作流与执行器共用这一份定义。 */
export type WritingActivityIO = {
    materialSourcesCurrent: {input: Chapter & Readonly<{hashes: Readonly<Record<string, string>>}>; output: boolean};
    effectiveWriterPrompt: {input: Readonly<{sessionId: number; fallback: WriterPrompt}>; output: WriterPrompt};
    prepare: {input: Chapter & Readonly<{task: WritingTask}>; output: PrepareOutput};
    validatePlan: {input: Planned & Readonly<{submission: JsonValue; sceneIndices?: readonly number[]}>; output: ValidatePlanOutput};
    sceneContext: {
        input: Planned & Readonly<{scene: PlannedScene; replaceBody: boolean; retryProblems: readonly string[]}>;
        output: SceneContextOutput;
    };
    registerIssues: {input: Chapter & Readonly<{drafts: readonly WritingIssueDraft[]; registrar: WritingIssueRegistrar}>;
        output: Readonly<{ok: true; blocking: boolean}> | Readonly<{ok: false; message: string}>};
    recheckIssues: {input: Chapter & Readonly<{since: string}>; output: Outcome};
    acceptScene: {input: Chapter & Readonly<{mode: "append" | "replace"; baseHash: string; text: string}>; output: AcceptSceneOutput};
    finish: {input: Planned & Readonly<{since: string; targetWords: number}>; output: FinishOutput};
    prepareRewrite: {input: Chapter & Readonly<{target: RewriteTarget}>; output: PrepareRewriteOutput};
    validateRewritePlan: {input: Chapter & Readonly<{submission: JsonValue}>; output: ValidateRewritePlanOutput};
    replaceRewrite: {input: Chapter & Readonly<{range: ParagraphRange; target: string; replacement: string}>; output: ReplaceRewriteOutput};
};

export type WritingActivityName = keyof WritingActivityIO;

/** 引用带版本：已落盘的运行记录按引用重放，输入输出合同变化时必须升版本。 */
const ACTIVITIES: Readonly<Record<WritingActivityName, Readonly<{reference: string; kind: "query" | "action"}>>> = {
    materialSourcesCurrent: {reference: "writing.material-sources-current@1", kind: "query"},
    effectiveWriterPrompt: {reference: "writing.effective-writer-prompt@1", kind: "query"},
    prepare: {reference: "writing.prepare@3", kind: "query"},
    validatePlan: {reference: "writing.validate-plan@4", kind: "query"},
    sceneContext: {reference: "writing.scene-context@3", kind: "query"},
    registerIssues: {reference: "writing.register-issues@2", kind: "action"},
    recheckIssues: {reference: "writing.recheck-issues@1", kind: "action"},
    acceptScene: {reference: "writing.accept-scene@1", kind: "action"},
    finish: {reference: "writing.finish@2", kind: "action"},
    prepareRewrite: {reference: "writing.prepare-rewrite@3", kind: "query"},
    validateRewritePlan: {reference: "writing.validate-rewrite-plan@2", kind: "query"},
    replaceRewrite: {reference: "writing.replace-rewrite@1", kind: "action"},
};

/**
 * 写作领域类型用只读数组，不满足 Kernel 的可变 JsonValue；运行记录又要求值能原样 JSON 往返。
 * 所以统一在这里做一次 JSON 往返：既去掉 undefined 字段，也让类型断言只出现在这一处边界。
 */
export function toJsonValue(value: unknown): JsonValue {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function fromJsonValue<T>(value: JsonValue): T {
    return value as unknown as T;
}

/** 进度投影按引用识别运行记录，与工作流共用同一份引用。 */
export function writingActivityReference(name: WritingActivityName): string {
    return ACTIVITIES[name].reference;
}

/** 工作流侧调用：按名称取引用与种类，输入输出按 WritingActivityIO 定型。 */
export async function callWritingActivity<K extends WritingActivityName>(
    wf: Pick<AgentWorkflowContext, "callAction" | "query">, name: K, input: WritingActivityIO[K]["input"],
): Promise<WritingActivityIO[K]["output"]> {
    const {reference, kind} = ACTIVITIES[name];
    const output = kind === "query" ? await wf.query(reference, toJsonValue(input)) : await wf.callAction(reference, toJsonValue(input));
    return fromJsonValue<WritingActivityIO[K]["output"]>(output);
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function planningChanged(chapterEntryId: string, message: string): Changed {
    return {status: "changed", issues: [{code: "PLANNING_CHANGED", severity: "blocking", message, location: {entryId: chapterEntryId}}]};
}

type CurrentPlanning =
    | Readonly<{status: "current"; facts: WritingRunFacts & Readonly<{context: NonNullable<WritingRunFacts["context"]>}>; materials: ChapterMaterials}>
    | Changed
    | Unavailable;

/**
 * 重新读取交接并与规划记录的依据比较。依据相同即交接内容相同，
 * 因此素材按当前交接重新整理，不必把整份素材放进每一步的输入。
 */
async function readCurrentPlanning(ready: ReadyProjectSessionRef, input: Planned): Promise<CurrentPlanning> {
    let facts: WritingRunFacts;
    try {
        facts = await readReadyWritingRunFacts(ready, {chapterEntryId: input.chapterEntryId});
    } catch (error) {
        if (error instanceof WritingError) return {status: "unavailable", message: error.message};
        throw error;
    }
    const {chapter, context} = facts;
    if (facts.planId !== input.planId) return {status: "unavailable", message: "写作方案已切换"};
    if (context === null) return planningChanged(input.chapterEntryId, `章节已不可写：${chapter.block?.message ?? "未知原因"}`);
    if (!sameWriterChapterBasis(input.basis, currentChapterBasis(chapter))) {
        return planningChanged(input.chapterEntryId, "章节大纲或细纲在写作期间已变化");
    }
    const built = buildChapterMaterials(context);
    if (!built.ok) return planningChanged(input.chapterEntryId, "章节细纲的场景结构在写作期间已变化");
    return {status: "current", facts: {...facts, context}, materials: built.materials};
}

function excerptPaths(scenes: readonly Readonly<{techniques: {excerpts: readonly {path: string}[]}; background: {excerpts: readonly {path: string}[]};
    supplements?: readonly {excerpts: readonly {path: string}[]}[]}>[]): string[] {
    return scenes.flatMap(({techniques, background, supplements}) => [...techniques.excerpts, ...background.excerpts,
        ...(supplements ?? []).flatMap(item => item.excerpts)].map(({path}) => path));
}

/** 一组 techniques/background 里的摘录路径；形状不对时交给结构校验报告，这里只尽量收集。 */
function materialExcerptPaths(holder: JsonValue): string[] {
    if (holder === null || typeof holder !== "object" || Array.isArray(holder)) return [];
    return [holder.techniques, holder.background, ...(Array.isArray(holder.supplements) ? holder.supplements : [])].flatMap((material) => {
        if (material === null || material === undefined || typeof material !== "object" || Array.isArray(material)
            || !Array.isArray(material.excerpts)) return [];
        return material.excerpts.flatMap((excerpt) => excerpt !== null && typeof excerpt === "object" && !Array.isArray(excerpt)
            && typeof excerpt.path === "string" ? [excerpt.path] : []);
    });
}

/** 细纲各场景的参考资料；场景规划校验时检查是否可读。 */
function sceneSourcePaths(materials: ChapterMaterials): string[] {
    return materials.scenes.flatMap(({references}) => references.flatMap(({path}) => path === undefined ? [] : [path]));
}

function submittedExcerptPaths(submission: JsonValue): string[] {
    if (submission === null || typeof submission !== "object" || Array.isArray(submission) || !Array.isArray(submission.scenes)) return [];
    return submission.scenes.flatMap(materialExcerptPaths);
}

async function readFactsOrUnavailable(ready: ReadyProjectSessionRef, chapterEntryId: string):
    Promise<Readonly<{ok: true; facts: WritingRunFacts}> | Readonly<{ok: false; message: string}>> {
    try {
        return {ok: true, facts: await readReadyWritingRunFacts(ready, {chapterEntryId})};
    } catch (error) {
        if (error instanceof WritingError) return {ok: false, message: error.message};
        throw error;
    }
}

type Handlers = {[K in WritingActivityName]: (input: WritingActivityIO[K]["input"]) => Promise<WritingActivityIO[K]["output"]>};

export type WriterPromptResolver = (sessionId: number, fallback: WriterPrompt) => Promise<WriterPrompt>;

function createHandlers(ready: ReadyProjectSessionRef, actor: OperationActor, resolveWriterPrompt?: WriterPromptResolver): Handlers {
    return {
        async materialSourcesCurrent({chapterEntryId, hashes}) {
            const read = await readFactsOrUnavailable(ready, chapterEntryId);
            if (!read.ok) return false;
            const files = await readReadyAssistantFiles(ready, {paths: Object.keys(hashes),
                referencePaths: read.facts.context ? chapterReferencePaths(read.facts.context) : []});
            return Object.entries(hashes).every(([path, hash]) => files.has(path) && materialSourceHash(files.get(path)!) === hash);
        },
        effectiveWriterPrompt: ({sessionId, fallback}) => resolveWriterPrompt ? resolveWriterPrompt(sessionId, fallback) : Promise.resolve(fallback),
        async prepare({chapterEntryId, task}) {
            let facts: WritingRunFacts;
            try {
                facts = await readReadyWritingRunFacts(ready, {chapterEntryId});
            } catch (error) {
                if (error instanceof WritingError) return {ok: false, reason: "unavailable", message: error.message, issues: []};
                throw error;
            }
            const {chapter, context, style, prose} = facts;
            if (context === null) {
                return {ok: false, reason: "not-writable", message: `章节不可写：${chapter.block?.message ?? "未知原因"}`, issues: []};
            }
            if (style === null) return {ok: false, reason: "style", message: "尚未选择文风文件，请先在写作设置中选择", issues: []};
            if (!style.result.ok) return {ok: false, reason: "style", message: style.result.message, issues: []};
            if (task === "new" && prose !== null && prose.body !== "") {
                return {ok: false, reason: "has-prose", message: "该章已有正文；请选择续写或整章重写", issues: []};
            }
            const built = buildChapterMaterials(context);
            if (!built.ok) return {ok: false, reason: "blocking-issue", message: "细纲结构不完整", issues: built.issues};
            const previousMissing: WritingIssueDraft[] = facts.hasEarlierChapter && facts.previous === null
                ? [{code: "MISSING_PREVIOUS_CHAPTER", severity: "hint", message: "上一章尚无正文，场景 1 不带上一章结尾", location: {entryId: chapterEntryId}}]
                : [];
            return {ok: true, planId: facts.planId, basis: context.basis, materials: built.materials,
                referencePaths: chapterReferencePaths(context), issues: [...built.issues, ...previousMissing],
                proseHash: prose?.hash ?? proseBodyHash(""), acceptedProse: task === "rewrite" ? "" : prose?.body ?? "",
                previousEnding: facts.previous?.ending ?? null};
        },

        async validatePlan(input) {
            const current = await readCurrentPlanning(ready, input);
            if (current.status !== "current") return current;
            const files = await readReadyAssistantFiles(ready, {
                paths: [...submittedExcerptPaths(input.submission), ...sceneSourcePaths(current.materials)],
                referencePaths: chapterReferencePaths(current.facts.context)});
            const validation = validateScenePlan(input.submission, {planId: input.planId, basis: input.basis,
                materials: current.materials, files, sceneIndices: input.sceneIndices});
            return validation.ok ? {status: "valid", plan: validation.value, issues: validation.issues}
                : {status: "invalid", errors: validation.errors};
        },

        async sceneContext(input) {
            const current = await readCurrentPlanning(ready, input);
            if (current.status !== "current") return current;
            const {facts, materials} = current;
            const unreadable = (message: string): SceneContextOutput => ({status: "source-unreadable", issues: [{code: "SOURCE_UNREADABLE",
                severity: "blocking", message, location: {entryId: input.scene.detailEntryId, sceneIndex: input.scene.index}}]});
            if (facts.style === null) return unreadable("文风文件已在写作期间取消选择");
            if (!facts.style.result.ok) return unreadable(`文风文件已不可用：${facts.style.result.message}`);
            const paths = excerptPaths([input.scene]);
            const files = await readReadyAssistantFiles(ready, {paths, referencePaths: chapterReferencePaths(facts.context)});
            const missing = [...new Set(paths)].filter((path) => !files.has(path));
            if (missing.length > 0) return unreadable(`摘录来源已不可读：${missing.join("、")}`);
            if (Object.entries(input.scene.sourceHashes ?? {}).some(([path, hash]) => !files.has(path) || materialSourceHash(files.get(path)!) !== hash)) {
                return unreadable("补充资料来源已在审核后变化，请重新补充与审核后再写作");
            }
            const body = facts.prose?.body ?? "";
            const prompt = renderScenePrompt({style: facts.style.result.style, materials, scene: input.scene,
                previousEnding: facts.previous?.ending ?? null, acceptedProse: input.replaceBody ? "" : body,
                retryProblems: input.retryProblems});
            return {status: "ready", prompt, proseHash: facts.prose?.hash ?? proseBodyHash("")};
        },

        async registerIssues({chapterEntryId, drafts, registrar}) {
            if (drafts.length === 0) return {ok: true, blocking: false};
            try {
                const saved = await registerReadyWritingIssues(ready, {chapterEntryId, drafts, registrar}, actor);
                return {ok: true, blocking: hasActiveBlockingDrafts(drafts, saved.issues)};
            } catch (error) {
                return {ok: false, message: errorMessage(error)};
            }
        },

        async recheckIssues({chapterEntryId, since}) {
            try {
                await recheckReadyWritingIssues(ready, {chapterEntryId, since}, actor);
                return {ok: true};
            } catch (error) {
                return {ok: false, message: errorMessage(error)};
            }
        },

        async acceptScene(input) {
            try {
                const written = await writeReadyProseBody(ready, input, actor);
                return written.status === "conflict" ? {status: "conflict"} : {status: written.status, hash: written.hash};
            } catch (error) {
                return {status: "failed", message: errorMessage(error)};
            }
        },

        async finish({chapterEntryId, planId, basis, since, targetWords}) {
            try {
                await writeReadyProseSource(ready, {planId, chapterEntryId, basis}, actor);
            } catch (error) {
                if (error instanceof WritingError && (error.code === "BASIS_CHANGED" || error.code === "CHAPTER_NOT_WRITABLE")) {
                    return planningChanged(chapterEntryId, error.message);
                }
                return {status: "failed", message: errorMessage(error)};
            }
            const facts = await readReadyWritingRunFacts(ready, {chapterEntryId});
            const words = countWords(facts.prose?.body ?? "");
            let hints: RunHint[] | null = null;
            let hintsError: string | null = null;
            try {
                const issues = await readReadyWritingIssues(ready);
                const unreadable = issues.unreadable.find((item) => item.chapterEntryId === chapterEntryId);
                if (unreadable) {
                    hintsError = unreadable.message;
                } else {
                    hints = (issues.chapters.find((item) => item.chapterEntryId === chapterEntryId)?.issues ?? [])
                        .filter((issue) => issue.severity === "hint" && issue.status === "open" && issue.registeredAt >= since)
                        .map(({id, code, message}) => ({id, code, message}));
                }
            } catch (error) {
                hintsError = errorMessage(error);
            }
            return {status: "done", words, targetWords, withinTarget: meetsWordLowerBound(words, targetWords), hints, hintsError};
        },

        async prepareRewrite({chapterEntryId, target}) {
            const read = await readFactsOrUnavailable(ready, chapterEntryId);
            if (!read.ok) return {ok: false, reason: "unavailable", message: read.message};
            const {style, prose, context} = read.facts;
            if (style === null) return {ok: false, reason: "style", message: "尚未选择文风文件，请先在写作设置中选择"};
            if (!style.result.ok) return {ok: false, reason: "style", message: style.result.message};
            if (prose === null || prose.body === "") return {ok: false, reason: "no-prose", message: "该章尚无正文，没有可改写的段落"};
            const located = locateRewrite(prose.body, target);
            if (!located.ok) return {ok: false, reason: "target", message: located.message};
            const built = context === null ? null : buildChapterMaterials(context);
            return {
                ok: true,
                located: located.value,
                style: style.result.style,
                guidance: built?.ok ? {chapterGuidance: built.materials.chapterGuidance, materials: built.materials, planId: read.facts.planId} : null,
                referencePaths: context === null ? [] : chapterReferencePaths(context),
                entryIds: [chapterEntryId, ...(context?.basis.details.map(({entryId}) => entryId) ?? [])],
            };
        },

        async validateRewritePlan({chapterEntryId, submission}) {
            const read = await readFactsOrUnavailable(ready, chapterEntryId);
            if (!read.ok) return {status: "unavailable", message: read.message};
            const context = read.facts.context;
            const files = await readReadyAssistantFiles(ready, {paths: materialExcerptPaths(submission),
                referencePaths: context === null ? [] : chapterReferencePaths(context)});
            const validation = validateRewritePlan(submission, files);
            return validation.ok ? {status: "valid", plan: validation.value} : {status: "invalid", errors: validation.errors};
        },

        async replaceRewrite(input) {
            try {
                const replaced = await replaceReadyProseParagraphs(ready, input, actor);
                return replaced.status === "target-changed" ? replaced : {status: replaced.status, hash: replaced.hash};
            } catch (error) {
                return {status: "failed", message: errorMessage(error)};
            }
        },
    };
}

/**
 * 绑定到一个已就绪项目的写作 Activity 执行器。领域失败都作为值返回，由工作流决定停止方式；
 * 抛出的只有意外错误，此时 Run 失败，续写时按运行记录重试这一步。
 */
export function createWritingActivityExecutor(ready: ReadyProjectSessionRef, actor: OperationActor, resolveWriterPrompt?: WriterPromptResolver): ActivityExecutor {
    const handlers = createHandlers(ready, actor, resolveWriterPrompt);
    const byReference = new Map(Object.entries(ACTIVITIES).map(([name, spec]) => [spec.reference, {name: name as WritingActivityName, ...spec}]));
    const execute = async (kind: "query" | "action", request: ActivityExecutionRequest): Promise<JsonValue> => {
        const activity = byReference.get(request.reference);
        if (activity === undefined || activity.kind !== kind) throw new Error(`未知的写作${kind === "query" ? "查询" : "动作"}：${request.reference}`);
        const handler = handlers[activity.name] as (input: unknown) => Promise<unknown>;
        return toJsonValue(await handler(request.input));
    };
    return {
        query: (request) => execute("query", request),
        callAction: (request) => execute("action", request),
    };
}

