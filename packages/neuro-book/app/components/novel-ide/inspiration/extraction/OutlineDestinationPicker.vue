<script setup lang="ts">
import {Button} from "@notnotype/nb-ui/components";
import ExtractionNotice from "nbook/app/components/novel-ide/inspiration/extraction/ExtractionNotice.vue";
import type {DestinationChoice} from "nbook/app/composables/useInspirationExtraction";

type DestinationOption = {planId: string; planTitle: string; canSupplement: boolean; canOverwrite: boolean; reason: string | null};

const props = withDefaults(defineProps<{
    options: readonly DestinationOption[];
    modelValue: DestinationChoice;
    disabled?: boolean;
}>(), {disabled: false});

const emit = defineEmits<{(event: "update:modelValue", choice: DestinationChoice): void}>();

function isChosen(kind: DestinationChoice["kind"], planId?: string): boolean {
    const current = props.modelValue;
    return current.kind === kind && (current.kind === "new" || current.planId === planId);
}
</script>

<template>
    <section class="destination-picker" aria-label="数据去向">
        <article class="card" :class="{'is-chosen': isChosen('new')}">
            <div class="card-head">
                <strong>新建提取方案</strong>
                <Button size="sm" :variant="isChosen('new') ? 'primary' : 'secondary'" :aria-pressed="isChosen('new')" :disabled="props.disabled" @click="emit('update:modelValue', {kind: 'new'})">
                    {{ isChosen('new') ? '已选择' : '选择' }}
                </Button>
            </div>
            <p class="card-text">提取结果写入一个新的大纲方案，不影响已有内容。</p>
        </article>
        <article v-for="option in props.options" :key="option.planId" class="card" :class="{'is-chosen': isChosen('supplement', option.planId) || isChosen('overwrite', option.planId)}">
            <div class="card-head">
                <strong>{{ option.planTitle }}</strong>
                <span class="card-buttons">
                    <Button
                        size="sm" :variant="isChosen('supplement', option.planId) ? 'primary' : 'secondary'" :aria-pressed="isChosen('supplement', option.planId)"
                        :disabled="props.disabled || !option.canSupplement" @click="emit('update:modelValue', {kind: 'supplement', planId: option.planId})"
                    >补充</Button>
                    <Button
                        size="sm" :variant="isChosen('overwrite', option.planId) ? 'primary' : 'secondary'" :aria-pressed="isChosen('overwrite', option.planId)"
                        :disabled="props.disabled || !option.canOverwrite" @click="emit('update:modelValue', {kind: 'overwrite', planId: option.planId})"
                    >覆盖</Button>
                </span>
            </div>
            <p class="card-text">补充只填入缺少的细纲、章节大纲、卷纲与总纲，已有内容不动；覆盖会先给出新旧对比，由你逐项确认后才替换。</p>
            <ExtractionNotice v-if="option.reason" tone="warning">{{ option.reason }}</ExtractionNotice>
        </article>
    </section>
</template>

<style scoped>
.destination-picker {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
}

.card {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-control);
    background: var(--bg-panel);
}

.card.is-chosen {
    border-color: var(--accent-main);
    background: var(--accent-bg);
}

.card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--space-2);
    color: var(--text-main);
    font-size: var(--text-sm);
}

.card-buttons {
    display: flex;
    gap: var(--space-2);
}

.card-text {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: 1.6;
}
</style>
