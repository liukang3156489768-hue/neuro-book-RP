import type {JsonValue, PendingAsk} from "@notnotype/nb-workflow";
import type {
    WritingAskRole, WritingAttemptDto, WritingChapterRunProgressDto, WritingPendingAskDto, WritingRewriteRunProgressDto,
    WritingRunSummaryDto, WritingSceneProgressDto,
} from "nbook/shared/dto/writing.dto";
import {checkIssueDrafts} from "./issues";
import {REWRITE_CONFIRM_TITLE} from "./rewrite";
import type {RewriteRunArgs, RewriteRunResult} from "./rewrite-workflow";
import {judgeScene, validateRewriteReview, validateSceneReview, type PlannedScene, type SceneReviewSubmission} from "./structures";
import {fromJsonValue, writingActivityReference} from "./workflow-activities";
import {
    envelope, LEAD_REVIEW_TITLE, SCENE_REWRITE_LIMIT, USER_CONFIRM_TITLE, WRITING_PROFILES, type WritingProgress, type WritingRunArgs,
    type WritingRunResult,
} from "./writing-workflow";

/**
 * 进度卡片的数据从运行记录投影，不另存状态，所以刷新页面、重开项目或进程重启后显示一致。
 * 这里按写作与改写工作流的调用顺序解读记录：工作流步骤变化时（届时 manifestHash 也要升级）须同步修改。
 * 进行中的调用还没有记录，所以“写作中”“审阅中”由最后一条已完成记录推断。
 */

/** 根路径上的一条运行记录，参数与结果已解码。 */
export type DecodedRecord = Readonly<{kind: string; params: JsonValue | null; result: JsonValue | null}>;

export type RunProgressSource = Readonly<{
    summary: WritingRunSummaryDto;
    phase: string | null;
    logs: readonly string[];
    pendingAsks: readonly PendingAsk[];
    records: readonly DecodedRecord[];
    checkpoint: JsonValue | null;
    result: JsonValue | null;
}>;

type Fields = {[key: string]: JsonValue};

function fields(value: JsonValue | null | undefined): Fields {
    return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) ? value : {};
}

const SCENE_CONTEXT = writingActivityReference("sceneContext");
const PREPARE = writingActivityReference("prepare");
const PREPARE_REWRITE = writingActivityReference("prepareRewrite");

export function askRole(title: string): WritingAskRole {
    if (title === REWRITE_CONFIRM_TITLE) return "rewrite-confirm";
    if (title.startsWith(USER_CONFIRM_TITLE)) return "user-confirm";
    if (title.startsWith(LEAD_REVIEW_TITLE)) return "lead-review";
    throw new Error(`无法识别的写作待应答项：${title}`);
}

function projectAsks(asks: readonly PendingAsk[]): WritingPendingAskDto[] {
    return asks.map(({key, spec}) => ({key, role: askRole(spec.title), title: spec.title, description: spec.description ?? null}));
}

/** 写手调用与助手调用都是 agents.invoke，只能按创建会话时的 Profile 区分。 */
function writerSessions(records: readonly DecodedRecord[]): ReadonlySet<number> {
    const ids = new Set<number>();
    for (const {kind, params, result} of records) {
        if (kind === "agents.create" && fields(params).profileKey === WRITING_PROFILES.writer) {
            const sessionId = fields(result).sessionId;
            if (typeof sessionId === "number") ids.add(sessionId);
        }
    }
    return ids;
}

/** 与工作流读取调用结果的方式一致：只有完成的调用才有产出。 */
function invokeOutput(result: JsonValue | null): string {
    const reply = fields(result);
    return reply.status === "completed" && typeof reply.message === "string" ? reply.message.trim() : "";
}

function invokeData(result: JsonValue | null): JsonValue | null {
    const reply = fields(result);
    return reply.status === "completed" ? reply.data ?? null : null;
}

function base(source: RunProgressSource) {
    return {...source.summary, phase: source.phase, asks: projectAsks(source.pendingAsks), logs: [...source.logs]};
}

type SceneAttempt = {writerSessionId: number | null; prompt: {system: string; user: string}; output: string | null; review: SceneReviewSubmission | null};

