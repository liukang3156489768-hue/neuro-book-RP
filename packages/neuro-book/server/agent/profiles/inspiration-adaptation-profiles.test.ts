import {describe, expect, it} from "vitest";
import {Value} from "typebox/value";
import mainDefinition from "nbook/assets/workspace/.nbook/agent/profiles/builtin/inspiration.profile";
import characterDefinition from "nbook/assets/workspace/.nbook/agent/profiles/builtin/inspiration.character.profile";
import factionDefinition from "nbook/assets/workspace/.nbook/agent/profiles/builtin/inspiration.faction.profile";
import instructionDefinition from "nbook/assets/workspace/.nbook/agent/profiles/builtin/inspiration.instruction.profile";
import itemDefinition from "nbook/assets/workspace/.nbook/agent/profiles/builtin/inspiration.item.profile";
import locationDefinition from "nbook/assets/workspace/.nbook/agent/profiles/builtin/inspiration.location.profile";
import noteDefinition from "nbook/assets/workspace/.nbook/agent/profiles/builtin/inspiration.note.profile";
import systemDefinition from "nbook/assets/workspace/.nbook/agent/profiles/builtin/inspiration.system.profile";
import worldDefinition from "nbook/assets/workspace/.nbook/agent/profiles/builtin/inspiration.world.profile";
import {normalizeAgentProfile} from "nbook/server/agent/profiles/define-agent-profile";
import {isReportResultBinding, reportResultSchemaForProfile} from "nbook/server/agent/profiles/report-result-schema";

const main = normalizeAgentProfile(mainDefinition);
const specialists = [characterDefinition, factionDefinition, instructionDefinition, itemDefinition,
    locationDefinition, noteDefinition, systemDefinition, worldDefinition].map(normalizeAgentProfile);

describe("设计工作台改编 Profile 权限与输出兼容合同", () => {
    it.each([main, ...specialists])("$manifest.key 只提交结构化草稿，不因改编增加素材读取或保存权限", profile => {
        expect(profile.rootToolKeys).toEqual(["report_result"]);
        const binding = profile.tools.report_result;
        expect(isReportResultBinding(binding)).toBe(true);
        const dataSchema = isReportResultBinding(binding) ? binding.dataSchema : undefined;
        expect(dataSchema).toBe(profile.outputSchema);
        const parameters = reportResultSchemaForProfile(profile);
        const data = profile.manifest.key === "inspiration"
            ? {assignments: [{category: "character", brief: "改编人物"}]}
            : {artifacts: [{title: "设计", fields: {名称: "人物"}}]};
        expect(Value.Check(parameters, {result: "完成", data})).toBe(true);
        expect(Value.Check(parameters, {result: "完成", data: "{\"artifacts\":[]}"})).toBe(false);
    });

    it("协调者仍按用户产物类别分派，沿用原有 assignments 外壳和八类上限", () => {
        expect(Value.Check(main.initialSchema!, {})).toBe(true);
        expect(Value.Check(main.outputSchema!, {assignments: [{category: "character", brief: "参考势力素材改编角色"}]})).toBe(true);
        expect(Value.Check(main.outputSchema!, {assignments: [{category: "character", brief: "角色", materialSources: []}]})).toBe(false);
        expect(Value.Check(main.outputSchema!, {assignments: []})).toBe(false);
        expect(Value.Check(main.outputSchema!, {assignments: Array.from({length: 9}, () => ({category: "character", brief: "设计"}))})).toBe(false);
    });

    it.each(specialists)("$manifest.key 保留 fields 初始值、artifacts 输出和草稿数量边界", profile => {
        expect(Value.Check(profile.initialSchema!, {fields: ["名称", "能力限制"]})).toBe(true);
        expect(Value.Check(profile.initialSchema!, {fields: [], creationMode: "adaptation"})).toBe(false);
        expect(Value.Check(profile.outputSchema!, {artifacts: [{title: "改编设计", fields: {名称: "新名称", 能力限制: "有代价"}}]})).toBe(true);
        expect(Value.Check(profile.outputSchema!, {artifacts: [{title: "设计", fields: {名称: "新名称"}, path: "lorebook/character/source/index.md"}]})).toBe(false);
        expect(Value.Check(profile.outputSchema!, {artifacts: [{title: "设计", content: "正文"}]})).toBe(false);
        expect(Value.Check(profile.outputSchema!, {artifacts: []})).toBe(false);
        expect(Value.Check(profile.outputSchema!, {artifacts: Array.from({length: 5}, () => ({title: "设计", fields: {名称: "新名称"}}))})).toBe(false);
    });
});
