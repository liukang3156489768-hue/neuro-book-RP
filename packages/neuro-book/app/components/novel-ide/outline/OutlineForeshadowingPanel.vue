<script setup lang="ts">
import {computed, ref, watch} from "vue";
import {Badge, Button, EmptyState, FormField, FormInput, FormTextarea} from "@notnotype/nb-ui/components";
import {useOutlineWorkbenchActions} from "nbook/app/composables/useOutlineWorkbenchActions";
import type {OutlineWorkbenchForeshadowingResponse, OutlineWorkbenchForeshadowingState, OutlineWorkbenchSnapshot} from "nbook/app/composables/useOutlineWorkbenchData";
import {
    emptyForeshadowForm, foreshadowToForm, formToCreateDesign, formToEditDesign, validateForeshadowForm, type ForeshadowFormValue,
} from "nbook/app/utils/outline/outline-foreshadow-form";

type State = OutlineWorkbenchForeshadowingState["status"];
type ObjectImpact = Readonly<{targetId: string; objectFile: string | null; references: readonly Readonly<{sourceFile: string; relation: string; sourceId?: string}>[]; canDeleteObject: boolean}>;
type Preview = Readonly<{revision: number; objectHash: string | null; impact: ObjectImpact}>;

const props = defineProps<{
    projectRoot: string | null;
    snapshot: OutlineWorkbenchSnapshot | null;
    foreshadowing: OutlineWorkbenchForeshadowingResponse | null;
    /** 已历章节按方案派生，只展示当前选中方案的结果。 */
    planId: string | null;
    refresh: () => Promise<void>;
}>();

const actions = useOutlineWorkbenchActions(() => props.projectRoot, () => props.refresh());
const stateLabels: Record<State, string> = {draft: "草稿", pending: "待使用", planted: "已埋设", recovered: "已回收"};
const stateTones: Record<State, "neutral" | "accent" | "success" | "warning"> = {draft: "warning", pending: "neutral", planted: "accent", recovered: "success"};
const actionLabels: Record<string, string> = {plant: "埋设", reinforce: "强化", recover: "回收"};
const issueLabels: Record<string, string> = {RECOVER_BEFORE_PLANT: "回收出现在埋设之前", REINFORCE_BEFORE_PLANT: "强化出现在埋设之前"};

const selectedId = ref<string | null>(null);
const mode = ref<"view" | "edit" | "create">("view");
const form = ref<ForeshadowFormValue>(emptyForeshadowForm());
const formError = ref<string | null>(null);
const preview = ref<Preview | null>(null);

const revision = computed(() => props.snapshot?.manifest.revision ?? 0);
const records = computed(() => props.snapshot?.foreshadowing ?? []);
const states = computed(() => new Map((props.foreshadowing?.states ?? []).map((item) => [item.id, item])));
const selected = computed(() => records.value.find(({value}) => value.id === selectedId.value) ?? null);
const selectedState = computed(() => selected.value ? states.value.get(selected.value.value.id) ?? null : null);
const selectedElapsed = computed(() => props.foreshadowing?.elapsed
    .find((item) => item.id === selectedId.value)?.plans.find((plan) => plan.planId === props.planId) ?? null);
const entryTitles = computed(() => new Map((props.snapshot?.entries ?? []).map(({value}) => [value.id, value.title])));
const planTitles = computed(() => new Map((props.snapshot?.manifest.plans ?? []).map(({id, title}) => [id, title])));
const graphPlanTitles = computed(() => new Map((props.snapshot?.graphs ?? []).map(({value}) => [value.id, planTitles.value.get(value.planId) ?? value.planId])));
const nodeColumns = computed(() => new Map((props.snapshot?.graphs ?? []).flatMap(({value}) => value.nodes.map((node) => [node.id, node.column] as const))));

// 数据刷新后选中的伏笔可能已被删除，此时回到空态而不是保留悬空的编辑表单。
watch(records, (next) => {
    if (selectedId.value && !next.some(({value}) => value.id === selectedId.value)) select(null);
});

