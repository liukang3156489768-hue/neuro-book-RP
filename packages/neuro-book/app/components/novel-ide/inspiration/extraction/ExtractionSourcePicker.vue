<script setup lang="ts">
import {computed} from "vue";
import {Button, FormField, FormSelect} from "@notnotype/nb-ui/components";
import ExtractionNotice from "nbook/app/components/novel-ide/inspiration/extraction/ExtractionNotice.vue";

const props = withDefaults(defineProps<{
    sources: ReadonlyArray<{path: string; name: string; bytes: number}>;
    modelValue: string;
    loading?: boolean;
    error?: string;
    warnings?: readonly string[];
}>(), {loading: false, error: "", warnings: () => []});

const emit = defineEmits<{
    (event: "update:modelValue", path: string): void;
    (event: "refresh"): void;
}>();

const options = computed(() => props.sources.map(source => ({value: source.path, label: `${source.path.replace(/^reference\//u, "")} · ${formatBytes(source.bytes)}`})));
const selected = computed(() => props.sources.find(source => source.path === props.modelValue) ?? null);

function formatBytes(bytes: number): string {
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
</script>

<template>
    <section class="source-picker" aria-label="提取来源">
        <div class="picker-row">
            <FormField label="作品来源" class="picker-field">
                <FormSelect
                    :model-value="props.modelValue"
                    :options="options"
                    :placeholder="options.length ? '选择 reference 中的作品' : '请先把作品放进项目的 reference 目录'"
                    @update:model-value="emit('update:modelValue', $event)"
                />
            </FormField>
            <Button variant="secondary" size="md" icon-class="i-lucide-refresh-cw" :loading="props.loading" :disabled="props.loading" @click="emit('refresh')">刷新</Button>
        </div>
        <p v-if="selected" class="picker-meta">所选作品 {{ formatBytes(selected.bytes) }}；提取只读取该文件，不会修改它。</p>
        <ExtractionNotice v-if="props.error" tone="danger">{{ props.error }}</ExtractionNotice>
        <ExtractionNotice v-for="warning in props.warnings" :key="warning" tone="warning">{{ warning }}</ExtractionNotice>
    </section>
</template>

<style scoped>
.source-picker {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
}

.picker-row {
    display: flex;
    align-items: flex-end;
    flex-wrap: wrap;
    gap: var(--space-2);
}

.picker-field {
    flex: 1 1 240px;
    min-width: 0;
}

.picker-meta {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
}
</style>
