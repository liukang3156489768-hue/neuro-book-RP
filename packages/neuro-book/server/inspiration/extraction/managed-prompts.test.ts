import {beforeEach, describe, expect, it, vi} from "vitest";
import {PromptPurposeDefinitionSchema, PromptSnapshotSchema, type PromptSnapshot} from "nbook/shared/dto/prompt-management.dto";
import {loadExtractionPromptDefinitions} from "nbook/server/prompt-management/extraction-catalog";
import {renderManagedPrompt} from "nbook/server/prompt-management/render";
import {callWithRepair} from "./repair";
import {createScriptedModel} from "./testing";
import {CHARACTER_OUTPUT_CONTRACT, characterDiscoveryGoal, characterExtractionTemplate, characterFocusedExtractionGoal, documentExtractionGoal, documentIntegrationGoal, entityIntegrationGoal, mergeItemsGoal} from "./material-prompts";
import {materialCategorySpec} from "./material-data";
import {validateEntityOutput} from "./material-extract";

const state = vi.hoisted(() => ({snapshots: new Map<string, PromptSnapshot>(), reads: vi.fn()}));
vi.mock("nbook/server/prompt-management/service", () => ({usePromptManagement: () => ({
    readSnapshot: async (id: string) => {state.reads(id); const snapshot = state.snapshots.get(id); if (!snapshot) throw new Error("快照不存在"); return snapshot;},
})}));

function builtinSnapshot(): PromptSnapshot {
    return PromptSnapshotSchema.parse({schemaVersion: 1, id: "a".repeat(64), purposes: Object.fromEntries(
        loadExtractionPromptDefinitions().map(definition => [definition.purposeId, {presetId: "builtin", presetRevision: 1, entries: definition.entries}]),
    )});
}
beforeEach(() => {state.snapshots.clear(); state.reads.mockClear();});