/** 状态接口覆盖每条定义；缺失只发生在状态读取失败时，此时只显示定义自身的确认状态，不在客户端推断埋设进度。 */
function badgeOf(id: string, status: "draft" | "adopted"): Readonly<{label: string; tone: "neutral" | "accent" | "success" | "warning"}> {
    const state = states.value.get(id)?.status;
    if (state) return {label: stateLabels[state], tone: stateTones[state]};
    return status === "draft" ? {label: stateLabels.draft, tone: stateTones.draft} : {label: "已确认", tone: "neutral"};
}
function select(id: string | null): void {
    selectedId.value = id;
    mode.value = "view";
    formError.value = null;
    preview.value = null;
}
function startCreate(): void {
    select(null);
    form.value = emptyForeshadowForm();
    mode.value = "create";
}
function startEdit(): void {
    if (!selected.value) return;
    form.value = foreshadowToForm(selected.value.value);
    formError.value = null;
    preview.value = null;
    mode.value = "edit";
}

async function submit(): Promise<void> {
    formError.value = validateForeshadowForm(form.value);
    if (formError.value) return;
    const base = {title: form.value.title.trim(), body: form.value.body};
    if (mode.value === "create") {
        const result = await actions.run<{foreshadowingId: string}>("foreshadowing-action", {expectedRevision: revision.value,
            action: {kind: "create-foreshadowing", ...base, ...formToCreateDesign(form.value)}}, {fallback: "新建伏笔失败"});
        if (result) select(result.foreshadowingId);
        return;
    }
    const current = selected.value;
    if (!current) return;
    const result = await actions.run("foreshadowing-action", {expectedRevision: revision.value, action: {kind: "edit-foreshadowing",
        id: current.value.id, expectedVersion: current.value.version, expectedContentHash: current.contentHash,
        ...base, ...formToEditDesign(form.value)}}, {fallback: "保存伏笔失败"});
    if (result) mode.value = "view";
}
async function confirm(): Promise<void> {
    const current = selected.value;
    if (!current) return;
    await actions.run("foreshadowing-action", {expectedRevision: revision.value, action: {kind: "confirm-foreshadowing",
        id: current.value.id, expectedVersion: current.value.version, expectedContentHash: current.contentHash}}, {fallback: "确认伏笔失败"});
}
async function previewDeletion(): Promise<void> {
    if (!selected.value) return;
    const result = await actions.run<Preview>("preview-object-deletion", {targetId: selected.value.value.id},
        {refresh: false, fallback: "读取删除影响失败"});
    if (result) preview.value = result;
}
async function confirmDeletion(): Promise<void> {
    const current = preview.value;
    if (!current?.objectHash || !current.impact.canDeleteObject) return;
    const result = await actions.run("remove-object", {targetId: current.impact.targetId, expectedRevision: current.revision,
        expectedObjectHash: current.objectHash, confirmedTotal: false}, {fallback: "删除伏笔失败"});
    if (result) select(null);
}

function describeReference(reference: ObjectImpact["references"][number]): string {
    const [relation] = reference.relation.split(":");
    if (relation === "marker") return `「${entryTitles.value.get(reference.sourceId ?? "") ?? reference.sourceFile}」正文中的伏笔标记`;
    if (relation === "node") return `方案「${graphPlanTitles.value.get(reference.sourceId ?? "") ?? reference.sourceId}」线路图中的节点`;
    return reference.sourceFile;
}
</script>

