<script setup lang="ts">
import {computed, ref} from "vue";
import {Badge, Button, EmptyState, Progress, SegmentedControl} from "@notnotype/nb-ui/components";
import type {ExtractionProgress} from "nbook/shared/dto/inspiration-extraction-task.dto";
import ExtractionNotice from "nbook/app/components/novel-ide/inspiration/extraction/ExtractionNotice.vue";
import {STOP_REASON_LABELS, TASK_STATUS_LABELS, TASK_STATUS_TONES, UNIT_STATUS_LABELS, UNIT_STATUS_TONES} from "nbook/app/utils/inspiration/extraction-labels";

const props = withDefaults(defineProps<{
    progress: ExtractionProgress | null;
    busy?: boolean;
    groupLabel?: (group: string) => string;
}>(), {busy: false, groupLabel: undefined});

const emit = defineEmits<{
    (event: "cancel"): void;
    (event: "resume"): void;
    (event: "retry-unit", unitId: string): void;
    (event: "skip-unit", unitId: string): void;
    (event: "retry-failed", unitIds: string[]): void;
    (event: "skip-failed", unitIds: string[]): void;
}>();

const filter = ref<"active" | "all">("active");
const filterOptions = [{label: "进行中与失败", value: "active"}, {label: "全部", value: "all"}];

const handled = computed(() => {
    const overall = props.progress?.overall;
    return overall ? overall.done + overall.skipped : 0;
});
const visibleUnits = computed(() => {
    const units = props.progress?.units ?? [];
    return filter.value === "all" ? units : units.filter(unit => unit.status === "running" || unit.status === "failed");
});
const failedIds = computed(() => (props.progress?.units ?? []).filter(unit => unit.status === "failed").map(unit => unit.id));
const canManageFailures = computed(() => props.progress?.status === "running" || props.progress?.status === "awaiting-input" || props.progress?.status === "partial-failed");
const canResume = computed(() => {
    const status = props.progress?.status;
    return status === "interrupted" || status === "cancelled" || status === "partial-failed";
});
const progressTone = computed(() => {
    const status = props.progress?.status;
    if (status === "completed") return "success";
    if (status === "partial-failed") return "danger";
    if (status === "interrupted" || status === "awaiting-input") return "warning";
    return "accent";
});

function groupName(group: string): string {
    return props.groupLabel ? props.groupLabel(group) : group;
}
</script>

<template>
    <section class="progress-panel" aria-label="提取进度">
        <EmptyState v-if="!props.progress" icon-class="i-lucide-activity" title="尚未开始" />
        <template v-else>
            <div class="status-line">
                <Badge :tone="TASK_STATUS_TONES[props.progress.status]">{{ TASK_STATUS_LABELS[props.progress.status] }}</Badge>
                <span class="count">已处理 {{ handled }} / 共 {{ props.progress.overall.total }}</span>
                <span v-if="props.progress.overall.failed" class="count count-failed">失败 {{ props.progress.overall.failed }}</span>
                <span class="status-actions">
                    <Button v-if="props.progress.status === 'running'" size="sm" variant="secondary" :disabled="props.busy" @click="emit('cancel')">取消</Button>
                    <Button v-if="canResume" size="sm" variant="primary" :loading="props.busy" @click="emit('resume')">继续</Button>
                </span>
            </div>
            <Progress :model-value="handled" :max="Math.max(props.progress.overall.total, 1)" :tone="progressTone" size="md" />
            <ExtractionNotice v-if="props.progress.status === 'interrupted'" tone="warning">
                任务被中断，已完成的部分都已保留，点“继续”即可接着做。
            </ExtractionNotice>
            <ExtractionNotice v-if="props.progress.awaitingInput" tone="info">{{ props.progress.awaitingInput }}</ExtractionNotice>
            <ExtractionNotice v-if="props.progress.stopReason" tone="danger">
                {{ STOP_REASON_LABELS[props.progress.stopReason.code] }}<template v-if="props.progress.stopReason.message">：{{ props.progress.stopReason.message }}</template>
            </ExtractionNotice>
            <ul v-if="props.progress.groups.length" class="group-list" aria-label="分组进度">
                <li v-for="group in props.progress.groups" :key="group.group">
                    <Badge :tone="group.counts.failed ? 'danger' : group.counts.done + group.counts.skipped === group.counts.total ? 'success' : 'neutral'" variant="soft">
                        {{ groupName(group.group) }} {{ group.counts.done + group.counts.skipped }}/{{ group.counts.total }}
                    </Badge>
                </li>
            </ul>
            <div class="unit-head">
                <strong>逐项状态</strong>
                <div class="unit-head-actions">
                    <Button size="sm" variant="secondary" :disabled="props.busy || !canManageFailures || !failedIds.length"
                        :aria-label="`一键重试 ${failedIds.length} 个失败项`" @click="emit('retry-failed', [...failedIds])">一键重试（{{ failedIds.length }}）</Button>
                    <Button size="sm" variant="ghost" :disabled="props.busy || !canManageFailures || !failedIds.length"
                        :aria-label="`一键跳过 ${failedIds.length} 个失败项`" title="放弃这些失败项，保留已成功产物" @click="emit('skip-failed', [...failedIds])">一键跳过（{{ failedIds.length }}）</Button>
                    <SegmentedControl v-model="filter" :options="filterOptions" size="sm" aria-label="逐项筛选" />
                </div>
            </div>
            <p v-if="!visibleUnits.length" class="empty-hint">{{ filter === 'active' ? '当前没有进行中或失败的项。' : '没有任何项。' }}</p>
            <ul v-else class="unit-list">
                <li v-for="unit in visibleUnits" :key="unit.id" class="unit-row" :data-status="unit.status">
                    <span class="unit-label">{{ unit.label }}</span>
                    <Badge :tone="UNIT_STATUS_TONES[unit.status]" variant="soft" size="sm">{{ UNIT_STATUS_LABELS[unit.status] }}</Badge>
                    <span v-if="unit.status === 'failed'" class="unit-actions">
                        <Button size="sm" variant="secondary" :disabled="props.busy" @click="emit('retry-unit', unit.id)">重试</Button>
                        <Button size="sm" variant="ghost" :disabled="props.busy" @click="emit('skip-unit', unit.id)">跳过</Button>
                    </span>
                    <p v-if="unit.status === 'failed' && unit.error" class="unit-error">{{ unit.error }}</p>
                </li>
            </ul>
        </template>
    </section>
</template>

<style scoped>
.progress-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
}

.status-line {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-secondary);
}

.count-failed {
    color: var(--status-danger);
}

.status-actions {
    display: flex;
    gap: var(--space-2);
    margin-left: auto;
}

.group-list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
}

.unit-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--space-2);
    color: var(--text-main);
    font-size: var(--text-sm);
}

.empty-hint {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
}

.unit-head-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
    min-width: 0;
}

@media (max-width: 520px) {
    .unit-head-actions {
        flex-basis: 100%;
    }
}

.unit-list {
    display: flex;
    flex-direction: column;
    max-height: 280px;
    margin: 0;
    padding: 0;
    overflow: auto;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-control);
    background: var(--bg-panel);
    list-style: none;
}

.unit-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border-color);
    font-size: var(--text-xs);
}

.unit-row:last-child {
    border-bottom: 0;
}

.unit-label {
    flex: 1 1 160px;
    min-width: 0;
    color: var(--text-main);
    overflow-wrap: anywhere;
}

.unit-actions {
    display: flex;
    gap: var(--space-1);
}

.unit-error {
    flex: 1 1 100%;
    margin: 0;
    color: var(--status-danger);
    overflow-wrap: anywhere;
}
</style>
