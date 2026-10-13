<script setup lang="ts">
import {ref, watch} from "vue";
import PromptManagementSettingsView from "nbook/app/components/novel-ide/settings/sections/prompt-management/PromptManagementSettingsView.vue";
import {PromptCatalogDtoSchema, type PromptCatalogDto, type PromptMutationDto} from "nbook/shared/dto/prompt-management.dto";
import {useLabSubject, type LabFixtureProps} from "../lab-subject";
import {useLabEventSink} from "../lab-event-sink";
import {promptManagementCatalog} from "./PromptManagement.scenes";
import type {TavernPreviewRequest, TavernPreviewResult} from "nbook/shared/dto/tavern-preset.dto";

const props = defineProps<LabFixtureProps>();
const subject = useLabSubject<typeof PromptManagementSettingsView>(() => props.input, []);
const events = useLabEventSink();
const catalog = ref<PromptCatalogDto>(PromptCatalogDtoSchema.parse(promptManagementCatalog));
watch(() => subject.bindings.value.catalog, (value) => {
    catalog.value = PromptCatalogDtoSchema.parse(value ?? promptManagementCatalog);
}, {immediate: true});

async function mutate(mutation: PromptMutationDto): Promise<PromptCatalogDto> {
    events("mutate", mutation);
    const next = PromptCatalogDtoSchema.parse(catalog.value);
    const purpose = next.purposes.find((item) => item.purposeId === mutation.purposeId);
    if (!purpose || mutation.expectedRevision !== next.revision) throw new Error("目录版本已变化，请重新打开预设。");
    if (mutation.action === "save") {
        const prior = purpose.presets.find((item) => item.id === mutation.presetId);
        if (prior?.builtin) throw new Error("内置默认不可修改。");
        const id = prior?.id ?? crypto.randomUUID();
        purpose.presets = purpose.presets.filter((item) => item.id !== id);
        purpose.presets.push({id, builtin: false, revision: (prior?.revision ?? 0) + 1, name: mutation.name, entries: mutation.entries});
        purpose.selectedPresetId = id;
    } else if (mutation.action === "toggle") {
        const preset = purpose.presets.find(item => item.id === mutation.presetId);
        if (!preset || preset.builtin) throw new Error("内置默认不可修改或预设不存在。");
        const entry = preset.entries.find(item => item.id === mutation.entryId);
        if (!entry) throw new Error("请先保存新条目。");
        entry.enabled = mutation.enabled;
        preset.revision++;
    } else if (mutation.action === "delete") {
        if (purpose.presets.find((item) => item.id === mutation.presetId)?.builtin) throw new Error("内置默认不可删除。");
        purpose.presets = purpose.presets.filter((item) => item.id !== mutation.presetId);
        if (purpose.selectedPresetId === mutation.presetId) purpose.selectedPresetId = "builtin";
    } else if (mutation.action === "select") {
        purpose.selectedPresetId = mutation.presetId;
    } else if (mutation.action === "import-tavern") {
        const prior = purpose.presets.find(item => item.id === mutation.presetId);
        const id = prior?.id ?? crypto.randomUUID();
        purpose.presets = purpose.presets.filter(item => item.id !== id);
        purpose.presets.push({id, builtin: false, revision: (prior?.revision ?? 0) + 1, name: mutation.name, entries: [], tavern: mutation.tavern});
        purpose.selectedPresetId = id;
    }
    next.revision++;
    catalog.value = next;
    return next;
}
async function preview(request: TavernPreviewRequest): Promise<TavernPreviewResult> {
    events("preview", request);
    return {report: {sourceSha256: "fixture", upstreamRevision: "fixture", prompts: 2, active: 2, regexes: 0, unsupported: [], extensionDependencies: [], promptSupported: true, fullEnvironmentEquivalent: false},
        messages: [{role: "system", content: "确定性预览示例"}], promptMessages: [{role: "system", content: "确定性预览示例"}], messageIdentifiers: ["main"], variablesBefore: {local: {}, global: {}}, variablesAfter: {local: {}, global: {}}, generation: {temperature: 1}};
}
</script>

<template>
    <div class="mx-auto h-full min-h-0 w-full max-w-6xl overflow-hidden bg-[var(--bg-panel)]">
        <PromptManagementSettingsView data-lab-subject :catalog="catalog" :saving="subject.bindings.value.saving" :mutate="mutate" :preview="preview" :download="(name, contents) => events('download', {name, contents})" />
    </div>
</template>