<template>
    <div class="foreshadow-panel">
        <div class="foreshadow-bar">
            <Button size="sm" variant="primary" icon-class="i-lucide-plus" :disabled="actions.pending.value" @click="startCreate">新建伏笔</Button>
            <span class="bar-hint">新建和修改后的伏笔为草稿，确认设计后才会参与状态计算。</span>
        </div>
        <div v-if="actions.error.value" class="panel-error" role="alert"><span class="i-lucide-circle-alert"></span>{{ actions.error.value }}<button type="button" @click="actions.clearError()">知道了</button></div>

        <section v-if="preview" class="impact-panel" aria-label="删除影响">
            <strong>删除伏笔「{{ selected?.value.title ?? preview.impact.targetId }}」</strong>
            <p>将删除文件 {{ preview.impact.objectFile ?? '（未找到文件）' }}，删除后可在操作记录中撤销。</p>
            <template v-if="preview.impact.references.length">
                <p>以下位置仍引用这条伏笔，请先移除这些标记：</p>
                <ul><li v-for="(reference, index) in preview.impact.references" :key="index">{{ describeReference(reference) }}</li></ul>
            </template>
            <div class="impact-actions">
                <Button size="sm" variant="ghost" @click="preview = null">取消</Button>
                <Button size="sm" variant="danger" :disabled="!preview.impact.canDeleteObject || !preview.objectHash || actions.pending.value" @click="confirmDeletion">确认</Button>
            </div>
        </section>

        <div class="foreshadow-columns">
            <nav class="foreshadow-list" aria-label="伏笔列表">
                <EmptyState v-if="!records.length" icon-class="i-lucide-book-marked" title="还没有伏笔" description="伏笔先在这里设计，再到章节大纲正文中标记埋设、强化和回收的位置。" />
                <button
                    v-for="record in records"
                    :key="record.value.id"
                    type="button"
                    class="foreshadow-row"
                    :class="{'is-selected': record.value.id === selectedId}"
                    @click="select(record.value.id)"
                >
                    <span class="row-title">{{ record.value.title }}</span>
                    <span v-if="states.get(record.value.id)?.issues.length" class="i-lucide-triangle-alert row-warning" title="标记顺序异常"></span>
                    <Badge :tone="badgeOf(record.value.id, record.value.status).tone">{{ badgeOf(record.value.id, record.value.status).label }}</Badge>
                </button>
            </nav>

            <div class="foreshadow-detail">
                <form v-if="mode !== 'view'" class="foreshadow-form" @submit.prevent="submit">
                    <h3>{{ mode === 'create' ? '新建伏笔' : '编辑伏笔' }}</h3>
                    <p v-if="mode === 'edit' && selected?.value.status === 'adopted'" class="detail-hint">保存后这条伏笔会回到草稿，需要重新确认设计；已标记的来源在重新确认前不计入状态。</p>
                    <FormField label="名称" required><FormInput v-model="form.title" :disabled="actions.pending.value" /></FormField>
                    <div class="form-grid">
                        <FormField label="表面线索" description="读者当时看到的内容。"><FormTextarea v-model="form.surface" :rows="2" :disabled="actions.pending.value" /></FormField>
                        <FormField label="背后关联" description="这条线索真正指向的事实。"><FormTextarea v-model="form.connection" :rows="2" :disabled="actions.pending.value" /></FormField>
                    </div>
                    <fieldset class="design-group">
                        <legend>埋设建议 <span>三项同时填写或全部留空</span></legend>
                        <FormField label="出现情境"><FormInput v-model="form.plant.situation" :disabled="actions.pending.value" /></FormField>
                        <FormField label="呈现方式"><FormInput v-model="form.plant.presentation" :disabled="actions.pending.value" /></FormField>
                        <FormField label="暗示程度"><FormInput v-model="form.plant.subtlety" :disabled="actions.pending.value" /></FormField>
                    </fieldset>
                    <fieldset class="design-group">
                        <legend>回收建议 <span>三项同时填写或全部留空</span></legend>
                        <FormField label="揭示条件"><FormInput v-model="form.recover.condition" :disabled="actions.pending.value" /></FormField>
                        <FormField label="前后呼应"><FormInput v-model="form.recover.echo" :disabled="actions.pending.value" /></FormField>
                        <FormField label="预期效果"><FormInput v-model="form.recover.effect" :disabled="actions.pending.value" /></FormField>
                    </fieldset>
                    <FormField label="补充说明"><FormTextarea v-model="form.body" :rows="5" :disabled="actions.pending.value" /></FormField>
                    <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
                    <div class="detail-actions">
                        <Button size="sm" variant="ghost" @click="mode = 'view'">取消</Button>
                        <Button size="sm" variant="primary" type="submit" :loading="actions.pending.value">保存为草稿</Button>
                    </div>
                </form>

                <template v-else-if="selected">
                    <div class="detail-heading">
                        <div>
                            <h3>{{ selected.value.title }}</h3>
                            <div class="detail-badges">
                                <Badge :tone="badgeOf(selected.value.id, selected.value.status).tone">{{ badgeOf(selected.value.id, selected.value.status).label }}</Badge>
                                <Badge v-if="selectedElapsed?.elapsed != null" tone="neutral">已过 {{ selectedElapsed.elapsed }} 格</Badge>
                            </div>
                        </div>
                        <div class="detail-actions">
                            <Button size="sm" variant="secondary" icon-class="i-lucide-pencil" @click="startEdit">编辑</Button>
                            <Button v-if="selected.value.status === 'draft'" size="sm" variant="primary" icon-class="i-lucide-check" :disabled="actions.pending.value" @click="confirm">确认设计</Button>
                            <Button size="sm" variant="danger" icon-class="i-lucide-trash-2" :disabled="actions.pending.value" @click="previewDeletion">删除</Button>
                        </div>
                    </div>
                    <dl class="detail-meta">
                        <template v-if="selected.value.surface"><dt>表面线索</dt><dd>{{ selected.value.surface }}</dd></template>
                        <template v-if="selected.value.connection"><dt>背后关联</dt><dd>{{ selected.value.connection }}</dd></template>
                        <template v-if="selected.value.plant"><dt>埋设建议</dt><dd>{{ selected.value.plant.situation }} · {{ selected.value.plant.presentation }} · 暗示程度：{{ selected.value.plant.subtlety }}</dd></template>
                        <template v-if="selected.value.recover"><dt>回收建议</dt><dd>{{ selected.value.recover.condition }} · {{ selected.value.recover.echo }} · 预期效果：{{ selected.value.recover.effect }}</dd></template>
                        <template v-if="selected.value.body.trim()"><dt>补充说明</dt><dd>{{ selected.value.body }}</dd></template>
                    </dl>
                    <section class="source-section" aria-label="伏笔标记来源">
                        <h4>正式来源</h4>
                        <p v-if="!selectedState?.sources.length" class="detail-hint">还没有来自已采用章节大纲的标记。在章节大纲的编辑界面选中文字即可标记埋设、强化或回收。</p>
                        <ul v-else class="source-list">
                            <li v-for="source in selectedState.sources" :key="`${source.nodeId}:${source.marker}`" :class="{'is-invalid': !source.valid}">
                                <Badge :tone="source.valid ? 'accent' : 'warning'">{{ actionLabels[source.action] }}</Badge>
                                <span class="source-chapter">{{ entryTitles.get(source.chapterId) ?? source.entryPath }}（第 {{ source.column }} 格）</span>
                                <span class="source-content">{{ source.content || '（空标记）' }}</span>
                                <span v-if="!source.valid" class="source-note">顺序异常，未计入状态</span>
                            </li>
                        </ul>
                        <ul v-if="selectedState?.issues.length" class="issue-list">
                            <li v-for="issue in selectedState.issues" :key="`${issue.nodeId}:${issue.marker}`">
                                「{{ entryTitles.get(issue.chapterId) ?? issue.chapterId }}」{{ issueLabels[issue.code] ?? issue.code }}（方案「{{ planTitles.get(issue.planId) ?? issue.planId }}」第 {{ nodeColumns.get(issue.nodeId) ?? '?' }} 格）
                            </li>
                        </ul>
                    </section>
                </template>
                <EmptyState v-else icon-class="i-lucide-mouse-pointer-click" title="选择一条伏笔" description="在左侧选择伏笔查看设计与标记来源，或新建一条伏笔。" />
            </div>
        </div>

        <section v-if="props.foreshadowing?.markerIssues.length" class="marker-diagnostics" aria-label="伏笔标记解析异常">
            <div class="marker-diagnostics-title"><span class="i-lucide-circle-alert"></span><strong>标记解析异常</strong><span>{{ props.foreshadowing.markerIssues.length }} 个章节</span></div>
            <article v-for="issue in props.foreshadowing.markerIssues" :key="`${issue.entryId}:${issue.path}`" class="marker-diagnostic">
                <strong>{{ entryTitles.get(issue.entryId) ?? issue.path }}</strong>
                <ul><li v-for="diagnostic in issue.diagnostics" :key="diagnostic.message">{{ diagnostic.message }}</li></ul>
            </article>
        </section>
    </div>
