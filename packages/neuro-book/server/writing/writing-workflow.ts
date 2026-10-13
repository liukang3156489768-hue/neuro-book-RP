import type {AgentWorkflowContext, AgentWorkflowDefinition, JsonValue, SessionHandle} from "@notnotype/nb-workflow";
import {sameWriterChapterBasis} from "nbook/server/outline/writer-context";
import type {WritingIssueDraft, WritingIssueRegistrar} from "nbook/shared/dto/writing.dto";
import {checkIssueDrafts} from "./issues";
import type {ChapterMaterials} from "./scenes";
import {MATERIAL_REJECTION_LIMIT, MATERIAL_REVIEW_PROFILE, reviewWritingMaterials} from "./material-review";
import {judgeScene, MATERIAL_SUPPLEMENT_CONTRACT, renderMaterial, renderSupplements, validateSceneReview, type PlannedScene, type ScenePlan, type SceneReviewSubmission} from "./structures";
import {callWritingActivity, fromJsonValue, toJsonValue, type RunHint, type WritingActivityIO, type WritingActivityName, type WritingTask} from "./workflow-activities";

export const WRITING_WORKFLOW_KEY = "writing.chapter";

export const WRITING_PROFILES = {lead: "writing.lead", assistant: "writing.assistant", writer: "writing.writer", reviewer: MATERIAL_REVIEW_PROFILE} as const;

/** 程序校验退回助手的次数上限；超过说明助手无法按合同提交，继续退回只会消耗调用。 */
export const PLAN_SUBMISSION_LIMIT = 3;
/** 主创（讨论模式含用户）退回场景规划的次数上限，见 writing.collaboration 状态表。 */
export const PLAN_REJECTION_LIMIT = 3;
/** 每个场景首写之外最多重写的次数。 */
export const SCENE_REWRITE_LIMIT = 2;
/** 审阅结果形状不合法时的提交次数上限。 */
export const REVIEW_SUBMISSION_LIMIT = 3;

/** 场景规划待应答项的标题前缀，后接轮次；进度投影与主创工具按它区分主创核对与用户确认。 */
export const LEAD_REVIEW_TITLE = "核对场景规划";
export const USER_CONFIRM_TITLE = "确认场景规划";

export type WritingMode = "auto" | "discussion";

/**
 * 写作粒度。scene 逐场景写作与审阅；chapter 是整章编写模式（助手一次规划、写手一次写成整章、助手整章审阅），
 * 助手 Profile 已预留 plan-chapter / review-chapter 两种调用，工作流尚未实现，收到时直接停止。
 */
export type WritingGranularity = "scene" | "chapter";

/** plan.scenes 是已审核确认的场景前缀，passed 是已写入正文的数量。 */
export type WritingProgress = Readonly<{plan: ScenePlan; passed: number; replaceBody: boolean}>;

export type WritingRunArgs = Readonly<{
    chapterEntryId: string;
    /** The initiating chat owns the prompt version, including all scene retries and resumed runs. */
    ownerSessionId?: number;
    task: WritingTask;
    mode: WritingMode;
    /** 缺省为 scene；已落盘的运行记录都没有这个字段，按 scene 重放。 */
    granularity?: WritingGranularity;
    /** 续写或整章重写复用的已确认规划；重写从第一个场景开始。 */
    resume?: WritingProgress;
}>;

export type WritingStopReason =
    | "unavailable" | "not-writable" | "style" | "has-prose" | "blocking-issue" | "plan-invalid" | "plan-rejected"
    | "planning-changed" | "source-unreadable" | "review-invalid" | "scene-failed" | "write-failed" | "prose-changed"
    | "resume-mismatch" | "unsupported" | "material-review-invalid" | "material-rejected";

/** 运行结果写进运行记录，必须是可 JSON 往返的普通值，所以不用可选字段。 */
export type WritingRunResult = {
    outcome: "completed" | "stopped";
    reason: WritingStopReason | null;
    message: string;
    passedScenes: number;
    totalScenes: number | null;
    failedScene: {index: number; heading: string; problems: string[]} | null;
    words: number | null;
    targetWords: number | null;
    withinTarget: boolean | null;
    hints: RunHint[];
    /** 不影响写作继续、但需要告诉用户的情况，例如问题登记失败。 */
    notes: string[];
};

/** 主创与用户对场景规划的应答：布尔值，或带退回意见的对象。 */
export type PlanApproval = boolean | {approved: boolean; comments?: string};

