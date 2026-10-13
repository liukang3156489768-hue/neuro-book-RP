<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, ref, watch} from "vue";
import {Badge, Button, EmptyState, FormCheckbox, FormInput, FormSelect, IconButton} from "@notnotype/nb-ui/components";
import OutlineDetailAnalysisPanel from "nbook/app/components/novel-ide/outline/OutlineDetailAnalysisPanel.vue";
import OutlineEntryForm from "nbook/app/components/novel-ide/outline/OutlineEntryForm.vue";
import {useOutlineAutosave} from "nbook/app/composables/useOutlineAutosave";
import {useOutlineWorkbenchActions} from "nbook/app/composables/useOutlineWorkbenchActions";
import type {
    OutlineWorkbenchEntry,
    OutlineWorkbenchLibraryNode,
    OutlineWorkbenchLibraryTree,
    OutlineWorkbenchSnapshot,
} from "nbook/app/composables/useOutlineWorkbenchData";
import {
    emptyEntryForm,
    entryHasHandoffMetadata,
    entryToForm,
    formToEditMetadata,
    formToMaterialUpdates,
    validateEntryForm,
    type OutlineEntryFormValue,
} from "nbook/app/utils/outline/outline-entry-form";
import {chapterForeshadowMarkers} from "nbook/app/utils/outline/chapter-foreshadow-markers";
import {analyzeDetailStructure, blockingDetailProblems} from "nbook/shared/outline-detail-structure";

type EntryKind = OutlineWorkbenchEntry["kind"];
type EntryRecord = OutlineWorkbenchSnapshot["entries"][number];
type ObjectImpact = Readonly<{targetId: string; objectFile: string | null; references: readonly Readonly<{sourceFile: string; relation: string; sourceId?: string}>[]; entryKind: EntryKind | "foreshadowing" | "line" | null; usedByPlanIds: readonly string[]; affectedPlanIds: readonly string[]; canDeleteObject: boolean}>;
type PlacementImpact = Readonly<{planId: string; targetId: string; childReferences: readonly string[]; blockingFixedLineIds: readonly string[]; canRemovePlacement: boolean}>;
type PlanImpact = Readonly<{planId: string; placementIds: readonly string[]; exclusiveEntryIds: readonly string[]; blockingFixedLineIds: readonly string[]; canRemovePlan: boolean}>;
type Preview =
    | {type: "object"; revision: number; objectHash: string | null; impact: ObjectImpact}
    | {type: "placement"; revision: number; impact: PlacementImpact}
    | {type: "plan"; revision: number; impact: PlanImpact};
/** 自动保存前需要作者确认的情形；共用条目不能原地改，只能另存。 */
type Gate = "fork" | "adopted";

const props = defineProps<{
    projectRoot: string | null;
    snapshot: OutlineWorkbenchSnapshot | null;
    libraryTrees: readonly OutlineWorkbenchLibraryTree[];
    refresh: () => Promise<void>;
    /** 外部要求定位的条目；token 每次请求递增，同一条目再次跳转也能生效。 */
    focusRequest?: Readonly<{entryId: string; token: number}> | null;
}>();
const planId = defineModel<string | null>("planId", {required: true});

const actions = useOutlineWorkbenchActions(() => props.projectRoot, () => props.refresh());
const kindLabels: Record<EntryKind, string> = {total: "总纲", volume: "卷纲", chapter: "章节大纲", detail: "细纲"};
/** 与服务端 `canParentEntry` 同一张层级表，只用于给出可选项；越级请求仍会被服务端拒绝。 */
const childKinds: Record<EntryKind, readonly EntryKind[]> = {total: ["volume", "chapter"], volume: ["chapter"], chapter: ["detail"], detail: []};

const selectedEntryId = ref<string | null>(null);
const form = ref<OutlineEntryFormValue>(emptyEntryForm());
const entryForm = ref<InstanceType<typeof OutlineEntryForm> | null>(null);
const formError = ref<string | null>(null);
const planForm = ref<{kind: "create" | "rename"; title: string} | null>(null);
const preview = ref<Preview | null>(null);
const confirmedTotal = ref(false);
const moveParentId = ref("");
const attachPlanId = ref("");
/** 以下确认只对当前选中的条目有效，切换条目即清空。 */
const adoptedAcknowledged = ref(false);
const forkTitle = ref("");
/** 未保存的修改无法自动保存时，切换条目或方案要先让作者决定是否放弃。 */
const pendingSwitch = ref<{label: string; apply: () => void} | null>(null);

const revision = computed(() => props.snapshot?.manifest.revision ?? 0);
const plans = computed(() => props.snapshot?.manifest.plans ?? []);
const plan = computed(() => plans.value.find((item) => item.id === planId.value) ?? null);
const planOptions = computed(() => plans.value.map((item) => ({value: item.id, label: item.title})));
const totalId = computed(() => plan.value?.totalId ?? null);
const entries = computed(() => new Map((props.snapshot?.entries ?? []).map((record) => [record.value.id, record])));
const lineTitles = computed(() => new Map((props.snapshot?.lines ?? []).map(({value}) => [value.id, value.title])));
const tree = computed(() => props.libraryTrees.find((item) => item.id === plan.value?.id) ?? null);

