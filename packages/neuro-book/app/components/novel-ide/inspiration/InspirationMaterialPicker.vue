<script setup lang="ts">
import {computed} from "vue";
import {Button, FormCheckbox, FormInput, FormSelect, IconButton} from "@notnotype/nb-ui/components";
import {INSPIRATION_CATEGORIES, INSPIRATION_CATEGORY_LABELS, type InspirationCategory, type InspirationMaterialListDto} from "nbook/shared/dto/inspiration.dto";

const props = defineProps<{
    items: InspirationMaterialListDto["items"];
    selected: readonly {path: string; title: string}[];
    total: number;
    hasMore: boolean;
    loading: boolean;
    disabled: boolean;
    error: string;
}>();
const query = defineModel<string>("query", {required: true});
const category = defineModel<InspirationCategory | "all">("category", {required: true});
const emit = defineEmits<{toggle: [path: string]; "load-more": []}>();
const categoryOptions = [{value: "all", label: "全部类别"}, ...INSPIRATION_CATEGORIES.map(value => ({value, label: INSPIRATION_CATEGORY_LABELS[value]}))];
const selectedPaths = computed(() => new Set(props.selected.map(item => item.path)));
function chooseCategory(value: string): void {
    if (value === "all" || INSPIRATION_CATEGORIES.some(item => item === value)) category.value = value as InspirationCategory | "all";
}
</script>

<template>
    <section class="material-picker" aria-label="改编参考素材">
        <div class="picker-heading"><strong>参考素材</strong><span>已选 {{ selected.length }} / 12</span></div>
        <p>选择当前作品中的素材进行改编，审阅后保存为新素材。</p>
        <div class="picker-filters">
            <FormInput v-model="query" :disabled="disabled" placeholder="搜索名称或路径" aria-label="搜索参考素材" />
            <FormSelect :model-value="category" :options="categoryOptions" :disabled="disabled" aria-label="参考素材类别" @update:model-value="chooseCategory" />
        </div>
        <ul v-if="selected.length" class="chosen-materials" aria-label="已选参考素材">
            <li v-for="item in selected" :key="item.path"><span :title="item.path">{{ item.title }}</span><IconButton :title="`移除参考素材：${item.title}`" icon-class="i-lucide-x" size="sm" :disabled="disabled" @click="emit('toggle', item.path)" /></li>
        </ul>
        <p v-else class="picker-hint">请选择至少一项参考素材后发送改编需求。</p>
        <p v-if="error" role="alert" class="picker-error">{{ error }}</p>
        <div class="material-directory" aria-label="参考素材目录" :aria-busy="loading">
            <p v-if="!items.length">{{ loading ? '正在读取素材目录…' : '没有符合条件的素材' }}</p>
            <article v-for="item in items" :key="item.path" class="material-option">
                <FormCheckbox :model-value="selectedPaths.has(item.path)" :label="item.title" :disabled="disabled || (!selectedPaths.has(item.path) && selected.length >= 12)" @update:model-value="emit('toggle', item.path)" />
                <small>{{ INSPIRATION_CATEGORY_LABELS[item.category] }} · {{ item.path }}</small>
            </article>
        </div>
        <div class="picker-footer"><span>共 {{ total }} 项</span><Button v-if="hasMore" variant="ghost" size="sm" :disabled="disabled || loading" @click="emit('load-more')">{{ loading ? '加载中…' : '加载更多' }}</Button></div>
    </section>
</template>

<style scoped>
.material-picker { display: grid; min-width: 0; gap: var(--space-3); padding: var(--space-4); border: var(--border-w) solid var(--divider); border-radius: var(--radius-panel); background: var(--bg-panel); }
.picker-heading, .picker-footer { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); font-size: var(--text-xs); }
.material-picker p { margin: 0; color: var(--text-secondary); font-size: var(--text-xs); }
.picker-filters { display: grid; min-width: 0; grid-template-columns: minmax(0, 1fr) minmax(120px, .65fr); gap: var(--space-3); }
.chosen-materials { display: flex; flex-wrap: wrap; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.chosen-materials li { display: flex; min-width: 0; max-width: 100%; align-items: center; gap: var(--space-2); padding-left: var(--space-3); border: var(--border-w) solid var(--divider); border-radius: var(--radius-control); font-size: var(--text-xs); }
.chosen-materials li span { overflow-wrap: anywhere; }
.material-directory { display: grid; min-height: 0; max-height: 190px; overflow: auto; gap: var(--space-3); }
.material-option { display: grid; min-width: 0; gap: var(--space-1); }
.material-option small, .picker-footer > span, .picker-heading > span { color: var(--text-muted); font-size: var(--text-2xs); overflow-wrap: anywhere; }
.material-picker .picker-error { color: var(--status-danger); }
@media (max-width: 520px) { .picker-filters { grid-template-columns: minmax(0, 1fr); } }
</style>
