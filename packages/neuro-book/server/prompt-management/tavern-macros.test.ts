import {describe, expect, it} from "vitest";
import type {TavernBindings} from "nbook/shared/dto/tavern-preset.dto";
import {createTavernMacroEvaluator, expandTavernMacros, type TavernState} from "./tavern-macros";
import {compileTavernPreset, inspectTavernPreset} from "./tavern-preset";

const identity = {user: "Author", char: "Writer"};
const bindings: TavernBindings = {...identity, slots: {}, nativeContext: {now: "2026-10-11T09:12:13Z", randomSeed: "fixed-seed", locale: "en", utcOffsetMinutes: 0,
    chatId: "test-chat", pickRerollSeed: 3, model: "model-1", maxContext: 1000, maxResponse: 100,
    character: {firstMessage: "hello", alternateGreetings: ["second"], mesExamplesRaw: "Author: ask\nWriter: answer"}}};
const preset = (prompts: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({prompts,
    prompt_order: [{character_id: 100001, order: prompts.map(prompt => ({identifier: (prompt as {identifier: string}).identifier, enabled: true}))}], new_chat_prompt: "", ...extra});
const native = (state: TavernState, input = bindings) => createTavernMacroEvaluator(input, identity, state, "native");

describe("酒馆原生与旧宏引擎", () => {
    it("无时区日期使用冻结时区解析，duration使用冻结locale而非进程默认", () => {
        for (const engine of ["legacy", "native"] as const) {
            const input = {...bindings, nativeContext: {...bindings.nativeContext, utcOffsetMinutes: 540, locale: "en"}};
            const evaluate = createTavernMacroEvaluator(input, identity, {local: {}, global: {}}, engine);
            expect(evaluate("{{timeDiff::2026-10-11 09:00:00::2026-10-11T00:00:00Z}}" )).toBe("a few seconds ago");
            const chinese = createTavernMacroEvaluator({...input, nativeContext: {...input.nativeContext, locale: "zh-cn"}}, identity, {local: {}, global: {}}, engine);
            expect(chinese("{{timeDiff::2026-10-11T00:00:00Z::2026-10-11T03:00:00Z}}" )).toBe("3 小时前");
            expect(evaluate("{{timeDiff::2026-10-11T00:00:00Z::2026-10-11T03:00:00Z}}" )).toBe("3 hours ago");
        }
    });
    it("legacy变量分类求值保留前向引用语义，inc/dec返回值，数组追加和数值归一化", () => {
        const state: TavernState = {local: {array: '["a"]'}, global: {}};
        expect(expandTavernMacros("{{getvar::n}}/{{incvar::n}}/{{setvar::n::2}}/{{addvar::n::3}}/{{decvar::n}}", identity, state)).toBe("5/6///5");
        expect(expandTavernMacros("{{incvar::array}}/{{setglobalvar::g::01}}{{getglobalvar::g}}", identity, state)).toBe("a,1/1");
        expect(state).toEqual({local: {array: '["a",1]', n: "5"}, global: {g: "01"}});
    });
    it("native嵌套条件只求值所选分支，变量shorthand支持比较和惰性默认值", () => {
        const state: TavernState = {local: {}, global: {}};
        const expand = native(state);
        expect(expand("{{.n=2}}{{if .n}}Y{{if .n > 1}}2{{else}}bad{{/if}}{{else}}{{setvar::wrong::yes}}{{/if}}/{{.n ?? {{incvar::unused}}}}"))
            .toBe("Y2/2");
        expect(state).toEqual({local: {n: "2"}, global: {}});
        expect(expand("{{.missing ??= fallback}}/{{.missing}}/{{$.n=3}}{{$.n++}}" )).toBe("fallback/fallback/4");
        expect(state.global).toEqual({n: "4"});
    });
    it("native范围宏、保留空白flag与索引变量依循原生parser", () => {
        const state: TavernState = {local: {}, global: {}};
        const expand = native(state);
        expect(expand("{{setvar::x}}  a\n {{/setvar}}{{getvar::x}}" )).toBe("a");
        expect(expand("{{#setvar::x}}  b\n {{/setvar}}{{getvar::x}}" )).toBe("  b\n ");
        expect(expand("{{setvarkey::object::one::value}}{{getvarkey::object::one}}/{{hasvar::object}}{{deletevar::x}}{{hasvar::x}}" )).toBe("value/truefalse");
        expect(state.local).toEqual({object: '{"one":"value"}'});
    });
    it("宏身份与请求role独立，环境/示例/问候和预算宏使用显式元数据", () => {
        const raw = preset([{identifier: "a", role: "assistant", content: "{{user}}/{{char}}/{{model}}/{{maxPrompt}}/{{greeting::1}}/{{mesExamples}}"}]);
        const result = compileTavernPreset(raw, bindings, {macroEngine: "native"});
        expect(result.messages).toEqual([{role: "assistant", content: "Author/Writer/model-1/900/second/<START>\nAuthor: ask\nWriter: answer\n"}]);
        expect(inspectTavernPreset(raw).promptSupported).toBe(false);
        expect(result.report.promptSupported).toBe(true);
    });
    it("生成参数覆盖同步影响预算宏，未启用裁剪时仍使用source额度", () => {
        const raw = preset([{identifier: "a", role: "system", content: "{{maxContext}}/{{maxResponse}}/{{maxPrompt}}"}], {openai_max_context: 1000, openai_max_tokens: 100});
        expect(compileTavernPreset(raw, {...identity, slots: {}}, {macroEngine: "native"}).messages[0]!.content).toBe("1000/100/900");
        expect(compileTavernPreset(raw, {...identity, slots: {}}, {macroEngine: "native", generation: {maxTokens: 25}}).messages[0]!.content).toBe("1000/25/975");
    });
    it("一次编译冻结clock和seed，跨条目RNG连续且回放逐字一致", () => {
        const raw = preset([{identifier: "a", role: "system", content: "{{isodate}}/{{isotime}}/{{pick::a::b::c}}/{{random::a::b::c}}/{{roll::2d20+3}}"},
            {identifier: "b", role: "user", content: "{{datetimeformat::YYYY-MM-DD HH:mm:ss}}/{{random::1::2::3}}"}]);
        const result = compileTavernPreset(raw, bindings, {macroEngine: "native"});
        const replay = compileTavernPreset(raw, result.resolvedBindings, {macroEngine: "native"});
        expect(replay.messages).toEqual(result.messages);
        expect(result.messages[0]!.content).toMatch(/^2026-10-11\/09:12\/[abc]\/[abc]\/\d+$/u);
        expect(result.messages[1]!.content).toMatch(/^2026-10-11 09:12:13\/[123]$/u);
        const captured = compileTavernPreset(preset([{identifier: "a", role: "system", content: "{{isotime}}"}]), {...identity, slots: {}}, {macroEngine: "native"});
        expect(captured.resolvedBindings.nativeContext).toMatchObject({locale: "en"});
        expect(captured.resolvedBindings.nativeContext?.now).toBeDefined();
        expect(captured.resolvedBindings.nativeContext?.randomSeed).toBeDefined();
    });
    it("原生短setter/未知宏参数保留字面文本，缺失宿主能力显式失败", () => {
        const state: TavernState = {local: {}, global: {}};
        const expand = native(state);
        expect(expand("{{setvar::x}}/{{madeup::{{user}}}}" )).toBe("{{setvar::x}}/{{madeup::Author}}");
        expect(state.local).toEqual({});
        expect(() => expand("{{outlet::key}}" )).toThrow("outlet");
        expect(() => expand("{{firstDisplayedMessageId}}" )).toThrow("firstDisplayedMessageId");
    });
    it("变量原型键作为数据，has/delete及索引访问不会污染原型", () => {
        const state: TavernState = {local: {}, global: {}};
        expect(native(state)("{{setvar::__proto__::ok}}{{getvar::__proto__}}/{{hasvar::toString}}/{{setvarkey::obj::__proto__::safe}}{{getvarkey::obj::__proto__}}" ))
            .toBe("ok/false/safe");
        expect(Object.hasOwn(state.local, "__proto__")).toBe(true);
        expect(Object.getPrototypeOf(state.local)).toBe(Object.prototype);
        expect(state.local.obj).toBe('{"__proto__":"safe"}');
    });
    it("SPreset设置条目不执行/输出；未触发的插件模板不阻止本次原生生成", () => {
        const raw = preset([{identifier: "SPresetSettings", content: '{"MacroNest":{"enabled":true}}'},
            {identifier: "inactive", role: "system", content: "<%= pluginCode() %>", injection_trigger: ["continue"]},
            {identifier: "a", role: "system", content: "{{user}}", spreset_condition_script: "throw new Error('never')"}], {extensions: {SPreset: {enabled: true}}});
        const result = compileTavernPreset(raw, bindings, {macroEngine: "native"});
        expect(result.messages).toEqual([{role: "system", content: "Author"}]);
        expect(result.report.extensionDependencies).toContain("extension: SPreset");
        expect(() => compileTavernPreset(raw, {...bindings, generationType: "continue"}, {macroEngine: "native"})).toThrow("template extension");
    });
    it("预算只执行首条被拒历史宏，保留原始索引用于写手必需字段保护", () => {
        const raw = preset([{identifier: "chatHistory", marker: true}]);
        const result = compileTavernPreset(raw, {...identity, slots: {chatHistory: [
            {role: "user", content: "{{setvar::old::yes}}A"}, {role: "user", content: "{{setvar::rejected::yes}}LONGGG"},
            {role: "user", content: "{{setvar::new::yes}}ok"},
        ]}}, {budget: {tokenizer: "claude", contextTokens: 8, responseTokens: 0, pinExamples: false, count: message => message.content.length}});
        expect(result.messages).toEqual([{role: "user", content: "ok"}]);
        expect(result.variablesAfter.local).toEqual({new: "yes", rejected: "yes"});
        expect(result.retainedHistoryIndices).toEqual([2]);
        expect(result.budgetReport).toMatchObject({usedTokens: 5, droppedHistory: 2});
        expect(() => compileTavernPreset(raw, {...identity, slots: {chatHistory: []}, contextBudget: {tokenizer: "claude", contextTokens: 100}})).toThrow("预算未准备");
    });
    it("system压缩保留newMainChat边界，再应用原生single后处理", () => {
        const raw = preset([{identifier: "a", role: "system", content: "first"}, {identifier: "b", role: "system", content: "second"},
            {identifier: "chatHistory", marker: true}], {new_chat_prompt: "[Start]", squash_system_messages: true, custom_prompt_post_processing: "single"});
        const result = compileTavernPreset(raw, {...identity, slots: {chatHistory: [{role: "user", content: "task"}]}});
        expect(result.promptMessages).toEqual([{role: "system", content: "first\nsecond"}, {role: "system", content: "[Start]"}, {role: "user", content: "task"}]);
        expect(result.messageIdentifiers).toEqual(["a", "newMainChat", "chatHistory"]);
        expect(result.messages).toEqual([{role: "user", content: "first\nsecond\n\n[Start]\n\nAuthor: task"}]);
    });
    it("system压缩保留newChat示例边界和命名消息", () => {
        const raw = preset([{identifier: "a", role: "system", content: "Rules"}, {identifier: "dialogueExamples", marker: true},
            {identifier: "chatHistory", marker: true}], {new_example_chat_prompt: "[Example]", new_chat_prompt: "[Start]", squash_system_messages: true});
        const result = compileTavernPreset(raw, {...identity, slots: {
            dialogueExamples: [{role: "system", name: "example_user", content: "ask"}, {role: "system", name: "example_assistant", content: "answer"}],
            chatHistory: [{role: "user", content: "task"}],
        }});
        expect(result.messages.slice(0, 3)).toEqual([{role: "system", content: "Rules"}, {role: "system", content: "[Example]"}, {role: "system", name: "example_user", content: "ask"}]);
        expect(result.messageIdentifiers.slice(0, 3)).toEqual(["a", "newChat", "dialogueExamples"]);
    });
    it.skipIf(!process.env.NBOOK_TAVERN_UPSTREAM_DIR)("原生ESM原函数独立加载，与嵌套/惰性/变量/时间/随机原函数逐字对照", async () => {
        const {runNativeOracle} = await import("nbook/scripts/smoke/tavern-native-oracle.mjs");
        const state: TavernState = {local: {}, global: {}};
        const expand = native(state);
        const texts = ["{{setvar::n::2}}{{if .n}}yes{{else}}{{setvar::wrong::yes}}{{/if}}", "{{.n++}}/{{.n>2}}/{{.missing??fallback}}",
            "{{setvar::x}} a {{/setvar}}{{getvar::x}}", "{{#setvar::x}} a {{/setvar}}{{getvar::x}}",
            "{{if .n}}{{if .n>2}}inner{{else}}bad{{/if}}{{else}}outer{{/if}}", "{{if false}}{{incvar::bad}}{{else}}{{reverse::{{user}}}}{{/if}}",
            "{{setvarkey::object::k::v}}{{getvarkey::object::k}}/{{hasvar::object}}/{{deletevar::x}}{{hasvar::x}}",
            "{{setglobalvar::g::01}}{{addglobalvar::g::2}}{{incglobalvar::g}}/{{getglobalvar::g}}", "{{.n??{{incvar::notExecuted}}}}",
            "{{setvar::short}}/{{unknown::{{user}}}}", "{{newline::2}}/{{space::3}}/{{trim}}\n A \n{{/trim}}",
            "{{!user}}/{{?char}}/{{~user}}/{{>user}}", "{{charVersion}}/{{greeting::1}}/{{mesExamples}}/{{model}}/{{maxPrompt}}",
            "{{isodate}}/{{time::UTC+2}}/{{datetimeformat::YYYY-MM-DD HH:mm:ss}}/{{weekday}}", "{{timeDiff::2026-10-11 00:00:00::2026-10-11 03:00:00}}",
            "{{pick::a::b::c}}/{{pick::a::b::c}}/{{random::a::b::c}}/{{random::1::2::3}}/{{roll::2d20+3}}",
        ];
        const expected = await runNativeOracle(bindings, texts);
        for (const [index, text] of texts.entries()) {
            expect(expand(text), text).toBe(expected[index]!.text);
            expect(state, text).toEqual(expected[index]!.state);
        }
    });
});
