<script setup lang="ts">
import {computed, ref, watch} from "vue";
import {Button, FormCheckbox, FormSelect, FormTextarea} from "@notnotype/nb-ui/components";
import type {OutlineWorkbenchActions} from "nbook/app/composables/useOutlineWorkbenchActions";
import type {OutlineWorkbenchDetailAnalysis, OutlineWorkbenchEntry} from "nbook/app/composables/useOutlineWorkbenchData";

type IssuedDetailReport = Readonly<{
    entryId: string;
    expectedRevision: number;
    expectedVersion: number;
    report: OutlineWorkbenchDetailAnalysis & Readonly<{planId: string; sourceHash: string; contextHash: string}>;
    warnings: readonly Readonly<{code: "PENDING_REFERENCE"; entryId: string; entryPath: string; path?: string; locator?: string; purpose?: string}>[];
}>;

const props = defineProps<{
    actions: OutlineWorkbenchActions;
    planId: string;
    revision: number;
    record: Readonly<{contentHash: string; value: OutlineWorkbenchEntry}>;
    /** 仅用于提示；能否分析仍以服务端判定为准。 */
    chapterAdopted: boolean;
}>();

const root = ref<HTMLElement | null>(null);
const issued = ref<IssuedDetailReport | null>(null);
/** 从操作行采用时分析出偏离或冲突，提示作者在面板里处理。 */
const notice = ref<string | null>(null);
const confirmDeviations = ref(false);
const resolutions = ref<Array<{decision: "resolved" | "ignored"; reason: string}>>([]);
const decisionOptions = [{value: "resolved", label: "已在细纲中处理"}, {value: "ignored", label: "忽略"}];

// 报告绑定细纲的内容哈希，细纲一旦变化旧报告就不能再用于采用。
watch(() => props.record.contentHash, () => {
    issued.value = null;
    confirmDeviations.value = false;
    resolutions.value = [];
    notice.value = null;
});

const report = computed(() => issued.value?.report ?? null);
const canAdopt = computed(() => {
    if (!report.value) return false;
    if (report.value.deviations.length && !confirmDeviations.value) return false;
    return resolutions.value.every((item) => item.reason.trim().length > 0);
});

async function analyze(): Promise<void> {
    notice.value = null;
    const {value, contentHash} = props.record;
    const result = await props.actions.run<IssuedDetailReport>("analyze-detail", {
        planId: props.planId, entryId: value.id, expectedRevision: props.revision,
        expectedVersion: value.version, expectedContentHash: contentHash,
    }, {refresh: false, fallback: "细纲分析失败"});
    if (!result) return;
    issued.value = result;
    confirmDeviations.value = false;
    resolutions.value = result.report.conflicts.map(() => ({decision: "resolved", reason: ""}));
}

async function adopt(): Promise<void> {
    if (!issued.value || !canAdopt.value) return;
    const current = issued.value;
    const result = await props.actions.run("adopt-detail", {
        planId: props.planId, entryId: current.entryId, expectedRevision: current.expectedRevision,
        expectedVersion: current.expectedVersion, expectedContentHash: props.record.contentHash,
        reportId: current.report.reportId, confirmDeviations: confirmDeviations.value,
        resolutions: resolutions.value.map((item, index) => ({index, decision: item.decision, reason: item.reason.trim()})),
    }, {fallback: "细纲采用失败"});
    if (result) {
        issued.value = null;
        notice.value = null;
    }
}

/**
 * 大纲库操作行的“正式采用”。报告只在方案修订号未变时沿用，否则服务端会拒绝采用；
 * 没有偏离和冲突时直接采用，否则留给作者在面板里确认偏离、说明冲突处理。
 */
async function analyzeAndAdopt(): Promise<void> {
    if (issued.value?.expectedRevision !== props.revision) await analyze();
    if (!report.value) return;
    if (report.value.deviations.length === 0 && report.value.conflicts.length === 0) {
        await adopt();
        return;
    }
    notice.value = "分析发现偏离或冲突，处理后点“正式采用细纲”。";
    root.value?.scrollIntoView({block: "nearest", behavior: "smooth"});
}