type Prepared = Extract<WritingActivityIO["prepare"]["output"], {ok: true}>;

class StopRun {
    constructor(readonly reason: WritingStopReason, readonly message: string,
        readonly failedScene: WritingRunResult["failedScene"] = null) {}
}

function isRecord(value: JsonValue | null | undefined): value is {[key: string]: JsonValue} {
    return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}

export function parseApproval(answer: JsonValue): Readonly<{approved: boolean; comments: string | null}> {
    if (typeof answer === "boolean") return {approved: answer, comments: null};
    if (isRecord(answer) && typeof answer.approved === "boolean") {
        return {approved: answer.approved, comments: typeof answer.comments === "string" && answer.comments.trim() !== "" ? answer.comments.trim() : null};
    }
    return {approved: false, comments: "应答格式无法识别，按退回处理"};
}

/** 助手提交在结构化结果里：`{<field>, issues?}`，field 按调用种类为 plan、review、rewrite 或 rewriteReview。 */
export function envelope(data: JsonValue | null, field: string):
    Readonly<{ok: true; value: JsonValue; issues: readonly JsonValue[]}> | Readonly<{ok: false; errors: string[]}> {
    if (!isRecord(data) || !(field in data)) return {ok: false, errors: [`没有提交结构化结果的 ${field} 字段`]};
    const issues = data.issues ?? [];
    if (!Array.isArray(issues)) return {ok: false, errors: ["issues 必须是数组"]};
    return {ok: true, value: data[field]!, issues};
}

function renderPlanSummary(plan: ScenePlan): string {
    const forbidden = plan.scenes[0]?.forbidden ?? [];
    return [
        `本章目标约 ${plan.targetWords} 字`,
        ...plan.scenes.map((scene) => [
            `### ${scene.heading}`,
            `- 场景简述：${scene.summary}`,
            `- 人称：${scene.perspective}`,
            `- 目标字数：${scene.targetWords}`,
            `- 必须写到：${scene.mustInclude.join("；")}`,
            `#### 写作手法补充\n${renderMaterial(scene.techniques) || "（无）"}`,
            `#### 背景知识\n${renderMaterial(scene.background) || "（无）"}`,
            renderSupplements(scene.supplements),
        ].join("\n")),
        ...(forbidden.length === 0 ? [] : [`### 禁止事项\n${forbidden.map((item) => `- ${item}`).join("\n")}`]),
    ].join("\n\n");
}

/** 续写沿用的已通过场景，必须与当前细纲切分出的同序场景一致，否则已写正文与规划对不上。 */
function samePassedScenes(previous: readonly PlannedScene[], current: ChapterMaterials["scenes"], passed: number): boolean {
    if (passed > current.length || passed > previous.length) return false;
    return previous.slice(0, passed).every((scene, index) => {
        const next = current[index]!;
        return scene.detailEntryId === next.detailEntryId && scene.heading === next.heading && scene.source === next.source;
    });
}

function emptyPlan(prepared: Prepared): ScenePlan {
    return {planId: prepared.planId, basis: prepared.basis, targetWords: prepared.materials.targetWords, scenes: [], materialVersion: 1};
}

class ChapterRun {
    private readonly chapterEntryId: string;
    private readonly notes: string[] = [];
    private since = "";
    private passed = 0;
    private total: number | null = null;
    private assistantSession: SessionHandle | null = null;

    constructor(private readonly wf: AgentWorkflowContext, private readonly args: WritingRunArgs) {
        this.chapterEntryId = args.chapterEntryId;
    }

    private activity<K extends WritingActivityName>(name: K, input: WritingActivityIO[K]["input"]) {
        return callWritingActivity(this.wf, name, input);
    }

    private async assistant(): Promise<SessionHandle> {
        this.assistantSession ??= await this.wf.agents.create(WRITING_PROFILES.assistant, {
            ...(this.args.ownerSessionId === undefined ? {} : {parent: await this.wf.sessions.open(this.args.ownerSessionId)}),
            tags: [`writing:${this.chapterEntryId}`], ephemeral: true, initial: {chapterEntryId: this.chapterEntryId},
        });
        return this.assistantSession;
    }

    /** 登记失败不中断写作，在报告里说明；返回其中是否有阻断问题。 */
    private async register(drafts: readonly WritingIssueDraft[], registrar: WritingIssueRegistrar): Promise<boolean> {
        if (drafts.length === 0) return false;
        const saved = await this.activity("registerIssues", {chapterEntryId: this.chapterEntryId, drafts, registrar});
        if (!saved.ok) this.notes.push(`问题登记失败：${saved.message}`);
        return saved.ok ? saved.blocking : drafts.some(({severity}) => severity === "blocking");
    }

