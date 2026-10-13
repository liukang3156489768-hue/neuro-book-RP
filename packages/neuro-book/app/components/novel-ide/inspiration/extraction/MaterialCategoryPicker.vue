<script setup lang="ts">
import {Button, FormCheckbox} from "@notnotype/nb-ui/components";
import {MATERIAL_CATEGORIES} from "nbook/shared/dto/inspiration-material.dto";

const props = withDefaults(defineProps<{
    modelValue: readonly string[];
    disabled?: boolean;
}>(), {disabled: false});

const emit = defineEmits<{
    (event: "toggle", key: string): void;
    (event: "update:modelValue", keys: string[]): void;
}>();

const MODE_HINTS = {entity: "实体类", document: "文档类", itemized: "文档类"} as const;
</script>

<template>
    <section class="category-picker" aria-label="素材类别">
        <div class="head">
            <strong>要提取的素材类别</strong>
            <span class="head-actions">
                <Button size="sm" variant="ghost" :disabled="props.disabled" @click="emit('update:modelValue', MATERIAL_CATEGORIES.map(category => category.key))">全选</Button>
                <Button size="sm" variant="ghost" :disabled="props.disabled" @click="emit('update:modelValue', [])">清空</Button>
            </span>
        </div>
        <div class="grid">
            <FormCheckbox
                v-for="category in MATERIAL_CATEGORIES" :key="category.key" :model-value="props.modelValue.includes(category.key)" :disabled="props.disabled"
                :label="category.label" :description="MODE_HINTS[category.mode]" @update:model-value="emit('toggle', category.key)"
            />
        </div>
        <p v-if="!props.modelValue.length" class="hint">至少选择一个类别才能开始提取。</p>
    </section>
</template>

<style scoped>
.category-picker {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
}

.head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--space-2);
    color: var(--text-main);
    font-size: var(--text-sm);
}

.head-actions {
    display: flex;
    gap: var(--space-1);
}

.grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: var(--space-2);
}

.hint {
    margin: 0;
    color: var(--status-warning);
    font-size: var(--text-xs);
}
</style>
