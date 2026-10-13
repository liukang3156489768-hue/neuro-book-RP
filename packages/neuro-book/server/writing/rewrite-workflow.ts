import type {AgentWorkflowContext, AgentWorkflowDefinition, SessionHandle} from "@notnotype/nb-workflow";
import type {WritingIssueDraft} from "nbook/shared/dto/writing.dto";
import {checkIssueDrafts} from "./issues";
import {REWRITE_CONFIRM_TITLE, type ParagraphRange, type RewriteTarget} from "./rewrite";
import {MATERIAL_SUPPLEMENT_CONTRACT, renderRewritePrompt, validateRewriteReview, type RewritePlan, type RewriteReviewSubmission, type WriterPrompt} from "./structures";
import {callWritingActivity, fromJsonValue, toJsonValue, type WritingActivityIO, type WritingActivityName} from "./workflow-activities";
import {envelope, parseApproval, PLAN_SUBMISSION_LIMIT, REVIEW_SUBMISSION_LIMIT, WRITING_PROFILES} from "./writing-workflow";
import {MATERIAL_REJECTION_LIMIT, reviewWritingMaterials} from "./material-review";

export const REWRITE_WORKFLOW_KEY = "writing.rewrite";

/** 改写首写之外最多重写的次数，见 writing.collaboration 结构 D。 */
export const REWRITE_RETRY_LIMIT = 2;

export type RewriteRunArgs = Readonly<{
    chapterEntryId: string;
    ownerSessionId?: number;
    target: RewriteTarget;
    /** 主创整理的用户修改要求，助手据此填写结构 D 的修改要求。 */
    requirement: string;
}>;

export type RewriteStopReason =
    | "unavailable" | "style" | "no-prose" | "target" | "plan-invalid" | "review-invalid" | "blocking-issue" | "rewrite-failed"
    | "target-changed" | "write-failed" | "material-review-invalid" | "material-rejected" | "source-unreadable";

/** 写进运行记录，必须可 JSON 往返，所以不用可选字段。 */
export type RewriteRunResult = {
    outcome: "replaced" | "discarded" | "stopped";
    reason: RewriteStopReason | null;
    message: string;
    range: ParagraphRange | null;
    original: string | null;
    replacement: string | null;
    /** 重写次数用尽时最后一次的问题清单。 */
    problems: string[];
    notes: string[];
};

type Prepared = Extract<WritingActivityIO["prepareRewrite"]["output"], {ok: true}>;

class StopRewrite {
    constructor(readonly reason: RewriteStopReason, readonly message: string, readonly problems: readonly string[] = []) {}
}

function rangeLabel(range: ParagraphRange): string {
    return range.from === range.to ? `第 ${range.from} 段` : `第 ${range.from}–${range.to} 段`;
}

export function renderRewriteComparison(range: ParagraphRange, original: string, replacement: string): string {
    return [`### 原文（${rangeLabel(range)}）`, original, "### 改写", replacement].join("\n\n");
}

class RewriteRun {
    private readonly chapterEntryId: string;
    private readonly notes: string[] = [];
    private range: ParagraphRange | null = null;
    private original: string | null = null;
    private replacement: string | null = null;
    private assistantSession: SessionHandle | null = null;

