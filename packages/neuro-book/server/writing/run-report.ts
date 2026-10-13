import type {PendingAsk} from "@notnotype/nb-workflow";
import type {NeuroAgentHarness} from "nbook/server/agent/harness/neuro-agent-harness";
import {AgentJobCancelledError, type SpawnedAgentJob} from "nbook/server/agent/jobs/agent-job-manager";
import type {JsonValue} from "nbook/server/agent/messages/types";
import {askRole} from "./run-progress";
import type {RewriteRunSummary, WritingRunService, WritingRunSummary} from "./run-service";

const RUN_STATUS: Record<WritingRunSummary["status"], string> = {
    running: "运行中",
    waiting: "等待应答",
    completed: "已结束",
    failed: "失败",
    cancelled: "已停止",
};

const ASK_GUIDE = {
    "rewrite-confirm": "这是替换前的用户确认：把上面的新旧对照交给用户，只按用户明确的替换或放弃决定调用 answer_rewrite，不要替用户决定。",
    "user-confirm": "这是讨论模式的用户确认：把上面的场景规划交给用户，按用户明确的通过或退回意见调用 answer_scene_plan，不要替用户决定。",
    "lead-review": "请核对这份场景规划，通过或带意见退回时调用 answer_scene_plan。",
} as const;

function describeAsk(ask: PendingAsk): string[] {
    return [`待应答：${ask.spec.title}`, ask.spec.description ?? "", ASK_GUIDE[askRole(ask.spec.title)]].filter((line) => line !== "");
}

function describeRewriteResult(summary: RewriteRunSummary): string[] {
    const result = summary.result;
    if (result === null) return [];
    const lines = [result.outcome === "stopped" ? `改写停止：${result.message}` : `改写${result.outcome === "replaced" ? "完成" : "放弃"}：${result.message}`];
    if (result.problems.length > 0) lines.push("最后一次未通过的问题：", ...result.problems.map((problem) => `- ${problem}`));
    if (result.notes.length > 0) lines.push("说明：", ...result.notes.map((note) => `- ${note}`));
    return lines;
}

/** 一段运行停下后交给主创的报告：等待应答时附规划概要或新旧对照，结束时附结果与提示。 */
export async function describeRun(service: WritingRunService, summary: WritingRunSummary, chapterTitle: string): Promise<string> {
    const what = summary.kind === "rewrite" ? "改写运行" : "写作运行";
    const lines = [`${chapterTitle} ${what} ${summary.runId}：${RUN_STATUS[summary.status]}${summary.interrupted ? "（进程曾中断，可续写）" : ""}`];
    if (summary.kind === "rewrite") lines.push(`修改要求：${summary.requirement}`);
    if (summary.kind === "chapter" && summary.progress) lines.push(`进度：已通过 ${summary.progress.passed}/${summary.progress.plan.scenes.length} 个场景`);
    if (summary.status === "waiting") {
        for (const ask of (await service.view(summary.runId)).pendingAsks) lines.push(...describeAsk(ask));
    }
    if (summary.kind === "rewrite") {
        lines.push(...describeRewriteResult(summary));
        if (summary.error) lines.push(`错误：${summary.error}`);
        return lines.join("\n");
    }
    const result = summary.result;
    if (result) {
        lines.push(result.outcome === "completed" ? `写作完成：${result.message}` : `写作停止：${result.message}`);
        lines.push(`通过场景：${result.passedScenes}/${result.totalScenes ?? "?"}`);
        if (result.words !== null) {
            lines.push(`字数：${result.words}${result.targetWords === null ? "" : `（目标 ${result.targetWords}，${result.withinTarget ? "在范围内" : "超出范围"}）`}`);
        }
        if (result.failedScene) {
            lines.push(`未通过场景 ${result.failedScene.index}「${result.failedScene.heading}」：`, ...result.failedScene.problems.map((problem) => `- ${problem}`));
        }
        if (result.hints.length > 0) lines.push("提示：", ...result.hints.map((hint) => `- ${hint.message}`));
        if (result.notes.length > 0) lines.push("说明：", ...result.notes.map((note) => `- ${note}`));
    }
    if (summary.error) lines.push(`错误：${summary.error}`);
    return lines.join("\n");
}

/**
 * 运行在后台推进，停在等待应答、结束、停止或失败时把报告交回 ownerSessionId 所在的主创会话。
 * 主创工具与界面操作都经这里，所以无论谁推进运行，报告都回到这一章的主创。
 * ref 不用 runId/workflowKey 字段：那一组字段表示演示工作流运行，会被 Workflow 待应答面板接管。
 */
export function trackWritingRun(input: Readonly<{
    harness: NeuroAgentHarness;
    ownerSessionId: number;
    originToolCallId?: string;
    service: WritingRunService;
    summary: WritingRunSummary;
    chapterTitle: string;
    /** 用户在界面上的操作；报告开头据此告诉主创是谁推进了运行。 */
    userAction?: string;
}>): SpawnedAgentJob {
    const {service, summary, chapterTitle} = input;
    const what = summary.kind === "rewrite" ? "改写运行" : "写作运行";
    return input.harness.jobs.spawn({
        kind: "workflow",
        title: `${summary.kind === "rewrite" ? "改写" : "写作"} ${chapterTitle}`,
        ownerSessionId: input.ownerSessionId,
        ...(input.originToolCallId === undefined ? {} : {originToolCallId: input.originToolCallId}),
        ref: {writingRunId: summary.runId, chapterEntryId: summary.chapterEntryId},
        onCancel: async () => {
            await service.stop(summary.runId);
        },
        run: async (ctx) => {
            const settled = await service.settle(summary.runId);
            if (ctx.signal.aborted || settled.status === "cancelled") throw new AgentJobCancelledError(`${what}已停止`);
            if (settled.status === "failed") throw new Error(`${what}失败：${settled.error ?? "未知错误"}（可调用 continue_writing 续写）`);
            const report = await describeRun(service, settled, chapterTitle);
            const action = input.userAction === undefined ? "" : `用户在写作视图中${input.userAction}。\n`;
            return {resultPreview: report.split("\n")[0]!, result: settled as unknown as JsonValue, message: `[写作运行报告]\n${action}${report}`};
        },
    });
}
