import {describe, expect, it} from "vitest";
import {createMappedTavernImport} from "nbook/shared/prompt-management/tavern-bindings";
import {compileWriterTavern} from "nbook/server/prompt-management/render";
import {TavernWriterPresetSchema, type TavernWriterPreset} from "nbook/shared/dto/tavern-preset.dto";
import {changeWriterSectionMode, moveTavernPromptGroup, parseEditableTavernSource, removeTavernPrompts, tavernEditorOrder} from "./tavern-editor";

function fixture(): TavernWriterPreset {
    const sourceJson = JSON.stringify({extra: "保留", prompts: [{identifier: "rule", role: "system", content: "规则 {{setvar::count::0}}{{incvar::count}}"},
        {identifier: "scenario", marker: true}, {identifier: "chatHistory", marker: true}],
    prompt_order: [{character_id: 100001, extra: true, order: ["rule", "scenario", "chatHistory"].map(identifier => ({identifier, enabled: true, extra: "保留"}))},
        {character_id: 42, order: [{identifier: "scenario", enabled: true}]}]});
    return {sourceJson, ...createMappedTavernImport("writing.writer.scene", sourceJson), macroEngine: "native", extensionPolicy: "prompt-only"};
}

describe("酒馆条目顺序和使用方式", () => {
    it.each(["legacy", "native"] as const)("%s直接条目与映射互斥，按序列发送且插入资料不参与宏初始化，切回清理所有引用", macroEngine => {
        const original = fixture();
        original.macroEngine = macroEngine;
        const direct = changeWriterSectionMode(original, "writing.writer.scene", "overview", "prompt", "writer-overview");
        expect(direct.writerMappings!.overview).toMatchObject({kind: "prompt", name: "writer-overview"});
        const source = parseEditableTavernSource(direct.sourceJson);
        moveTavernPromptGroup(source, ["writer-overview"], "rule");
        const variables = Object.fromEntries([...direct.sourceJson.matchAll(/\{\{(\w+)\}\}/gu)].map(match => [match[1]!, "占位"]));
        // Only the selected direct section is needed for this boundary assertion.
        const compiled = compileWriterTavern("writing.writer.scene", {...direct, sourceJson: JSON.stringify(source), writerMappings: {overview: direct.writerMappings!.overview!}},
            {...variables, overview: "审核总览 {{setvar::count::999}}"}, ["overview"]);
        expect(compiled.messages[0]).toEqual({role: "user", content: "## 章节总览\n\n审核总览 {{setvar::count::999}}"});
        expect(compiled.variablesAfter.local.count).toBe("1");
        expect(() => compileWriterTavern("writing.writer.scene", {...direct, writerMappings: {overview: {kind: "prompt", name: "missing"}}}, {overview: "资料"}, ["overview"])).toThrow("不存在");
        const back = changeWriterSectionMode(direct, "writing.writer.scene", "overview", "mapping", "unused");
        expect(back.writerMappings!.overview).toEqual(original.writerMappings!.overview);
        expect(parseEditableTavernSource(back.sourceJson).prompts.some(prompt => prompt.identifier === "writer-overview")).toBe(false);
        expect(original.sourceJson).not.toContain("writer-overview");
    });
    it("切换方式保存直接模板改动，完整配置重开后恢复，彻底删除同时清理缓存", () => {
        const preset = fixture();
        preset.writerMappings!.overview = {kind: "slot", name: "chatHistory"};
        const direct = changeWriterSectionMode(preset, "writing.writer.scene", "overview", "prompt", "first");
        const source = parseEditableTavernSource(direct.sourceJson);
        Object.assign(source.prompts.find(prompt => prompt.identifier === "first")!, {name: "自定义总览", content: "审核：{{overview}}", role: "assistant", injection_depth: 2, extra: "保留"});
        const mapped = changeWriterSectionMode({...direct, sourceJson: JSON.stringify(source)}, "writing.writer.scene", "overview", "mapping", "unused");
        expect(mapped.writerMappings!.overview).toEqual({kind: "slot", name: "chatHistory"});
        const restored = changeWriterSectionMode(TavernWriterPresetSchema.parse(JSON.parse(JSON.stringify(mapped))), "writing.writer.scene", "overview", "prompt", "second");
        expect(parseEditableTavernSource(restored.sourceJson).prompts.find(prompt => prompt.identifier === "second")).toMatchObject({name: "自定义总览", content: "审核：{{overview}}", role: "assistant", injection_depth: 2, extra: "保留"});
        expect(removeTavernPrompts(restored, ["second"]).writerDirectDrafts!.overview).toBeUndefined();
    });
    it("深度直接条目保留资料字面宏文本，并拒绝编辑时丢失必需变量", () => {
        const direct = changeWriterSectionMode(fixture(), "writing.writer.scene", "overview", "prompt", "writer-overview");
        direct.writerMappings = {overview: direct.writerMappings!.overview!};
        const source = parseEditableTavernSource(direct.sourceJson);
        const entry = source.prompts.find(prompt => prompt.identifier === "writer-overview")!;
        entry.injection_position = 1; entry.injection_depth = 0;
        direct.sourceJson = JSON.stringify(source);
        const compiled = compileWriterTavern("writing.writer.scene", direct, {overview: "总览 {{getvar::count}}"}, ["overview"]);
        expect(compiled.messages.map(message => message.content).join("\n")).toContain("总览 {{getvar::count}}");
        entry.content = "删除了变量"; direct.sourceJson = JSON.stringify(source);
        expect(() => compileWriterTavern("writing.writer.scene", direct, {overview: "总览"}, ["overview"])).toThrow("必需写作条目");
    });
    it("彻底删除清除所有角色顺序和资料绑定，保留失效映射，直接项删除回到未映射", () => {
        const preset = changeWriterSectionMode(fixture(), "writing.writer.scene", "overview", "prompt", "direct");
        preset.bindings.slots.scenario = [{role: "system", content: "手工资料"}];
        const removed = removeTavernPrompts(preset, ["scenario", "direct"]);
        const source = parseEditableTavernSource(removed.sourceJson);
        expect(source.prompts.map(prompt => prompt.identifier)).toEqual(["rule", "chatHistory"]);
        expect(source.prompt_order[1]!.order).toEqual([]);
        expect(source.extra).toBe("保留");
        expect(removed.bindings.slots.scenario).toBeUndefined();
        expect(removed.writerMappings!.overview).toBeNull();
        expect(removed.writerMappings!.plot).toEqual({kind: "slot", name: "scenario"});
        expect(preset.bindings.slots.scenario).toHaveLength(1);
    });
    it("非连续多选按原相对顺序整体移动，保留顺序元数据和未选条目", () => {
        const source = parseEditableTavernSource(fixture().sourceJson);
        moveTavernPromptGroup(source, ["rule", "chatHistory"], "scenario");
        expect(tavernEditorOrder(source).map(entry => entry.identifier)).toEqual(["scenario", "rule", "chatHistory"]);
        expect(tavernEditorOrder(source).every(entry => entry.extra === "保留")).toBe(true);
        moveTavernPromptGroup(source, ["rule", "chatHistory"], "scenario");
        expect(tavernEditorOrder(source).map(entry => entry.identifier)).toEqual(["rule", "chatHistory", "scenario"]);
    });
});