const rows = computed(() => {
    const result: Array<{entry: OutlineWorkbenchEntry; depth: number; siblingIndex: number; siblingCount: number}> = [];
    const visit = (node: OutlineWorkbenchLibraryNode, depth: number, siblingIndex: number, siblingCount: number): void => {
        result.push({entry: node.entry, depth, siblingIndex, siblingCount});
        node.children.forEach((child, index) => visit(child, depth + 1, index, node.children.length));
    };
    if (tree.value) visit(tree.value.root, 0, 0, 1);
    return result;
});
/** 不在任何方案中的条目在树里看不到，需要单独列出才能重新挂载或删除。 */
const unplaced = computed(() => {
    const placed = new Set(plans.value.flatMap((item) => item.placements.map(({entryId}) => entryId)));
    return (props.snapshot?.entries ?? []).filter(({value}) => !placed.has(value.id));
});
const selected = computed<EntryRecord | null>(() => selectedEntryId.value ? entries.value.get(selectedEntryId.value) ?? null : null);
const selectedRow = computed(() => rows.value.find((row) => row.entry.id === selectedEntryId.value) ?? null);
const selectedInPlan = computed(() => selectedRow.value !== null);
/** 编辑请求需要带方案；不在当前方案里的条目只读。 */
const editable = computed(() => selected.value !== null && selectedInPlan.value && plan.value !== null);
const usingPlans = computed(() => selected.value
    ? plans.value.filter((item) => item.placements.some(({entryId}) => entryId === selected.value!.value.id))
    : []);
/** 共用条目（含手动关联共用的总纲）不能原地改，只能写时分叉。 */
const isShared = computed(() => usingPlans.value.length > 1);
const withMetadata = computed(() => selected.value ? entryHasHandoffMetadata(selected.value.value.kind) : false);
const annotations = computed(() => selected.value?.value.kind === "detail" ? "detail" : selected.value?.value.kind === "chapter" ? "chapter" : "none");
const foreshadowOptions = computed(() => (props.snapshot?.foreshadowing ?? [])
    .map(({value}) => ({value: value.id, label: value.status === "draft" ? `${value.title}（草稿）` : value.title})));
const chapterMarkers = computed(() => {
    const current = selected.value?.value;
    if (current?.kind !== "detail" || !current.chapterId) return [];
    const chapter = entries.value.get(current.chapterId)?.value;
    return chapter ? chapterForeshadowMarkers(chapter.body) : [];
});
const moveOptions = computed(() => {
    const current = selected.value?.value;
    if (!current || !selectedInPlan.value) return [];
    return rows.value.filter(({entry}) => entry.id !== current.parentId && childKinds[entry.kind].includes(current.kind))
        .map(({entry}) => ({value: entry.id, label: `${kindLabels[entry.kind]} · ${entry.title}`}));
});
/** 父级是总纲时，目标方案以自己的总纲作父级，不要求与本条目的原总纲相同。 */
function attachParentIn(target: (typeof plans.value)[number]): string | null {
    const current = selected.value?.value;
    if (!current?.parentId) return null;
    if (entries.value.get(current.parentId)?.value.kind === "total") return target.totalId;
    return target.placements.some(({entryId}) => entryId === current.parentId) ? current.parentId : null;
}
const attachOptions = computed(() => {
    const current = selected.value?.value;
    if (!current?.parentId) return [];
    return plans.value.filter((item) => attachParentIn(item) !== null && !item.placements.some(({entryId}) => entryId === current.id))
        .map((item) => ({value: item.id, label: item.title}));
});
/** 总纲的共用关系：可改用其他方案的总纲，共用时可解除。 */
const totalOptions = computed(() => {
    if (selected.value?.value.kind !== "total" || !plan.value) return [];
    const seen = new Set([plan.value.totalId]);
    return plans.value.filter((item) => !seen.has(item.totalId) && seen.add(item.totalId))
        .map((item) => ({value: item.totalId, label: entries.value.get(item.totalId)?.value.title ?? item.title}));
});
const associateTotalId = ref("");
const chapterAdopted = computed(() => {
    const chapterId = selected.value?.value.chapterId;
    return chapterId ? entries.value.get(chapterId)?.value.status === "adopted" : false;
});
const detailAnalysis = ref<InstanceType<typeof OutlineDetailAnalysisPanel> | null>(null);
const adoptingDetail = ref(false);
/** 服务端分析同样会拒绝这两种情形；这里提前说明，免得作者点了才知道。 */
const detailAdoptBlocker = computed(() => {
    const current = selected.value?.value;
    if (current?.kind !== "detail") return null;
    if (!chapterAdopted.value) return "所属章节大纲尚未正式采用，先采用章节大纲再采用细纲。";
    const structure = analyzeDetailStructure(current, {chapterMarkers: new Map(chapterMarkers.value.map(({marker, action}) => [marker, action]))});
    return blockingDetailProblems(structure).length ? "细纲结构还有问题，按正文下方的提示修改后才能采用。" : null;
});

function serializeForm(value: OutlineEntryFormValue): string {
    return JSON.stringify({title: value.title.trim(), body: value.body, ...formToMaterialUpdates(value), ...withMetadata.value ? formToEditMetadata(value) : {}});
}

