import {describe, expect, it} from "vitest";
import {TavernWriterPresetSchema, type TavernWriterPreset} from "nbook/shared/dto/tavern-preset.dto";
import {createMappedTavernImport} from "./tavern-bindings";
import {createDefaultWriterMappings, discoverWriterMappingFields, enableWriterMappings, materializeWriterMappings, writerMappingSections} from "./tavern-writer-mapping";
import {compileWriterTavern} from "nbook/server/prompt-management/render";
import {loadWritingPromptDefinitions} from "nbook/server/prompt-management/writing-catalog";

const purposeId = "writing.writer.scene";
function source(content: string, extra: {identifier: string; marker?: boolean; content?: string; role?: string; enabled?: boolean; injection_trigger?: string[]}[] = []) {
    const prompts = [{identifier: "rule", role: "system", content}, ...extra];
    return JSON.stringify({new_chat_prompt: "", prompts, prompt_order: [{character_id: 100001, order: prompts.map(prompt => ({identifier: prompt.identifier, enabled: !("enabled" in prompt) || prompt.enabled !== false}))}]});
}
function fixture(engine: "legacy" | "native" = "legacy") {
    const sourceJson = source("{{getvar::facts}}{{setvar::facts::默认资料}}{{setglobalvar::facts::全局默认}}{{incvar::counter}}\n{{getglobalvar::facts}}");
    const tavern: TavernWriterPreset = {sourceJson, ...createMappedTavernImport(purposeId, sourceJson), macroEngine: engine, extensionPolicy: "prompt-only"};
    const definition = loadWritingPromptDefinitions().find(value => value.purposeId === purposeId)!;
    const variables = Object.fromEntries(definition.variables.map(name => [name, `已审核-${name}`]));
    return {tavern, definition, variables};
}