    private checkDrafts(drafts: readonly JsonValue[], plan: Readonly<{basis: ScenePlan["basis"]}>) {
        return checkIssueDrafts(drafts, new Set([this.chapterEntryId, ...plan.basis.details.map(({entryId}) => entryId)]));
    }

    async run(): Promise<WritingRunResult> {
        try {
            return await this.execute();
        } catch (error) {
            if (!(error instanceof StopRun)) throw error;
            return this.result("stopped", error.reason, error.message, {failedScene: error.failedScene});
        }
    }

    private result(outcome: WritingRunResult["outcome"], reason: WritingStopReason | null, message: string,
        extra: Partial<Pick<WritingRunResult, "failedScene" | "words" | "targetWords" | "withinTarget" | "hints">> = {}): WritingRunResult {
        return {outcome, reason, message, passedScenes: this.passed, totalScenes: this.total, failedScene: extra.failedScene ?? null,
            words: extra.words ?? null, targetWords: extra.targetWords ?? null, withinTarget: extra.withinTarget ?? null,
            hints: extra.hints ?? [], notes: [...this.notes]};
    }

    private async execute(): Promise<WritingRunResult> {
        const {wf, args} = this;
        // 整章编写模式的分支位置：实现时在这里转入整章流程，不复用逐场景循环。
        if (args.granularity === "chapter") throw new StopRun("unsupported", "整章编写模式尚未启用，请按场景写作");
        this.since = await wf.now();
        wf.progress({phase: "planning"});
        const prepared = await this.activity("prepare", {chapterEntryId: this.chapterEntryId, task: args.task});
        if (!prepared.ok) {
            await this.register(prepared.issues, "workflow");
            throw new StopRun(prepared.reason, prepared.message);
        }
        this.total = prepared.materials.scenes.length;
        if (await this.register(prepared.issues, "workflow")) throw new StopRun("blocking-issue", "准备阶段发现阻断问题");

        const resumed = this.resumeFrom(prepared);
        let plan: ScenePlan;
        let replaceBody: boolean;
        if (resumed !== null && resumed.plan.materialVersion === 1 && resumed.plan.planId === prepared.planId && sameWriterChapterBasis(resumed.plan.basis, prepared.basis)
            && await this.activity("materialSourcesCurrent", {chapterEntryId: this.chapterEntryId,
                hashes: Object.assign({}, ...resumed.plan.scenes.slice(resumed.passed).map(scene => scene.sourceHashes ?? {}))})) {
            ({plan, replaceBody} = resumed);
            this.passed = resumed.passed;
            wf.log(`依据未变，从场景 ${this.passed + 1} 继续`);
        } else {
            const kept = resumed?.plan.scenes.slice(0, resumed.passed) ?? [];
            plan = {...emptyPlan(prepared), scenes: kept};
            this.passed = resumed?.passed ?? 0;
            replaceBody = resumed?.replaceBody ?? args.task === "rewrite";
            const rechecked = await this.activity("recheckIssues", {chapterEntryId: this.chapterEntryId, since: this.since});
            if (!rechecked.ok) this.notes.push(`旧问题复核失败：${rechecked.message}`);
        }
        await wf.checkpoint(toJsonValue({plan, passed: this.passed, replaceBody} satisfies WritingProgress));

        for (let index = plan.scenes.length; index < prepared.materials.scenes.length; index += 1) {
            const source = prepared.materials.scenes[index]!;
            wf.progress({phase: "planning", done: index, total: this.total});
            wf.log(`开始规划场景 ${index + 1}/${this.total}「${source.heading}」`);
            const scene = await this.planOneScene(prepared, plan, source);
            plan = {...plan, scenes: [...plan.scenes, scene]};
            await wf.checkpoint(toJsonValue({plan, passed: this.passed, replaceBody} satisfies WritingProgress));
            wf.log(`场景 ${source.index} 规划已通过并保存`);
        }

        for (const scene of plan.scenes.slice(this.passed)) {
            wf.progress({phase: "writing", done: this.passed, total: this.total});
            await this.writeScene(plan, scene, replaceBody);
            this.passed += 1;
            // 整章重写只在第一个场景替换旧正文，之后的场景接在新正文后。
            replaceBody = false;
            await wf.checkpoint(toJsonValue({plan, passed: this.passed, replaceBody} satisfies WritingProgress));
        }

        wf.progress({phase: "finishing", done: this.passed, total: plan.scenes.length});
        const finished = await this.activity("finish", {chapterEntryId: this.chapterEntryId, planId: plan.planId, basis: plan.basis, since: this.since,
            targetWords: plan.targetWords});
        if (finished.status === "changed") {
            await this.register(finished.issues, "workflow");
            throw new StopRun("planning-changed", finished.issues[0]?.message ?? "规划已在写作中变化");
        }
        if (finished.status === "failed") throw new StopRun("write-failed", `写入正文依据失败：${finished.message}`);
        if (finished.hintsError !== null) this.notes.push(`提示问题读取失败：${finished.hintsError}`);
        const deviation = finished.withinTarget ? null : `整章 ${finished.words} 字，不足细纲目标 ${finished.targetWords} 字的 70%`;
        if (deviation !== null) this.notes.push(deviation);
        return this.result("completed", null, `全部 ${prepared.materials.scenes.length} 个场景已通过`, {
            words: finished.words, targetWords: finished.targetWords, withinTarget: finished.withinTarget, hints: [...finished.hints ?? []],
        });
    }

