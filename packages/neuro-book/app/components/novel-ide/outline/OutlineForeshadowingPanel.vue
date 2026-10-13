<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, ref, watch} from "vue";
import {Badge, Button, EmptyState, FormField, FormInput, FormTextarea} from "@notnotype/nb-ui/components";
import OutlineRichTextEditor from "nbook/app/components/novel-ide/outline/OutlineRichTextEditor.vue";
import {useOutlineAutosave} from "nbook/app/composables/useOutlineAutosave";
import {useOutlineWorkbenchActions} from "nbook/app/composables/useOutlineWorkbenchActions";
import type {OutlineWorkbenchForeshadowingResponse, OutlineWorkbenchForeshadowingState, OutlineWorkbenchSnapshot} from "nbook/app/composables/useOutlineWorkbenchData";
import {
    emptyForeshadowForm, foreshadowToForm, formToEditDesign, validateForeshadowForm, type ForeshadowFormValue,
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
const form = ref<ForeshadowFormValue>(emptyForeshadowForm());
const formRoot = ref<HTMLElement | null>(null);
const preview = ref<Preview | null>(null);
/** 已确认的伏笔一改就回到草稿；作者确认一次后，本次选中期间不再询问。 */
const adoptedAcknowledged = ref(false);
const pendingSwitch = ref<(() => void) | null>(null);

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
const gated = computed(() => selected.value?.value.status === "adopted" && !adoptedAcknowledged.value);

const autosave = useOutlineAutosave({
    key: () => selectedId.value,
    base: () => selected.value ? {version: selected.value.value.version, contentHash: selected.value.contentHash} : null,
    form,
    load: () => selected.value ? foreshadowToForm(selected.value.value) : emptyForeshadowForm(),
    serialize: (value) => JSON.stringify({title: value.title.trim(), body: value.body, ...formToEditDesign(value)}),
    validate: validateForeshadowForm,
    blocked: () => gated.value,
    save: async (value, base) => {
        const current = selected.value;
        if (!current) return false;
        const result = await actions.run("foreshadowing-action", {expectedRevision: revision.value, action: {kind: "edit-foreshadowing",
            id: current.value.id, expectedVersion: base.version, expectedContentHash: base.contentHash,
            title: value.title.trim(), body: value.body, ...formToEditDesign(value)}}, {fallback: "保存伏笔失败"});
        return result !== null;
    },
    errorMessage: () => actions.error.value,
});
const busy = computed(() => actions.pending.value || autosave.dirty.value);
const statusText = computed(() => {
    const status = autosave.status.value;
    if (status.kind === "dirty") return "有未保存的修改";
    if (status.kind === "saving") return "正在保存…";
    if (status.kind === "saved") return "已保存";
    if (status.kind === "invalid") return `暂未保存：${status.message}`;
    if (status.kind === "blocked") return "确认后保存";
    if (status.kind === "error") return "保存失败";
    if (status.kind === "conflict") return "伏笔已在别处修改";
    return "修改会自动保存";
});

// 数据刷新后选中的伏笔可能已被删除，此时回到空态而不是保留悬空的表单。
watch(records, (next) => {
    if (selectedId.value && !next.some(({value}) => value.id === selectedId.value)) applySelection(null);
});
onBeforeUnmount(() => void autosave.flush());

/** 状态接口覆盖每条定义；缺失只发生在状态读取失败时，此时只显示定义自身的确认状态，不在客户端推断埋设进度。 */
function badgeOf(id: string, status: "draft" | "adopted"): Readonly<{label: string; tone: "neutral" | "accent" | "success" | "warning"}> {
    const state = states.value.get(id)?.status;
    if (state) return {label: stateLabels[state], tone: stateTones[state]};
    return status === "draft" ? {label: stateLabels.draft, tone: stateTones.draft} : {label: "已确认", tone: "neutral"};
}
function applySelection(id: string | null): void {
    selectedId.value = id;
    preview.value = null;
    adoptedAcknowledged.value = false;
    pendingSwitch.value = null;
    actions.clearError();
}
async function select(id: string): Promise<void> {
    if (id === selectedId.value) return;
    if (await autosave.flush()) applySelection(id);
    else pendingSwitch.value = () => applySelection(id);
}
function discardAndSwitch(): void {
    const apply = pendingSwitch.value;
    if (!apply) return;
    autosave.reload();
    apply();
}
function onFormFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget as Element | null;
    // 富文本的浮动菜单挂在主题宿主上，点菜单不算离开表单。
    if (next && (formRoot.value?.contains(next) || next.closest?.(".outline-rich-text-menu-layer"))) return;
    void autosave.flush();
}

