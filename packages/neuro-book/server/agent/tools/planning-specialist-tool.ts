import {Type} from "typebox";
import type {Static} from "typebox";
import {normalizeToolResultDetails} from "nbook/server/agent/messages/message-utils";
import type {JsonValue} from "nbook/server/agent/messages/types";
import type {AgentInvocationResult, AgentSummary} from "nbook/server/agent/harness/types";
import type {NeuroAgentTool, NeuroToolResult, ToolExecutionContext} from "nbook/server/agent/tools/types";
import {withPlanningWriteGrant} from "nbook/server/agent/tools/planning-delegation";

export const PLANNING_SPECIALIST_PROFILE_KEYS = {
    outline: "outline.outline",
    detailed: "outline.detailed",
    foreshadowing: "outline.foreshadowing",
} as const;

type PlanningSpecialist = keyof typeof PLANNING_SPECIALIST_PROFILE_KEYS;

const SPECIALIST_TITLES: Record<PlanningSpecialist, string> = {
    outline: "outline（大纲专家）",
    detailed: "Detailed outline（细纲专家）",
    foreshadowing: "foreshadowing（伏笔专家）",
};

// 专家只做建议；限定唯一委派方，才能保证规划写入仍只经过规划助手的审批边界，并阻断专家间递归委派。
const PLANNER_PROFILE_KEY = "outline.planner";

const ConsultSchema = Type.Object({
    specialist: Type.Union([Type.Literal("outline"), Type.Literal("detailed"), Type.Literal("foreshadowing")], {
        description: "outline: 总纲/卷纲/章节大纲骨架、方案与已有伏笔的使用安排；detailed: 细纲；foreshadowing: 伏笔设计与埋设/回收建议。",
    }),
    brief: Type.String({minLength: 1, maxLength: 20000, description: "交给专家的问题与已知背景；写清目标、约束和用户意图。"}),
    targetIds: Type.Optional(Type.Array(Type.String({pattern: "^(ol|fo|ln|nd|fm)-[a-z0-9][a-z0-9-]*$"}), {
        maxItems: 128,
        description: "可选：本次咨询聚焦的大纲、伏笔或线路对象 id。",
    })),
}, {additionalProperties: false});

type ConsultInput = Static<typeof ConsultSchema>;

export function createPlanningSpecialistTool(): NeuroAgentTool {
    return {
        key: "consult_planning_specialist",
        name: "consult_planning_specialist",
        label: "咨询规划专家",
        description: "Ask a planning specialist sub-agent (outline, detailed, foreshadowing) for an advisory report. In a consultation the specialist only reads and previews; it cannot write. Returned proposals must be verified and applied by you via apply_planning_change after the required user approval. To have the specialist produce and save entries itself, use delegate_planning_task.",
        parameters: ConsultSchema,
        // 同一专家 session 的查找/创建与调用不能并发，否则会重复创建子 Agent 或撞上 active invocation。
        executionMode: "sequential",
        mutatesWorkspace: false,
        executeWithContext: (context, toolCallId, raw, _userInput, signal) =>
            runSpecialist(context, toolCallId, raw as ConsultInput, false, signal),
    };
}

/**
 * 专家是最终条目的产出者：委派期间它可以直接写规划模块和 lorebook/。
 * 声明 mutatesWorkspace 让 harness 在讨论模式下先请用户批准这次委派（任务范围即 brief），
 * 自动模式则直接执行；删除和线路操作不在专家写入范围内，仍由规划助手预览并审核。
 */
export function createPlanningDelegationTool(): NeuroAgentTool {
    return {
        key: "delegate_planning_task",
        name: "delegate_planning_task",
        label: "委派规划专家产出",
        description: "Delegate a production task to a planning specialist (outline, detailed, foreshadowing). During this call the specialist may create and edit planning entries (no deletions, no line-planning actions) and read/write lorebook/ files within the brief's scope. In discuss mode the user approves this delegation first, so state the exact scope in brief. Report the returned applied changes and transaction ids to the user.",
        parameters: ConsultSchema,
        executionMode: "sequential",
        mutatesWorkspace: true,
        executeWithContext: (context, toolCallId, raw, _userInput, signal) =>
            runSpecialist(context, toolCallId, raw as ConsultInput, true, signal),
    };
}

