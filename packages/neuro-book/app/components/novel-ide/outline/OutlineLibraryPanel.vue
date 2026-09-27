<script setup lang="ts">
import {computed, ref, watch} from "vue";
import {Badge, Button, EmptyState, FormCheckbox, FormInput, FormSelect, IconButton} from "@notnotype/nb-ui/components";
import OutlineDetailAnalysisPanel from "nbook/app/components/novel-ide/outline/OutlineDetailAnalysisPanel.vue";
import OutlineEntryForm from "nbook/app/components/novel-ide/outline/OutlineEntryForm.vue";
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
    formToCreateMetadata,
    formToEditMetadata,
    validateEntryForm,
    type OutlineEntryFormValue,
} from "nbook/app/utils/outline/outline-entry-form";

type EntryKind = OutlineWorkbenchEntry["kind"];
type EntryRecord = OutlineWorkbenchSnapshot["entries"][number];
type ObjectImpact = Readonly<{targetId: string; objectFile: string | null; references: readonly Readonly<{sourceFile: string; relation: string; sourceId?: string}>[]; canDeleteObject: boolean}>;
type PlacementImpact = Readonly<{planId: string; targetId: string; childReferences: readonly string[]; blockingFixedLineIds: readonly string[]; canRemovePlacement: boolean}>;
type PlanImpact = Readonly<{planId: string; placementIds: readonly string[]; exclusiveEntryIds: readonly string[]; blockingFixedLineIds: readonly string[]; canRemovePlan: boolean}>;
type Preview =
    | {type: "object"; revision: number; objectHash: string | null; impact: ObjectImpact}
    | {type: "placement"; revision: number; impact: PlacementImpact}
    | {type: "plan"; revision: number; impact: PlanImpact};
type Mode = "view" | "edit" | "create-child" | "create-total";

const props = defineProps<{
    projectRoot: string | null;
    snapshot: OutlineWorkbenchSnapshot | null;
    libraryTrees: readonly OutlineWorkbenchLibraryTree[];
    refresh: () => Promise<void>;
}>();
const planId = defineModel<string | null>("planId", {required: true});

const actions = useOutlineWorkbenchActions(() => props.projectRoot, () => props.refresh());
const kindLabels: Record<EntryKind, string> = {total: "总纲", volume: "卷纲", chapter: "章节大纲", detail: "细纲"};
/** 与服务端 `canParentEntry` 同一张层级表，只用于给出可选项；越级请求仍会被服务端拒绝。 */
const childKinds: Record<EntryKind, readonly EntryKind[]> = {total: ["volume", "chapter"], volume: ["chapter"], chapter: ["detail"], detail: []};

const selectedEntryId = ref<string | null>(null);
const mode = ref<Mode>("view");
const form = ref<OutlineEntryFormValue>(emptyEntryForm());
const formError = ref<string | null>(null);
const childKind = ref<EntryKind>("chapter");
const confirmGlobal = ref(false);
const planForm = ref<{kind: "create" | "rename"; title: string} | null>(null);
const preview = ref<Preview | null>(null);
const confirmedTotal = ref(false);
const moveParentId = ref("");
const attachPlanId = ref("");

const revision = computed(() => props.snapshot?.manifest.revision ?? 0);
const plans = computed(() => props.snapshot?.manifest.plans ?? []);
const plan = computed(() => plans.value.find((item) => item.id === planId.value) ?? null);
const planOptions = computed(() => plans.value.map((item) => ({value: item.id, label: item.title})));
const totalId = computed(() => props.snapshot?.manifest.totalId ?? null);
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
const usingPlans = computed(() => selected.value
    ? plans.value.filter((item) => item.placements.some(({entryId}) => entryId === selected.value!.value.id))
    : []);
/** 总纲天然被所有方案引用，走全局确认而不是写时分叉。 */
const isShared = computed(() => selected.value?.value.kind !== "total" && usingPlans.value.length > 1);
const withMetadata = computed(() => selected.value ? entryHasHandoffMetadata(selected.value.value.kind) : false);
const foreshadowOptions = computed(() => (props.snapshot?.foreshadowing ?? [])
    .map(({value}) => ({value: value.id, label: value.status === "draft" ? `${value.title}（草稿）` : value.title})));
