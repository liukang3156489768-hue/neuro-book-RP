import {describe, expect, it} from "vitest";
import {createTavernMacroEvaluator, type TavernState} from "./tavern-macros";
import {compileTavernPreset} from "./tavern-preset";
import type {TavernBindings} from "nbook/shared/dto/tavern-preset.dto";

const bindings: TavernBindings = {user: "Author", char: "Writer", slots: {chatHistory: [{role: "user", content: "older task"}, {role: "assistant", content: "latest prose"}]},
    nativeContext: {now: "2026-10-11T09:12:13.000Z", randomSeed: "legacy-seed", locale: "en", utcOffsetMinutes: 0,
        chatId: "legacy-chat", maxContext: 1000, maxResponse: 100, firstDisplayedMessageId: 2, firstIncludedMessageId: 1, input: "current input"}};

describe("原生旧宏求值器", () => {
    it("分类顺序与单次求值语义保持，支持Unicode反转和历史/预算宏", () => {
        const state: TavernState = {local: {}, global: {}};
        const expand = createTavernMacroEvaluator(bindings, bindings, state, "legacy");
        expect(expand("{{getvar::x}}/{{setvar::x::02}}{{incvar::x}}/{{reverse:A😀中}}/{{lastUserMessage}}/{{maxPrompt}}"))
            .toBe("3/3/中😀A/older task/900");
        expect(expand("{{setvar::nested::{{user}}}}{{getvar::nested}}" )).toBe("}}{{user");
    });
    it("旧宏时间和随机数使用编译时冻结输入，短变量setter保持字面文本", () => {
        const source = JSON.stringify({prompts: [{identifier: "a", role: "system", content: "{{isodate}}/{{isotime}}/{{random::a::b::c}}/{{roll 2d20+3}}/{{setvar::short}}"}],
            prompt_order: [{character_id: 100001, order: [{identifier: "a", enabled: true}]}]});
        const compiled = compileTavernPreset(source, bindings);
        expect(compiled.messages[0]!.content).toMatch(/^2026-10-11\/09:12\/[abc]\/\d+\/\{\{setvar::short\}\}$/u);
        expect(compileTavernPreset(source, compiled.resolvedBindings).messages).toEqual(compiled.messages);
    });
    it.skipIf(!process.env.NBOOK_TAVERN_UPSTREAM_DIR)("固定SHA旧宏原函数独立VM与生产类别、时间、随机及变量副作用一致", async () => {
        const {createLegacyOracle} = await import("nbook/scripts/smoke/tavern-native-oracle.mjs");
        const oracle = await createLegacyOracle(bindings);
        const state: TavernState = {local: {}, global: {}};
        const expand = createTavernMacroEvaluator(bindings, bindings, state, "legacy");
        for (const text of ["<user>/<char>/<group>/{{char}}", "{{getvar::n}}/{{setvar::n::02}}{{incvar::n}}/{{decvar::n}}",
            "{{setvar::a::[\"x\"]}}{{addvar::a::new}}{{getvar::a}}", "{{setglobalvar::g::01}}{{addglobalvar::g::2}}{{getglobalvar::g}}",
            "{{reverse:A😀中}}/{{newline}}/{{trim}}\n{{noop}}X{{//comment}}", "{{input}}/{{model}}/{{lastGenerationType}}/{{isMobile}}",
            "{{maxPrompt}}/{{maxContextTokens}}/{{maxResponseTokens}}", "{{lastMessageId}}/{{lastUserMessage}}/{{lastCharMessage}}/{{allChatRange}}",
            "{{firstIncludedMessageId}}/{{firstDisplayedMessageId}}", "{{isodate}}/{{isotime}}/{{date}}/{{time}}/{{weekday}}/{{datetimeformat YYYY-MM-DD HH:mm:ss}}",
            "{{time_UTC+2}}/{{timeDiff::2026-10-11 00:00:00::2026-10-11 03:00:00}}", "{{pick::a::b::c}}/{{pick::a::b::c}}/{{random::a::b::c}}/{{roll 2d20+3}}",
            "{{setvar::nested::{{user}}}}{{getvar::nested}}/{{setvar::short}}",
        ]) {
            expect(expand(text), text).toBe(oracle.evaluate(text));
            expect(state, text).toEqual(oracle.state());
        }
    });
});