describe("managed extraction prompts", () => {
    it("抽象化素材的提取与整合提示词禁止绑定原作专名和连续剧情", () => {
        const technique = materialCategorySpec("writing-technique");
        const feature = materialCategorySpec("material-feature");
        const system = materialCategorySpec("system");
        for (const prompt of [
            documentExtractionGoal(technique, {firstParagraphId: "P1", lastParagraphId: "P2"}, {maxEntries: 3, titleField: "标题"}),
            documentIntegrationGoal(feature, {maxEntries: 3, titleField: "标题"}),
            entityIntegrationGoal(system),
            mergeItemsGoal(technique),
        ]) {
            expect(prompt).toContain("不得出现原作中的人物姓名");
            expect(prompt).toContain("不得复述连续事件链");
        }
    });

    it("新快照的提取与修复保留全部有序角色，原文只追加一次", async () => {
        const snapshot = builtinSnapshot();
        const purpose = snapshot.purposes["extraction.character.discovery"]!;
        purpose.messageOrder = "configured";
        purpose.entries = [
            {id: "s1", name: "规则1", role: "system", content: "规则1"},
            {id: "u", name: "目标", role: "user", content: "目标 {{range}}"},
            {id: "s2", name: "规则2", role: "system", content: "规则2"},
            {id: "a", name: "示例", role: "assistant", content: "示例输出"},
        ];
        snapshot.purposes["extraction.repair"]!.messageOrder = "configured";
        state.snapshots.set(snapshot.id, snapshot);
        const model = createScriptedModel((_, index) => index === 0 ? "invalid" : "valid");
        await callWithRepair({model, signal: new AbortController().signal, promptSnapshotId: snapshot.id,
            purposeId: "extraction.character.discovery", variables: {range: "P1-P2"},
            prompt: {prefix: "原文标记", goal: "旧目标"}, validate: output => output === "valid" ? {ok: true, value: output} : {ok: false, error: "格式错误"}});
        expect(model.requests[0]!.orderedMessages).toEqual([
            {role: "system", content: "规则1"}, {role: "user", content: "目标 P1-P2"},
            {role: "system", content: "规则2"}, {role: "assistant", content: "示例输出"}, {role: "user", content: "原文标记"},
        ]);
        expect(model.requests[1]!.orderedMessages?.slice(0, 5)).toEqual(model.requests[0]!.orderedMessages);
        expect(model.requests[1]!.orderedMessages?.filter(message => message.content === "原文标记")).toHaveLength(1);
        expect(model.requests[1]!.orderedMessages?.at(-1)?.content).toContain("invalid");
    });

    it("逐角色提取的自定义有序预设固定为系统、原文、模板、动态任务", async () => {
        const snapshot = builtinSnapshot();
        const purpose = snapshot.purposes["extraction.character.focused"]!;
        purpose.messageOrder = "configured";
        purpose.entries = [
            {id: "system", name: "系统规则", role: "system", content: "固定规则"},
            {id: "example-user", name: "模板说明", role: "user", content: "固定模板说明"},
            {id: "example-assistant", name: "示例", role: "assistant", content: "示例输出"},
            {id: "task", name: "任务", role: "user", content: "处理 {{characterName}}，范围 {{range}}"},
        ];
        state.snapshots.set(snapshot.id, snapshot);
        const model = createScriptedModel(() => "valid");
        await callWithRepair({model, signal: new AbortController().signal, promptSnapshotId: snapshot.id,
            purposeId: "extraction.character.focused", variables: {characterName: "角色甲", range: "P1-P2"},
            prompt: {prefix: "原文", supplements: ["角色字段模板"], goal: "旧目标"},
            validate: output => ({ok: true, value: output})});
        expect(model.requests[0]!.orderedMessages).toEqual([
            {role: "system", content: "固定规则"},
            {role: "user", content: "原文\n\n角色字段模板"},
            {role: "user", content: "固定模板说明"},
            {role: "assistant", content: "示例输出"},
            {role: "user", content: `处理 角色甲，范围 P1-P2\n\n${CHARACTER_OUTPUT_CONTRACT}`},
        ]);
    });
    it("registers real templates and fills character names, aliases and paragraph ranges", () => {
        const definitions = loadExtractionPromptDefinitions().map(value => PromptPurposeDefinitionSchema.parse(value));
        expect(new Set(definitions.map(value => value.purposeId)).size).toBe(definitions.length);
        const snapshot = builtinSnapshot();
        const range = {firstParagraphId: "P3", lastParagraphId: "P18"};
        expect(renderManagedPrompt(snapshot, "extraction.character.discovery", {range: "P3-P18"}).messages[0]!.content)
            .toBe(characterDiscoveryGoal(range));
        const name = '林“舟”';
        const goal = renderManagedPrompt(snapshot, "extraction.character.focused", {
            range: "P3-P18", characterName: name, characterNameJson: JSON.stringify(name),
            aliasesRule: "- 该角色已知别称：小林。命中这些称呼时仍写同一个 name。",
        }).messages[0]!.content;
        expect(goal).toBe(characterFocusedExtractionGoal(materialCategorySpec("character"), name, ["小林"], range));
        const example = JSON.parse(goal.split("输出格式：")[1]!);
        expect(Object.keys(example.entity.fields)).toEqual([...materialCategorySpec("character").fields]);
        expect(example.entity).toMatchObject({name, aliases: [], references: "", experiences: [], relationships: []});
        example.entity.fields.性格 = "沉稳";
        example.entity.references = "P3";
        expect(validateEntityOutput(materialCategorySpec("character"), range, {}, JSON.stringify({entities: [example.entity]})).ok).toBe(true);
    });

    it("旧快照缺少引用示例时仍收到结构合同，定向修复通过实际校验且保留前缀", async () => {
        const snapshot = builtinSnapshot();
        snapshot.purposes["extraction.character.focused"]!.entries.at(-1)!.content = '只提取 {{characterName}}。输出 {"entity":{"name":"{{characterName}}","aliases":[],"fields":{}}}';
        state.snapshots.set(snapshot.id, snapshot);
        const original = JSON.stringify(snapshot);
        const range = {firstParagraphId: "P3", lastParagraphId: "P18"};
        const spec = materialCategorySpec("character");
        const model = createScriptedModel((_request, index) => JSON.stringify({entity: {
            name: "甲", aliases: [], fields: index === 0 ? {性格: "沉稳", references: "P3"} : {性格: "沉稳"},
            ...(index === 0 ? {} : {references: "P3", experiences: [], relationships: []}),
        }}));
        await callWithRepair({model, signal: new AbortController().signal, promptSnapshotId: snapshot.id,
            purposeId: "extraction.character.focused", variables: {characterName: "甲"},
            prompt: {prefix: "【原文】\n【P3】甲性格沉稳。", supplements: [characterExtractionTemplate(spec, range)], goal: "提取甲"},
            validate: output => validateEntityOutput(spec, range, {}, JSON.stringify({entities: [JSON.parse(output).entity]})),
        });
        expect(model.requests).toHaveLength(2);
        expect(model.requests[0]!.orderedMessages?.at(-1)?.content).toContain(CHARACTER_OUTPUT_CONTRACT);
        expect(model.requests[1]!.orderedMessages?.at(-1)?.content).toContain("entity.references");
        expect(model.requests[1]!.orderedMessages?.slice(0, 2)).toEqual(model.requests[0]!.orderedMessages?.slice(0, 2));
        expect(model.requests[1]!.metadata?.prefixHash).toBe(model.requests[0]!.metadata?.prefixHash);
        expect(JSON.stringify(snapshot)).toBe(original);
    });

    it("sends configured roles, preserves source prefix, and uses the same snapshot for repair", async () => {
        const snapshot = builtinSnapshot();
        const preset = snapshot.purposes["extraction.character.discovery"]!;
        preset.entries[0]!.content = "自定义系统规则";
        preset.entries.splice(1, 0,
            {id: "example-user", name: "示例问题", role: "user", content: "示例用户"},
            {id: "example-assistant", name: "示例回答", role: "assistant", content: "示例回答"});
        snapshot.purposes["extraction.repair"]!.entries[0]!.content += "\n固定修复版本";
        state.snapshots.set(snapshot.id, snapshot);
        const model = createScriptedModel((_, index) => index === 0 ? "invalid" : "valid");
        await callWithRepair({model, signal: new AbortController().signal, promptSnapshotId: snapshot.id,
            purposeId: "extraction.character.discovery", variables: {range: "P3-P18"},
            prompt: {prefix: "【原文】\n【P3】角色出场", goal: "旧目标"},
            validate: output => output === "valid" ? {ok: true, value: output} : {ok: false, error: "格式错误"}});
        expect(model.requests).toHaveLength(2);
        expect(state.reads).toHaveBeenCalledOnce();
        expect(model.requests[0]!.system).toBe("自定义系统规则");
        expect(model.requests[0]!.preMessages).toEqual([{role: "user", content: "示例用户"}, {role: "assistant", content: "示例回答"}]);
        expect(model.requests[0]!.prompt).toMatch(/^【原文】\n【P3】角色出场\n\n【任务】/u);
        expect(model.requests[1]!.prompt.startsWith(model.requests[0]!.prompt)).toBe(true);
        expect(model.requests[1]!.prompt).toContain("固定修复版本");
    });

    it("keeps legacy tasks independent of global selections", async () => {
        const model = createScriptedModel(() => "ok");
        await callWithRepair({model, signal: new AbortController().signal,
            purposeId: "extraction.character.discovery", variables: {range: "P1-P3"}, system: "旧系统",
            prompt: {prefix: "原文", goal: "旧任务目标"}, validate: output => ({ok: true, value: output})});
        expect(state.reads).not.toHaveBeenCalled();
        expect(model.requests[0]).toMatchObject({system: "旧系统", prompt: "原文\n\n旧任务目标"});
    });
});