    constructor(private readonly wf: AgentWorkflowContext, private readonly args: RewriteRunArgs) {
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

    /** 登记失败不中断改写，在报告里说明；返回其中是否有阻断问题。 */
    private async register(drafts: readonly WritingIssueDraft[]): Promise<boolean> {
        if (drafts.length === 0) return false;
        const saved = await this.activity("registerIssues", {chapterEntryId: this.chapterEntryId, drafts, registrar: "assistant"});
        if (!saved.ok) this.notes.push(`问题登记失败：${saved.message}`);
        return saved.ok ? saved.blocking : drafts.some(({severity}) => severity === "blocking");
    }

    private result(outcome: RewriteRunResult["outcome"], reason: RewriteStopReason | null, message: string,
        problems: readonly string[] = []): RewriteRunResult {
        return {outcome, reason, message, range: this.range, original: this.original, replacement: this.replacement,
            problems: [...problems], notes: [...this.notes]};
    }

    async run(): Promise<RewriteRunResult> {
        try {
            return await this.execute();
        } catch (error) {
            if (!(error instanceof StopRewrite)) throw error;
            return this.result("stopped", error.reason, error.message, error.problems);
        }
    }

    private async execute(): Promise<RewriteRunResult> {
        const {wf} = this;
        wf.progress({phase: "planning"});
        const prepared = await this.activity("prepareRewrite", {chapterEntryId: this.chapterEntryId, target: this.args.target});
        if (!prepared.ok) throw new StopRewrite(prepared.reason, prepared.message);
        this.range = prepared.located.range;
        this.original = prepared.located.window.target;
        const plan = await this.planRewrite(prepared);

        let problems: readonly string[] = [];
        for (let attempt = 0; attempt <= REWRITE_RETRY_LIMIT && this.replacement === null; attempt += 1) {
            if (!await this.activity("materialSourcesCurrent", {chapterEntryId: this.chapterEntryId, hashes: plan.sourceHashes ?? {}})) {
                throw new StopRewrite("source-unreadable", "补充资料来源已变化，请重新发起改写以补充和审核资料");
            }
            wf.progress({phase: "writing", done: attempt, total: REWRITE_RETRY_LIMIT + 1});
            const prompt = renderRewritePrompt({style: prepared.style, window: prepared.located.window, plan, retryProblems: problems});
            // 写手每次都是全新上下文，与整章写作相同。
            const writer = await wf.agents.create(WRITING_PROFILES.writer, {
                ...(this.args.ownerSessionId === undefined ? {} : {parent: await this.assistant()}),
                tags: [`writing:${this.chapterEntryId}`], ephemeral: true, initial: {system: prompt.system,
                    ...(this.args.ownerSessionId !== undefined && prompt.managed ? {managedPurposeId: prompt.managed.purposeId, managedVariables: prompt.managed.variables} : {})},
            });
            const written = await writer.invoke({message: prompt.user});
            const output = written.status === "completed" ? written.result.message.trim() : "";
            const actualPrompt = this.args.ownerSessionId === undefined ? {system: prompt.system, user: prompt.user}
                : await this.activity("effectiveWriterPrompt", {sessionId: writer.id, fallback: prompt});
            const review = output === "" ? null : await this.reviewRewrite(plan, actualPrompt, output, prepared);
            const passed = review?.passed === true;
            problems = review === null ? ["写手输出为空"] : review.problems;
            wf.log(`改写第 ${attempt + 1} 次：${passed ? "通过" : `未通过（${problems.join("；")}）`}`);
            if (passed) this.replacement = output;
        }
        if (this.replacement === null) {
            throw new StopRewrite("rewrite-failed", `改写重写 ${REWRITE_RETRY_LIMIT} 次仍未通过审阅`, problems);
        }

        wf.progress({phase: "confirming"});
        const answer = parseApproval(await wf.ask({kind: "approve", title: REWRITE_CONFIRM_TITLE,
            description: renderRewriteComparison(this.range, this.original, this.replacement)}));
        if (!answer.approved) return this.result("discarded", null, "用户放弃了改写，正文未改动");
        if (!await this.activity("materialSourcesCurrent", {chapterEntryId: this.chapterEntryId, hashes: plan.sourceHashes ?? {}})) {
            throw new StopRewrite("source-unreadable", "资料来源在改写期间变化，正文未替换，请重新补充与审核");
        }
        const replaced = await this.activity("replaceRewrite", {chapterEntryId: this.chapterEntryId, range: this.range,
            target: this.original, replacement: this.replacement});
        if (replaced.status === "target-changed") throw new StopRewrite("target-changed", replaced.message);
        if (replaced.status === "failed") throw new StopRewrite("write-failed", `替换正文失败：${replaced.message}`);
        return this.result("replaced", null, `已替换${rangeLabel(this.range)}`);
    }

    private async planRewrite(prepared: Prepared): Promise<RewritePlan> {
        const assistant = await this.assistant();
        let errors: readonly string[] = [];
        let invalid = 0;
        let rejected = 0;
        for (;;) {
            const reply = await assistant.invoke({
                message: "请按改写提示（结构 D）填写归助手的字段。",
                input: toJsonValue({kind: "plan-rewrite", requirement: this.args.requirement, window: prepared.located.window,
                    supplementContract: MATERIAL_SUPPLEMENT_CONTRACT,
                    guidance: prepared.guidance, referencePaths: prepared.referencePaths, feedback: {errors}}),
            });
            const submitted = envelope(reply.status === "completed" ? reply.result.data : null, "rewrite");
            const drafts = submitted.ok ? checkIssueDrafts(submitted.issues, new Set(prepared.entryIds)) : null;
            const validation = submitted.ok && drafts?.ok
                ? await this.activity("validateRewritePlan", {chapterEntryId: this.chapterEntryId, submission: submitted.value}) : null;
            if (validation?.status === "unavailable") throw new StopRewrite("unavailable", validation.message);
            if (validation?.status === "valid" && drafts?.ok) {
                if (await this.register(drafts.drafts)) throw new StopRewrite("blocking-issue", "改写规划中登记了阻断问题");
                this.wf.progress({phase: "material-review"});
                const audit = await reviewWritingMaterials(this.wf, {chapterEntryId: this.chapterEntryId, ownerSessionId: this.args.ownerSessionId,
                    draft: toJsonValue({requirement: this.args.requirement, window: prepared.located.window, guidance: prepared.guidance, plan: validation.plan})});
                if (!audit.ok) throw new StopRewrite("material-review-invalid", `资料审核提交无效：${audit.errors.join("；")}`);
                if (!audit.review.passed) {
                    rejected += 1;
                    if (rejected >= MATERIAL_REJECTION_LIMIT) throw new StopRewrite("material-rejected", "改写资料稿连续三次未通过独立审核", audit.review.problems);
                    errors = audit.review.problems;
                    this.wf.progress({phase: "planning"});
                    continue;
                }
                return validation.plan;
            }
            errors = !submitted.ok ? submitted.errors : drafts && !drafts.ok ? drafts.errors
                : validation?.status === "invalid" ? validation.errors : [];
            invalid += 1;
            this.wf.log(`改写规划校验未通过（第 ${invalid} 次）：${errors.join("；")}`);
            if (invalid >= PLAN_SUBMISSION_LIMIT) break;
        }
        throw new StopRewrite("plan-invalid", `改写规划 ${PLAN_SUBMISSION_LIMIT} 次未通过程序校验：${errors.join("；")}`);
    }

    private async reviewRewrite(plan: RewritePlan, prompt: WriterPrompt, output: string, prepared: Prepared): Promise<RewriteReviewSubmission> {
        const assistant = await this.assistant();
        let errors: readonly string[] = [];
        for (let attempt = 1; attempt <= REVIEW_SUBMISSION_LIMIT; attempt += 1) {
            const reply = await assistant.invoke({
                message: "请审阅改写结果是否满足修改要求，提交改写审阅结果。",
                input: toJsonValue({kind: "review-rewrite", requirement: plan.requirement, prompt, output, feedback: {errors}}),
            });
            const submitted = envelope(reply.status === "completed" ? reply.result.data : null, "rewriteReview");
            const drafts = submitted.ok ? checkIssueDrafts(submitted.issues, new Set(prepared.entryIds)) : null;
            const review = submitted.ok && drafts?.ok ? validateRewriteReview(submitted.value) : null;
            if (review?.ok && drafts?.ok) {
                if (await this.register(drafts.drafts)) throw new StopRewrite("blocking-issue", "审阅改写时登记了阻断问题");
                return review.value;
            }
            errors = !submitted.ok ? submitted.errors : drafts && !drafts.ok ? drafts.errors : review && !review.ok ? review.errors : [];
            this.wf.log(`改写审阅结果校验未通过（第 ${attempt} 次）：${errors.join("；")}`);
        }
        throw new StopRewrite("review-invalid", `改写审阅结果 ${REVIEW_SUBMISSION_LIMIT} 次未通过校验：${errors.join("；")}`);
    }
}

/**
 * 局部改写工作流。manifestHash 固定的理由与 writing.chapter 相同：
 * 步骤顺序或 Activity 调用方式变化时必须升 version 与 manifestHash。
 */
export const writingRewriteWorkflow: AgentWorkflowDefinition = {
    key: REWRITE_WORKFLOW_KEY,
    version: "4",
    manifestHash: "writing.rewrite@4",
    requires: {durability: "durable", processRestart: true},
    phases: [
        {key: "planning", title: "改写规划"},
        {key: "material-review", title: "资料审核"},
        {key: "writing", title: "改写与审阅"},
        {key: "confirming", title: "确认替换"},
    ],
    run: async (wf, args) => toJsonValue(await new RewriteRun(wf, fromJsonValue<RewriteRunArgs>(args)).run()),
};