</template>

<style scoped>
.foreshadow-panel { display: flex; min-height: 0; flex: 1; flex-direction: column; gap: var(--space-4); }
.foreshadow-bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-4); }
.bar-hint, .detail-hint { margin: 0; color: var(--text-muted); font-size: var(--text-2xs); }
.panel-error { display: flex; align-items: center; gap: var(--space-3); border: 1px solid var(--status-danger-border); border-radius: var(--radius-control); background: var(--status-danger-bg); color: var(--status-danger); padding: var(--space-3) var(--space-5); font-size: var(--text-xs); }
.panel-error button { margin-left: auto; border: 0; background: transparent; color: inherit; cursor: pointer; text-decoration: underline; }
.impact-panel { display: grid; gap: var(--space-3); border: 1px solid var(--status-warning-border); border-radius: var(--radius-control); background: var(--status-warning-bg); padding: var(--space-5); font-size: var(--text-xs); }
.impact-panel p { margin: 0; }
.impact-panel ul { display: grid; gap: var(--space-2); margin: 0; padding-left: var(--space-6); }
.impact-actions, .detail-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-3); }
.foreshadow-columns { display: grid; min-height: 0; flex: 1; grid-template-columns: minmax(220px, 320px) minmax(0, 1fr); gap: var(--space-5); }
.foreshadow-list { display: flex; min-height: 0; flex-direction: column; gap: var(--space-2); overflow: auto; border-right: 1px solid var(--border-color); padding-right: var(--space-4); }
.foreshadow-row { display: flex; align-items: center; gap: var(--space-3); border: 1px solid transparent; border-radius: var(--radius-control); background: transparent; color: var(--text-main); cursor: pointer; padding: var(--space-3) var(--space-4); text-align: left; font-size: var(--text-xs); }
.foreshadow-row:hover { background: color-mix(in srgb, var(--text-main) 8%, transparent); }
.foreshadow-row.is-selected { border-color: var(--accent-main); background: var(--accent-bg); color: var(--accent-text); }
.row-title { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-warning { flex: 0 0 auto; color: var(--status-warning); }
.foreshadow-detail { display: flex; min-width: 0; min-height: 0; flex-direction: column; gap: var(--space-4); overflow: auto; padding-right: var(--space-2); }
.foreshadow-detail h3 { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-strong); }
.foreshadow-detail h4 { margin: 0; font-size: var(--text-xs); font-weight: var(--weight-medium); }
.foreshadow-form { display: grid; gap: var(--space-5); }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-5); }
.design-group { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-4); margin: 0; border: 1px solid var(--border-color); border-radius: var(--radius-control); padding: var(--space-4) var(--space-5) var(--space-5); }
.design-group legend { padding: 0 var(--space-2); font-size: var(--text-xs); font-weight: var(--weight-medium); }
.design-group legend span { color: var(--text-muted); font-size: var(--text-2xs); font-weight: normal; }
.form-error { margin: 0; color: var(--status-danger); font-size: var(--text-xs); }
.detail-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); }
.detail-badges { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-3); }
.detail-meta { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-3) var(--space-5); margin: 0; font-size: var(--text-xs); }
.detail-meta dt { color: var(--text-muted); }
.detail-meta dd { margin: 0; white-space: pre-wrap; }
.source-section { display: grid; gap: var(--space-3); border-top: 1px solid var(--border-color); padding-top: var(--space-4); }
.source-list, .issue-list { display: grid; gap: var(--space-3); margin: 0; padding: 0; list-style: none; font-size: var(--text-xs); }
.source-list li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
.source-chapter { color: var(--text-muted); }
.source-content { border-bottom: 1px dashed var(--accent-main); }
.source-list li.is-invalid .source-content { border-bottom-color: var(--status-warning); }
.source-note, .issue-list { color: var(--status-warning); font-size: var(--text-2xs); }
.marker-diagnostics { display: grid; gap: var(--space-3); border: 1px solid var(--status-warning-border); border-radius: var(--radius-control); background: var(--status-warning-bg); padding: var(--space-5); color: var(--status-warning); font-size: var(--text-xs); }
.marker-diagnostics-title { display: flex; align-items: center; gap: var(--space-3); }
.marker-diagnostic ul { margin: var(--space-2) 0 0; padding-left: var(--space-6); }
</style>
