<script setup lang="ts">
import {computed, ref, watch} from "vue";
import {Button, FormSelect, FormTextarea} from "@notnotype/nb-ui/components";
import type {OutlineWorkbenchActions} from "nbook/app/composables/useOutlineWorkbenchActions";
import type {OutlineWorkbenchLine} from "nbook/app/composables/useOutlineWorkbenchData";

type IssuedLineReport = Readonly<{
    lineId: string;
    expectedRevision: number;
    expectedVersion: number;
    report: Readonly<{reportId: string; planId: string; sourceHash: string; contextHash: string; summary: string; conflicts: readonly string[]}>;
}>;

const props = defineProps<{
    actions: OutlineWorkbenchActions;
    revision: number;
    record: Readonly<{contentHash: string; value: OutlineWorkbenchLine}>;
}>();

const issued = ref<IssuedLineReport | null>(null);
const resolutions = ref<Array<{decision: "resolved" | "ignored"; reason: string}>>([]);
const decisionOptions = [{value: "resolved", label: "已在线路中处理"}, {value: "ignored", label: "忽略"}];

// 报告绑定线路内容哈希和方案上下文；线路一旦变化旧报告就不能再用于固定。
watch(() => props.record.contentHash, () => {
    issued.value = null;
    resolutions.value = [];
});

const report = computed(() => issued.value?.report ?? null);
const canFix = computed(() => !!report.value && resolutions.value.every((item) => item.reason.trim().length > 0));

async function analyze(): Promise<void> {
    const {value, contentHash} = props.record;
    const result = await props.actions.run<IssuedLineReport>("analyze-line", {
        lineId: value.id, expectedRevision: props.revision, expectedVersion: value.version, expectedContentHash: contentHash,
    }, {refresh: false, fallback: "线路分析失败"});
    if (!result) return;
    issued.value = result;
    resolutions.value = result.report.conflicts.map(() => ({decision: "resolved", reason: ""}));
}

async function fix(): Promise<void> {
    if (!issued.value || !canFix.value) return;
    const current = issued.value;
    const result = await props.actions.run("fix-line", {
        lineId: current.lineId, expectedRevision: current.expectedRevision, expectedVersion: current.expectedVersion,
        expectedContentHash: props.record.contentHash, reportId: current.report.reportId,
        resolutions: resolutions.value.map((item, index) => ({index, decision: item.decision, reason: item.reason.trim()})),
    }, {fallback: "固定线路失败"});
    if (result) issued.value = null;
}
</script>

<template>
    <section class="analysis-panel" aria-label="线路分析">
        <template v-if="props.record.value.fixed">
            <h4>已固定</h4>
            <p v-if="props.record.value.analysis" class="analysis-summary">{{ props.record.value.analysis.summary }}</p>
            <ul v-if="props.record.value.analysis?.resolutions.length" class="analysis-list">
                <li v-for="item in props.record.value.analysis.resolutions" :key="item.index">
                    {{ props.record.value.analysis.conflicts[item.index] }} · {{ item.decision === 'resolved' ? '已处理' : '已忽略' }}：{{ item.reason }}
                </li>
            </ul>
        </template>
        <template v-else>
            <div class="analysis-heading">
                <div>
                    <h4>固定前的线路分析</h4>
                    <p>用当前默认模型检查线路与本方案其他线路、大纲之间的矛盾。节点须关联已正式采用的条目；修改线路后需要重新分析。</p>
                </div>
                <Button size="sm" variant="secondary" icon-class="i-lucide-scan-search" :loading="props.actions.pending.value" :disabled="props.record.value.nodeIds.length < 2" @click="analyze">
                    {{ report ? '重新分析' : '开始分析' }}
                </Button>
            </div>
            <p v-if="props.record.value.nodeIds.length < 2" class="analysis-hint">线路至少需要 2 个节点，先编辑节点再分析。</p>
            <template v-if="report">
                <p class="analysis-summary">{{ report.summary }}</p>
                <div v-if="report.conflicts.length" class="analysis-block">
                    <strong>冲突（每条都需要说明处理方式）</strong>
                    <article v-for="(item, index) in report.conflicts" :key="index" class="conflict-row">
                        <p>{{ item }}</p>
                        <div v-if="resolutions[index]" class="conflict-controls">
                            <FormSelect v-model="resolutions[index].decision" :options="decisionOptions" size="sm" aria-label="处理方式" />
                            <FormTextarea v-model="resolutions[index].reason" :rows="2" placeholder="说明如何处理或为何忽略" />
                        </div>
                    </article>
                </div>
                <p v-else class="analysis-hint">没有发现冲突。</p>
                <div class="analysis-actions">
                    <Button size="sm" variant="primary" icon-class="i-lucide-lock" :disabled="!canFix || props.actions.pending.value" @click="fix">固定线路</Button>
                </div>
            </template>
        </template>
    </section>
</template>

<style scoped>
.analysis-panel { display: grid; gap: var(--space-4); border: 1px solid var(--border-color); border-radius: var(--radius-control); background: var(--bg-subtle); padding: var(--space-5); }
.analysis-panel h4 { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-medium); }
.analysis-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-5); }
.analysis-heading p, .analysis-hint { margin: var(--space-2) 0 0; color: var(--text-muted); font-size: var(--text-2xs); }
.analysis-summary { margin: 0; font-size: var(--text-xs); line-height: var(--leading-ui); white-space: pre-wrap; }
.analysis-block { display: grid; gap: var(--space-3); font-size: var(--text-xs); }
.analysis-list { display: grid; gap: var(--space-2); margin: 0; padding-left: var(--space-6); font-size: var(--text-xs); }
.conflict-row { display: grid; gap: var(--space-3); border-top: 1px solid var(--border-color); padding-top: var(--space-3); }
.conflict-row p { margin: 0; }
.conflict-controls { display: grid; grid-template-columns: 160px minmax(0, 1fr); gap: var(--space-3); align-items: start; }
.analysis-actions { display: flex; justify-content: flex-end; }
</style>
