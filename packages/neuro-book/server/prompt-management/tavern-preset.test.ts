import {readFile} from "node:fs/promises";
import {describe, expect, it} from "vitest";
import {compileTavernPreset, expandTavernMacros, applyTavernRegex, parseTavernPreset, inspectTavernPreset, tavernPromptsForGeneration} from "./tavern-preset";
import type {TavernBindings} from "nbook/shared/dto/tavern-preset.dto";
import {createTavernMacroEvaluator} from "./tavern-macros";

const identity = {user: "作者角色", char: "叙事者"};
const source = (prompts: unknown[], order: unknown[]) => JSON.stringify({prompts, prompt_order: [{character_id: 100000, order: []}, {character_id: 100001, order}], new_chat_prompt: ""});
const ordered = (...ids: string[]) => ids.map(identifier => ({identifier, enabled: true}));

describe("酒馆预设的编排合同", () => {
    it("查找正则支持原样与逐宏转义，保留表达式字面语法和变量副作用", async () => {
        for (const macroEngine of ["legacy", "native"] as const) for (const substituteRegex of [0, 1, 2]) {
            const state = {local: {pattern: "a.b"}, global: {}};
            const bindings = {user: "a.b", char: "Writer", slots: {}};
            const expand = createTavernMacroEvaluator(bindings, bindings, state, macroEngine);
            const script = {scriptName: "find macros", findRegex: "/^({{getvar::pattern}})$/g", replaceString: "[$1]",
                placement: [2], promptOnly: true, substituteRegex, trimStrings: []};
            const preset = parseTavernPreset(JSON.stringify({prompts: [], prompt_order: [{character_id: 100001, order: []}], extensions: {regex_scripts: [script]}}));
            expect(applyTavernRegex(preset, "a.b", 2, "prompt", 0, bindings, state, expand)).toBe(substituteRegex ? "[a.b]" : "a.b");
            expect(applyTavernRegex(preset, "axb", 2, "prompt", 0, bindings, state, expand)).toBe(substituteRegex === 1 ? "[axb]" : "axb");
            if (process.env.NBOOK_TAVERN_UPSTREAM_DIR && macroEngine === "legacy") {
                const {createOracle} = await import("nbook/scripts/smoke/tavern-upstream-oracle.mjs");
                const oracle = createOracle(preset, {...bindings, localVariables: state.local});
                for (const text of ["a.b", "axb"]) expect(applyTavernRegex(preset, text, 2, "prompt", 0, bindings, state, expand))
                    .toBe(oracle.regex(text, [script], 2, {isPrompt: true, depth: 0}));
            }
            if (substituteRegex) {
                preset.extensions!.regex_scripts![0]!.findRegex = "/^{{incvar::n}}$/";
                expect(applyTavernRegex(preset, "1", 2, "prompt", 0, bindings, state, expand)).toBe("[]");
                expect(state.local).toMatchObject({n: "1"});
            }
        }
    });
    it("名称模式仅影响历史：CONTENT前缀排除system，COMPLETION清洗name，其他模式移除name", () => {
        const preset = JSON.parse(source([{identifier: "chatHistory", marker: true}], ordered("chatHistory")));
        const bindings: TavernBindings = {user: "Author", char: "Writer", slots: {chatHistory: [
            {role: "user", name: "作 者", content: "ask\r\nnext"}, {role: "assistant", content: "answer"},
            {role: "system", name: "Narrator", content: "note"},
        ]}};
        for (const names_behavior of [-1, 0, 1, 2]) {
            preset.names_behavior = names_behavior;
            expect(compileTavernPreset(JSON.stringify(preset), bindings).messages).toEqual([
                {role: "user", content: names_behavior === 2 ? "作 者: ask\nnext" : "ask\nnext", ...(names_behavior === 1 ? {name: "___"} : {})},
                {role: "assistant", content: names_behavior === 2 ? "Writer: answer" : "answer", ...(names_behavior === 1 ? {name: "Writer"} : {})},
                {role: "system", content: "note", ...(names_behavior === 1 ? {name: "Narrator"} : {})},
            ]);
        }
        preset.continue_prefill = true;
        expect(compileTavernPreset(JSON.stringify(preset), {...bindings, generationType: "continue"}).messages.at(-1)?.name).toBeUndefined();
        preset.names_behavior = 1;
        expect(compileTavernPreset(JSON.stringify(preset), {...bindings, generationType: "continue"}).messages.at(-1)?.name).toBe("Narrator");
    });
    it("按类别求值、保留短宏、身份与来源角色无关，兼容旧式 user 标签", () => {
        const state = {local: {}, global: {}};
        expect(expandTavernMacros("{{getvar::x}}/{{setvar:: x ::02}}/{{getvar::x}}/<user>/{{char}}/{{setvar::missing}}", identity, state))
            .toBe("2//2/作者角色/叙事者/{{setvar::missing}}");
        expect(state.local).toEqual({x: "02"});
        expect(expandTavernMacros("{{getvar::constructor}}/{{getvar::__proto__}}", identity, state)).toBe("/");
    });
    it("按全局 order 启用普通条目，资料槽位后求值，空白保留而空串过滤", () => {
        const raw = source([
            {identifier: "off", role: "system", content: "{{setvar::x::wrong}}"},
            {identifier: "init", enabled: false, role: "assistant", content: "{{setvar::x::right}}"},
            {identifier: "charDescription", marker: true, role: "user"},
            {identifier: "read", role: "user", content: "{{getvar::x}}"},
            {identifier: "space", role: "system", content: "  "},
        ], [...ordered("charDescription", "init", "read", "space"), {identifier: "off", enabled: false}]);
        const result = compileTavernPreset(raw, {...identity, slots: {charDescription: [{role: "system", content: "{{getvar::x}} character"}]}});
        expect(result.messages).toEqual([{role: "user", content: "right character"}, {role: "user", content: "right"}, {role: "system", content: "  "}]);
        expect(result.variablesAfter.local).toEqual({x: "right"});
    });
    it("历史最新消息先求值，最终历史依旧按时间排序", () => {
        const raw = source([{identifier: "chatHistory", marker: true}], ordered("chatHistory"));
        const result = compileTavernPreset(raw, {...identity, slots: {chatHistory: [
            {role: "assistant", content: "old={{getvar::x}}"}, {role: "user", content: "new{{setvar::x::2}}"},
        ]}});
        expect(result.messages).toEqual([{role: "assistant", content: "old=2"}, {role: "user", content: "new"}]);
    });
    it("未知机制拒绝编译；任意插件保留为依赖，不执行源码", () => {
        const raw = JSON.stringify({prompts: [{identifier: "a", role: "system", content: "ok"}], prompt_order: [{character_id: 100001, order: ordered("a")}],
            extensions: {tavern_helper: {scripts: [{name: "reply-hook", enabled: true, content: "throw new Error('never run')"}]}}});
        expect(inspectTavernPreset(raw)).toMatchObject({promptSupported: true, extensionDependencies: ["reply-hook"], fullEnvironmentEquivalent: false});
        expect(() => compileTavernPreset(source([{identifier: "a", role: "system", content: "{{plugin_macro::x}}"}], ordered("a")), {...identity, slots: {}})).toThrow("未支持");
        expect(() => compileTavernPreset(source([{identifier: "a", role: "system", content: "x", injection_position: 2}], ordered("a")), {...identity, slots: {}})).toThrow("unknown injection position");
        const formatted = JSON.parse(raw);
        formatted.new_chat_prompt = "{{plugin_macro::x}}";
        expect(() => compileTavernPreset(JSON.stringify(formatted), {...identity, slots: {}})).toThrow("new_chat_prompt");
    });
    it("正则阶段分离、深度边界包含、普通模式不自动全局替换，支持第零捕获", () => {
        const raw = JSON.stringify({prompts: [], prompt_order: [{character_id: 100001, order: []}], extensions: {regex_scripts: [
            {scriptName: "prompt", findRegex: "a", replaceString: "$0/b", placement: [2], promptOnly: true, minDepth: 2, maxDepth: 4},
            {scriptName: "display", findRegex: "/a/g", replaceString: "d", placement: [2], markdownOnly: true},
        ]}});
        const preset = parseTavernPreset(raw);
        expect(applyTavernRegex(preset, "aaa", 2, "prompt", 1)).toBe("aaa");
        expect(applyTavernRegex(preset, "aaa", 2, "prompt", 2)).toBe("a/baa");
        expect(applyTavernRegex(preset, "aaa", 2, "prompt", 4)).toBe("a/baa");
        expect(applyTavernRegex(preset, "aaa", 2, "prompt", 5)).toBe("aaa");
        expect(applyTavernRegex(preset, "aaa", 2, "prompt")).toBe("a/baa");
        expect(applyTavernRegex(preset, "aaa", 2, "display", 0)).toBe("ddd");
        expect(applyTavernRegex(preset, "aaa", 2, "stored", 0)).toBe("aaa");
    });
    it("未勾选promptOnly/markdownOnly的正则仅在存储阶段执行一次", () => {
        const preset = parseTavernPreset(JSON.stringify({prompts: [], prompt_order: [{character_id: 100001, order: []}], extensions: {regex_scripts: [
            {scriptName: "stored", findRegex: "a", replaceString: "aa", placement: [2]},
        ]}}));
        const stored = applyTavernRegex(preset, "a", 2, "stored", 0);
        expect(stored).toBe("aa");
        expect(applyTavernRegex(preset, stored, 2, "display", 0)).toBe("aa");
        expect(applyTavernRegex(preset, stored, 2, "prompt", 0)).toBe("aa");
    });
    it("generation triggers在宏求值前过滤，旧预设的空字符串trigger仍然总是生效", () => {
        const raw = source([
            {identifier: "normal", role: "system", content: "{{setvar::x::normal}}normal", injection_trigger: ["normal"]},
            {identifier: "continue", role: "system", content: "{{setvar::x::continue}}continue", injection_trigger: ["continue"]},
            {identifier: "legacy", role: "system", content: "{{getvar::x}}", injection_trigger: ""},
        ], ordered("normal", "continue", "legacy"));
        expect(compileTavernPreset(raw, {...identity, slots: {}}).messages.map(message => message.content)).toEqual(["normal", "normal"]);
    });
    it("必需资料验证可只看本次trigger生效的marker，而非所有启用marker", () => {
        const raw = source([
            {identifier: "charDescription", marker: true, injection_trigger: ["continue"]},
            {identifier: "personaDescription", marker: true, injection_trigger: ["normal"]},
            {identifier: "rule", role: "system", content: "rule", injection_trigger: ""},
        ], ordered("charDescription", "personaDescription", "rule"));
        expect(tavernPromptsForGeneration(parseTavernPreset(raw)).map(prompt => prompt.identifier)).toEqual(["personaDescription", "rule"]);
        expect(tavernPromptsForGeneration(parseTavernPreset(raw), "continue").map(prompt => prompt.identifier)).toEqual(["charDescription", "rule"]);
        expect(compileTavernPreset(raw, {...identity, slots: {personaDescription: [{role: "system", content: "present"}]}}).messages)
            .toEqual([{role: "system", content: "present"}, {role: "system", content: "rule"}]);
    });
    it("SPreset配置和条件脚本仅报告扩展依赖，原生条目按enabled生效", () => {
        const raw = source([{identifier: "SPresetSettings", content: '{"MacroNest":{"enabled":true}}'},
            {identifier: "a", role: "system", content: "a"}], ordered("a"));
        expect(inspectTavernPreset(raw).extensionDependencies).toContain("SPresetSettings: extension runtime configuration");
        const result = compileTavernPreset(source([{identifier: "a", role: "system", content: "a", spreset_condition_script: "throw new Error('must not execute')"}], ordered("a")),
            {...identity, slots: {}});
        expect(result.report.extensionDependencies).toContain("a: SPreset condition script");
        expect(result.messages).toEqual([{role: "system", content: "a"}]);
    });
    it("深度从最后一条历史算起，同深度按优先级和角色合并，超过历史长度的注入放在开头", () => {
        const raw = source([
            {identifier: "chatHistory", marker: true},
            {identifier: "tail", role: "system", content: " tail ", injection_position: 1, injection_depth: 0},
            {identifier: "first", role: "system", content: " a ", injection_position: 1, injection_depth: 1, injection_order: 100},
            {identifier: "second", role: "system", content: "b", injection_position: 1, injection_depth: 1, injection_order: 100},
            {identifier: "user", role: "user", content: "u", injection_position: 1, injection_depth: 1, injection_order: 100},
            {identifier: "priority", role: "assistant", content: "p", injection_position: 1, injection_depth: 1, injection_order: 200},
            {identifier: "far", role: "system", content: "far", injection_position: 1, injection_depth: 8},
        ], ordered("chatHistory", "tail", "first", "second", "user", "priority", "far"));
        expect(compileTavernPreset(raw, {...identity, slots: {chatHistory: [{role: "user", content: "old"}, {role: "assistant", content: "new"}]}}).messages)
            .toEqual([{role: "system", content: "far"}, {role: "user", content: "old"}, {role: "user", content: "u"},
                {role: "system", content: "a \nb"}, {role: "assistant", content: "p"}, {role: "assistant", content: "new"}, {role: "system", content: "tail"}]);
        expect(() => compileTavernPreset(raw, {...identity, slots: {}})).toThrow("显式绑定");
    });
    it("多条历史续写将最新消息移到尾部，lastChatMessage宏保留原续写文本", () => {
        const preset = JSON.parse(source([{identifier: "chatHistory", marker: true}, {identifier: "end", role: "system", content: "end"}], ordered("chatHistory", "end")));
        preset.continue_nudge_prompt = "continue {{lastChatMessage}}";
        const bindings: TavernBindings = {...identity, generationType: "continue", slots: {chatHistory: [
            {role: "user", content: "old={{getvar::x}}"}, {role: "assistant", content: "new{{setvar::x::2}}"},
        ]}};
        expect(compileTavernPreset(JSON.stringify(preset), bindings).messages).toEqual([
            {role: "user", content: "old=2"}, {role: "system", content: "end"}, {role: "assistant", content: "new"}, {role: "system", content: "continue new"},
        ]);
        preset.continue_prefill = true;
        expect(compileTavernPreset(JSON.stringify(preset), bindings).messages.at(-1)).toEqual({role: "assistant", content: "new{{setvar::x::2}}"});
        expect(() => compileTavernPreset(JSON.stringify(preset), {...bindings, slots: {chatHistory: []}})).toThrow("至少一条");
    });
});

