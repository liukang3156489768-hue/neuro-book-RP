import {describe, expect, it} from "vitest";
import {createDefaultTavernBindings, defaultTavernOutputPolicy} from "./tavern-bindings";
import {loadWritingPromptDefinitions} from "nbook/server/prompt-management/writing-catalog";
import {validatePromptEntries} from "nbook/server/prompt-management/render";

function source(...markers: string[]) {
    return JSON.stringify({prompts: markers.map(identifier => ({identifier, marker: true})),
        prompt_order: [{character_id: 100001, order: markers.map(identifier => ({identifier, enabled: true}))}]});
}

describe("写手原生资料默认绑定", () => {
    it.each(["writing.writer.scene", "writing.writer.rewrite"])("%s的必需资料只进入已启用槽位，身份独立于人物与消息角色", purposeId => {
        const raw = source("charDescription", "scenario", "worldInfoBefore", "chatHistory", "personaDescription");
        const binding = createDefaultTavernBindings(purposeId, raw);
        const definition = loadWritingPromptDefinitions().find(value => value.purposeId === purposeId)!;
        const content = Object.values(binding.slots).flat().map(message => message.content).join("\n");
        expect(() => validatePromptEntries(definition, [{id: "binding", name: "资料", role: "user", content}])).not.toThrow();
        expect(binding.user).toBe("作者"); expect(binding.char).toBe("写手");
        expect(binding.slots.chatHistory?.at(-1)?.role).toBe("user");
        if (purposeId.endsWith("scene")) expect(binding.slots.chatHistory?.[0]).toMatchObject({role: "assistant", content: expect.stringContaining("{{acceptedProse}}")});
        expect(content).not.toContain("只输出本场景正文");
    });
    it("无历史时资料落到启用场景槽位，无可用资料槽位明确拒绝", () => {
        const binding = createDefaultTavernBindings("writing.writer.scene", source("scenario"));
        expect(binding.slots.scenario?.[0]?.content).toContain("{{characters}}");
        expect(() => createDefaultTavernBindings("writing.writer.scene", source("dialogueExamples"))).toThrow("资料槽位");
        expect(() => createDefaultTavernBindings("writing.lead", source("chatHistory"))).toThrow("写手");
    });
    it("只有启用条目要求content时才默认标签提取", () => {
        const raw = JSON.stringify({prompts: [{identifier: "on", content: "只输出<content>正文</content>"}, {identifier: "off", content: "<content>"}],
            prompt_order: [{character_id: 100001, order: [{identifier: "on", enabled: true}, {identifier: "off", enabled: false}]}]});
        expect(defaultTavernOutputPolicy(raw)).toEqual({mode: "tag", tag: "content", qualityCheck: true});
        expect(defaultTavernOutputPolicy(source("chatHistory"))).toEqual({mode: "full", qualityCheck: true});
    });
});
