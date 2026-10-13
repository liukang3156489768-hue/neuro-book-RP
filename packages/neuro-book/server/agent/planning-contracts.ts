import type {OperationActor} from "@notnotype/nb-history";
import type {JsonValue} from "nbook/server/agent/messages/types";

/** 规划 Agent 的正式操作审计记录；正文内容只以摘要或 ID 进入会话历史。 */
export type PlanningAuditRecord = Readonly<{
    schema: "nbook.outline-agent-audit/v1";
    operationId: string;
    phase: "preview" | "apply" | "undo";
    suggestionId?: string;
    projectGeneration: number;
    manifestRevision: number;
    targetIds: readonly string[];
    beforeHash?: string;
    afterHash?: string;
    mode: "discuss" | "auto" | "unknown";
    actor: OperationActor;
    approvalDecision: "approved" | "rejected" | "not-required";
    result: "previewed" | "applied" | "failed" | "partial" | "undone";
    transactionId?: string;
    error?: string;
}>;

export type PlanningAuditInput = Omit<PlanningAuditRecord, "schema">;

export function createPlanningAuditRecord(input: PlanningAuditInput): PlanningAuditRecord {
    return {schema: "nbook.outline-agent-audit/v1", ...input};
}
/** 可进入待审阅列表的规划变更建议；不代表已经写入规范文件。 */
export type PlanningChangeProposal = Readonly<{
    proposalId: string;
    operation: "mutate" | "delete-object" | "remove-placement" | "delete-plan";
    expectedRevision: number;
    targetIds: readonly string[];
    impact?: JsonValue;
}>;

/** 结构检查与语义分析共用的冲突报告，不携带正文原文。 */
export type PlanningConflictReport = Readonly<{
    status: "clear" | "warning" | "blocked";
    conflicts: readonly Readonly<{
        code: string;
        severity: "info" | "warning" | "error";
        message: string;
        targetIds: readonly string[];
    }>[];
    sourceRevision: number;
    generatedAt: string;
}>;

/** 伏笔建议只描述来源和建议动作，必须经用户确认后才会成为正式标记。 */
export type ForeshadowingSuggestion = Readonly<{
    suggestionId: string;
    foreshadowingId?: string;
    action: "create" | "plant" | "strengthen" | "resolve" | "repair";
    sourceEntryIds: readonly string[];
    rationale: string;
    confidence?: number;
}>;