    /**
     * 续写时依据已变：重新规划，但已通过的场景仍须与当前切分一致，否则停止，由用户决定是否整章重写。
     * 依据未变时交接内容相同，沿用上次规划。
     */
    private resumeFrom(prepared: Prepared): WritingProgress | null {
        const resume = this.args.resume;
        if (resume === undefined) return null;
        if (this.args.task === "rewrite") {
            return {plan: resume.plan, passed: 0, replaceBody: true};
        }
        if (!samePassedScenes(resume.plan.scenes, prepared.materials.scenes, resume.passed)) {
            throw new StopRun("resume-mismatch", "细纲在停止期间已修改，已通过的场景与当前场景不再对应；如需按新细纲写作，请整章重写");
        }
        return resume;
    }

    private async planOneScene(prepared: Prepared, currentPlan: ScenePlan, source: ChapterMaterials["scenes"][number]): Promise<PlannedScene> {
        const {wf} = this;
        const assistant = await this.assistant();
        let invalid = 0;
        let rejected = 0;
        let materialRejected = 0;
        let feedback: Readonly<{errors?: readonly string[]; comments?: string}> = {};
        for (;;) {
            const reply = await assistant.invoke({
                message: `请按场景规划（结构 A）只填写当前场景 ${source.index}「${source.heading}」归助手的字段，不要规划其它场景。`,
                input: toJsonValue({kind: "plan-scenes", chapterEntryId: this.chapterEntryId,
                    sceneIndex: source.index,
                    plannedScenes: currentPlan.scenes.map(({index, heading, summary, ending}) => ({index, heading, summary, ending})),
                    sceneRoster: prepared.materials.scenes.map(({index, heading, summary, ending}) => ({index, heading, summary, ending})),
                    materials: {...prepared.materials, scenes: [source]},
                    supplementContract: MATERIAL_SUPPLEMENT_CONTRACT,
                    planId: prepared.planId, acceptedProse: prepared.acceptedProse, previousEnding: prepared.previousEnding,
                    referencePaths: prepared.referencePaths, feedback}),
            });
            const submitted = envelope(reply.status === "completed" ? reply.result.data : null, "plan");
            const drafts = submitted.ok ? this.checkDrafts(submitted.issues, prepared) : null;
            const validation = submitted.ok && drafts?.ok ? await this.activity("validatePlan", {
                chapterEntryId: this.chapterEntryId, planId: prepared.planId, basis: prepared.basis, submission: submitted.value,
                sceneIndices: [source.index],
            }) : null;
            if (validation?.status === "changed") {
                await this.register(validation.issues, "workflow");
                throw new StopRun("planning-changed", validation.issues[0]?.message ?? "规划已在写作中变化");
            }
            if (validation?.status === "unavailable") throw new StopRun("unavailable", validation.message);
            const errors = !submitted.ok ? submitted.errors : drafts && !drafts.ok ? drafts.errors
                : validation?.status === "invalid" ? validation.errors : [];
            if (validation?.status !== "valid" || !drafts?.ok) {
                invalid += 1;
                wf.log(`场景规划校验未通过（第 ${invalid} 次）：${errors.join("；")}`);
                if (invalid >= PLAN_SUBMISSION_LIMIT) throw new StopRun("plan-invalid", `场景规划 ${invalid} 次未通过程序校验：${errors.join("；")}`);
                feedback = {errors};
                continue;
            }
            const plan = validation.plan;
            const planned = plan.scenes[0];
            if (planned === undefined) throw new StopRun("plan-invalid", "场景规划校验通过但没有返回当前场景");
            const blocking = [
                await this.register(validation.issues, "workflow"),
                await this.register(drafts.drafts, "assistant"),
            ].some(Boolean);
            if (blocking) throw new StopRun("blocking-issue", "场景规划中登记了阻断问题");
            wf.progress({phase: "material-review"});
            const audit = await reviewWritingMaterials(wf, {chapterEntryId: this.chapterEntryId, ownerSessionId: this.args.ownerSessionId,
                draft: toJsonValue({materials: {...prepared.materials, scenes: [source]}, plan, planId: prepared.planId,
                    acceptedProse: prepared.acceptedProse, previousEnding: prepared.previousEnding})});
            if (!audit.ok) throw new StopRun("material-review-invalid", `资料审核 ${REVIEW_SUBMISSION_LIMIT} 次提交无效：${audit.errors.join("；")}`);
            if (!audit.review.passed) {
                materialRejected += 1;
                wf.log(`资料补充稿被独立审核退回（第 ${materialRejected} 次）`);
                if (materialRejected >= MATERIAL_REJECTION_LIMIT) throw new StopRun("material-rejected", `资料稿 ${materialRejected} 次未通过审核：${audit.review.problems.join("；")}`);
                feedback = {errors: audit.review.problems};
                wf.progress({phase: "planning"});
                continue;
            }
            wf.progress({phase: "planning"});
            const review = this.args.mode === "auto" ? {approved: true, comments: null} : await this.reviewPlan(plan, rejected + 1);
            if (review.approved) return planned;
            rejected += 1;
            if (rejected >= PLAN_REJECTION_LIMIT) throw new StopRun("plan-rejected", `场景规划被退回 ${rejected} 次`);
            feedback = review.comments === null ? {} : {comments: review.comments};
        }
    }