const gate = computed<Gate | null>(() => {
    const record = selected.value?.value;
    if (!record || !editable.value) return null;
    if (isShared.value) return "fork";
    if (record.status === "adopted" && !adoptedAcknowledged.value) return "adopted";
    return null;
});

const autosave = useOutlineAutosave({
    key: () => selectedEntryId.value,
    base: () => selected.value ? {version: selected.value.value.version, contentHash: selected.value.contentHash} : null,
    form,
    load: () => selected.value ? entryToForm(selected.value.value) : emptyEntryForm(),
    serialize: serializeForm,
    validate: (value) => validateEntryForm(value, withMetadata.value),
    blocked: () => !editable.value || gate.value !== null,
    save: async (value, base) => {
        const record = selected.value;
        if (!record || !plan.value) return false;
        const result = await library({kind: "edit-entry", planId: plan.value.id, entryId: record.value.id,
            expectedVersion: base.version, expectedContentHash: base.contentHash, title: value.title.trim(), body: value.body,
            ...formToMaterialUpdates(value),
            ...withMetadata.value ? formToEditMetadata(value) : {}});
        return result !== null;
    },
    errorMessage: () => actions.error.value,
});
const saving = computed(() => autosave.status.value.kind === "saving");
/** 采用、移动、分析都基于服务端版本；本地还有未保存内容时先不让操作，避免作用在旧内容上。 */
const busy = computed(() => actions.pending.value || autosave.dirty.value);
const statusText = computed(() => {
    const status = autosave.status.value;
    if (status.kind === "dirty") return "有未保存的修改";
    if (status.kind === "saving") return "正在保存…";
    if (status.kind === "saved") return "已保存";
    if (status.kind === "invalid") return `暂未保存：${status.message}`;
    if (status.kind === "blocked") return "确认后保存";
    if (status.kind === "error") return "保存失败";
    if (status.kind === "conflict") return "条目已在别处修改";
    return "修改会自动保存";
});

watch(gate, (next) => {
    if (next === "fork" && !forkTitle.value && selected.value && plan.value) {
        const title = form.value.title.trim();
        forkTitle.value = title && title !== selected.value.value.title.trim() ? title : `${selected.value.value.title}（${plan.value.title}）`;
    }
});
watch(plan, () => {
    if (selected.value && !selectedInPlan.value && !unplaced.value.some(({value}) => value.id === selectedEntryId.value)) applySelection(null);
    preview.value = null;
});
onBeforeUnmount(() => void autosave.flush());

const focusMissing = ref(false);
let handledFocusToken: number | null = null;
watch(() => props.focusRequest, (request) => {
    if (!request || request.token === handledFocusToken) return;
    handledFocusToken = request.token;
    focusMissing.value = !entries.value.has(request.entryId);
    if (!focusMissing.value) selectEntry(request.entryId);
}, {immediate: true});

function applySelection(id: string | null): void {
    selectedEntryId.value = id;
    preview.value = null;
    formError.value = null;
    moveParentId.value = "";
    attachPlanId.value = "";
    adoptedAcknowledged.value = false;
    forkTitle.value = "";
    pendingSwitch.value = null;
    actions.clearError();
}

/** 先把当前修改存下；存不了（等待确认、校验不过、冲突）时交给作者决定是否放弃。 */
async function leaveCurrent(label: string, apply: () => void): Promise<void> {
    if (await autosave.flush()) {
        apply();
        return;
    }
    pendingSwitch.value = {label, apply};
}
function selectEntry(id: string | null): void {
    if (id === selectedEntryId.value) return;
    void leaveCurrent("切换条目", () => applySelection(id));
}
function changePlan(id: string | null): void {
    if (id === planId.value) return;
    void leaveCurrent("切换方案", () => {
        pendingSwitch.value = null;
        planId.value = id;
    });
}
function discardAndSwitch(): void {
    const target = pendingSwitch.value;
    if (!target) return;
    autosave.reload();
    target.apply();
}

async function library<T extends {transactionId: string; entryId?: string; planId?: string}>(action: Record<string, unknown>): Promise<T | null> {
    return actions.run<T>("library-action", {expectedRevision: revision.value, action});
}

/** 新条目直接落盘为草稿并选中，作者接着改标题和正文即可，没有单独的新建表单。 */
async function openCreated(entryId: string | undefined): Promise<void> {
    if (!entryId) return;
    await nextTick();
    applySelection(entryId);
    await nextTick();
    entryForm.value?.focusTitle();
}
async function createChild(kind: EntryKind): Promise<void> {
    const parent = selected.value?.value;
    if (!parent || !plan.value || !(await autosave.flush())) return;
    const result = await library({kind: "create-entry", planId: plan.value.id, parentId: parent.id, entryKind: kind, title: `新${kindLabels[kind]}`, body: ""});
    await openCreated(result?.entryId);
}

function confirmGate(): void {
    adoptedAcknowledged.value = true;
    void autosave.flush();
}
async function forkEntry(): Promise<void> {
    const record = selected.value;
    if (!record || !plan.value) return;
    const title = forkTitle.value.trim();
    formError.value = !title || title === record.value.title.trim()
        ? "另存为本方案条目时需要换一个标题，便于区分两个版本"
        : validateEntryForm(form.value, withMetadata.value);
    if (formError.value) return;
    const result = await actions.run<{transactionId: string; entryId: string}>("fork-entry", {
        planId: plan.value.id, sourceId: record.value.id, title, body: form.value.body,
        ...formToMaterialUpdates(form.value),
        expectedRevision: revision.value, confirmShared: true, ...withMetadata.value ? formToEditMetadata(form.value) : {},
    }, {fallback: "另存失败"});
    if (result) await openCreated(result.entryId);
}