defineExpose({analyzeAndAdopt});

function describeWarning(warning: IssuedDetailReport["warnings"][number]): string {
    const subject = warning.locator ?? warning.path ?? "未说明的资料";
    return warning.purpose ? `${subject}（用途：${warning.purpose}）` : subject;
}
</script>

<template>
    <section ref="root" class="analysis-panel" aria-label="细纲偏差分析">
        <template v-if="props.record.value.status === 'adopted'">
            <h4>已正式采用</h4>
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
                    <h4>正式采用前的偏差分析</h4>
                    <p>用当前默认模型对照所属章节大纲检查偏离和冲突。修改细纲后需要重新分析。</p>
                </div>
                <Button size="sm" variant="secondary" icon-class="i-lucide-scan-search" :loading="props.actions.pending.value" :disabled="!props.chapterAdopted" @click="analyze">
                    {{ report ? '重新分析' : '开始分析' }}
                </Button>
            </div>
            <p v-if="!props.chapterAdopted" class="analysis-hint">所属章节大纲尚未正式采用，先采用章节大纲再分析细纲。</p>
            <template v-if="report && issued">
                <p v-if="notice" class="analysis-notice" role="status">{{ notice }}</p>
                <p class="analysis-summary">{{ report.summary }}</p>
                <div v-if="issued.warnings.length" class="analysis-block is-warning">
                    <strong>待补参考资料</strong>
                    <ul class="analysis-list"><li v-for="(warning, index) in issued.warnings" :key="index">{{ describeWarning(warning) }}</li></ul>
                    <p>待补资料不阻止采用，但正文写作时会收到同样的提醒。</p>
                </div>
                <div v-if="report.deviations.length" class="analysis-block">
                    <strong>与章节大纲的偏离</strong>
                    <ul class="analysis-list"><li v-for="(item, index) in report.deviations" :key="index">{{ item }}</li></ul>
                    <FormCheckbox v-model="confirmDeviations" label="我已了解以上偏离，仍按当前细纲采用" />
                </div>
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
                <p v-if="!report.deviations.length && !report.conflicts.length" class="analysis-hint">没有发现偏离或冲突。</p>
                <div class="analysis-actions">
                    <Button size="sm" variant="primary" icon-class="i-lucide-check" :disabled="!canAdopt || props.actions.pending.value" @click="adopt">正式采用细纲</Button>
                </div>
            </template>
        </template>
    </section>
</template>

<style scoped>
.analysis-panel { display: grid; gap: var(--space-4); border: 1px solid var(--border-color); border-radius: var(--radius-control); background: var(--bg-subtle); padding: var(--space-5); }
.analysis-panel h4 { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-medium); }
.analysis-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-5); }
.analysis-heading p, .analysis-hint, .analysis-block p { margin: var(--space-2) 0 0; color: var(--text-muted); font-size: var(--text-2xs); }
.analysis-notice { margin: 0; color: var(--status-warning); font-size: var(--text-xs); }
.analysis-summary { margin: 0; font-size: var(--text-xs); line-height: var(--leading-ui); white-space: pre-wrap; }
.analysis-block { display: grid; gap: var(--space-3); font-size: var(--text-xs); }
.analysis-block.is-warning { border: 1px solid var(--status-warning-border); border-radius: var(--radius-control); background: var(--status-warning-bg); padding: var(--space-4); color: var(--status-warning); }
.analysis-list { display: grid; gap: var(--space-2); margin: 0; padding-left: var(--space-6); font-size: var(--text-xs); }
.conflict-row { display: grid; gap: var(--space-3); border-top: 1px solid var(--border-color); padding-top: var(--space-3); }
.conflict-row p { margin: 0; }
.conflict-controls { display: grid; grid-template-columns: 160px minmax(0, 1fr); gap: var(--space-3); align-items: start; }
.analysis-actions { display: flex; justify-content: flex-end; }
</style>
