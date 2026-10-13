<script setup lang="ts">
import {computed} from "vue";
import {Badge} from "@notnotype/nb-ui/components";
import type {WriteReport} from "nbook/app/utils/inspiration/extraction-api";
import ExtractionNotice from "nbook/app/components/novel-ide/inspiration/extraction/ExtractionNotice.vue";
import {WRITE_STATUS_LABELS, WRITE_STATUS_TONES} from "nbook/app/utils/inspiration/extraction-labels";

const props = defineProps<{report: WriteReport}>();

const count = (status: "written" | "skipped" | "failed"): number => props.report.outcomes.filter(outcome => outcome.status === status).length;
const failed = computed(() => count("failed"));
</script>

<template>
    <section v-if="props.report.outcomes.length" class="write-report" aria-label="写入结果">
        <div class="summary">
            <Badge tone="success" variant="soft">已写入 {{ count('written') }}</Badge>
            <Badge tone="neutral" variant="soft">已跳过 {{ count('skipped') }}</Badge>
            <Badge v-if="failed" tone="danger" variant="soft">失败 {{ failed }}</Badge>
        </div>
        <ExtractionNotice v-if="failed" tone="warning">失败的条目仍在清单中，可以修改后再次确认写入；已经写成功的部分不会重复写。</ExtractionNotice>
        <ul class="outcome-list">
            <li v-for="outcome in props.report.outcomes" :key="outcome.itemId" class="outcome">
                <span class="outcome-title">{{ outcome.title }}</span>
                <Badge :tone="WRITE_STATUS_TONES[outcome.status]" variant="soft" size="sm">{{ WRITE_STATUS_LABELS[outcome.status] }}</Badge>
                <span v-for="path in outcome.paths" :key="path" class="outcome-path">{{ path }}</span>
                <p v-if="outcome.status === 'failed' && outcome.error" class="outcome-error">{{ outcome.error }}</p>
            </li>
        </ul>
    </section>
</template>

<style scoped>
.write-report {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
}

.summary {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
}

.outcome-list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-control);
    background: var(--bg-panel);
    list-style: none;
}

.outcome {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border-color);
    font-size: var(--text-xs);
}

.outcome:last-child {
    border-bottom: 0;
}

.outcome-title {
    color: var(--text-main);
    font-weight: var(--weight-medium);
    overflow-wrap: anywhere;
}

.outcome-path {
    flex: 1 1 100%;
    color: var(--text-muted);
    overflow-wrap: anywhere;
}

.outcome-error {
    flex: 1 1 100%;
    margin: 0;
    color: var(--status-danger);
    overflow-wrap: anywhere;
}
</style>