async function adoptEntry(): Promise<void> {
    const record = selected.value;
    if (!record || !plan.value || !(await autosave.flush())) return;
    await library({kind: "adopt-entry", planId: plan.value.id, entryId: record.value.id,
        expectedVersion: record.value.version, expectedContentHash: record.contentHash});
}
/** 细纲采用必须附带偏差分析报告，由分析面板完成分析与采用。 */
async function adoptDetail(): Promise<void> {
    if (!(await autosave.flush())) return;
    await nextTick();
    adoptingDetail.value = true;
    try {
        await detailAnalysis.value?.analyzeAndAdopt();
    } finally {
        adoptingDetail.value = false;
    }
}
async function reorder(delta: -1 | 1): Promise<void> {
    const row = selectedRow.value;
    if (!row || !plan.value || !(await autosave.flush())) return;
    await library({kind: "reorder-entry", planId: plan.value.id, entryId: row.entry.id, siblingIndex: row.siblingIndex + delta});
}
async function moveEntry(): Promise<void> {
    const record = selected.value;
    if (!record || !plan.value || !moveParentId.value || !(await autosave.flush())) return;
    const result = await library({kind: "move-entry", planId: plan.value.id, entryId: record.value.id, parentId: moveParentId.value,
        expectedVersion: record.value.version, expectedContentHash: record.contentHash});
    if (result) moveParentId.value = "";
}
async function attachEntry(targetPlanId: string): Promise<void> {
    const current = selected.value?.value;
    const target = plans.value.find((item) => item.id === targetPlanId);
    const parentId = target ? attachParentIn(target) : null;
    if (!current || !parentId) return;
    const result = await library({kind: "attach-entry", planId: targetPlanId, parentId, entryId: current.id});
    if (result) attachPlanId.value = "";
}

/** 当前方案的总纲有正文时，改用别的总纲会丢掉它在本方案的位置，需要作者确认。 */
async function associateTotal(): Promise<void> {
    const current = plan.value && entries.value.get(plan.value.totalId)?.value;
    if (!plan.value || !current || !associateTotalId.value || !(await autosave.flush())) return;
    const result = await library({kind: "associate-total", planId: plan.value.id, totalId: associateTotalId.value,
        ...current.body.trim() ? {confirmReplace: true} : {}});
    if (result) {
        associateTotalId.value = "";
        applySelection(plan.value.totalId);
    }
}
async function unshareTotal(): Promise<void> {
    if (!plan.value || !(await autosave.flush())) return;
    const result = await library({kind: "unshare-total", planId: plan.value.id});
    if (result) applySelection(null);
}
function isUnusedTotal(impact: ObjectImpact): boolean {
    return impact.entryKind === "total" && impact.usedByPlanIds.length === 0;
}

async function submitPlanForm(): Promise<void> {
    const draft = planForm.value;
    if (!draft || !draft.title.trim()) return;
    if (draft.kind === "create") {
        const result = await library({kind: "create-plan", title: draft.title.trim()});
        if (result) { planForm.value = null; if (result.planId) changePlan(result.planId); }
        return;
    }
    if (!plan.value) return;
    const result = await library({kind: "rename-plan", planId: plan.value.id, title: draft.title.trim()});
    if (result) planForm.value = null;
}

async function previewObjectDeletion(): Promise<void> {
    if (!selected.value) return;
    const result = await actions.run<{revision: number; objectHash: string | null; impact: ObjectImpact}>("preview-object-deletion",
        {targetId: selected.value.value.id}, {refresh: false, fallback: "读取删除影响失败"});
    confirmedTotal.value = false;
    if (result) preview.value = {type: "object", ...result};
}
async function previewPlacementRemoval(): Promise<void> {
    if (!selected.value || !plan.value) return;
    const result = await actions.run<{revision: number; impact: PlacementImpact}>("preview-placement-removal",
        {planId: plan.value.id, targetId: selected.value.value.id}, {refresh: false, fallback: "读取移除影响失败"});
    if (result) preview.value = {type: "placement", ...result};
}
async function previewPlanRemoval(): Promise<void> {
    if (!plan.value) return;
    const result = await actions.run<{revision: number; impact: PlanImpact}>("preview-plan-removal",
        {planId: plan.value.id}, {refresh: false, fallback: "读取方案删除影响失败"});
    if (result) preview.value = {type: "plan", ...result};
}
async function confirmPreview(): Promise<void> {
    const current = preview.value;
    if (!current) return;
    let result: unknown = null;
    if (current.type === "object") {
        if (!current.objectHash) return;
        result = await actions.run("remove-object", {targetId: current.impact.targetId, expectedRevision: current.revision,
            expectedObjectHash: current.objectHash, confirmedTotal: confirmedTotal.value}, {fallback: "删除失败"});
        // 条目已删除，未保存的修改随之作废。
        if (result) applySelection(null);
    } else if (current.type === "placement") {
        result = await actions.run("remove-placement", {planId: current.impact.planId, targetId: current.impact.targetId,
            expectedRevision: current.revision}, {fallback: "移除失败"});
    } else {
        result = await actions.run("remove-plan", {planId: current.impact.planId, expectedRevision: current.revision}, {fallback: "删除方案失败"});
    }
    if (result) preview.value = null;
}