describe.skipIf(!process.env.NBOOK_TAVERN_UPSTREAM_DIR)("固定上游的深度与续写编排对照", () => {
    it("COMPLETION历史名称与prefill按固定原函数清洗并保留", async () => {
        const {createOracle} = await import("nbook/scripts/smoke/tavern-upstream-oracle.mjs");
        for (const generationType of ["normal", "continue"] as const) for (const continue_prefill of [false, true]) {
            const preset = {...JSON.parse(source([{identifier: "chatHistory", marker: true}], ordered("chatHistory"))), names_behavior: 1, continue_prefill, continue_nudge_prompt: "Continue"};
            const history = [{role: "user" as const, name: "Author_Name", content: "task"}, {role: "assistant" as const, name: "写 手-1😀", content: "text"}];
            const expected = await createOracle(preset, {...identity, generationType, history}).compile();
            expect(compileTavernPreset(JSON.stringify(preset), {...identity, generationType, slots: {chatHistory: history}}).messages).toEqual(expected.messages);
        }
    });
    it("深度、trigger、多历史续写与prefill复用原上游函数核对", async () => {
        const {createOracle} = await import("nbook/scripts/smoke/tavern-upstream-oracle.mjs");
        for (const generationType of ["normal", "continue"] as const) for (const prefill of [false, true]) {
            const preset = {prompts: [
                {identifier: "chatHistory", marker: true, system_prompt: true},
                {identifier: "init", role: "system", content: "{{setvar::x::2}}", system_prompt: false},
                {identifier: "relative", role: "system", content: "relative", system_prompt: false},
                {identifier: "depth", role: "system", content: " depth {{getvar::x}} ", system_prompt: false,
                    injection_position: 1, injection_depth: 0, injection_order: 100},
                {identifier: "deep", role: "user", content: "before", system_prompt: false, injection_position: 1, injection_depth: 2, injection_order: 100},
                {identifier: "trigger", role: "system", content: "continuing", system_prompt: false, injection_trigger: ["continue"]},
            ], prompt_order: [{character_id: 100001, order: ordered("init", "chatHistory", "relative", "depth", "deep", "trigger")}],
            new_chat_prompt: "START", continue_prefill: prefill, continue_nudge_prompt: "Continue {{lastChatMessage}}"};
            const history = [{role: "user" as const, content: "one"}, {role: "assistant" as const, content: "two"}, {role: "assistant" as const, content: "three"}];
            const expected = await createOracle(preset, {...identity, history, generationType}).compile();
            const actual = compileTavernPreset(JSON.stringify(preset), {...identity, generationType, slots: {chatHistory: history}});
            expect(actual.messages).toEqual(expected.messages);
            expect(actual.variablesAfter).toEqual({local: expected.localVariables, global: expected.globalVariables});
        }
    });
});

