<script setup lang="ts">
import {computed} from "vue";
import {Button, EmptyState, FormField, FormInput, FormNumberInput, SegmentedControl} from "@notnotype/nb-ui/components";
import ChapterListEditor from "nbook/app/components/novel-ide/inspiration/extraction/ChapterListEditor.vue";
import ExtractionNotice from "nbook/app/components/novel-ide/inspiration/extraction/ExtractionNotice.vue";
import ExtractionProgressPanel from "nbook/app/components/novel-ide/inspiration/extraction/ExtractionProgressPanel.vue";
import OutlineDestinationPicker from "nbook/app/components/novel-ide/inspiration/extraction/OutlineDestinationPicker.vue";
import OutlineOverwriteComparison from "nbook/app/components/novel-ide/inspiration/extraction/OutlineOverwriteComparison.vue";
import OutlineResultCard from "nbook/app/components/novel-ide/inspiration/extraction/OutlineResultCard.vue";
import VolumeDivisionEditor from "nbook/app/components/novel-ide/inspiration/extraction/VolumeDivisionEditor.vue";
import ExtractionBlockPreview from "nbook/app/components/novel-ide/inspiration/extraction/ExtractionBlockPreview.vue";
import type {OutlineController} from "nbook/app/composables/useInspirationExtraction";

const props = withDefaults(defineProps<{
    outline: OutlineController;
    modelKey?: string;
}>(), {modelKey: ""});

const emit = defineEmits<{(event: "open-plan", plan: {planId: string; planTitle: string}): void}>();

const hasTask = computed(() => props.outline.task !== null || props.outline.progress !== null);
const status = computed(() => props.outline.progress?.status ?? props.outline.task?.status ?? null);
const settled = computed(() => status.value !== null && status.value !== "running" && status.value !== "awaiting-input");
const comparison = computed(() => props.outline.outcome?.comparison ?? null);
const chunkCount = computed(() => props.outline.preview?.mode === "chunks" ? props.outline.preview.chapters.length : 0);
const chapterCount = computed(() => props.outline.preview?.mode === "chapters" ? props.outline.preview.recognition.chapters.length : 0);

function paragraphText(paragraphId: string): string | null {
    return props.outline.paragraphText.get(paragraphId) ?? null;
}

function start(): void {
    void props.outline.startOutline(props.modelKey || undefined);
}
</script>

<template>
    <section class="outline-view" aria-label="大纲提取">
        <EmptyState v-if="!props.outline.preview && !props.outline.previewLoading && !props.outline.previewError && !hasTask" icon-class="i-lucide-book-open" title="先在上方选择要提取的作品" />
        <ExtractionNotice v-else-if="!props.outline.preview && props.outline.previewError && !hasTask" tone="danger">{{ props.outline.previewError.message }}</ExtractionNotice>
        <template v-else-if="!hasTask">
            <section v-if="props.outline.preview" class="step">
                <h3 class="step-title">切分预览</h3>
                <SegmentedControl v-model="props.outline.structureMode" :options="[{label: '按章节', value: 'chapters'}, {label: '按字数分块', value: 'chunks'}]" aria-label="大纲切分方式" @update:model-value="props.outline.refreshPreview()" />
                <FormField v-if="props.outline.structureMode === 'chunks'" label="目标字数">
                    <FormNumberInput v-model="props.outline.targetCharacters" min="1" max="1000000" step="1000" @submit="props.outline.refreshPreview()" />
                </FormField>
                <ExtractionBlockPreview v-if="props.outline.preview.mode === 'chunks'" :chunks="props.outline.preview.chapters" />
            </section>
            <section class="step">
                <h3 class="step-title">1. 章节</h3>
                <ChapterListEditor
                    :preview="props.outline.preview" :corrections="props.outline.corrections" :loading="props.outline.previewLoading"
                    :error="props.outline.correctionError?.message ?? ''" :paragraph-text="paragraphText"
                    @correct="props.outline.addCorrection($event)" @undo="props.outline.undoCorrection()" @clear="props.outline.clearCorrections()"
                />
            </section>
            <section v-if="props.outline.preview" class="step">
                <h3 class="step-title">2. 划卷</h3>
                <VolumeDivisionEditor
                    v-model:volumes="props.outline.volumes" v-model:chunks-per-volume="props.outline.chunksPerVolume"
                    :mode="props.outline.preview.mode" :chapter-count="chapterCount" :chunk-count="chunkCount"
                    :error="props.outline.divisionError?.message ?? ''" :checking="props.outline.divisionChecking" :valid="Boolean(props.outline.confirmedStructure)"
                    @restore="props.outline.restoreSuggestedVolumes()"
                />
            </section>
            <section v-if="props.outline.preview && props.outline.destinations.length" class="step">
                <h3 class="step-title">3. 数据去向</h3>
                <OutlineDestinationPicker v-model="props.outline.destination" :options="props.outline.destinations" />
            </section>
            <section v-if="props.outline.preview" class="step">
                <h3 class="step-title">{{ props.outline.destinations.length ? '4' : '3' }}. 开始</h3>
                <FormField label="作品名" description="用于新建方案的标题">
                    <FormInput :model-value="props.outline.workTitle" @update:model-value="props.outline.workTitle = $event" />
                </FormField>
                <ExtractionNotice v-if="props.outline.startError" tone="danger">{{ props.outline.startError.message }}</ExtractionNotice>
                <div class="actions">
                    <Button variant="primary" icon-class="i-lucide-play" :loading="props.outline.busy" :disabled="!props.outline.canStartOutline" @click="start()">确认划分并开始提取</Button>
                </div>
            </section>
        </template>
        <template v-else>
            <ExtractionNotice v-if="props.outline.error" tone="danger">{{ props.outline.error.message }}</ExtractionNotice>
            <ExtractionProgressPanel
                :progress="props.outline.progress" :busy="props.outline.busy"
                @cancel="props.outline.cancel()" @resume="props.outline.resume()"
                @retry-unit="props.outline.retryUnit($event)" @skip-unit="props.outline.skipUnit($event)"
                @retry-failed="props.outline.retryFailed($event)" @skip-failed="props.outline.skipFailed($event)"
            />
            <ExtractionNotice v-if="props.outline.outcomeError" tone="danger">{{ props.outline.outcomeError.message }}</ExtractionNotice>
            <section v-if="comparison && status === 'awaiting-input'" class="step">
                <h3 class="step-title">确认覆盖</h3>
                <OutlineOverwriteComparison :items="comparison" :confirmed="props.outline.outcome?.confirmed ?? null" :busy="props.outline.busy" @confirm="props.outline.confirmOverwrite($event)" />
            </section>
            <OutlineResultCard
                v-if="props.outline.outcome && settled" :outcome="props.outline.outcome" :busy="props.outline.resultBusy"
                @open-plan="emit('open-plan', $event)" @resummarize="props.outline.resummarize()"
            />
            <div v-if="settled" class="actions">
                <Button variant="secondary" icon-class="i-lucide-undo-2" @click="props.outline.dismiss()">返回设置</Button>
            </div>
        </template>
    </section>
</template>

<style scoped>
.outline-view {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
}

.step {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
}

.step-title {
    margin: 0;
    color: var(--text-main);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
}

.actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
}
</style>