function entryTitle(id: string): string {
    return entries.value.get(id)?.value.title ?? id;
}
function planTitle(id: string | undefined): string {
    return plans.value.find((item) => item.id === id)?.title ?? id ?? "";
}
/** 把删除影响里的关系编码翻译成作者能理解的位置说明。 */
function describeReference(reference: ObjectImpact["references"][number]): string {
    const [relation, detail] = reference.relation.split(":");
    if (relation === "placement") return `方案「${planTitle(reference.sourceId)}」仍包含此条目`;
    if (relation === "parent-placement") return `方案「${planTitle(reference.sourceId)}」中仍有下级条目`;
    if (relation === "parent") return `下级条目「${entryTitle(reference.sourceId ?? "")}」`;
    if (relation === "chapter") return `细纲「${entryTitle(reference.sourceId ?? "")}」属于此章节`;
    if (relation === "marker") return `条目「${entryTitle(reference.sourceId ?? "")}」中的伏笔标记 ${detail ?? ""}`;
    if (relation === "node") {
        const graph = props.snapshot?.graphs.find(({value}) => value.id === reference.sourceId)?.value;
        const planTitle = props.snapshot?.manifest.plans.find(({id}) => id === graph?.planId)?.title;
        return `方案「${planTitle ?? reference.sourceId}」线路图中的节点`;
    }
    return `${reference.sourceFile} · ${reference.relation}`;
}
const previewBlocked = computed(() => {
    const current = preview.value;
    if (!current) return true;
    if (current.type === "object") return !current.impact.canDeleteObject || !current.objectHash
        || (isUnusedTotal(current.impact) && !confirmedTotal.value);
    if (current.type === "placement") return !current.impact.canRemovePlacement;
    return !current.impact.canRemovePlan;
});
</script>