const samplePath = process.env.NBOOK_TAVERN_SAMPLE;
describe.skipIf(!samplePath)("开发者提供的图灵真实预设", () => {
    it("原始文件指纹、初始化变量、短宏及不同阶段的历史过滤", async () => {
        const raw = await readFile(samplePath!, "utf8");
        const slots: TavernBindings["slots"] = Object.fromEntries(["worldInfoBefore", "worldInfoAfter", "charDescription", "charPersonality", "scenario", "personaDescription",
            "dialogueExamples", "chatHistory", "agentTask", "agentSystemPrompt", "agentResults"].map(id => [id, []]));
        slots.chatHistory = [{role: "assistant", content: "<content>前文</content><build>构建</build><锐评>评语</锐评><math>上轮记录</math>"}, {role: "user", content: "审核后的写作任务"}];
        const result = compileTavernPreset(raw, {...identity, slots});
        expect(result.report).toMatchObject({sourceSha256: "4ca46dc936a6c63434c556a9ac314c6ae33162ab871c5376699d352c0b82a23f", prompts: 120, active: 57, regexes: 17, unsupported: []});
        expect(Object.keys(result.variablesAfter.local)).toHaveLength(50);
        expect(result.variablesAfter.local.turing_banyan).toContain("用户扮演");
        expect(result.messages.filter(message => message.content.includes("{{setvar::mokuai}}"))).toHaveLength(1);
        expect(result.messages.find(message => message.role === "assistant" && message.content.includes("<content>前文"))?.content).toBe("<content>前文</content><math>上轮记录</math>");
        expect(result.messages.some(message => message.content.includes("{{getvar::"))).toBe(false);
    });
});