describe("写作条目映射合同", () => {
    it("静态发现固定变量、资料宏、停用字段和动态名称，局部全局同名保持独立", () => {
        const found = discoverWriterMappingFields(source("{{setvar::same::默认}}{{getvar::same}}{{getglobalvar::same}}{{.short}}{{ $wide }}{{description}}{{setvar::{{user}}::动态}}", [
            {identifier: "scenario", marker: true}, {identifier: "disabled", role: "system", content: "{{getvar::off}}", enabled: false},
            {identifier: "continue", role: "system", content: "{{getvar::later}}", injection_trigger: ["continue"]},
        ]));
        expect(found.fields).toEqual(expect.arrayContaining([
            {kind: "local", name: "same", active: true, read: true}, {kind: "global", name: "same", active: true, read: true},
            {kind: "local", name: "short", active: true, read: true}, {kind: "global", name: "wide", active: true, read: true},
            {kind: "slot", name: "charDescription", active: true, read: true}, {kind: "slot", name: "scenario", active: true, read: true},
            {kind: "local", name: "off", active: false, read: false}, {kind: "local", name: "later", active: false, read: false},
        ]));
        expect(found.dynamicNames).toHaveLength(1);
        expect(found.fields.some(field => field.name === "user")).toBe(false);
    });
    it.each(["legacy", "native"] as const)("%s先初始化一次，再覆盖映射，最终提示和终态均采用写作资料", engine => {
        const {tavern, definition, variables} = fixture(engine);
        const compiled = compileWriterTavern(purposeId, tavern, variables, definition.requiredVariables ?? [], undefined, {local: {counter: "4", facts: "持久化旧资料"}, global: {}});
        expect(compiled.variablesAfter.local.counter).toBe("5");
        expect(compiled.variablesAfter.global.facts).toBe("全局默认");
        expect(compiled.variablesAfter.local.facts).toContain("已审核-requirements");
        expect(compiled.messages.map(message => message.content).join("\n")).toContain("已审核-sceneDescription");
        expect(compiled.messages.map(message => message.content).join("\n")).not.toContain("默认资料");
        expect(compiled.variablesAfter.local.facts).not.toContain("只输出本场景正文");
        expect(tavern.bindings.localVariables).toBeUndefined();
        expect(tavern.sourceJson).toContain("默认资料");
    });
    it("多个条目按原顺序合并，同名局部全局可分别映射", () => {
        const {tavern, variables} = fixture();
        tavern.writerMappings = {"style-requirements": {kind: "global", name: "facts"}, overview: {kind: "local", name: "facts"}, plot: {kind: "local", name: "facts"}};
        const compiled = compileWriterTavern(purposeId, tavern, variables, []);
        expect(compiled.variablesAfter.global.facts).toContain("文风要求");
        expect(compiled.variablesAfter.local.facts).toBe("## 章节总览\n\n已审核-overview\n\n## 具体情节\n\n已审核-plot");
    });
    it("无marker的资料宏也可接收映射，资料映射优先于旧宏环境人物字段", () => {
        const {definition, variables} = fixture("native");
        const sourceJson = source("{{description}}");
        const tavern: TavernWriterPreset = {sourceJson, ...createMappedTavernImport(purposeId, sourceJson), macroEngine: "native", extensionPolicy: "prompt-only"};
        tavern.bindings.nativeContext = {character: {description: "旧描述"}};
        const result = compileWriterTavern(purposeId, tavern, variables, definition.requiredVariables ?? []);
        expect(result.messages[0]!.content).toContain("已审核-characters");
        expect(result.messages[0]!.content).not.toContain("旧描述");
        expect(tavern.bindings.nativeContext.character!.description).toBe("旧描述");
    });
    it("仅定义未读取、停用或消失的目标拒绝；未映射必需条目拒绝", () => {
        const {tavern, definition, variables} = fixture();
        tavern.writerMappings!.overview = null;
        expect(() => compileWriterTavern(purposeId, tavern, variables, definition.requiredVariables ?? [])).toThrow("章节总览");
        tavern.writerMappings!.overview = {kind: "local", name: "missing"};
        expect(() => compileWriterTavern(purposeId, tavern, variables, [])).toThrow("不可用");
        const onlySet = source("{{setvar::facts::默认}}");
        expect(() => materializeWriterMappings(purposeId, onlySet, tavern.bindings, {overview: {kind: "local", name: "facts"}})).toThrow("未被读取");
    });
    it("条件未实际读取映射内容时不能用静态发现骗过必需资料检查", () => {
        const {tavern, definition, variables} = fixture("native");
        tavern.sourceJson = source("{{if false}}{{getvar::facts}}{{/if}}");
        expect(() => compileWriterTavern(purposeId, tavern, variables, definition.requiredVariables ?? [])).toThrow("未进入最终提示词");
    });
    it("旧配置缺少映射字段时保持序列化，显式转换不重复已知条目且保留手工资料", () => {
        const sourceJson = source("规则", [{identifier: "scenario", marker: true}]);
        const legacy: TavernWriterPreset = {sourceJson, macroEngine: "legacy", extensionPolicy: "prompt-only", bindings: {user: "作者", char: "写手", slots: {scenario: [{role: "system", content: "手工资料\n\n## 章节总览\n\n{{overview}}"}]}}};
        expect(TavernWriterPresetSchema.parse(legacy)).toEqual(legacy);
        const converted = enableWriterMappings(purposeId, sourceJson, legacy.bindings);
        expect(converted.writerMappings.overview).toEqual({kind: "slot", name: "scenario"});
        expect(converted.bindings.slots.scenario).toEqual([{role: "system", content: "手工资料"}]);
        expect(legacy.bindings.slots.scenario![0]!.content).toContain("{{overview}}");
        expect(writerMappingSections("writing.writer.rewrite")).toHaveLength(12);
        expect(Object.keys(createDefaultWriterMappings(purposeId, sourceJson))).not.toContain("role");
    });
    it("预算裁剪映射历史导致必需资料缺失时拒发", () => {
        const sourceJson = source("规则", [{identifier: "chatHistory", marker: true}]);
        const {definition, variables} = fixture();
        const tavern: TavernWriterPreset = {sourceJson, ...createMappedTavernImport(purposeId, sourceJson), macroEngine: "legacy", extensionPolicy: "prompt-only"};
        expect(() => compileWriterTavern(purposeId, tavern, variables, definition.requiredVariables ?? [], {
            tokenizer: "cl100k_base", contextTokens: 100, responseTokens: 10, pinExamples: false, count: message => message.content.length,
        })).toThrow("必需写作条目");
    });
});
