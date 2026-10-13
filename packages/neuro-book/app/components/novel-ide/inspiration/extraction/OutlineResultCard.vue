<script setup lang="ts">
import {Badge, Button} from "@notnotype/nb-ui/components";
import type {OutlineExtractionOutcome} from "nbook/app/utils/inspiration/extraction-api";
import ExtractionNotice from "nbook/app/components/novel-ide/inspiration/extraction/ExtractionNotice.vue";
import {ITEM_KIND_LABELS} from "nbook/app/utils/inspiration/extraction-labels";

const props = withDefaults(defineProps<{
    outcome: OutlineExtractionOutcome;
    busy?: boolean;
}>(), {busy: false});

const emit = defineEmits<{
    (event: "open-plan", plan: {planId: string; planTitle: string}): void;
    (event: "resummarize"): void;
}>();

const DESTINATION_LABELS = {new: "新建", supplement: "补充", overwrite: "覆盖"} as const;
</script>

<template>
    <section class="result-card" aria-label="大纲提取结果">
        <header class="head">
            <strong class="plan-title">{{ props.outcome.planTitle }}</strong>
            <Badge tone="accent" variant="soft">{{ DESTINATION_LABELS[props.outcome.destination] }}</Badge>
        </header>
        <ExtractionNotice v-if="props.outcome.staleNotice" tone="warning">{{ props.outcome.staleNotice }}</ExtractionNotice>
        <ExtractionNotice v-if="props.outcome.failedOverwrites.length" tone="danger">
            <p class="notice-title">以下覆盖项写入失败，原内容保持不变：</p>
            <ul class="failed-list">
                <li v-for="item in props.outcome.failedOverwrites" :key="item.unitId">第 {{ item.chapterIndex }} 章{{ ITEM_KIND_LABELS[item.kind] }}：{{ item.error }}</li>
            </ul>
        </ExtractionNotice>
        <ExtractionNotice v-if="props.outcome.unmappedChapters.length" tone="info">
            第 {{ props.outcome.unmappedChapters.join('、') }} 章在所选方案里没有对应章节，未提取。
        </ExtractionNotice>
        <div class="actions">
            <Button variant="primary" icon-class="i-lucide-external-link" @click="emit('open-plan', {planId: props.outcome.planId, planTitle: props.outcome.planTitle})">打开提取方案</Button>
            <Button v-if="props.outcome.staleNotice" variant="secondary" :loading="props.busy" :disabled="!props.outcome.canResummarize" @click="emit('resummarize')">重新汇总本卷与总纲</Button>
        </div>
    </section>
</template>

<style scoped>
.result-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-control);
    background: var(--bg-panel);
}

.head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
    color: var(--text-main);
    font-size: var(--text-sm);
}

.plan-title {
    min-width: 0;
    overflow-wrap: anywhere;
}

.notice-title {
    margin: 0 0 var(--space-1);
}

.failed-list {
    margin: 0;
    padding-left: var(--space-5);
}

.actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
}
</style>
