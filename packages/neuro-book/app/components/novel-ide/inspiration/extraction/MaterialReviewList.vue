<script setup lang="ts">
import {computed, ref, watch} from "vue";
import {Badge, Button, EmptyState, FormCheckbox} from "@notnotype/nb-ui/components";
import type {MaterialReviewActionDto} from "nbook/shared/dto/inspiration-extraction-api.dto";
import {MATERIAL_CATEGORIES} from "nbook/shared/dto/inspiration-material.dto";
import type {MaterialReview} from "nbook/app/utils/inspiration/extraction-api";
import MaterialReviewItemEditor from "nbook/app/components/novel-ide/inspiration/extraction/MaterialReviewItemEditor.vue";
import MaterialReviewSplitForm from "nbook/app/components/novel-ide/inspiration/extraction/MaterialReviewSplitForm.vue";
import {WRITE_STATUS_LABELS, WRITE_STATUS_TONES} from "nbook/app/utils/inspiration/extraction-labels";

type ReviewItem = MaterialReview["items"][number];

const props = withDefaults(defineProps<{
    review: MaterialReview;
    busy?: boolean;
    error?: string;
}>(), {busy: false, error: ""});

const emit = defineEmits<{
    (event: "action", action: MaterialReviewActionDto): void;
    (event: "write"): void;
}>();

const mergeChecked = ref<Set<string>>(new Set());
const editing = ref<{id: string; mode: "edit" | "split"} | null>(null);

// 动作成功后服务端返回新的清单：正在编辑的条目被改动或不存在时收起编辑器（切换其他条目的勾选不打断编辑），并丢弃已不存在条目的合并勾选。
watch(() => props.review, (review, previous) => {
    const current = editing.value;
    if (current) {
        const next = review.items.find(item => item.id === current.id);
        const before = previous.items.find(item => item.id === current.id);
        if (!next || JSON.stringify(next.nodes) !== JSON.stringify(before?.nodes) || next.title !== before?.title) editing.value = null;
    }
    const alive = new Set(review.items.map(item => item.id));
    mergeChecked.value = new Set([...mergeChecked.value].filter(id => alive.has(id)));
});

const sections = computed(() => MATERIAL_CATEGORIES.flatMap(category => {
    const items = props.review.items.filter(item => item.category === category.key);
    return items.length ? [{key: category.key, label: category.label, directory: category.directory, items}] : [];
}));
const writable = computed(() => props.review.items.filter(item => item.write.status !== "written"));
const selectedCount = computed(() => writable.value.filter(item => item.selected).length);
const writtenCount = computed(() => props.review.items.length - writable.value.length);
const mergeItems = computed(() => props.review.items.filter(item => mergeChecked.value.has(item.id)));
const mergeProblem = computed(() => {
    if (mergeItems.value.length < 2) return "至少选作合并两个条目";
    if (new Set(mergeItems.value.map(item => item.category)).size > 1) return "只能合并同一类别的条目";
    return "";
});

function select(itemIds: string[], selected: boolean): void {
    if (itemIds.length) emit("action", {kind: "select", itemIds, selected});
}

function setMerge(itemId: string, value: boolean | "indeterminate"): void {
    const next = new Set(mergeChecked.value);
    if (value === true) next.add(itemId);
    else next.delete(itemId);
    mergeChecked.value = next;
}

function merge(): void {
    if (mergeProblem.value) return;
    emit("action", {kind: "merge", itemIds: mergeItems.value.map(item => item.id)});
}

function toggleEditor(item: ReviewItem, mode: "edit" | "split"): void {
    editing.value = editing.value?.id === item.id && editing.value.mode === mode ? null : {id: item.id, mode};
}
</script>

<template>
    <section class="review-list" aria-label="待写入清单">
        <EmptyState v-if="!props.review.items.length" icon-class="i-lucide-clipboard-list" title="没有待写入的条目" />
        <template v-else>
            <div class="toolbar">
                <span class="summary">已选 {{ selectedCount }} / 共 {{ writable.length }}<template v-if="writtenCount">，已写入 {{ writtenCount }}</template></span>
                <Button size="sm" variant="ghost" :disabled="props.busy" @click="select(writable.map(item => item.id), true)">全选</Button>
                <Button size="sm" variant="ghost" :disabled="props.busy" @click="select(writable.map(item => item.id), false)">全不选</Button>
                <Button size="sm" variant="secondary" :disabled="props.busy || Boolean(mergeProblem)" :title="mergeProblem" @click="merge()">合并所选（{{ mergeItems.length }}）</Button>
                <Button size="sm" variant="primary" :loading="props.busy" :disabled="!selectedCount" @click="emit('write')">确认写入 {{ selectedCount }} 项</Button>
            </div>
            <section v-for="section in sections" :key="section.key" class="section">
                <h4 class="section-title">{{ section.label }}（{{ section.items.length }}）</h4>
                <ul class="item-list">
                    <li v-for="item in section.items" :key="item.id" class="item" :data-write="item.write.status">
                        <div class="item-row">
                            <FormCheckbox
                                :model-value="item.selected" :disabled="props.busy || item.write.status === 'written'" :label="item.title"
                                :description="[item.aliases.length ? `别称：${item.aliases.join('、')}` : '', `${section.directory}${item.write.savedAs ?? item.directoryName}`].filter(Boolean).join(' · ')"
                                @update:model-value="select([item.id], $event === true)"
                            />
                            <Badge :tone="WRITE_STATUS_TONES[item.write.status]" variant="soft" size="sm">{{ WRITE_STATUS_LABELS[item.write.status] }}</Badge>
                            <span v-if="item.write.status !== 'written'" class="item-actions">
                                <FormCheckbox :model-value="mergeChecked.has(item.id)" :disabled="props.busy" label="选作合并" @update:model-value="setMerge(item.id, $event)" />
                                <Button size="sm" variant="ghost" :disabled="props.busy" @click="toggleEditor(item, 'edit')">编辑</Button>
                                <Button v-if="item.category === 'character'" size="sm" variant="ghost" :disabled="props.busy" @click="toggleEditor(item, 'split')">拆分</Button>
                                <Button size="sm" variant="ghost" :disabled="props.busy" @click="emit('action', {kind: 'remove', itemId: item.id})">删除</Button>
                            </span>
                        </div>
                        <p v-if="item.write.status === 'failed' && item.write.error" class="item-error">{{ item.write.error }}</p>
                        <MaterialReviewItemEditor v-if="editing?.id === item.id && editing.mode === 'edit'" :item="item" :busy="props.busy" :error="props.error" @save="emit('action', {kind: 'update', itemId: item.id, patch: $event})" @cancel="editing = null" />
                        <MaterialReviewSplitForm v-else-if="editing?.id === item.id && editing.mode === 'split'" :item="item" :busy="props.busy" :error="props.error" @split="emit('action', {kind: 'split', itemId: item.id, input: $event})" @cancel="editing = null" />
                    </li>
                </ul>
            </section>
        </template>
    </section>
</template>

<style scoped>
.review-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
}

.toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
}

.summary {
    flex: 1 1 140px;
    color: var(--text-secondary);
    font-size: var(--text-xs);
}

.section-title {
    margin: 0 0 var(--space-1);
    color: var(--text-main);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
}

.item-list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-control);
    background: var(--bg-panel);
    list-style: none;
}

.item {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border-color);
}

.item:last-child {
    border-bottom: 0;
}

.item-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
}

.item-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-1);
    margin-left: auto;
}

.item-error {
    margin: 0;
    color: var(--status-danger);
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
}
</style>