    /** 主创核对；讨论模式在主创通过后再交用户确认，用户退回同样计入退回次数。 */
    private async reviewPlan(plan: ScenePlan, round: number): Promise<Readonly<{approved: boolean; comments: string | null}>> {
        const description = renderPlanSummary(plan);
        const lead = parseApproval(await this.wf.ask({kind: "approve", title: `${LEAD_REVIEW_TITLE}（第 ${round} 轮）`, description}));
        if (!lead.approved || this.args.mode !== "discussion") return lead;
        return parseApproval(await this.wf.ask({kind: "approve", title: `${USER_CONFIRM_TITLE}（第 ${round} 轮）`, description}));
    }

    private async writeScene(plan: ScenePlan, scene: PlannedScene, replaceBody: boolean): Promise<void> {
        const {wf} = this;
        let problems: readonly string[] = [];
        for (let attempt = 0; attempt <= SCENE_REWRITE_LIMIT; attempt += 1) {
            const context = await this.activity("sceneContext", {chapterEntryId: this.chapterEntryId, planId: plan.planId, basis: plan.basis,
                scene, replaceBody, retryProblems: problems});
            if (context.status === "changed") {
                await this.register(context.issues, "workflow");
                throw new StopRun("planning-changed", context.issues[0]?.message ?? "规划已在写作中变化");
            }
            if (context.status === "source-unreadable") {
                await this.register(context.issues, "workflow");
                throw new StopRun("source-unreadable", context.issues[0]?.message ?? "文风或参考文件已不可读");
            }
            if (context.status === "unavailable") throw new StopRun("unavailable", context.message);
            // 写手每次都是全新上下文，只看到渲染好的提示：系统提示随会话初始值进入 Profile，用户提示作为消息。
            const writer = await wf.agents.create(WRITING_PROFILES.writer, {
                ...(this.args.ownerSessionId === undefined ? {} : {parent: await this.assistant()}),
                tags: [`writing:${this.chapterEntryId}`], ephemeral: true, initial: {system: context.prompt.system,
                    ...(this.args.ownerSessionId !== undefined && context.prompt.managed ? {managedPurposeId: context.prompt.managed.purposeId, managedVariables: context.prompt.managed.variables} : {})},
            });
            const written = await writer.invoke({message: context.prompt.user});
            const output = written.status === "completed" ? written.result.message.trim() : "";
            const actualPrompt = this.args.ownerSessionId === undefined ? {system: context.prompt.system, user: context.prompt.user}
                : await this.activity("effectiveWriterPrompt", {sessionId: writer.id, fallback: context.prompt});
            const review = output === "" ? null : await this.reviewScene(plan, scene, actualPrompt, output);
            const judgement = judgeScene({review, output, targetWords: scene.targetWords});
            wf.log(`场景 ${scene.index} 第 ${attempt + 1} 次：${judgement.passed ? "通过" : `未通过（${judgement.problems.join("；")}）`}`);
            if (judgement.passed) {
                if (!await this.activity("materialSourcesCurrent", {chapterEntryId: this.chapterEntryId, hashes: scene.sourceHashes ?? {}})) {
                    throw new StopRun("source-unreadable", "资料来源在正文生成期间变化，本场景未写入，请重新补充与审核");
                }
                const accepted = await this.activity("acceptScene", {chapterEntryId: this.chapterEntryId,
                    mode: replaceBody ? "replace" : "append", baseHash: context.proseHash, text: output});
                if (accepted.status === "conflict") throw new StopRun("prose-changed", "正文在写作期间被修改，本场景未写入");
                if (accepted.status === "failed") throw new StopRun("write-failed", `写入正文失败，本场景未通过：${accepted.message}`);
                return;
            }
            problems = judgement.problems;
        }
        throw new StopRun("scene-failed", `场景 ${scene.index}「${scene.heading}」重写 ${SCENE_REWRITE_LIMIT} 次仍未通过`,
            {index: scene.index, heading: scene.heading, problems: [...problems]});
    }

