import type PromptManagementSettingsView from "nbook/app/components/novel-ide/settings/sections/prompt-management/PromptManagementSettingsView.vue";
import type TavernPresetEditor from "nbook/app/components/novel-ide/settings/sections/prompt-management/TavernPresetEditor.vue";
import type {PromptCatalogDto} from "nbook/shared/dto/prompt-management.dto";
import type {LabFixtureDefinition} from "./index";

export const promptManagementCatalog: PromptCatalogDto = {
    revision: 1,
    purposes: [{
        purposeId: "inspiration.character", module: "design", label: "角色人设设计", description: "设计性格、动机和行为表现，支持指定人设改编。",
        variables: ["{{任务}}"], requiredVariables: ["{{任务}}"],
        entries: [{id: "system", name: "系统职责与规则", role: "system", content: "根据所选人设和创作要求设计角色，说明性格、动机与行为的联系。"}, {id: "task", name: "任务上下文", role: "user", content: "{{任务}}"}],
        selectedPresetId: "builtin",
        presets: [{id: "builtin", name: "内置默认", builtin: true, revision: 1, entries: [{id: "system", name: "系统职责与规则", role: "system", content: "根据所选人设和创作要求设计角色，说明性格、动机与行为的联系。"}, {id: "task", name: "任务上下文", role: "user", content: "{{任务}}"}]}],
    }],
};

export const promptManagementScenes = [
    {id: "default", label: "内置默认与自定义预设", input: {props: {catalog: promptManagementCatalog, saving: false}}},
    {id: "saving", label: "保存中", input: {props: {catalog: promptManagementCatalog, saving: true}}},
    {id: "empty", label: "空目录", input: {props: {catalog: {revision: 1, purposes: []}, saving: false}}},
    {id: "tavern", label: "酒馆写手预设", input: {props: {catalog: {revision: 1, purposes: [{
        purposeId: "writing.writer.scene", module: "writing", label: "场景写手", description: "按酒馆原生预设编排写手提示词。", variables: ["{{requirements}}"], requiredVariables: ["{{requirements}}"], entries: [], selectedPresetId: "tavern",
        presets: [{id: "builtin", name: "内置默认", builtin: true, revision: 1, entries: []}, {id: "tavern", name: "酒馆示例", builtin: false, revision: 1, entries: [], tavern: {
            macroEngine: "legacy", extensionPolicy: "prompt-only", outputPolicy: {mode: "tag", tag: "content", qualityCheck: true},
            bindings: {user: "作者", char: "写手", slots: {chatHistory: [{role: "user", content: "{{requirements}}"}]}, variablePersistence: "writing-session"},
            sourceJson: JSON.stringify({prompts: [{identifier: "main", name: "写作规则", role: "system", content: "由{{char}}创作，正文放在<content>中。"}, {identifier: "chatHistory", name: "作品任务", marker: true}], prompt_order: [{character_id: 100001, order: [{identifier: "main", enabled: true}, {identifier: "chatHistory", enabled: true}]}], temperature: 1}, null, 2),
        }}],
    }]}, saving: false}}},
] satisfies LabFixtureDefinition<typeof PromptManagementSettingsView>["scenes"];

export const tavernPresetEditorScenes = [{id: "default", label: "酒馆原生序列", input: {
    props: {purposeId: "writing.writer.scene", name: "酒馆示例", disabled: false},
    model: {modelValue: {macroEngine: "legacy", extensionPolicy: "prompt-only", outputPolicy: {mode: "tag", tag: "content", qualityCheck: true},
        bindings: {user: "作者", char: "写手", slots: {chatHistory: [{role: "user", content: "{{requirements}}"}]}, variablePersistence: "writing-session"},
        sourceJson: JSON.stringify({prompts: [{identifier: "main", name: "写作规则", role: "system", content: "由{{char}}创作，正文放在<content>中。"}, {identifier: "chatHistory", name: "作品任务", marker: true}], prompt_order: [{character_id: 100001, order: [{identifier: "main", enabled: true}, {identifier: "chatHistory", enabled: true}]}], temperature: 1}, null, 2),
    }},
}}] satisfies LabFixtureDefinition<typeof TavernPresetEditor>["scenes"];
