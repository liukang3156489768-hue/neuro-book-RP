/** @jsxImportSource nbook/profile-sdk */
/** @jsxRuntime automatic */
import {Type, defineAgentProfile, builtin, toolset, ProfilePrompt, System} from "nbook/profile-sdk";

export const profileManifest = {key: "inspiration.extract", name: "作品分析提取师", description: "从用户选择的作品分块中提取可审阅的设定与结构资料。"} as const;
const Category = Type.Union([Type.Literal("character"), Type.Literal("faction"), Type.Literal("instruction"), Type.Literal("item"), Type.Literal("location"), Type.Literal("note"), Type.Literal("system"), Type.Literal("world")]);
export const InitialSchema = Type.Object({categories: Type.Array(Category, {minItems: 1, maxItems: 8}), fields: Type.Record(Type.String(), Type.Array(Type.String()))}, {additionalProperties: false});
export const OutputSchema = Type.Object({artifacts: Type.Array(Type.Object({
    category: Category, title: Type.String({minLength: 1, maxLength: 120}), fields: Type.Record(Type.String(), Type.String({minLength: 1, maxLength: 80000})),
    citations: Type.Array(Type.Object({firstParagraphId: Type.String({pattern: "^P[1-9]\\d*$"}), lastParagraphId: Type.String({pattern: "^P[1-9]\\d*$"})}, {additionalProperties: false}), {minItems: 1, maxItems: 12}),
}, {additionalProperties: false}), {minItems: 1, maxItems: 12})}, {additionalProperties: false});

export default defineAgentProfile({
    manifest: profileManifest, initialSchema: InitialSchema, outputSchema: OutputSchema,
    tools: toolset(builtin.result.main({dataSchema: OutputSchema})),
    context(ctx) {
        return <ProfilePrompt><System>{[
            "你是作品分析提取师。用户消息中提供的是一个有边界的原文分块，段落以 [P编号] 标识。",
            `只返回以下目标类别：${ctx.initial.categories.join("、")}。每一项必须是从原文提取、归纳或结构化得到的资料，不得续写、补写、猜测或把常识当成原文事实。`,
            "可把原文中的人物、世界规则、势力、地点、物品、叙事风格组织成素材卡；若用户要求大纲或细纲，使用 note 类别输出作品结构分析、事件链和章节推进，但仍只能陈述本分块所见内容。",
            `模板字段映射：${JSON.stringify(ctx.initial.fields)}。每项必须只使用所属类别映射中的字段键；note 类别可自行组织字段。字段值必须是从原文提取或归纳出的纯文本，至少返回一个非空字段，不要返回 content 或原始 Markdown。程序会按模板顺序转换为可审阅内容。`,
            "每项必须附 citations，引用覆盖该项依据的最小连续段落范围。不得引用消息未提供、当前分块范围外或不存在的 P 编号。原文未说明的信息应标为“本范围未见”，不能补全。",
            "不得宣称已保存、已读完整作品或完成跨分块合并。必须调用 report_result，data 为 {artifacts:[{category,title,fields,citations}]}。",
        ].join("\n")}</System></ProfilePrompt>;
    },
});
