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

// 专家复用子会话；限定委派方并逐次明确任务，避免沿用旧方案或扩大写入授权。
const PLANNER_PROFILE_KEY = "outline.planner";

const AdaptationSchema = Type.Union([
    Type.Object({
        kind: Type.Literal("chapter"),
        sourcePlanId: Type.String({minLength: 1}),
        sourceEntryId: Type.String({minLength: 1}),
    }, {additionalProperties: false}),
    Type.Object({
        kind: Type.Literal("between"),
        sourcePlanId: Type.String({minLength: 1}),
        beforeEntryId: Type.String({minLength: 1}),
        afterEntryId: Type.String({minLength: 1}),
    }, {additionalProperties: false}),
]);

const ConsultSchema = Type.Object({
    specialist: Type.Union([Type.Literal("outline"), Type.Literal("detailed"), Type.Literal("foreshadowing")], {
        description: "outline: 总纲/卷纲/章节大纲骨架、方案与已有伏笔的使用安排；detailed: 细纲；foreshadowing: 伏笔设计与埋设/回收建议。",
    }),
    brief: Type.String({minLength: 1, maxLength: 20000, description: "交给专家的问题与已知背景；写清目标、约束和用户意图。"}),
    taskContext: Type.Optional(Type.Object({
        creationMode: Type.Union([Type.Literal("original"), Type.Literal("adaptation")]),
        targetPlanId: Type.Union([Type.String({minLength: 1}), Type.Null()]),
        adaptation: Type.Optional(AdaptationSchema),
        materialPaths: Type.Optional(Type.Array(Type.String({minLength: 1, maxLength: 4096}), {maxItems: 128})),
    }, {additionalProperties: false, description: "本次任务的最新创作方式、目标方案、已明确的来源锚点及所选素材路径；每次委派重新传递，不沿用子会话历史。"})),
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
 * 专家是最终条目的产出者：委派期间只经规划领域保存条目及其关联的方案新信息。
 * 声明 mutatesWorkspace 让 harness 在讨论模式下先请用户批准这次委派（任务范围即 brief），
 * 自动模式则直接执行；删除和线路操作不在专家写入范围内，仍由规划助手预览并审核。
 */
export function createPlanningDelegationTool(): NeuroAgentTool {
    return {
        key: "delegate_planning_task",
        name: "delegate_planning_task",
        label: "委派规划专家产出",
        description: "Delegate a production task to a planning specialist (outline, detailed, foreshadowing). During this call the specialist may create/edit planning entries and synchronize existing objects' plan-specific adaptation records via materialUpdates. It cannot create characters/items/locations, edit base or extracted material, delete entries, or modify lines. Pass the latest taskContext and exact scope in brief; discuss mode requires user approval. Report applied changes and transaction ids.",
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
    const sessionId = await resolveSpecialistSession(context, input.specialist, profileKey, projectRoot, input.taskContext?.creationMode ?? "original");
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
    creationMode: "original" | "adaptation",
): Promise<number> {
    const linked = await context.harness.getAgent(undefined, context.sessionId);
    const summaries: AgentSummary[] = Array.isArray(linked) ? linked : [linked];
    const modeTitle = `${SPECIALIST_TITLES[specialist]}（${creationMode === "adaptation" ? "改编" : "原创"}）`;
    const existing = summaries.find((agent) => agent.profileKey === profileKey && agent.currentProjectRoot === projectRoot
        && (agent.title === modeTitle || (creationMode === "original" && (!agent.title || agent.title === SPECIALIST_TITLES[specialist]))));
    if (existing) return existing.sessionId;
    const created = await context.harness.createAgent({
        profileKey,
        initial: {projectRoot, creationMode},
        parentSessionId: context.sessionId,
        currentProjectRoot: projectRoot,
        title: modeTitle,
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
        ? "任务类型：产出。本次可在任务范围内用 commit_planning_change 写入规划，并随 create-entry/edit-entry 的 materialUpdates 同步已有对象的当前方案改编信息；不能新建对象或修改基础资料与提取记录。结果列出已执行变更和事务 id。"
        : "任务类型：咨询。本次只能读取和预览，不得写入；把建议放进 proposals。";
    const task = input.taskContext
        ? `[大纲工作台当前任务]\n${JSON.stringify(input.taskContext)}\n本次上下文覆盖旧委派；先用规划快照核实方案及来源，按需读取所选素材和当前方案改编记录。`
        : "本次未提供结构化任务上下文；仅根据本次 brief 核实方案和来源，信息不足放入 openQuestions，不能沿用旧委派的目标或授权。";
    return `${task}\n\n规划助手委派的问题：\n${input.brief}\n\n聚焦对象 id：${targets}\n${mode}`;
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
