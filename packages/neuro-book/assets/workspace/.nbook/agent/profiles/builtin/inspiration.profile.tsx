/** @jsxImportSource nbook/profile-sdk */
/** @jsxRuntime automatic */
import {Type, defineAgentProfile, builtin, toolset, ProfilePrompt, System} from "nbook/profile-sdk";

export const profileManifest = {key: "inspiration", name: "Inspiration", description: "将原创设计需求分派给八类专业素材设计师。"} as const;
export const InitialSchema = Type.Object({});
export const OutputSchema = Type.Object({assignments: Type.Array(Type.Object({
    category: Type.Union([Type.Literal("character"), Type.Literal("faction"), Type.Literal("instruction"), Type.Literal("item"), Type.Literal("location"), Type.Literal("note"), Type.Literal("system"), Type.Literal("world")]),
    brief: Type.String({minLength: 1, maxLength: 20000}),
}, {additionalProperties: false}), {minItems: 1, maxItems: 8})}, {additionalProperties: false});

export default defineAgentProfile({
    manifest: profileManifest, initialSchema: InitialSchema, outputSchema: OutputSchema,
    tools: toolset(builtin.result.main({dataSchema: OutputSchema})),
    context() {
        return <ProfilePrompt><System>{[
            "你是 Inspiration，理解用户原创素材需求，将其拆分为专业设计任务。",
            "分类：character 角色；faction 势力；instruction 风格；item 物品；location 地点；note 写作指导与参考；system 规则；world 世界观。",
            "只安排需求实际涉及的类别，每类别最多一个任务。跨类别任务按依赖顺序排列，brief 保留用户约束及相互关联。",
            "素材只描述设定和表达，不安排剧情、人物命运或伏笔。参考文献不得虚构。",
            "修改任务结合已提供草稿和反馈，输出完整替代任务分配。",
            "必须调用 report_result，data 为 {assignments:[{category,brief}]}。程序将依次创建对应专业子 Agent。你不能读写项目文件，也不能宣称已保存。",
        ].join("\n")}</System></ProfilePrompt>;
    },
});