async function runSpecialist(
    context: ToolExecutionContext,
    toolCallId: string,
    input: ConsultInput,
    write: boolean,
    signal: AbortSignal | undefined,
): Promise<NeuroToolResult> {
    const toolKey = write ? "delegate_planning_task" : "consult_planning_specialist";
    if (context.profileKey !== PLANNER_PROFILE_KEY) {
        throw new Error(`${toolKey} 只能由规划助手调用；规划专家和其他 Agent 不能再委派规划专家。`);
    }
    if (!context.currentProject) throw new Error("规划 Agent 必须绑定当前 ready Project");
    const profileKey = PLANNING_SPECIALIST_PROFILE_KEYS[input.specialist];
    const projectRoot: string = context.currentProject.workspace.ref.projectRoot;
    const sessionId = await resolveSpecialistSession(context, input.specialist, profileKey, projectRoot);
    const modelKey = await plannerModelKey(context);
    const invoke = () => context.harness.invokeAgent({
        sessionId,
        mode: "prompt",
        message: {text: renderBrief(input, write)},
        ...(modelKey ? {modelKey} : {}),
        caller: {kind: "agent", sessionId: context.sessionId, profileKey: context.profileKey, toolCallId},
        queueIfBusy: false,
        signal,
    });
    const result = write ? await withPlanningWriteGrant(sessionId, invoke) : await invoke();
    if (result.status === "waiting") {
        throw new Error(`${SPECIALIST_TITLES[input.specialist]} #${sessionId} 停在等待状态；规划专家不应请求输入或审批，请检查该会话后重试。`);
    }
    if (result.status === "error") {
        throw new Error(`${SPECIALIST_TITLES[input.specialist]} #${sessionId} 调用失败：${result.error ?? "未知错误"}`);
    }
    const details = compactResult(result, input.specialist, sessionId);
    // 模型只能看到 content；结构化结果（提案、已执行变更与事务 id）必须进入文本，规划助手才能核对和汇报。
    const text = details.data === null
        ? details.finalMessage
        : `${details.finalMessage}\n\n结构化结果：\n${JSON.stringify(details.data, null, 2)}`;
    return {content: [{type: "text", text: text || "专家未返回内容"}], details: normalizeToolResultDetails(details)};
}

async function resolveSpecialistSession(
    context: ToolExecutionContext,
    specialist: PlanningSpecialist,
    profileKey: string,
    projectRoot: string,
): Promise<number> {
    const linked = await context.harness.getAgent(undefined, context.sessionId);
    const summaries: AgentSummary[] = Array.isArray(linked) ? linked : [linked];
    const existing = summaries.find((agent) => agent.profileKey === profileKey && agent.currentProjectRoot === projectRoot);
    if (existing) return existing.sessionId;
    const created = await context.harness.createAgent({
        profileKey,
        initial: {projectRoot},
        parentSessionId: context.sessionId,
        currentProjectRoot: projectRoot,
        title: SPECIALIST_TITLES[specialist],
    });
    return created.sessionId;
}

/** 专家跟随用户为规划助手会话选择的模型；会话未选模型时交给专家 Profile 的默认模型解析。 */
async function plannerModelKey(context: ToolExecutionContext): Promise<string | undefined> {
    const state = await context.harness.getSessionLiveState(context.sessionId);
    return state.model ? `${state.model.providerConfigId}/${state.model.modelId}` : undefined;
}

function renderBrief(input: ConsultInput, write: boolean): string {
    const targets = input.targetIds?.length ? input.targetIds.join(", ") : "（未指定）";
    const mode = write
        ? "任务类型：产出。本次可在任务范围内用 commit_planning_change 写入规划、用 write_lorebook/edit_lorebook 写入 lorebook/，并在结果中列出已执行变更和事务 id。"
        : "任务类型：咨询。本次只能读取和预览，不得写入；把建议放进 proposals。";
    return `规划助手委派的问题：\n${input.brief}\n\n聚焦对象 id：${targets}\n${mode}`;
}

function compactResult(result: AgentInvocationResult, specialist: PlanningSpecialist, sessionId: number) {
    return {
        specialist,
        sessionId,
        status: result.status,
        finalMessage: result.reportResult?.result ?? result.finalMessage ?? "",
        data: result.reportResult?.data === undefined ? null : result.reportResult.data as JsonValue,
    };
}