function sceneJudgement(attempt: SceneAttempt, scene: PlannedScene): WritingAttemptDto["judgement"] {
    if (attempt.output === null || (attempt.output !== "" && attempt.review === null)) return null;
    const judged = judgeScene({review: attempt.review, output: attempt.output, targetWords: scene.targetWords});
    return {passed: judged.passed, problems: [...judged.problems]};
}

function sceneState(scene: PlannedScene, position: number, attempts: readonly SceneAttempt[], passed: number, running: boolean,
    planningPosition: number | null, result: WritingRunResult | null):
    Pick<WritingSceneProgressDto, "state" | "retry"> {
    if (position < passed) return {state: "passed", retry: 0};
    if (running && planningPosition === position) return {state: "planning", retry: 0};
    const last = attempts.at(-1);
    if (last === undefined) return {state: "pending", retry: 0};
    const judgement = sceneJudgement(last, scene);
    if (running) {
        if (last.output === null) return attempts.length === 1 ? {state: "writing", retry: 0} : {state: "retrying", retry: attempts.length - 1};
        if (judgement === null) return {state: "reviewing", retry: 0};
        // 判定通过到写入正文、保存检查点之间只差一次文件写入。
        if (judgement.passed) return {state: "passed", retry: 0};
        return attempts.length <= SCENE_REWRITE_LIMIT ? {state: "retrying", retry: attempts.length} : {state: "failed", retry: 0};
    }
    // 停止或中断在场景中途时，续写会重写这个场景，所以只有判定未通过的场景显示“未通过”。
    const failed = result?.failedScene?.index === scene.index || judgement?.passed === false;
    return {state: failed ? "failed" : "pending", retry: 0};
}

export function projectChapterRun(source: RunProgressSource, args: WritingRunArgs): WritingChapterRunProgressDto {
    const progress = source.checkpoint === null ? args.resume ?? null : fromJsonValue<WritingProgress>(source.checkpoint);
    const result = source.result === null ? null : fromJsonValue<WritingRunResult>(source.result);
    const plan = progress?.plan ?? null;
    const writers = writerSessions(source.records);
    const scenes = new Map(plan?.scenes.map((scene) => [scene.index, scene]) ?? []);
    const allowedEntries = new Set([args.chapterEntryId, ...plan?.basis.details.map(({entryId}) => entryId) ?? []]);
    const attempts = new Map<number, SceneAttempt[]>();
    let current: Readonly<{scene: PlannedScene; attempt: SceneAttempt}> | null = null;
    let sourceScenes: {index: number; heading: string}[] = [];

    for (const {kind, params, result: output} of source.records) {
        const call = fields(params);
        if (kind === "query" && call.reference === PREPARE) {
            const prepared = fields(output);
            const materials = fields(prepared.materials);
            if (prepared.ok === true && Array.isArray(materials.scenes)) {
                sourceScenes = materials.scenes.flatMap((item) => {
                    const scene = fields(item);
                    return typeof scene.index === "number" && typeof scene.heading === "string" ? [{index: scene.index, heading: scene.heading}] : [];
                });
            }
        }
        if (kind === "query" && (call.reference === SCENE_CONTEXT || call.reference === "writing.scene-context@2")) {
            const context = fields(output);
            const scene = scenes.get(fields(fields(call.input).scene).index as number);
            if (context.status !== "ready" || scene === undefined) continue;
            const attempt: SceneAttempt = {writerSessionId: null, prompt: fromJsonValue(context.prompt!), output: null, review: null};
            attempts.set(scene.index, [...attempts.get(scene.index) ?? [], attempt]);
            current = {scene, attempt};
        } else if (kind === "agents.create" && call.profileKey === WRITING_PROFILES.writer && current !== null) {
            const sessionId = fields(output).sessionId;
            if (typeof sessionId === "number") current.attempt.writerSessionId = sessionId;
        } else if (kind === "agents.invoke" && current !== null) {
            const input = fields(call.input);
            if (writers.has(call.id as number)) {
                current.attempt.output = invokeOutput(output);
            } else if (input.kind === "review-scene" && input.sceneIndex === current.scene.index) {
                const submitted = envelope(invokeData(output), "review");
                if (!submitted.ok || !checkIssueDrafts(submitted.issues, allowedEntries).ok) continue;
                const review = validateSceneReview(submitted.value, current.scene);
                if (review.ok) current.attempt.review = review.value;
            }
        }
    }

    const running = source.summary.status === "running";
    const planningIndex = (running || source.summary.status === "waiting") && (source.phase === "planning" || source.phase === "material-review")
        ? plan?.scenes.length ?? 0 : null;
    const projectedSources = sourceScenes.length > 0 ? sourceScenes : (plan?.scenes.map(({index, heading}) => ({index, heading})) ?? []);
    return {
        ...base(source),
        kind: "chapter",
        task: args.task,
        mode: args.mode,
        scenes: projectedSources.map((sourceScene, position) => {
            const scene = scenes.get(sourceScene.index);
            const list = attempts.get(sourceScene.index) ?? [];
            if (scene === undefined) return {index: sourceScene.index, heading: sourceScene.heading,
                ...({state: planningIndex === position ? "planning" : "unplanned", retry: 0} satisfies Pick<WritingSceneProgressDto, "state" | "retry">), attempts: []};
            return {
                index: scene.index,
                heading: scene.heading,
                ...sceneState(scene, position, list, progress?.passed ?? 0, running, planningIndex, result),
                attempts: list.map((attempt) => ({writerSessionId: attempt.writerSessionId, prompt: attempt.prompt, output: attempt.output, judgement: sceneJudgement(attempt, scene)})),
            };
        }),
        result,
    };
}

