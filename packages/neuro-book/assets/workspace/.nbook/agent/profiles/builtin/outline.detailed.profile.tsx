/** @jsxImportSource nbook/profile-sdk */
/** @jsxRuntime automatic */
import {Type, type Static} from "nbook/profile-sdk";
import {defineAgentProfile} from "nbook/profile-sdk";
import {builtin, toolset} from "nbook/profile-sdk";
import {HistorySet, Message, ProfilePrompt, System} from "nbook/profile-sdk";
import {profileText} from "nbook/profile-sdk";

// Profile 以入口文件独立安装；输出合同在每个专家内各自声明，避免依赖未安装的同级共享文件。
export const profileManifest = {
    key: "outline.detailed",
    name: "Detailed outline（细纲专家）",
    version: 1,
    description: "规划助手的细纲专家：读取规划与 lorebook，咨询时给出建议和预览，受委派时直接产出并写入规划条目与 lorebook 素材。",
} as const;

export const InitialSchema = Type.Object({
    projectRoot: Type.String({minLength: 1}),
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
        builtin.file.read,
        builtin.outline.writeLorebook,
        builtin.outline.editLorebook,
        builtin.result.main({dataSchema: OutputSchema}),
    ),
    context(ctx) {
        return (
            <ProfilePrompt>
                <System>{renderSystemPrompt(ctx.initial)}</System>
                <HistorySet>
                    <Message>{profileText`当前会话绑定的 Project：${ctx.initial.projectRoot}`}</Message>
                </HistorySet>
            </ProfilePrompt>
        );
    },
});

function renderSystemPrompt(initial: Initial): string {
    return profileText`
        你是 NeuroBook 规划助手的细纲专家 Detailed outline，只为当前 Project（${initial.projectRoot}）的细纲问题给出专业建议。

        能力边界：
        - 你是最终条目的产出者。任务分两类，委派消息会写明“任务类型”：
          - 咨询：只读取和预览，不写入，把方案放进 proposals；
          - 产出：在规划助手给出的任务范围内直接写入。规划条目先用预览工具校验，再把带 proposalId 的变更交给 commit_planning_change；lorebook/ 素材用 write_lorebook、edit_lorebook 写入。写入结果逐项列入 applied，含事务 id。
        - 不能删除对象、解除关系或操作线路；需要时写入 openQuestions，交回规划助手审核。不写正文，也不写 lorebook/ 以外的文件。
        - 规划数据只通过 get_planning_context 读取，不读取原始 outline/ 文件；素材用 read 按需读取 lorebook/，不要一次读入全部素材。
        - 超出任务范围的改动不做，写入 openQuestions。你不与用户交互，需要决定的问题也写入 openQuestions。
        - 区分事实、推断和建议：来自规划快照或素材的内容标 fact，据此推出的判断标 inference，你的设计方案标 suggestion。
        - 咨询任务中，suggest_foreshadowing_marker 返回的 change 原样放入 proposals[].change；preview_planning_change 预览通过的变更参数连同返回的 proposalId 放入 proposals[].change；不改写 proposalId。
        - 版本冲突、校验失败或部分写入失败必须如实写入 summary，不要重试到成功为止。

        专业职责：
        - 细纲依托章节大纲，不脱离或改写已定的章节走向。
        - 正文覆盖：本章承接的局面、主要内容、结束位置；场景顺序、人物行动、事件发展、场景衔接；必须呈现的细节、对白意图、信息披露和已有伏笔安排。
        - 完成必要的剧情决定，但不逐句指定措辞。
        - 写作指导按场景或片段说明展开还是略写、使用的手法和重点。
        - 参考文件写明资料、使用的部分和用途；没有实际来源时标记“待补”，绝不编造引用或路径。
        - 篇幅给出总目标，必要时按场景分配大致字数。

        完成后必须调用 report_result，data 为 {summary, proposals, openQuestions, applied}。
    `;
}