const moveOptions = computed(() => {
    const current = selected.value?.value;
    if (!current || !selectedInPlan.value) return [];
    return rows.value.filter(({entry}) => entry.id !== current.parentId && childKinds[entry.kind].includes(current.kind))
        .map(({entry}) => ({value: entry.id, label: `${kindLabels[entry.kind]} · ${entry.title}`}));
});
const attachOptions = computed(() => {
    const current = selected.value?.value;
    if (!current?.parentId) return [];
    return plans.value.filter((item) => item.placements.some(({entryId}) => entryId === current.parentId)
        && !item.placements.some(({entryId}) => entryId === current.id))
        .map((item) => ({value: item.id, label: item.title}));
});
const chapterAdopted = computed(() => {
    const chapterId = selected.value?.value.chapterId;
    return chapterId ? entries.value.get(chapterId)?.value.status === "adopted" : false;
});

watch(plan, () => {
    if (selected.value && !selectedInPlan.value && !unplaced.value.some(({value}) => value.id === selectedEntryId.value)) selectEntry(null);
    preview.value = null;
});
// 条目内容变化（保存成功或他处修改）后回到查看态，避免表单基于旧版本继续编辑。
watch(() => selected.value?.contentHash, (next, previous) => {
    if (previous !== undefined && next !== previous && mode.value === "edit") mode.value = "view";
});

function selectEntry(id: string | null): void {
    selectedEntryId.value = id;
    mode.value = "view";
    preview.value = null;
    formError.value = null;
    moveParentId.value = "";
    attachPlanId.value = "";
    actions.clearError();
}

function startCreateTotal(): void {
    selectEntry(null);
    form.value = {...emptyEntryForm(), title: "总纲"};
    formError.value = null;
    mode.value = "create-total";
}
function startCreateChild(): void {
    const kinds = selected.value ? childKinds[selected.value.value.kind] : [];
    if (!kinds.length) return;
    childKind.value = kinds[0]!;
    form.value = emptyEntryForm();
    formError.value = null;
    mode.value = "create-child";
}
function startEdit(): void {
    if (!selected.value) return;
    form.value = entryToForm(selected.value.value);
    formError.value = null;
    confirmGlobal.value = false;
    mode.value = "edit";
}

async function library<T extends {transactionId: string; entryId?: string; planId?: string}>(action: Record<string, unknown>): Promise<T | null> {
    return actions.run<T>("library-action", {expectedRevision: revision.value, action});
}

async function submitCreateTotal(): Promise<void> {
    formError.value = validateEntryForm(form.value, false);
    if (formError.value) return;
    const result = await library({kind: "create-total", title: form.value.title.trim(), body: form.value.body});
    if (result?.entryId) selectEntry(result.entryId);
}
async function submitCreateChild(): Promise<void> {
    const parent = selected.value?.value;
    if (!parent || !plan.value) return;
    const metadata = entryHasHandoffMetadata(childKind.value);
    formError.value = validateEntryForm(form.value, metadata);
    if (formError.value) return;
    const result = await library({kind: "create-entry", planId: plan.value.id, parentId: parent.id, entryKind: childKind.value,
        title: form.value.title.trim(), body: form.value.body, ...metadata ? formToCreateMetadata(form.value) : {}});
    if (result?.entryId) selectEntry(result.entryId);
}
async function submitEdit(): Promise<void> {
    const record = selected.value;
    if (!record || !plan.value) return;
    formError.value = validateEntryForm(form.value, withMetadata.value);
    if (formError.value) return;
    const metadata = withMetadata.value ? formToEditMetadata(form.value) : {};
    if (isShared.value) {
        if (form.value.title.trim() === record.value.title.trim()) {
            formError.value = "另存为本方案专属条目时需要换一个标题，便于区分两个版本";
            return;
        }
        const result = await actions.run<{transactionId: string; entryId: string}>("fork-entry", {
            planId: plan.value.id, sourceId: record.value.id, title: form.value.title.trim(), body: form.value.body,
            expectedRevision: revision.value, confirmShared: true, ...metadata,
        }, {fallback: "另存失败"});
        if (result) selectEntry(result.entryId);
        return;
    }
    const isTotal = record.value.kind === "total";
    if (isTotal && !confirmGlobal.value) {
        formError.value = "总纲被所有方案共用，请先勾选确认";
        return;
    }
    const result = await library({kind: "edit-entry", planId: plan.value.id, entryId: record.value.id,
        expectedVersion: record.value.version, expectedContentHash: record.contentHash,
        title: form.value.title.trim(), body: form.value.body, ...isTotal ? {confirmGlobal: true} : {}, ...metadata});
    if (result) mode.value = "view";
}
async function adoptEntry(): Promise<void> {
    const record = selected.value;
    if (!record || !plan.value) return;
    await library({kind: "adopt-entry", planId: plan.value.id, entryId: record.value.id,
        expectedVersion: record.value.version, expectedContentHash: record.contentHash});
}
async function reorder(delta: -1 | 1): Promise<void> {
    const row = selectedRow.value;
    if (!row || !plan.value) return;
    await library({kind: "reorder-entry", planId: plan.value.id, entryId: row.entry.id, siblingIndex: row.siblingIndex + delta});
}
async function moveEntry(): Promise<void> {
    const record = selected.value;
    if (!record || !plan.value || !moveParentId.value) return;
    const result = await library({kind: "move-entry", planId: plan.value.id, entryId: record.value.id, parentId: moveParentId.value,
        expectedVersion: record.value.version, expectedContentHash: record.contentHash});
    if (result) moveParentId.value = "";
}
async function attachEntry(targetPlanId: string): Promise<void> {
    const current = selected.value?.value;
    if (!current?.parentId || !targetPlanId) return;
    const result = await library({kind: "attach-entry", planId: targetPlanId, parentId: current.parentId, entryId: current.id});
    if (result) attachPlanId.value = "";
}

