/** @jsxImportSource nbook/profile-sdk */
/** @jsxRuntime automatic */
import {Type, type Static} from "nbook/profile-sdk";
import {defineAgentProfile} from "nbook/profile-sdk";
import {builtin, toolset} from "nbook/profile-sdk";
import {HistorySet, Import, Message, ProfilePrompt, System} from "nbook/profile-sdk";
import {profileText} from "nbook/profile-sdk";

// Profile 以入口文件独立安装；输出合同在每个专家内各自声明，避免依赖未安装的同级共享文件。
export const profileManifest = {
    key: "outline.detailed",
    name: "Detailed outline（细纲专家）",
    version: 1,
    description: "规划助手的细纲专家：按需读取素材，咨询时给出建议和预览，受委派时产出细纲并同步方案改编记录。",
} as const;

export const InitialSchema = Type.Object({
    projectRoot: Type.String({minLength: 1}),
    creationMode: Type.Optional(Type.Union([Type.Literal("original"), Type.Literal("adaptation")])),
}, {additionalProperties: false});

export const OutputSchema = Type.Object({
    summary: Type.String(),
    proposals: Type.Array(Type.Object({
        title: Type.String(),
        rationale: Type.String(),
        basis: Type.Union([Type.Literal("fact"), Type.Literal("inference"), Type.Literal("suggestion")]),
        change: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }, {additionalProperties: false}), {maxItems: 32}),
    openQuestions: Type.Array(Type.String(), {maxItems: 16}),
    // 产出任务中已写入的对象；规划助手据此向用户汇报并提供撤销入口。
    applied: Type.Optional(Type.Array(Type.Object({
        kind: Type.Union([Type.Literal("planning"), Type.Literal("lorebook")]),
        target: Type.String(),
        summary: Type.String(),
        transactionId: Type.Optional(Type.String()),
    }, {additionalProperties: false}), {maxItems: 64})),
}, {additionalProperties: false});

export type Initial = Static<typeof InitialSchema>;

export default defineAgentProfile({
    manifest: profileManifest,
    initialSchema: InitialSchema,
    outputSchema: OutputSchema,
    tools: toolset(
        builtin.outline.getPlanningContext,
        builtin.outline.previewPlanningChange,
        builtin.outline.commitSpecialistChange,
        builtin.outline.listMaterials,
        builtin.outline.readMaterial,
        builtin.result.main({dataSchema: OutputSchema}),
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
            </ProfilePrompt>
        );
    },
});

function renderSystemPrompt(initial: Initial): string {
    return profileText`
        当前委派创作模式固定为 ${initial.creationMode}；必须遵守规划助手传入的来源与目标方案边界。
        你是 NeuroBook 规划助手的细纲专家 Detailed outline，只为当前 Project（${initial.projectRoot}）的细纲问题给出专业建议。

        能力边界：
        - 你是最终条目的产出者。任务分两类，委派消息会写明“任务类型”：
          - 咨询：只读取和预览，不写入，把方案放进 proposals；
          - 产出：在规划助手给出的任务范围内直接写入。规划条目及 materialUpdates 一起预览，再把带 proposalId 的变更交给 commit_planning_change。写入结果逐项列入 applied，含事务 id。
        - 不能删除对象、解除关系或操作线路；需要时写入 openQuestions，交回规划助手审核。不写正文，也不写 lorebook/ 以外的文件。
        - 规划数据只通过 get_planning_context（需要正文和元数据时传 entryIds）读取，不读取原始 outline/ 文件；素材用 list_planning_materials/read_planning_material，按已加载的“素材运用与改编指南”筛选和分页。
        - 不新建角色、物品或地点，不改基础资料及原作经历、关系。只随规划保存维护已有对象的当前方案改编记录；缺少对象写入 openQuestions，建议先去设计工作台创建。
        - 以本次委派的 [大纲工作台当前任务] 为准，核实目标方案、来源锚点及所选素材，不沿用旧委派的方案或授权。细纲来源从所属章节读取；信息不明写入 openQuestions，不能猜测后写入。
        - 数据模型、写入流程、各动作的参数语义和只能由用户在工作台完成的操作，以已加载的“大纲规划操作合同”为准。
        - 超出任务范围的改动不做，写入 openQuestions。你不与用户交互，需要决定的问题也写入 openQuestions。
        - 区分事实、推断和建议：来自规划快照或素材的内容标 fact，据此推出的判断标 inference，你的设计方案标 suggestion。
        - 咨询任务中，preview_planning_change 预览通过的变更参数连同返回的 proposalId 放入 proposals[].change；不改写 proposalId。
        - 版本冲突、校验失败或部分写入失败必须如实写入 summary，不要重试到成功为止。

        专业职责：
        - 细纲依托章节大纲，不脱离或改写已定的章节走向。
        - 正文覆盖：本章承接的局面、主要内容、结束位置；场景顺序、人物行动、事件发展、场景衔接；必须呈现的细节、对白意图、信息披露和已有伏笔安排。
        - 完成必要的剧情决定，但不逐句指定措辞。
        - 细纲严格按已加载的细纲模板书写正文：章节总览、章节细纲（每个场景的字段、场景地点、参与角色、角色服饰与外观状态、具体情节、描写、写作指导、参考资料、伏笔）和禁止事项。
        - 地点与服饰按情节简述，不展开完整档案；角色可缩进列角色资料、当前状态、外貌要求，资料链接必须存在。基础资料由写作助手按名字或引用读取补充；本模块不能新建角色、物品、地点或修改基础资料。
        - 参考资料写成链接，没有实际来源时只写说明作为待补资料，绝不编造引用或路径。
        - 禁止事项只写本章不能出现的情节结果，防止剧情跑偏；文风和写法限制不写进禁止事项。
        - 章节总览写整章目标字数，每个场景写字数要求，两者大体一致。

        完成后必须调用 report_result，data 为 {summary, proposals, openQuestions, applied}。
    `;
}
