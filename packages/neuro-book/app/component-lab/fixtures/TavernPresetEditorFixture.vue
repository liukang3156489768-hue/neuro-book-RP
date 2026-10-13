<script setup lang="ts">
import TavernPresetEditor from "nbook/app/components/novel-ide/settings/sections/prompt-management/TavernPresetEditor.vue";
import type {TavernPreviewRequest, TavernPreviewResult} from "nbook/shared/dto/tavern-preset.dto";
import {useLabSubject, type LabFixtureProps} from "../lab-subject";
import {useLabEventSink} from "../lab-event-sink";

const props = defineProps<LabFixtureProps>();
const subject = useLabSubject<typeof TavernPresetEditor>(() => props.input, ["update:modelValue"]);
const events = useLabEventSink();
async function preview(request: TavernPreviewRequest): Promise<TavernPreviewResult> {
    events("preview", request);
    return {report: {sourceSha256: "fixture", upstreamRevision: "fixture", prompts: 2, active: 2, regexes: 0, unsupported: [], extensionDependencies: [], promptSupported: true, fullEnvironmentEquivalent: false}, messages: [{role: "user", content: "预览示例"}], promptMessages: [{role: "user", content: "预览示例"}], messageIdentifiers: ["chatHistory"], variablesBefore: {local: {}, global: {}}, variablesAfter: {local: {}, global: {}}, generation: {}};
}
</script>

<template>
    <div class="h-full min-h-0 w-full overflow-y-auto bg-[var(--bg-panel)]">
        <TavernPresetEditor data-lab-subject v-bind="subject.bindings.value" :preview="preview" :download="(name, contents) => events('download', {name, contents})" />
    </div>
</template>
