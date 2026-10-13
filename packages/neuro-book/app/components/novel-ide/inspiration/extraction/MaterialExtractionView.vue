<script setup lang="ts">
import {computed} from "vue";
import {Button, EmptyState} from "@notnotype/nb-ui/components";
import ExtractionNotice from "nbook/app/components/novel-ide/inspiration/extraction/ExtractionNotice.vue";
import ExtractionProgressPanel from "nbook/app/components/novel-ide/inspiration/extraction/ExtractionProgressPanel.vue";
import MaterialCategoryPicker from "nbook/app/components/novel-ide/inspiration/extraction/MaterialCategoryPicker.vue";
import MaterialClassificationPanel from "nbook/app/components/novel-ide/inspiration/extraction/MaterialClassificationPanel.vue";
import MaterialConflictResolver from "nbook/app/components/novel-ide/inspiration/extraction/MaterialConflictResolver.vue";
import MaterialReviewList from "nbook/app/components/novel-ide/inspiration/extraction/MaterialReviewList.vue";
import MaterialWriteReport from "nbook/app/components/novel-ide/inspiration/extraction/MaterialWriteReport.vue";
import type {MaterialController} from "nbook/app/composables/useInspirationExtraction";
import type {InspirationSourceChunkDto} from "nbook/shared/dto/inspiration-source.dto";
import ExtractionBlockPreview from "nbook/app/components/novel-ide/inspiration/extraction/ExtractionBlockPreview.vue";

const props = withDefaults(defineProps<{
    material: MaterialController;
    sourceReady: boolean;
    chunks: readonly InspirationSourceChunkDto[];
    modelKey?: string;
}>(), {modelKey: "", chunks: () => []});

const hasTask = computed(() => props.material.task !== null || props.material.progress !== null);
const status = computed(() => props.material.progress?.status ?? props.material.task?.status ?? null);
const settled = computed(() => status.value !== null && status.value !== "running" && status.value !== "awaiting-input");

function start(): void {
    void props.material.startMaterial(props.modelKey || undefined);
}

function toggleBlock(index: number, range: boolean): void {
    props.material.toggleBlock(index, range);
}
</script>

<template>
    <section class="material-view" aria-label="素材提取">
        <EmptyState v-if="!hasTask && !props.sourceReady" icon-class="i-lucide-library" title="先在上方选择要提取的作品" />
        <template v-else-if="!hasTask">
            <ExtractionBlockPreview
                v-if="props.chunks.length" :chunks="props.chunks" :selected="props.material.selectedBlocks" selectable show-actions
                @toggle="toggleBlock" @select-all="props.material.selectAllBlocks()" @clear="props.material.clearBlocks()" @invert="props.material.invertBlocks()"
            />
            <ExtractionNotice v-if="props.chunks.length && props.material.selectedBlocks.length < props.chunks.length" tone="warning">跳过前面的分块可能影响后面分块的实体识别。</ExtractionNotice>
            <MaterialCategoryPicker :model-value="props.material.categories" @toggle="props.material.toggleCategory($event)" @update:model-value="props.material.categories = $event" />
            <p v-if="props.chunks.length" class="estimate">已选 {{ props.material.selectedBlocks.length }} 块，基础调用 {{ props.material.selectedBlocks.length }} × {{ props.material.categories.length }} 次；角色会在粗读后按出现情况追加逐角色提取。</p>
            <ExtractionNotice v-if="props.material.startError" tone="danger">{{ props.material.startError.message }}</ExtractionNotice>
            <div class="actions">
                <Button variant="primary" icon-class="i-lucide-play" :loading="props.material.busy" :disabled="!props.material.categories.length || (props.chunks.length > 0 && !props.material.selectedBlocks.length)" @click="start()">开始提取素材</Button>
            </div>
        </template>
        <template v-else>
            <ExtractionNotice v-if="props.material.error" tone="danger">{{ props.material.error.message }}</ExtractionNotice>
            <ExtractionProgressPanel
                :progress="props.material.progress" :busy="props.material.busy"
                @cancel="props.material.cancel()" @resume="props.material.resume()"
                @retry-unit="props.material.retryUnit($event)" @skip-unit="props.material.skipUnit($event)"
                @retry-failed="props.material.retryFailed($event)" @skip-failed="props.material.skipFailed($event)"
            />
            <section v-if="status === 'awaiting-input' && props.material.classification" class="step">
                <h3 class="step-title">实体归类</h3>
                <MaterialClassificationPanel
                    :classification="props.material.classification" :busy="props.material.classificationBusy"
                    @submit="props.material.submitClassification({groups: $event})" @skip="props.material.submitClassification({skip: true})"
                />
            </section>
            <ExtractionNotice v-if="props.material.resultError && !props.material.review" tone="danger">{{ props.material.resultError.message }}</ExtractionNotice>
            <section v-if="props.material.review && settled" class="step">
                <h3 class="step-title">待写入清单</h3>
                <MaterialWriteReport v-if="props.material.writeReport" :report="props.material.writeReport" />
                <MaterialConflictResolver
                    v-if="props.material.pendingConflicts.length" :conflicts="props.material.pendingConflicts" :busy="props.material.reviewBusy"
                    @confirm="props.material.confirmWrite($event)" @cancel="props.material.cancelConflicts()"
                />
                <MaterialReviewList
                    v-else :review="props.material.review" :busy="props.material.reviewBusy" :error="props.material.resultError?.message ?? ''"
                    @action="props.material.reviewAction($event)" @write="props.material.requestWrite()"
                />
            </section>
            <div v-if="settled" class="actions">
                <Button variant="secondary" icon-class="i-lucide-undo-2" @click="props.material.dismiss()">返回设置</Button>
            </div>
        </template>
    </section>
</template>

<style scoped>
.material-view {
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

.estimate { margin: calc(var(--space-2) * -1) 0 0; color: var(--text-muted); font-size: var(--text-xs); }
</style>