<template>
    <div class="library-panel">
        <header class="plan-bar">
            <FormSelect :model-value="planId ?? ''" :options="planOptions" placeholder="还没有方案" size="sm" class="plan-select" aria-label="选择方案" :disabled="!planOptions.length" @update:model-value="changePlan($event || null)" />
            <Button size="sm" variant="ghost" icon-class="i-lucide-plus" @click="planForm = {kind: 'create', title: ''}">新建方案</Button>
            <Button size="sm" variant="ghost" icon-class="i-lucide-pencil" :disabled="!plan" @click="planForm = {kind: 'rename', title: plan?.title ?? ''}">重命名</Button>
            <Button size="sm" variant="ghost" icon-class="i-lucide-trash-2" :disabled="!plan" @click="previewPlanRemoval">删除方案</Button>
        </header>
        <form v-if="planForm" class="inline-form" @submit.prevent="submitPlanForm">
            <FormInput v-model="planForm.title" :placeholder="planForm.kind === 'create' ? '新方案名称' : '方案名称'" size="sm" autofocus aria-label="方案名称" />
            <Button size="sm" variant="primary" type="submit" :disabled="!planForm.title.trim() || actions.pending.value">{{ planForm.kind === 'create' ? '创建' : '保存' }}</Button>
            <Button size="sm" variant="ghost" @click="planForm = null">取消</Button>
        </form>
        <div v-if="actions.error.value" class="panel-error" role="alert"><span class="i-lucide-circle-alert"></span>{{ actions.error.value }}<button type="button" @click="actions.clearError()">知道了</button></div>
        <div v-if="focusMissing" class="panel-notice" role="status"><span>要打开的条目已不存在，可能已被删除。</span><button type="button" @click="focusMissing = false">知道了</button></div>
        <div v-if="pendingSwitch" class="panel-notice" role="alert">
            <span>当前条目还有没保存的修改（{{ statusText }}），{{ pendingSwitch.label }}会丢弃这些修改。</span>
            <div class="notice-actions">
                <Button size="sm" variant="ghost" @click="pendingSwitch = null">留在这里</Button>
                <Button size="sm" variant="danger" @click="discardAndSwitch">放弃修改并{{ pendingSwitch.label }}</Button>
            </div>
        </div>

        <section v-if="preview" class="impact-panel" aria-label="删除影响">
            <template v-if="preview.type === 'object'">
                <strong>删除条目「{{ entryTitle(preview.impact.targetId) }}」</strong>
                <p>将删除文件 {{ preview.impact.objectFile ?? '（未找到文件）' }}，删除后可在操作记录中撤销。</p>
                <template v-if="preview.impact.references.length">
                    <p>还有以下引用，需要先逐一处理才能删除：</p>
                    <ul><li v-for="(reference, index) in preview.impact.references" :key="index">{{ describeReference(reference) }}</li></ul>
                </template>
                <p v-if="preview.impact.usedByPlanIds.length">总纲仍被方案「{{ preview.impact.usedByPlanIds.map(planTitle).join('、') }}」使用，请先让这些方案改用其他总纲或删除这些方案。</p>
                <template v-else>
                    <p v-if="preview.impact.affectedPlanIds.length">删除会同时影响方案：{{ preview.impact.affectedPlanIds.map(planTitle).join('、') }}。</p>
                    <FormCheckbox v-if="isUnusedTotal(preview.impact)" v-model="confirmedTotal" label="我确认删除这份未被方案使用的总纲" />
                </template>
            </template>
            <template v-else-if="preview.type === 'placement'">
                <strong>从方案「{{ planTitle(preview.impact.planId) }}」移除「{{ entryTitle(preview.impact.targetId) }}」</strong>
                <p>只解除该方案对条目的引用，条目文件保留。</p>
                <p v-if="preview.impact.childReferences.length">仍有 {{ preview.impact.childReferences.length }} 个下级条目：{{ preview.impact.childReferences.map(entryTitle).join('、') }}，请先移除下级。</p>
                <p v-if="preview.impact.blockingFixedLineIds.length">被已固定的线路引用：{{ preview.impact.blockingFixedLineIds.map((id) => lineTitles.get(id) ?? id).join('、') }}，请先处理线路。</p>
                <p v-if="preview.impact.targetId === totalId">总纲是方案的根，不能单独移除；要换总纲请用“关联总纲”。</p>
            </template>
            <template v-else>
                <strong>删除方案「{{ planTitle(preview.impact.planId) }}」</strong>
                <p>将删除方案本身及其专属条目的下级内容；被其他方案共享的条目会保留。该方案共包含 {{ preview.impact.placementIds.length }} 个条目。</p>
                <p v-if="preview.impact.exclusiveEntryIds.length">其中 {{ preview.impact.exclusiveEntryIds.length }} 个条目只属于这个方案，将随方案递归删除。</p>
                <p v-if="preview.impact.blockingFixedLineIds.length">被已固定的线路引用：{{ preview.impact.blockingFixedLineIds.map((id) => lineTitles.get(id) ?? id).join('、') }}，请先处理线路。</p>
            </template>
            <div class="impact-actions">
                <Button size="sm" variant="ghost" @click="preview = null">取消</Button>
                <Button size="sm" variant="danger" :disabled="previewBlocked || actions.pending.value" @click="confirmPreview">确认</Button>
            </div>
        </section>

        <div class="library-columns">
            <nav class="library-tree" aria-label="大纲条目">
                <EmptyState v-if="!plan" icon-class="i-lucide-git-fork" title="还没有方案" description="每个方案有自己的总纲，从总纲展开卷纲与章节安排，可以并行保留多套。">
                    <template #action><Button size="sm" variant="primary" icon-class="i-lucide-plus" @click="planForm = {kind: 'create', title: '方案一'}">新建方案</Button></template>
                </EmptyState>
                <template v-else>
                    <button
                        v-for="row in rows"
                        :key="row.entry.id"
                        type="button"
                        class="tree-row"
                        :class="{'is-selected': row.entry.id === selectedEntryId}"
                        :style="{paddingLeft: `calc(var(--space-4) + ${row.depth} * var(--space-6))`}"
                        @click="selectEntry(row.entry.id)"
                    >
                        <span class="tree-kind">{{ kindLabels[row.entry.kind] }}</span>
                        <span class="tree-title">{{ row.entry.title }}</span>
                        <span v-if="row.entry.status === 'draft'" class="tree-draft">草稿</span>
                    </button>
                </template>
                <section v-if="unplaced.length" class="unplaced" aria-label="未归入方案的条目">
                    <h4>未归入方案的条目</h4>
                    <button v-for="record in unplaced" :key="record.value.id" type="button" class="tree-row" :class="{'is-selected': record.value.id === selectedEntryId}" @click="selectEntry(record.value.id)">
                        <span class="tree-kind">{{ kindLabels[record.value.kind] }}</span>
                        <span class="tree-title">{{ record.value.title }}</span>
                    </button>
                </section>
            </nav>

            <div class="library-detail">
                <template v-if="selected">
                    <div class="detail-heading">
                        <div class="detail-badges">
                            <Badge size="sm" tone="neutral">{{ kindLabels[selected.value.kind] }}</Badge>
                            <Badge size="sm" :tone="selected.value.status === 'adopted' ? 'success' : 'warning'">{{ selected.value.status === 'adopted' ? '正式采用' : '草稿' }}</Badge>
                            <Badge v-if="isShared" size="sm" tone="accent">共用于 {{ usingPlans.length }} 个方案</Badge>
                            <Badge v-if="!selectedInPlan" size="sm" tone="neutral">未归入当前方案</Badge>
                        </div>
                        <div class="detail-tools">
                            <span v-if="editable" class="save-status" :class="`is-${autosave.status.value.kind}`" role="status" aria-live="polite">{{ statusText }}</span>
                            <Button v-if="autosave.status.value.kind === 'error'" size="sm" variant="ghost" @click="autosave.flush()">重试</Button>
                            <IconButton v-if="selectedRow && selectedRow.depth > 0" title="上移" icon-class="i-lucide-arrow-up" size="sm" :disabled="selectedRow.siblingIndex === 0 || busy" @click="reorder(-1)" />
                            <IconButton v-if="selectedRow && selectedRow.depth > 0" title="下移" icon-class="i-lucide-arrow-down" size="sm" :disabled="selectedRow.siblingIndex >= selectedRow.siblingCount - 1 || busy" @click="reorder(1)" />
                        </div>
                    </div>

                    <div v-if="autosave.status.value.kind === 'conflict'" class="detail-notice" role="alert">
                        这个条目刚在别处（例如 Agent 或另一个窗口）被修改，你这里的修改还没有保存。载入最新内容会丢弃这里的修改。
                        <div class="notice-actions"><Button size="sm" variant="secondary" @click="autosave.reload()">载入最新内容</Button></div>
                    </div>
                    <div v-else-if="gate && autosave.dirty.value" class="detail-notice" role="alert">
                        <template v-if="gate === 'fork'">
                            这个条目同时用于 {{ usingPlans.length }} 个方案（{{ usingPlans.map((item) => item.title).join('、') }}），不能直接修改。可以把修改另存为当前方案专属的新条目，其他方案保持不变；两份之后各自独立，不会再合并。
                            <div class="fork-form">
                                <FormInput v-model="forkTitle" size="sm" aria-label="新条目标题" placeholder="新条目标题（需与原标题不同）" />
                                <Button size="sm" variant="primary" :loading="actions.pending.value" @click="forkEntry">另存为本方案条目</Button>
                                <Button size="sm" variant="ghost" @click="autosave.reload()">撤销修改</Button>
                            </div>
                            <p v-if="formError" class="form-error">{{ formError }}</p>
                        </template>
                        <template v-else>
                            <template v-if="selected.value.status === 'adopted'">这个{{ kindLabels[selected.value.kind] }}已正式采用，保存后会回到草稿，需要重新正式采用。</template>
                            <div class="notice-actions">
                                <Button size="sm" variant="ghost" @click="autosave.reload()">撤销修改</Button>
                                <Button size="sm" variant="primary" @click="confirmGate">保存并回到草稿</Button>
                            </div>
                        </template>
                    </div>

                    <OutlineEntryForm
                        ref="entryForm"
                        :key="`${selected.value.id}:${autosave.generation.value}`"
                        v-model="form"
                        :with-metadata="withMetadata"
                        :annotations="annotations"
                        :foreshadow-options="foreshadowOptions"
                        :chapter-markers="chapterMarkers"
                        :readonly="!editable"
                        @commit="autosave.flush()"
                    />
                    <p v-if="!selectedInPlan" class="detail-hint">条目不在当前方案中，只能查看；加入方案后才能编辑。</p>

                    <div class="detail-actions">
                        <Button v-if="selectedInPlan && selected.value.status === 'draft'" size="sm" variant="secondary" icon-class="i-lucide-check" :loading="adoptingDetail" :disabled="busy || detailAdoptBlocker !== null" :title="detailAdoptBlocker ?? undefined" @click="selected.value.kind === 'detail' ? adoptDetail() : adoptEntry()">正式采用</Button>
                        <template v-if="selectedInPlan">
                            <Button v-for="kind in childKinds[selected.value.kind]" :key="kind" size="sm" variant="secondary" icon-class="i-lucide-plus" :disabled="actions.pending.value || saving" @click="createChild(kind)">新增{{ kindLabels[kind] }}</Button>
                        </template>
                        <Button v-if="selectedInPlan && selected.value.kind !== 'total'" size="sm" variant="ghost" icon-class="i-lucide-unlink" @click="previewPlacementRemoval">从本方案移除</Button>
                        <Button size="sm" variant="ghost" icon-class="i-lucide-trash-2" @click="previewObjectDeletion">删除条目</Button>
                    </div>
                    <p v-if="selectedInPlan && selected.value.status === 'draft' && detailAdoptBlocker" class="detail-hint">{{ detailAdoptBlocker }}</p>
                    <div v-if="selectedInPlan && moveOptions.length" class="inline-form">
                        <FormSelect v-model="moveParentId" :options="moveOptions" placeholder="移动到其他上级…" size="sm" aria-label="移动到其他上级" />
                        <Button size="sm" variant="secondary" :disabled="!moveParentId || busy" @click="moveEntry">移动</Button>
                    </div>
                    <div v-if="selectedInPlan && selected.value.kind === 'total' && (totalOptions.length || isShared)" class="inline-form">
                        <template v-if="totalOptions.length">
                            <FormSelect v-model="associateTotalId" :options="totalOptions" placeholder="改用其他方案的总纲…" size="sm" aria-label="关联总纲" />
                            <Button size="sm" variant="secondary" :disabled="!associateTotalId || busy" @click="associateTotal">关联总纲</Button>
                        </template>
                        <Button v-if="isShared" size="sm" variant="ghost" :disabled="busy" @click="unshareTotal">解除共用</Button>
                    </div>
                    <div v-if="attachOptions.length" class="inline-form">
                        <FormSelect v-model="attachPlanId" :options="attachOptions" placeholder="同时加入其他方案…" size="sm" aria-label="同时加入其他方案" />
                        <Button size="sm" variant="secondary" :disabled="!attachPlanId || busy" @click="attachEntry(attachPlanId)">加入</Button>
                    </div>
                    <p v-if="usingPlans.length" class="detail-hint">所在方案：{{ usingPlans.map((item) => item.title).join('、') }}</p>
                    <template v-if="selected.value.kind === 'detail' && selectedInPlan && plan">
                        <p v-if="autosave.dirty.value" class="detail-hint">细纲修改保存后才能分析或采用。</p>
                        <!-- 原生 fieldset 统一禁用分析面板里的按钮与输入，面板本身不需要知道自动保存状态。 -->
                        <fieldset class="analysis-fieldset" :disabled="autosave.dirty.value">
                            <OutlineDetailAnalysisPanel
                                ref="detailAnalysis"
                                :actions="actions"
                                :plan-id="plan.id"
                                :revision="revision"
                                :record="selected"
                                :chapter-adopted="chapterAdopted"
                            />
                        </fieldset>
                    </template>
                </template>
                <EmptyState v-else icon-class="i-lucide-mouse-pointer-click" title="选择一个条目" description="在左侧选择条目即可直接编辑，修改会自动保存。" />
            </div>
        </div>
    </div>