    private async reviewScene(plan: ScenePlan, scene: PlannedScene, prompt: Readonly<{system: string; user: string}>, output: string):
        Promise<SceneReviewSubmission> {
        const assistant = await this.assistant();
        let errors: readonly string[] = [];
        for (let attempt = 1; attempt <= REVIEW_SUBMISSION_LIMIT; attempt += 1) {
            const reply = await assistant.invoke({
                message: `请审阅场景 ${scene.index} 的写手产出，提交审阅结果（结构 C）。`,
                // 伏笔的作用不进写手提示，只在这里交给助手核对产出没有提前点明。
                input: toJsonValue({kind: "review-scene", sceneIndex: scene.index, prompt, output,
                    foreshadowing: scene.foreshadowing.map(({action, text, purpose, effect}) => ({action, text, purpose, effect})),
                    feedback: {errors}}),
            });
            const submitted = envelope(reply.status === "completed" ? reply.result.data : null, "review");
            const drafts = submitted.ok ? this.checkDrafts(submitted.issues, plan) : null;
            const review = submitted.ok && drafts?.ok ? validateSceneReview(submitted.value, scene) : null;
            if (review?.ok && drafts?.ok) {
                if (await this.register(drafts.drafts, "assistant")) throw new StopRun("blocking-issue", `审阅场景 ${scene.index} 时登记了阻断问题`);
                return review.value;
            }
            errors = !submitted.ok ? submitted.errors : drafts && !drafts.ok ? drafts.errors : review && !review.ok ? review.errors : [];
            this.wf.log(`场景 ${scene.index} 审阅结果校验未通过（第 ${attempt} 次）：${errors.join("；")}`);
        }
        throw new StopRun("review-invalid", `场景 ${scene.index} 的审阅结果 ${REVIEW_SUBMISSION_LIMIT} 次未通过校验：${errors.join("；")}`);
    }
}

/**
 * 整章写作工作流。manifestHash 固定：已落盘的运行记录按它找回定义重放，
 * 步骤顺序或 Activity 调用方式变化会让旧记录无法重放，届时必须升 version 与 manifestHash。
 * 参数与结果随运行记录以 JSON 重放，定义按 JsonValue 注册，领域类型只在 run 的入口出口转换。
 */
export const writingChapterWorkflow: AgentWorkflowDefinition = {
    key: WRITING_WORKFLOW_KEY,
    version: "6",
    manifestHash: "writing.chapter@6",
    requires: {durability: "durable", processRestart: true},
    phases: [
        {key: "planning", title: "场景规划"},
        {key: "material-review", title: "资料审核"},
        {key: "writing", title: "逐场景写作"},
        {key: "finishing", title: "写入依据"},
    ],
    run: async (wf, args) => toJsonValue(await new ChapterRun(wf, fromJsonValue<WritingRunArgs>(args)).run()),
};