/** 新伏笔直接以草稿落盘并选中，作者接着改名、填写设计即可，不再有单独的新建表单。 */
async function create(): Promise<void> {
    if (!(await autosave.flush())) return;
    const result = await actions.run<{foreshadowingId: string}>("foreshadowing-action", {expectedRevision: revision.value,
        action: {kind: "create-foreshadowing", title: "新伏笔", body: ""}}, {fallback: "新建伏笔失败"});
    if (!result) return;
    await nextTick();
    applySelection(result.foreshadowingId);
    await nextTick();
    const input = formRoot.value?.querySelector<HTMLInputElement>(".foreshadow-title input");
    input?.focus();
    input?.select();
}
function acknowledgeAdopted(): void {
    adoptedAcknowledged.value = true;
    void autosave.flush();
}
async function confirm(): Promise<void> {
    const current = selected.value;
    if (!current || !(await autosave.flush())) return;
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
    if (result) applySelection(null);
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
            <Button size="sm" variant="primary" icon-class="i-lucide-plus" :disabled="actions.pending.value" @click="create">新建伏笔</Button>
            <span class="bar-hint">伏笔直接在右侧编辑，改动自动保存为草稿；确认设计后才会参与状态计算。</span>
        </div>
        <div v-if="actions.error.value" class="panel-error" role="alert"><span class="i-lucide-circle-alert"></span>{{ actions.error.value }}<button type="button" @click="actions.clearError()">知道了</button></div>
        <div v-if="pendingSwitch" class="panel-notice" role="alert">
            <span>当前伏笔还有没保存的修改（{{ statusText }}），切换会丢弃这些修改。</span>
            <div class="notice-actions">
                <Button size="sm" variant="ghost" @click="pendingSwitch = null">留在这里</Button>
                <Button size="sm" variant="danger" @click="discardAndSwitch">放弃修改并切换</Button>
            </div>
        </div>

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
                <template v-if="selected">
                    <div class="detail-heading">
                        <div class="detail-badges">
                            <Badge :tone="badgeOf(selected.value.id, selected.value.status).tone">{{ badgeOf(selected.value.id, selected.value.status).label }}</Badge>
                            <Badge v-if="selectedElapsed?.elapsed != null" tone="neutral">已过 {{ selectedElapsed.elapsed }} 格</Badge>
                            <span class="save-status" :class="`is-${autosave.status.value.kind}`" role="status" aria-live="polite">{{ statusText }}</span>
                            <Button v-if="autosave.status.value.kind === 'error'" size="sm" variant="ghost" @click="autosave.flush()">重试</Button>
                        </div>
                        <div class="detail-actions">
                            <Button v-if="selected.value.status === 'draft'" size="sm" variant="primary" icon-class="i-lucide-check" :disabled="busy" @click="confirm">确认设计</Button>
                            <Button size="sm" variant="danger" icon-class="i-lucide-trash-2" :disabled="busy" @click="previewDeletion">删除</Button>
                        </div>
                    </div>

                    <div v-if="autosave.status.value.kind === 'conflict'" class="detail-notice" role="alert">
                        这条伏笔刚在别处（例如 Agent 或另一个窗口）被修改，你这里的修改还没有保存。载入最新内容会丢弃这里的修改。
                        <div class="notice-actions"><Button size="sm" variant="secondary" @click="autosave.reload()">载入最新内容</Button></div>
                    </div>
                    <div v-else-if="gated && autosave.dirty.value" class="detail-notice" role="alert">
                        这条伏笔已确认设计，保存后会回到草稿，需要重新确认；已标记的来源在重新确认前不计入状态。
                        <div class="notice-actions">
                            <Button size="sm" variant="ghost" @click="autosave.reload()">撤销修改</Button>
                            <Button size="sm" variant="primary" @click="acknowledgeAdopted">保存并回到草稿</Button>
                        </div>
                    </div>

                    <div :key="`${selected.value.id}:${autosave.generation.value}`" ref="formRoot" class="foreshadow-form" @focusout="onFormFocusOut">
                        <FormField label="名称" required class="foreshadow-title"><FormInput v-model="form.title" /></FormField>
                        <div class="form-grid">
                            <FormField label="表面线索" description="读者当时看到的内容。"><FormTextarea v-model="form.surface" :rows="2" /></FormField>
                            <FormField label="背后关联" description="这条线索真正指向的事实。"><FormTextarea v-model="form.connection" :rows="2" /></FormField>
                        </div>
                        <fieldset class="design-group">
                            <legend>埋设建议 <span>三项同时填写或全部留空</span></legend>
                            <FormField label="出现情境"><FormInput v-model="form.plant.situation" /></FormField>
                            <FormField label="呈现方式"><FormInput v-model="form.plant.presentation" /></FormField>
                            <FormField label="暗示程度"><FormInput v-model="form.plant.subtlety" /></FormField>
                        </fieldset>
                        <fieldset class="design-group">
                            <legend>回收建议 <span>三项同时填写或全部留空</span></legend>
                            <FormField label="揭示条件"><FormInput v-model="form.recover.condition" /></FormField>
                            <FormField label="前后呼应"><FormInput v-model="form.recover.echo" /></FormField>
                            <FormField label="预期效果"><FormInput v-model="form.recover.effect" /></FormField>
                        </fieldset>
                        <FormField label="补充说明">
                            <OutlineRichTextEditor v-model="form.body" placeholder="其他设计备注，例如与人物、主题的关系。" aria-label="补充说明" />
                        </FormField>
                    </div>

                    <section class="source-section" aria-label="伏笔标记来源">
                        <h4>正式来源</h4>
                        <p v-if="!selectedState?.sources.length" class="detail-hint">还没有来自已采用章节大纲的标记。在大纲库的章节大纲正文里选中文字，从浮动菜单标记埋设、强化或回收。</p>
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
                <EmptyState v-else icon-class="i-lucide-mouse-pointer-click" title="选择一条伏笔" description="在左侧选择伏笔直接编辑设计、查看标记来源，或新建一条伏笔。" />
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
.panel-notice { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); border: 1px solid var(--status-warning-border); border-radius: var(--radius-control); background: var(--status-warning-bg); color: var(--status-warning); padding: var(--space-3) var(--space-5); font-size: var(--text-xs); }
.panel-notice > span { min-width: 0; flex: 1 1 16rem; }
.notice-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-3); }
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
.foreshadow-detail h4 { margin: 0; font-size: var(--text-xs); font-weight: var(--weight-medium); }
.foreshadow-form { display: grid; gap: var(--space-5); }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-5); }
.design-group { display: grid; min-width: 0; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-4); margin: 0; border: 1px solid var(--border-color); border-radius: var(--radius-control); padding: var(--space-4) var(--space-5) var(--space-5); }
.design-group legend { padding: 0 var(--space-2); font-size: var(--text-xs); font-weight: var(--weight-medium); }
.design-group legend span { color: var(--text-muted); font-size: var(--text-2xs); font-weight: normal; }
.detail-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-3); }
.detail-badges { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.save-status { color: var(--text-muted); font-size: var(--text-2xs); }
.save-status.is-invalid, .save-status.is-blocked, .save-status.is-dirty { color: var(--status-warning); }
.save-status.is-error, .save-status.is-conflict { color: var(--status-danger); }
.detail-notice { display: grid; gap: var(--space-3); border: 1px solid var(--status-warning-border); border-radius: var(--radius-control); background: var(--status-warning-bg); color: var(--status-warning); padding: var(--space-4); font-size: var(--text-xs); line-height: var(--leading-ui); }
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
@media (max-width: 640px) {
    .foreshadow-columns, .form-grid, .design-group { grid-template-columns: minmax(0, 1fr); }
    .foreshadow-list { max-height: 40vh; border-right: 0; border-bottom: 1px solid var(--border-color); padding-right: 0; padding-bottom: var(--space-4); }
}
</style>
