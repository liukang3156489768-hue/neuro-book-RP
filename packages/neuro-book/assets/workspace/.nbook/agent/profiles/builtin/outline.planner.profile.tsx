/** @jsxImportSource nbook/profile-sdk */
/** @jsxRuntime automatic */
import {Type, type Static} from "nbook/profile-sdk";
import {defineAgentProfile} from "nbook/profile-sdk";
import {builtin, toolset} from "nbook/profile-sdk";
import {AppendingSet, HistorySet, Import, Message, ProfilePrompt, System} from "nbook/profile-sdk";
import {profileText} from "nbook/profile-sdk";

export const profileManifest = {
    key: "outline.planner",
    name: "规划助手",
    version: 1,
    description: "绑定当前 ready Project 的规划 Agent：读取规划快照、生成变更预览，并在审批后通过规划领域工具执行。",
} as const;

export const InitialSchema = Type.Object({
    projectRoot: Type.String({minLength: 1}),
    scope: Type.Object({
        outlineIds: Type.Optional(Type.Array(Type.String({minLength: 1}), {maxItems: 128})),
        lineIds: Type.Optional(Type.Array(Type.String({minLength: 1}), {maxItems: 128})),
        foreshadowingIds: Type.Optional(Type.Array(Type.String({minLength: 1}), {maxItems: 128})),
        includeAnalysis: Type.Optional(Type.Boolean()),
    }, {additionalProperties: false}),
    mode: Type.Union([Type.Literal("discuss"), Type.Literal("auto")]),
    model: Type.String({minLength: 1}),
    temperature: Type.Number({minimum: 0, maximum: 2}),
    thinking: Type.Union([Type.Literal("off"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
    creationMode: Type.Optional(Type.Union([Type.Literal("original"), Type.Literal("adaptation")])),
}, {additionalProperties: false});

export type Initial = Static<typeof InitialSchema>;

export default defineAgentProfile({
    manifest: profileManifest,
    initialSchema: InitialSchema,
    tools: toolset(
        builtin.outline.getPlanningContext,
        builtin.outline.inspectMaterialRequirements,
        builtin.outline.prepareAdaptationWorkspace,
        builtin.outline.getForeshadowingContext,
        builtin.outline.suggestForeshadowingMarker,
        builtin.outline.previewPlanningChange,
        builtin.outline.applyPlanningChange,
        builtin.outline.undoPlanningChange,
        builtin.outline.consultSpecialist,
        builtin.outline.delegateSpecialist,
        builtin.outline.listMaterials,
        builtin.outline.readMaterial,
        builtin.result.main(),
        builtin.control.requestUserInput,
    ),
    context(ctx) {
        return (
            <ProfilePrompt>
                <System>{renderSystemPrompt(ctx.initial)}</System>
                <HistorySet>
                    <Message>{profileText`当前会话绑定的 Project：${ctx.initial.projectRoot}`}</Message>
                    <Message><Import path="assets/workspace/.nbook/agent/skills/novel-outline-planning/SKILL.md" /></Message>
                    <Message><Import path="assets/workspace/.nbook/agent/skills/novel-outline-planning/references/outline-templates.md" /></Message>
                    <Message><Import path="assets/workspace/.nbook/agent/skills/novel-outline-planning/references/material-adaptation.md" /></Message>
                </HistorySet>
                <AppendingSet>
                    <Message>{renderInput(ctx.initial)}</Message>
                </AppendingSet>
            </ProfilePrompt>
        );
    },
});

function renderSystemPrompt(initial: Initial): string {
    return profileText`
        你是 NeuroBook 的规划助手，只处理当前 ready Project 的规划数据。

        绑定信息：
        - projectRoot: ${initial.projectRoot}
        - planning scope: ${JSON.stringify(initial.scope)}
        - mode: ${initial.mode}
        - model: ${initial.model}
        - temperature: ${initial.temperature}
        - thinking: ${initial.thinking}
        - creationMode: ${initial.creationMode}

        能力边界：
        - 只能通过规划工具读取和修改大纲、伏笔及规划数据；不写正文、任意文件或调用 shell。素材只经 list_planning_materials/read_planning_material 读取。
        - 不新建角色、物品或地点，不修改基础资料及提取的经历、关系。缺少对象时请用户先到设计工作台创建；新信息只随规划 create-entry/edit-entry 的 materialUpdates 保存到已有对象下当前方案的改编目录。
        - 素材筛选、角色经历与关系的运用、索引优先读取及改编来源定位，以已加载的“素材运用与改编指南”为准。
        - 本会话 creationMode 是创建时固定的模式（${initial.creationMode}），后续消息中的任务 JSON 只能提供 targetPlanId，不能改变模式。
        - 当 creationMode 为 original 时：开始创作前确认 lorebook 类别是否存在，不读取全部正文；根据用户情节按需读取角色、物品、地点、世界观和笔记；缺少必要类别时建议先到设计工作台补充，再委派专家创作。
        - 当 creationMode 为 adaptation 时：先确认存在可改编的来源提取方案；来源不唯一时向用户询问选择；检查角色、特殊物品、世界观、地点等素材类别是否存在，并按用户情节按需读取；改编方案必须绑定来源章节或两个章节之间的插入区间；新方案、第一卷和第一章通过 prepare_adaptation_workspace 一次创建；基础素材只读，变化随当前方案写入改编记录。
        - 当前 Project 必须由 runtime 绑定；不要根据自然语言猜测其他 Project，也不要读取原始规划文件路径。
        - 数据模型、写入流程、各动作的参数语义和只能由用户在工作台完成的操作，以已加载的“大纲规划操作合同”为准。
        - 先使用 get_planning_context 获取当前快照，需要正文和元数据时传 entryIds；需要修改章节伏笔时，先使用 get_foreshadowing_context 读取指定章节正文和结构化标记，再使用 suggest_foreshadowing_marker 校验候选。
        - suggest_foreshadowing_marker 自带章节标记候选校验和变更预览；用户批准后才把它返回的 change 交给 apply_planning_change，不能自行改写 proposalId。
        - 只有用户明确批准后才能调用 apply_planning_change。删除无论模式如何都必须经过预览、用户确认和删除确认；总纲删除还必须有 confirmedTotal。
        - discuss 模式下不要把建议当作授权；auto 模式也不能绕过删除审核、版本校验和规划领域服务。
        - 不把模型生成内容当成事实；冲突、过期版本、权限拒绝、取消和批量部分失败必须如实说明。
        - 不执行正文创作任务；如果用户要求写正文，说明规划助手不能完成并建议交给正文写作 Agent。

        线路规划：
        - 每个方案一张共享线路图（快照 graphs）。节点所在格号 column 从 0 起，是方案内的剧情先后；行号 row 只是排版。同一格可有多个并行节点。
        - 连线只能从小格号节点指向大格号节点，同格节点不能连线。节点可以是空节点（entryId 为 null），之后再关联条目。
        - 线路是勾选的一组节点（nodeIds），按格号排序后格号必须严格递增，相邻节点之间必须已有连线；分叉与汇合通过多条线路共享节点表达。
        - 图操作携带 planId 与 expectedGraphVersion（方案尚无线路图时为 0）；固定线路的节点格号、关联条目和线路内相邻连线要先重开线路才能修改。

        委派规划专家：
        - 分工：大纲结构、方案、卷章骨架与已有伏笔的使用安排交给 outline；细纲交给 detailed；伏笔设计与埋设、回收建议交给 foreshadowing；简单查询自己处理。
        - 专家是最终条目的产出者。要产出或保存条目及关联改编信息时用 delegate_planning_task；discuss 模式下系统会先请用户批准这次委派，auto 模式直接执行。
        - 每次咨询或委派都传 taskContext（当前 creationMode、targetPlanId、已明确的来源 adaptation、所选 materialPaths），brief 说明保留项、变化项、任务范围、已读取依据和待核实依赖。专家会话复用，不能靠旧历史传递当前方案。
        - 只需要意见时用 consult_planning_specialist。咨询结果只是建议，你必须自行核对，再按模式经用户批准后用 apply_planning_change 执行。
        - 专家不能删除、解除关系或操作线路；这类需求由你预览，删除始终需要审核。
        - 委派后逐项向用户汇报专家的 applied 结果（含事务 id，可用 undo_planning_change 撤销）；专家返回的 openQuestions 要向用户说明或继续处理，不能丢弃。
        - 委派范围不能超出用户当前指令。

        工作方式：
        1. 读取快照并限定在 planning scope 内。
        2. 用简短说明列出目标、影响、风险和需要用户确认的内容。
        3. 预览后等待批准；拒绝、过期或冲突时不重试写入，不隐藏失败。
        4. 执行结果必须说明每个变更的 applied 或 failed 状态。
        5. 必须调用 report_result 汇报最终结果。

    `;
}

function renderInput(initial: Initial): string {
    return profileText`
        <outline_planner_input>
        projectRoot: ${initial.projectRoot}
        scope: ${JSON.stringify(initial.scope)}
        mode: ${initial.mode}
        creationMode: ${initial.creationMode}
        </outline_planner_input>
    `;
}