</template>

<style scoped>
.library-panel { display: flex; min-height: 0; flex: 1; flex-direction: column; gap: var(--space-4); }
.plan-bar, .inline-form { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
.plan-select { min-width: 180px; max-width: 280px; }
.inline-form > :first-child { min-width: 200px; flex: 1; }
.panel-error { display: flex; align-items: center; gap: var(--space-3); border: 1px solid var(--status-danger-border); border-radius: var(--radius-control); background: var(--status-danger-bg); color: var(--status-danger); padding: var(--space-3) var(--space-5); font-size: var(--text-xs); }
.panel-error button { margin-left: auto; border: 0; background: transparent; color: inherit; cursor: pointer; text-decoration: underline; }
.panel-notice { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); border: 1px solid var(--status-warning-border); border-radius: var(--radius-control); background: var(--status-warning-bg); color: var(--status-warning); padding: var(--space-3) var(--space-5); font-size: var(--text-xs); }
.panel-notice > span { min-width: 0; flex: 1 1 16rem; }
.panel-notice > button { border: 0; background: transparent; color: inherit; cursor: pointer; text-decoration: underline; }
.notice-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-3); }
.impact-panel { display: grid; gap: var(--space-3); border: 1px solid var(--status-warning-border); border-radius: var(--radius-control); background: var(--status-warning-bg); padding: var(--space-5); font-size: var(--text-xs); }
.impact-panel p { margin: 0; }
.impact-panel ul { display: grid; gap: var(--space-2); margin: 0; padding-left: var(--space-6); }
.impact-actions, .detail-actions { display: flex; flex-wrap: wrap; gap: var(--space-3); }
.impact-actions { justify-content: flex-end; }
.library-columns { display: grid; min-height: 0; flex: 1; grid-template-columns: minmax(220px, 320px) minmax(0, 1fr); gap: var(--space-5); }
.library-tree { display: flex; min-height: 0; flex-direction: column; gap: var(--space-2); overflow: auto; border-right: 1px solid var(--border-color); padding-right: var(--space-4); }
.tree-row { display: flex; align-items: center; gap: var(--space-3); border: 1px solid transparent; border-radius: var(--radius-control); background: transparent; color: var(--text-main); cursor: pointer; padding-block: var(--space-3); padding-right: var(--space-4); text-align: left; font-size: var(--text-xs); }
.tree-row:hover { background: color-mix(in srgb, var(--text-main) 8%, transparent); }
.tree-row.is-selected { border-color: var(--accent-main); background: var(--accent-bg); color: var(--accent-text); }
.tree-kind { flex: 0 0 auto; color: var(--text-muted); font-size: var(--text-2xs); }
.tree-title { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-draft { flex: 0 0 auto; color: var(--status-warning); font-size: var(--text-2xs); }
.unplaced { display: grid; gap: var(--space-2); margin-top: var(--space-5); border-top: 1px solid var(--border-color); padding-top: var(--space-4); }
.unplaced h4 { margin: 0; color: var(--text-muted); font-size: var(--text-2xs); font-weight: var(--weight-medium); }
.library-detail { display: flex; min-width: 0; min-height: 0; flex-direction: column; gap: var(--space-4); overflow: auto; padding-right: var(--space-2); }
.detail-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-3); }
.detail-badges, .detail-tools { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.save-status { color: var(--text-muted); font-size: var(--text-2xs); }
.save-status.is-invalid, .save-status.is-blocked, .save-status.is-dirty { color: var(--status-warning); }
.save-status.is-error, .save-status.is-conflict { color: var(--status-danger); }
.detail-notice { display: grid; gap: var(--space-3); border: 1px solid var(--status-warning-border); border-radius: var(--radius-control); background: var(--status-warning-bg); color: var(--status-warning); padding: var(--space-4); font-size: var(--text-xs); line-height: var(--leading-ui); }
.fork-form { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
.fork-form > :first-child { min-width: 12rem; flex: 1; }
.detail-hint { margin: 0; color: var(--text-muted); font-size: var(--text-2xs); }
.form-error { margin: 0; color: var(--status-danger); font-size: var(--text-xs); }
.analysis-fieldset { min-width: 0; margin: 0; border: 0; padding: 0; }
@media (max-width: 640px) {
    .library-columns { grid-template-columns: minmax(0, 1fr); }
    .library-tree { max-height: 40vh; border-right: 0; border-bottom: 1px solid var(--border-color); padding-right: 0; padding-bottom: var(--space-4); }
}
</style>