async function submitPlanForm(): Promise<void> {
    const draft = planForm.value;
    if (!draft || !draft.title.trim()) return;
    if (draft.kind === "create") {
        const result = await library({kind: "create-plan", title: draft.title.trim()});
        if (result) { planForm.value = null; if (result.planId) planId.value = result.planId; }
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
        if (result) selectEntry(null);
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
        || (current.impact.targetId === totalId.value && !confirmedTotal.value);
    if (current.type === "placement") return !current.impact.canRemovePlacement;
    return !current.impact.canRemovePlan;
});
</script>

<template>
    <div class="library-panel">
        <header class="plan-bar">
            <FormSelect :model-value="planId ?? ''" :options="planOptions" placeholder="还没有方案" size="sm" class="plan-select" aria-label="选择方案" :disabled="!planOptions.length" @update:model-value="planId = $event || null" />
            <Button size="sm" variant="ghost" icon-class="i-lucide-plus" :disabled="!totalId" :title="totalId ? undefined : '先创建总纲'" @click="planForm = {kind: 'create', title: ''}">新建方案</Button>
            <Button size="sm" variant="ghost" icon-class="i-lucide-pencil" :disabled="!plan" @click="planForm = {kind: 'rename', title: plan?.title ?? ''}">重命名</Button>
            <Button size="sm" variant="ghost" icon-class="i-lucide-trash-2" :disabled="!plan" @click="previewPlanRemoval">删除方案</Button>
        </header>
        <form v-if="planForm" class="inline-form" @submit.prevent="submitPlanForm">
            <FormInput v-model="planForm.title" :placeholder="planForm.kind === 'create' ? '新方案名称' : '方案名称'" size="sm" autofocus aria-label="方案名称" />
            <Button size="sm" variant="primary" type="submit" :disabled="!planForm.title.trim() || actions.pending.value">{{ planForm.kind === 'create' ? '创建' : '保存' }}</Button>
            <Button size="sm" variant="ghost" @click="planForm = null">取消</Button>
        </form>
        <div v-if="actions.error.value" class="panel-error" role="alert"><span class="i-lucide-circle-alert"></span>{{ actions.error.value }}<button type="button" @click="actions.clearError()">知道了</button></div>

        <section v-if="preview" class="impact-panel" aria-label="删除影响">
            <template v-if="preview.type === 'object'">
                <strong>删除条目「{{ entryTitle(preview.impact.targetId) }}」</strong>
                <p>将删除文件 {{ preview.impact.objectFile ?? '（未找到文件）' }}，删除后可在操作记录中撤销。</p>
                <template v-if="preview.impact.references.length">
                    <p>还有以下引用，需要先逐一处理才能删除：</p>
                    <ul><li v-for="(reference, index) in preview.impact.references" :key="index">{{ describeReference(reference) }}</li></ul>
                </template>
                <FormCheckbox v-if="preview.impact.targetId === totalId && preview.impact.canDeleteObject" v-model="confirmedTotal" label="我确认删除全局总纲" />
            </template>
            <template v-else-if="preview.type === 'placement'">
                <strong>从方案「{{ planTitle(preview.impact.planId) }}」移除「{{ entryTitle(preview.impact.targetId) }}」</strong>
                <p>只解除该方案对条目的引用，条目文件保留。</p>
                <p v-if="preview.impact.childReferences.length">仍有 {{ preview.impact.childReferences.length }} 个下级条目：{{ preview.impact.childReferences.map(entryTitle).join('、') }}，请先移除下级。</p>
                <p v-if="preview.impact.blockingFixedLineIds.length">被已固定的线路引用：{{ preview.impact.blockingFixedLineIds.map((id) => lineTitles.get(id) ?? id).join('、') }}，请先处理线路。</p>
                <p v-if="preview.impact.targetId === totalId">总纲是方案的根，不能单独移除。</p>
            </template>
            <template v-else>
                <strong>删除方案「{{ planTitle(preview.impact.planId) }}」</strong>
                <p>只删除方案本身，条目文件全部保留。该方案共包含 {{ preview.impact.placementIds.length }} 个条目。</p>
                <p v-if="preview.impact.exclusiveEntryIds.length">其中 {{ preview.impact.exclusiveEntryIds.length }} 个条目只属于这个方案，删除后会出现在“未归入方案的条目”里，可以重新加入其他方案或删除。</p>
                <p v-if="preview.impact.blockingFixedLineIds.length">被已固定的线路引用：{{ preview.impact.blockingFixedLineIds.map((id) => lineTitles.get(id) ?? id).join('、') }}，请先处理线路。</p>
            </template>
            <div class="impact-actions">
                <Button size="sm" variant="ghost" @click="preview = null">取消</Button>
                <Button size="sm" variant="danger" :disabled="previewBlocked || actions.pending.value" @click="confirmPreview">确认</Button>
            </div>
        </section>

        <div class="library-columns">
            <nav class="library-tree" aria-label="大纲条目">
                <EmptyState v-if="!totalId" icon-class="i-lucide-library" title="还没有总纲" description="总纲是全书唯一的顶层大纲，所有方案都从它展开。">
                    <template #action><Button size="sm" variant="primary" icon-class="i-lucide-plus" @click="startCreateTotal">创建总纲</Button></template>
                </EmptyState>
                <EmptyState v-else-if="!plan" icon-class="i-lucide-git-fork" title="还没有方案" description="方案是从总纲展开的一套卷纲与章节安排，可以并行保留多套。">
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
                <template v-if="mode === 'create-total'">
                    <h3>创建总纲</h3>
                    <OutlineEntryForm v-model="form" :with-metadata="false" :disabled="actions.pending.value" />
                    <p v-if="formError" class="form-error">{{ formError }}</p>
                    <div class="detail-actions">
                        <Button size="sm" variant="ghost" @click="mode = 'view'">取消</Button>
                        <Button size="sm" variant="primary" :loading="actions.pending.value" @click="submitCreateTotal">创建</Button>
                    </div>
                </template>
                <template v-else-if="mode === 'create-child' && selected">
                    <h3>在「{{ selected.value.title }}」下新增</h3>
                    <FormSelect
                        v-if="childKinds[selected.value.kind].length > 1"
                        v-model="childKind"
                        :options="childKinds[selected.value.kind].map((kind) => ({value: kind, label: kindLabels[kind]}))"
                        size="sm"
                        aria-label="条目类型"
                    />
                    <p v-else class="detail-hint">类型：{{ kindLabels[childKind] }}</p>
                    <OutlineEntryForm v-model="form" :with-metadata="entryHasHandoffMetadata(childKind)" :detail="childKind === 'detail'" :foreshadow-options="childKind === 'chapter' ? foreshadowOptions : undefined" :disabled="actions.pending.value" />
                    <p v-if="formError" class="form-error">{{ formError }}</p>
                    <div class="detail-actions">
                        <Button size="sm" variant="ghost" @click="mode = 'view'">取消</Button>
                        <Button size="sm" variant="primary" :loading="actions.pending.value" @click="submitCreateChild">保存为草稿</Button>
                    </div>
                </template>
                <template v-else-if="mode === 'edit' && selected">
                    <h3>编辑{{ kindLabels[selected.value.kind] }}</h3>
                    <div v-if="isShared" class="detail-notice">
                        这个条目同时用于 {{ usingPlans.length }} 个方案（{{ usingPlans.map((item) => item.title).join('、') }}）。保存时会为当前方案另存一份新条目，其他方案保持不变；两份之后各自独立，不会再合并。请换一个标题以便区分。
                    </div>
                    <div v-else-if="selected.value.kind === 'total'" class="detail-notice">
                        总纲被所有方案共用，修改会影响全部方案。
                        <FormCheckbox v-model="confirmGlobal" label="我确认修改全局总纲" />
                    </div>
                    <p v-if="selected.value.status === 'adopted'" class="detail-hint">保存后条目会回到草稿状态，需要重新正式采用。</p>
                    <OutlineEntryForm v-model="form" :with-metadata="withMetadata" :detail="selected.value.kind === 'detail'" :foreshadow-options="selected.value.kind === 'chapter' ? foreshadowOptions : undefined" :disabled="actions.pending.value" />
                    <p v-if="formError" class="form-error">{{ formError }}</p>
                    <div class="detail-actions">
                        <Button size="sm" variant="ghost" @click="mode = 'view'">取消</Button>
                        <Button size="sm" variant="primary" :loading="actions.pending.value" @click="submitEdit">{{ isShared ? '另存为本方案条目' : '保存为草稿' }}</Button>
                    </div>
                </template>
                <template v-else-if="selected">
                    <div class="detail-heading">
                        <div>
                            <h3>{{ selected.value.title }}</h3>
                            <div class="detail-badges">
                                <Badge size="sm" tone="neutral">{{ kindLabels[selected.value.kind] }}</Badge>
                                <Badge size="sm" :tone="selected.value.status === 'adopted' ? 'success' : 'warning'">{{ selected.value.status === 'adopted' ? '正式采用' : '草稿' }}</Badge>
                                <Badge v-if="isShared" size="sm" tone="accent">共用于 {{ usingPlans.length }} 个方案</Badge>
                                <Badge v-if="!selectedInPlan" size="sm" tone="neutral">未归入当前方案</Badge>
                            </div>
                        </div>
                        <div class="detail-tools">
                            <IconButton v-if="selectedRow && selectedRow.depth > 0" title="上移" icon-class="i-lucide-arrow-up" size="sm" :disabled="selectedRow.siblingIndex === 0 || actions.pending.value" @click="reorder(-1)" />
                            <IconButton v-if="selectedRow && selectedRow.depth > 0" title="下移" icon-class="i-lucide-arrow-down" size="sm" :disabled="selectedRow.siblingIndex >= selectedRow.siblingCount - 1 || actions.pending.value" @click="reorder(1)" />
                        </div>
                    </div>
                    <div class="detail-actions is-start">
                        <Button v-if="selectedInPlan" size="sm" variant="secondary" icon-class="i-lucide-pencil" @click="startEdit">编辑</Button>
                        <Button v-if="selectedInPlan && selected.value.status === 'draft' && selected.value.kind !== 'detail'" size="sm" variant="secondary" icon-class="i-lucide-check" :disabled="actions.pending.value" @click="adoptEntry">正式采用</Button>
                        <Button v-if="selectedInPlan && childKinds[selected.value.kind].length" size="sm" variant="secondary" icon-class="i-lucide-plus" @click="startCreateChild">新增下级</Button>
                        <Button v-if="selectedInPlan && selected.value.kind !== 'total'" size="sm" variant="ghost" icon-class="i-lucide-unlink" @click="previewPlacementRemoval">从本方案移除</Button>
                        <Button size="sm" variant="ghost" icon-class="i-lucide-trash-2" @click="previewObjectDeletion">删除条目</Button>
                    </div>
                    <div v-if="selectedInPlan && moveOptions.length" class="inline-form">
                        <FormSelect v-model="moveParentId" :options="moveOptions" placeholder="移动到其他上级…" size="sm" aria-label="移动到其他上级" />
                        <Button size="sm" variant="secondary" :disabled="!moveParentId || actions.pending.value" @click="moveEntry">移动</Button>
                    </div>
                    <div v-if="attachOptions.length" class="inline-form">
                        <FormSelect v-model="attachPlanId" :options="attachOptions" placeholder="同时加入其他方案…" size="sm" aria-label="同时加入其他方案" />
                        <Button size="sm" variant="secondary" :disabled="!attachPlanId || actions.pending.value" @click="attachEntry(attachPlanId)">加入</Button>
                    </div>
                    <p v-if="usingPlans.length" class="detail-hint">所在方案：{{ usingPlans.map((item) => item.title).join('、') }}</p>
                    <pre class="detail-body">{{ selected.value.body || '（正文为空）' }}</pre>
                    <dl v-if="selected.value.targetWords || selected.value.writingGuidance || selected.value.materialRefs?.length || selected.value.references?.length" class="detail-meta">
                        <template v-if="selected.value.targetWords"><dt>目标字数</dt><dd>{{ selected.value.targetWords }}</dd></template>
                        <template v-if="selected.value.writingGuidance"><dt>写作指导</dt><dd>{{ selected.value.writingGuidance }}</dd></template>
                        <template v-if="selected.value.materialRefs?.length"><dt>素材索引</dt><dd>{{ selected.value.materialRefs.join('、') }}</dd></template>
                        <template v-if="selected.value.references?.length">
                            <dt>参考资料</dt>
                            <dd><ul><li v-for="(item, index) in selected.value.references" :key="index">
                                <span v-if="item.pending" class="pending-mark">待补</span>{{ item.path ?? '' }}<template v-if="item.locator"> · {{ item.locator }}</template><template v-if="item.purpose">（{{ item.purpose }}）</template>
                            </li></ul></dd>
                        </template>
                    </dl>
                    <OutlineDetailAnalysisPanel
                        v-if="selected.value.kind === 'detail' && selectedInPlan && plan"
                        :actions="actions"
                        :plan-id="plan.id"
                        :revision="revision"
                        :record="selected"
                        :chapter-adopted="chapterAdopted"
                    />
                </template>
                <EmptyState v-else icon-class="i-lucide-mouse-pointer-click" title="选择一个条目" description="在左侧选择条目查看内容，或进行编辑、采用和整理。" />
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
.impact-panel { display: grid; gap: var(--space-3); border: 1px solid var(--status-warning-border); border-radius: var(--radius-control); background: var(--status-warning-bg); padding: var(--space-5); font-size: var(--text-xs); }
.impact-panel p { margin: 0; }
.impact-panel ul { display: grid; gap: var(--space-2); margin: 0; padding-left: var(--space-6); }
.impact-actions, .detail-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-3); }
.detail-actions.is-start { justify-content: flex-start; }
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
.library-detail h3 { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-strong); }
.detail-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); }
.detail-badges, .detail-tools { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-3); }
.detail-notice { display: grid; gap: var(--space-3); border: 1px solid var(--status-warning-border); border-radius: var(--radius-control); background: var(--status-warning-bg); color: var(--status-warning); padding: var(--space-4); font-size: var(--text-xs); line-height: var(--leading-ui); }
.detail-hint { margin: 0; color: var(--text-muted); font-size: var(--text-2xs); }
.form-error { margin: 0; color: var(--status-danger); font-size: var(--text-xs); }
.detail-body { margin: 0; border: 1px solid var(--border-color); border-radius: var(--radius-control); background: var(--bg-subtle); padding: var(--space-5); font-family: inherit; font-size: var(--text-xs); line-height: var(--leading-ui); white-space: pre-wrap; word-break: break-word; }
.detail-meta { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-3) var(--space-5); margin: 0; font-size: var(--text-xs); }
.detail-meta dt { color: var(--text-muted); }
.detail-meta dd { margin: 0; white-space: pre-wrap; }
.detail-meta ul { display: grid; gap: var(--space-2); margin: 0; padding-left: var(--space-5); }
.pending-mark { margin-right: var(--space-2); color: var(--status-warning); }
</style>