export function projectRewriteRun(source: RunProgressSource, args: RewriteRunArgs): WritingRewriteRunProgressDto {
    const result = source.result === null ? null : fromJsonValue<RewriteRunResult>(source.result);
    const writers = writerSessions(source.records);
    let range: WritingRewriteRunProgressDto["range"] = null;
    let original: string | null = null;
    let entryIds = new Set<string>();
    const attempts: WritingAttemptDto[] = [];
    let system: string | null = null;

    for (const {kind, params, result: output} of source.records) {
        const call = fields(params);
        if (kind === "query" && (call.reference === PREPARE_REWRITE || call.reference === "writing.prepare-rewrite@2")) {
            const prepared = fields(output);
            if (prepared.ok !== true) continue;
            const located = fields(prepared.located);
            range = fromJsonValue(located.range!);
            original = fields(located.window).target as string;
            entryIds = new Set(prepared.entryIds as string[]);
        } else if (kind === "agents.create" && fields(call).profileKey === WRITING_PROFILES.writer) {
            system = fields(call.initial).system as string;
            const sessionId = fields(output).sessionId;
            attempts.push({writerSessionId: typeof sessionId === "number" ? sessionId : null, prompt: null, output: null, judgement: null});
        } else if (kind === "agents.invoke") {
            const attempt = attempts.at(-1);
            if (attempt === undefined) continue;
            if (writers.has(call.id as number)) {
                attempt.prompt = {system: system ?? "", user: typeof call.message === "string" ? call.message : ""};
                attempt.output = invokeOutput(output);
                if (attempt.output === "") attempt.judgement = {passed: false, problems: ["写手输出为空"]};
            } else if (fields(call.input).kind === "review-rewrite") {
                const submitted = envelope(invokeData(output), "rewriteReview");
                if (!submitted.ok || !checkIssueDrafts(submitted.issues, entryIds).ok) continue;
                const review = validateRewriteReview(submitted.value);
                if (review.ok) attempt.judgement = {passed: review.value.passed, problems: [...review.value.problems]};
            }
        }
    }

    const passed = attempts.findLast(({judgement}) => judgement?.passed === true);
    return {
        ...base(source),
        kind: "rewrite",
        requirement: args.requirement,
        range: result?.range ?? range,
        original: result?.original ?? original,
        replacement: result?.replacement ?? passed?.output ?? null,
        attempts,
        result,
    };
}
