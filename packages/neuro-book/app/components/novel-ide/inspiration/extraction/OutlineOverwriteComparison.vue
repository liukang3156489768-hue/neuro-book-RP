<script setup lang="ts">
import {computed, ref, watch} from "vue";
import {Badge, Button, EmptyState, FormCheckbox} from "@notnotype/nb-ui/components";
import type {OutlineComparisonItem} from "nbook/shared/dto/inspiration-outline-extraction.dto";
import {ITEM_KIND_LABELS} from "nbook/app/utils/inspiration/extraction-labels";

type OverwriteItemKey = {chapterIndex: number; kind: "detail" | "outline"};

const props = withDefaults(defineProps<{
    items: readonly OutlineComparisonItem[];
    confirmed: readonly OverwriteItemKey[] | null;
    busy?: boolean;
}>(), {busy: false});

const emit = defineEmits<{(event: "confirm", items: OverwriteItemKey[]): void}>();

const keyOf = (item: OverwriteItemKey): string => `${item.chapterIndex}:${item.kind}`;

const selected = ref<Set<string>>(new Set());
// 对比内容变化（重新提取）后，默认重新只勾选有变化的项。
watch(() => props.items, items => {
    selected.value = new Set(items.filter(item => item.changed).map(keyOf));
}, {immediate: true});

const changedCount = computed(() => props.items.filter(item => item.changed).length);
const readOnly = computed(() => props.confirmed !== null);
const selectedItems = computed(() => props.items.filter(item => item.changed && selected.value.has(keyOf(item))).map(item => ({chapterIndex: item.chapterIndex, kind: item.kind})));

function toggle(item: OutlineComparisonItem, checked: boolean | "indeterminate"): void {
    const next = new Set(selected.value);
    if (checked === true) next.add(keyOf(item));
    else next.delete(keyOf(item));
    selected.value = next;
}

function selectAllChanged(): void {
    selected.value = new Set(props.items.filter(item => item.changed).map(keyOf));
}
</script>

<template>
    <section class="overwrite-comparison" aria-label="覆盖新旧对比">
        <EmptyState v-if="!props.items.length" icon-class="i-lucide-git-compare" title="没有需要覆盖的项" />
        <template v-else>
            <div class="toolbar">
                <span class="summary">共 {{ props.items.length }} 项，其中 {{ changedCount }} 项有变化</span>
                <template v-if="!readOnly">
                    <Button size="sm" variant="ghost" :disabled="props.busy" @click="selectAllChanged()">全选有变化的项</Button>
                    <Button size="sm" variant="danger" :loading="props.busy" :disabled="!selectedItems.length" @click="emit('confirm', selectedItems)">确认覆盖 {{ selectedItems.length }} 项</Button>
                </template>
                <Badge v-else tone="success">已确认覆盖 {{ props.confirmed?.length ?? 0 }} 项</Badge>
            </div>
            <article v-for="item in props.items" :key="keyOf(item)" class="item">
                <header class="item-head">
                    <FormCheckbox
                        :model-value="item.changed && selected.has(keyOf(item))" :disabled="readOnly || props.busy || !item.changed"
                        :label="`第 ${item.chapterIndex} 章 ${item.chapterTitle}`" :description="item.changed ? undefined : '与现有内容相同'"
                        @update:model-value="toggle(item, $event)"
                    />
                    <Badge tone="neutral" variant="soft" size="sm">{{ ITEM_KIND_LABELS[item.kind] }}</Badge>
                    <span v-if="item.locator" class="locator">{{ item.locator }}</span>
                </header>
                <div class="sides">
                    <div class="side">
                        <h4>现有内容</h4>
                        <p v-if="item.oldText !== null" class="text">{{ item.oldText }}</p>
                        <p v-else class="text text-empty">该章目前没有内容</p>
                    </div>
                    <div class="side side-new">
                        <h4>新提取</h4>
                        <p class="text">{{ item.newText }}</p>
                    </div>
                </div>
            </article>
        </template>
    </section>
</template>

<style scoped>
.overwrite-comparison {
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
    flex: 1 1 auto;
    color: var(--text-secondary);
    font-size: var(--text-xs);
}

.item {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-control);
    background: var(--bg-panel);
}

.item-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
}

.locator {
    color: var(--text-muted);
    font-size: var(--text-xs);
}

.sides {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--space-2);
}

.side {
    min-width: 0;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-control);
    background: var(--bg-main);
}

.side-new {
    border: 1px solid var(--accent-main);
}

.side h4 {
    margin: 0 0 var(--space-1);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
}

.text {
    margin: 0;
    color: var(--text-main);
    font-size: var(--text-xs);
    line-height: 1.7;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}

.text-empty {
    color: var(--text-muted);
}
</style>
