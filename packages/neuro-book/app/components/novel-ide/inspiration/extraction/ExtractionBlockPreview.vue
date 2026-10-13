<script setup lang="ts">
import {computed} from "vue";
import {Badge, Button} from "@notnotype/nb-ui/components";
type PreviewBlock = Readonly<{index: number; firstParagraphId: string; lastParagraphId: string; characterCount: number}>;

const props = withDefaults(defineProps<{
    chunks: readonly PreviewBlock[];
    selected?: readonly number[];
    selectable?: boolean;
    showActions?: boolean;
    title?: string;
}>(), {selected: () => [], selectable: false, showActions: false, title: "分块预览"});

const emit = defineEmits<{
    (event: "toggle", index: number, range: boolean): void;
    (event: "select-all"): void;
    (event: "clear"): void;
    (event: "invert"): void;
}>();

const selectedSet = computed(() => new Set(props.selected));
const selectedCount = computed(() => props.chunks.filter(chunk => selectedSet.value.has(chunk.index)).length);

function formatCount(value: number): string {
    return value >= 10_000 ? `${(value / 10_000).toFixed(value >= 100_000 ? 0 : 1)} 万` : String(value);
}
</script>

<template>
    <section class="block-preview" :aria-label="props.title">
        <div class="preview-head">
            <strong>{{ props.title }}</strong>
            <span class="preview-meta">{{ props.chunks.length }} 块<span v-if="props.selectable"> · 已选 {{ selectedCount }} 块</span></span>
        </div>
        <div v-if="props.showActions && props.selectable" class="preview-actions">
            <Button size="sm" variant="ghost" @click="emit('select-all')">全选</Button>
            <Button size="sm" variant="ghost" @click="emit('clear')">清空</Button>
            <Button size="sm" variant="ghost" @click="emit('invert')">反选</Button>
        </div>
        <div class="chunk-chips">
            <button
                v-for="chunk in props.chunks" :key="chunk.index" type="button" class="chunk-chip"
                :class="{selected: selectedSet.has(chunk.index), selectable: props.selectable}"
                :aria-pressed="props.selectable ? selectedSet.has(chunk.index) : undefined"
                :aria-label="`块 ${chunk.index}，${chunk.firstParagraphId} 至 ${chunk.lastParagraphId}，${formatCount(chunk.characterCount)} 字`"
                @click="props.selectable ? emit('toggle', chunk.index, $event.shiftKey) : undefined"
            >
                <span>块 {{ chunk.index }}</span><span>· {{ chunk.firstParagraphId }}–{{ chunk.lastParagraphId }}</span><small>{{ formatCount(chunk.characterCount) }} 字</small>
            </button>
        </div>
        <p v-if="props.selectable && !props.chunks.length" class="empty">来源没有可用分块。</p>
    </section>
</template>

<style scoped>
.block-preview { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
.preview-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-2); color: var(--text-main); font-size: var(--text-sm); }
.preview-meta { color: var(--text-muted); font-size: var(--text-xs); }
.preview-actions { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.chunk-chips { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
.chunk-chip { display: inline-flex; align-items: center; gap: 4px; min-height: 30px; border: 1px solid var(--border-color); border-radius: 999px; background: var(--bg-panel); padding: 4px 9px; color: var(--text-secondary); font-size: var(--text-xs); white-space: nowrap; }
.chunk-chip.selectable { cursor: pointer; }
.chunk-chip.selectable:hover { border-color: var(--border-accent); color: var(--text-main); }
.chunk-chip.selected { border-color: var(--border-accent); background: var(--accent-bg); color: var(--accent-text); }
.chunk-chip small { color: var(--text-muted); font-size: 10px; }
.chunk-chip.selected small { color: var(--accent-text); }
.empty { margin: 0; color: var(--text-muted); font-size: var(--text-xs); }
</style>
