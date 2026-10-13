/** @jsxImportSource nbook/profile-sdk */
/** @jsxRuntime automatic */
import {Type, type Static} from "nbook/profile-sdk";
import {defineAgentProfile} from "nbook/profile-sdk";
import {toolset} from "nbook/profile-sdk";
import {ProfilePrompt, System} from "nbook/profile-sdk";

export const profileManifest = {
    key: "writing.writer",
    name: "写作写手",
    version: 1,
    description: "由写作工作流调用：每次都是全新上下文，只看到渲染好的场景写作提示，只输出正文。",
} as const;

// 系统提示（写手职责、文风、禁用写法、样文）由写作工作流按结构 B 渲染，Profile 不追加任何内容，
// 保证写手看到的就是运行记录里的那份提示。
export const InitialSchema = Type.Object({
    system: Type.String({minLength: 1}),
    managedPurposeId: Type.Optional(Type.Union([Type.Literal("writing.writer.scene"), Type.Literal("writing.writer.rewrite")])),
    managedVariables: Type.Optional(Type.Record(Type.String(), Type.String())),
    tavernOwnerKey: Type.Optional(Type.String({minLength: 1, maxLength: 1024})),
}, {additionalProperties: false});

export type Initial = Static<typeof InitialSchema>;

export default defineAgentProfile({
    manifest: profileManifest,
    initialSchema: InitialSchema,
    tools: toolset(),
    context(ctx) {
        return (
            <ProfilePrompt>
                <System>{ctx.initial.system}</System>
            </ProfilePrompt>
        );
    },
});
