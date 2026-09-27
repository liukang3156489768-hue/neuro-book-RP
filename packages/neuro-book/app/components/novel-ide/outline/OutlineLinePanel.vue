<script setup lang="ts">
import {computed, ref, watch} from "vue";
import {Badge, Button, EmptyState, FormField, FormInput, FormSelect} from "@notnotype/nb-ui/components";
import OutlineLineAnalysisPanel from "nbook/app/components/novel-ide/outline/OutlineLineAnalysisPanel.vue";
import OutlineLineGraphCanvas, {type GraphEdgeDecor, type GraphNodeDecor} from "nbook/app/components/novel-ide/outline/line-graph/OutlineLineGraphCanvas.vue";
import {chainProblemLabels, lineColors, lockedGraphParts, resolveLineChain, type GraphCell}
    from "nbook/app/components/novel-ide/outline/line-graph/outline-line-graph";
import {useOutlineWorkbenchActions} from "nbook/app/composables/useOutlineWorkbenchActions";
import type {OutlineWorkbenchGraphEdge, OutlineWorkbenchLineType, OutlineWorkbenchSnapshot} from "nbook/app/composables/useOutlineWorkbenchData";

type LineRecord = OutlineWorkbenchSnapshot["lines"][number];
type NodeStatus = "valid" | "yellow" | "red" | "empty";
type Inspection = Readonly<{
    lineId: string;
    contentHash: string;
    revision: number;
    nodes: readonly Readonly<{nodeId: string; entryId: string | null; column: number; status: NodeStatus}>[];
}>;
type GraphDeletionImpact = Readonly<{planId: string; kind: "node" | "edge"; targetId: string; entryId?: string | null;
    removedEdges: readonly OutlineWorkbenchGraphEdge[]; affectedLineIds: readonly string[];
    expectedRevision: number; expectedGraphVersion: number; impactHash: string}>;
type ObjectPreview = Readonly<{revision: number; objectHash: string | null;
    impact: Readonly<{targetId: string; objectFile: string | null; references: readonly Readonly<{sourceFile: string; relation: string; sourceId?: string}>[]; canDeleteObject: boolean}>}>;
/** 每种确认都绑定服务端预览或读取时的版本；确认面板同一时间只出现一个。 */
type Pending =
    | {kind: "remove-graph"; impact: GraphDeletionImpact}
    | {kind: "reopen"; record: LineRecord}
    | {kind: "switch-main"; record: LineRecord; previous: LineRecord}
    | {kind: "delete-line"; record: LineRecord; preview: ObjectPreview};
type Selection = Readonly<{kind: "line" | "node" | "edge"; id: string}>;
/** 勾选模式：lineId 为 null 表示新建线路。 */
type Picking = {lineId: string | null; title: string; type: OutlineWorkbenchLineType; nodeIds: string[]};

const props = defineProps<{
    projectRoot: string | null;
    snapshot: OutlineWorkbenchSnapshot | null;
    planId: string | null;
    refresh: () => Promise<void>;
}>();

const actions = useOutlineWorkbenchActions(() => props.projectRoot, () => props.refresh());
// 节点状态读取与编辑动作分开记录忙碌和错误，避免刷新后的自动读取覆盖动作的错误提示。
const inspector = useOutlineWorkbenchActions(() => props.projectRoot, () => {});

/** 选择框不接受空字符串选项值，空节点用哨兵值表示，提交时换成 null。 */
const EMPTY_ENTRY = "__empty__";
const typeLabels: Record<OutlineWorkbenchLineType, string> = {main: "主线", branch: "支线", character: "角色线", if: "IF 线"};
const typeOptions = (Object.keys(typeLabels) as OutlineWorkbenchLineType[]).map((value) => ({value, label: typeLabels[value]}));

const selection = ref<Selection | null>(null);
const picking = ref<Picking | null>(null);
const pickError = ref<string | null>(null);
const pending = ref<Pending | null>(null);
const inspection = ref<Inspection | null>(null);
const notice = ref<string | null>(null);
const relinkEntryId = ref(EMPTY_ENTRY);
const canvas = ref<InstanceType<typeof OutlineLineGraphCanvas> | null>(null);

const revision = computed(() => props.snapshot?.manifest.revision ?? 0);
const plan = computed(() => props.snapshot?.manifest.plans.find(({id}) => id === props.planId) ?? null);
const graph = computed(() => props.snapshot?.graphs.find(({value}) => value.planId === props.planId)?.value ?? null);
const graphVersion = computed(() => graph.value?.version ?? 0);
const planLines = computed(() => (props.snapshot?.lines ?? []).filter(({value}) => value.planId === props.planId));
const currentMain = computed(() => planLines.value.find(({value}) => value.type === "main") ?? null);
const entries = computed(() => new Map((props.snapshot?.entries ?? []).map(({value}) => [value.id, value])));
const colors = computed(() => lineColors(planLines.value.map(({value}) => value)));
const chains = computed(() => new Map(planLines.value.map(({value}) => [value.id, resolveLineChain(graph.value, value.nodeIds)])));
const locked = computed(() => lockedGraphParts(graph.value, planLines.value.map(({value}) => value)));

const selectedLine = computed(() => selection.value?.kind === "line"
    ? planLines.value.find(({value}) => value.id === selection.value!.id) ?? null : null);
const selectedNode = computed(() => selection.value?.kind === "node"
    ? graph.value?.nodes.find(({id}) => id === selection.value!.id) ?? null : null);
const selectedEdge = computed(() => selection.value?.kind === "edge"
    ? graph.value?.edges.find(({id}) => id === selection.value!.id) ?? null : null);
const pickingChain = computed(() => picking.value ? resolveLineChain(graph.value, picking.value.nodeIds) : null);

/** 选中线路时高亮它的链；勾选模式高亮已勾选的节点。 */
const highlight = computed(() => {
    if (picking.value) return null;
    const lineId = selectedLine.value?.value.id;
    const chain = lineId ? chains.value.get(lineId) : undefined;
    return chain && lineId ? {lineId, nodeIds: new Set(chain.nodes.map(({id}) => id)), edgeIds: new Set(chain.edges.map(({id}) => id))} : null;
});
const nodeStatus = computed(() => {
    const current = inspection.value;
    const line = selectedLine.value;
    return current && line && current.lineId === line.value.id && current.contentHash === line.contentHash && current.revision === revision.value
        ? new Map(current.nodes.map((node) => [node.nodeId, node.status])) : new Map<string, NodeStatus>();
});

function nodeTitle(nodeId: string): string {
    const node = graph.value?.nodes.find(({id}) => id === nodeId);
    if (!node) return "未知节点";
    if (node.entryId === null) return "空节点";
    return entries.value.get(node.entryId)?.title ?? "条目已删除";
}
function nodeLineIds(nodeId: string): string[] {
    return planLines.value.filter(({value}) => value.nodeIds.includes(nodeId)).map(({value}) => value.id);
}

const nodeDecor = computed(() => new Map<string, GraphNodeDecor>((graph.value?.nodes ?? []).map((node) => {
    const entry = node.entryId === null ? undefined : entries.value.get(node.entryId);
    const status = nodeStatus.value.get(node.id);
    const tone: GraphNodeDecor["tone"] = node.entryId === null ? "muted" : !entry || status === "red" ? "danger"
        : status === "yellow" && selectedLine.value?.value.fixed ? "warning" : "none";
    const note = node.entryId === null ? "空节点，选中后关联条目" : !entry ? "条目已删除"
        : status === "yellow" && selectedLine.value?.value.fixed ? "条目已变化，需重新固定"
            : entry.status === "draft" ? "草稿条目" : undefined;
    return [node.id, {title: nodeTitle(node.id), tone, note, colors: nodeLineIds(node.id).map((id) => colors.value.get(id)!),
        locked: locked.value.nodeIds.has(node.id), ticked: picking.value?.nodeIds.includes(node.id) ?? false,
        dimmed: highlight.value ? !highlight.value.nodeIds.has(node.id) : false}];
})));
const edgeDecor = computed(() => new Map<string, GraphEdgeDecor>((graph.value?.edges ?? []).map((edge) => {
    const lineId = highlight.value?.edgeIds.has(edge.id) ? highlight.value.lineId
        : [...chains.value].find(([, chain]) => chain.edges.some(({id}) => id === edge.id))?.[0];
    return [edge.id, {color: lineId ? colors.value.get(lineId) ?? null : null, dimmed: highlight.value ? !highlight.value.edgeIds.has(edge.id) : false}];
})));

/** 候选只按方案挂载关系列出；细纲不能独立成为节点，同一图内一个条目只能关联一个节点。 */
const entryOptions = computed(() => {
    const used = new Set((graph.value?.nodes ?? []).filter(({id}) => id !== selectedNode.value?.id).map(({entryId}) => entryId));
    return [{value: EMPTY_ENTRY, label: "（空节点）"}, ...(plan.value?.placements ?? []).flatMap(({entryId}) => {
        const entry = entries.value.get(entryId);
        if (!entry || entry.kind === "detail" || used.has(entryId)) return [];
        return [{value: entryId, label: entry.status === "draft" ? `${entry.title}（草稿）` : entry.title}];
    })];
});

watch(() => props.planId, () => { select(null); picking.value = null; });
watch(() => [selection.value, graph.value, planLines.value] as const, () => {
    // 刷新后选中对象可能已被删除。
    if (selection.value && !selectedLine.value && !selectedNode.value && !selectedEdge.value) selection.value = null;
    relinkEntryId.value = selectedNode.value?.entryId ?? EMPTY_ENTRY;
});
// 节点红黄状态由服务端按当前规范快照判定；线路内容或方案修订变化后重新读取。
watch(() => [selectedLine.value?.value.id, selectedLine.value?.contentHash, revision.value] as const, async ([lineId, contentHash, current]) => {
    if (!lineId || !contentHash) { inspection.value = null; return; }
    const result = await inspector.run<Omit<Inspection, "contentHash" | "revision">>("inspect-line", {lineId}, {refresh: false, fallback: "读取节点状态失败"});
    if (result && selectedLine.value?.value.id === lineId) inspection.value = {...result, contentHash, revision: current};
}, {immediate: true});

function select(next: Selection | null): void {
    selection.value = next;
    pending.value = null;
    notice.value = null;
}
function onNodeClick(nodeId: string): void {
    if (!picking.value) { select({kind: "node", id: nodeId}); return; }
    const current = picking.value;
    if (current.nodeIds.includes(nodeId)) {
        current.nodeIds = current.nodeIds.filter((id) => id !== nodeId);
        return;
    }
    // 一条线路在每一格只能经过一个节点；点选同格的另一个节点视为改走这一格的另一条分支。
    const column = graph.value?.nodes.find(({id}) => id === nodeId)?.column;
    const byId = new Map((graph.value?.nodes ?? []).map((node) => [node.id, node]));
    current.nodeIds = [...current.nodeIds.filter((id) => byId.get(id)?.column !== column), nodeId];
}

function startCreate(): void {
    select(null);
    pickError.value = null;
    picking.value = {lineId: null, title: "", type: currentMain.value ? "branch" : "main", nodeIds: []};
}
function startEdit(record: LineRecord): void {
    pickError.value = null;
    pending.value = null;
    picking.value = {lineId: record.value.id, title: record.value.title, type: record.value.type, nodeIds: [...record.value.nodeIds]};
}
function cancelPicking(): void {
    const lineId = picking.value?.lineId;
    picking.value = null;
    select(lineId ? {kind: "line", id: lineId} : null);
}

function lineCas(record: LineRecord) {
    return {lineId: record.value.id, expectedVersion: record.value.version, expectedContentHash: record.contentHash};
}
function lineAction<T = Record<string, unknown>>(action: Record<string, unknown>, fallback: string, expectedRevision = revision.value): Promise<T | null> {
    return actions.run<T>("line-action", {expectedRevision, action}, {fallback});
}
function graphAction<T = Record<string, unknown>>(action: Record<string, unknown>, fallback: string): Promise<T | null> {
    if (!props.planId) return Promise.resolve(null);
    return lineAction<T>({...action, planId: props.planId, expectedGraphVersion: graphVersion.value}, fallback);
}

async function savePicking(): Promise<void> {
    const current = picking.value;
    if (!current || !props.planId) return;
    const title = current.title.trim();
    pickError.value = title ? null : "线路名称不能为空";
    if (pickError.value) return;
    // 保存顺序按格号排列，与服务端派生的线路顺序一致，方便阅读文件。
    const nodeIds = pickingChain.value!.nodes.map(({id}) => id);
    if (current.lineId === null) {
        const result = await lineAction<{lineId: string}>({kind: "create-line", planId: props.planId, title, type: current.type, nodeIds}, "新建线路失败");
        if (result) { picking.value = null; select({kind: "line", id: result.lineId}); }
        return;
    }
    const record = planLines.value.find(({value}) => value.id === current.lineId);
    if (!record) return;
    const result = await lineAction({kind: "edit-draft-line", ...lineCas(record), title, type: current.type, nodeIds}, "保存线路失败");
    if (result) cancelPicking();
}

async function createNode(cell: GraphCell): Promise<void> {
    const result = await graphAction<{nodeId: string}>({kind: "add-graph-node", column: cell.column, row: cell.row}, "新建节点失败");
    if (result?.nodeId) select({kind: "node", id: result.nodeId});
}
async function moveNode(nodeId: string, cell: GraphCell): Promise<void> {
    const result = await graphAction({kind: "move-graph-node", nodeId, column: cell.column, row: cell.row}, "移动节点失败");
    if (!result) canvas.value?.reset();
}
async function connectNodes(from: string, to: string): Promise<void> {
    await graphAction({kind: "connect-graph-nodes", from, to}, "连接节点失败");
}
async function relinkNode(): Promise<void> {
    if (!selectedNode.value) return;
    await graphAction({kind: "relink-graph-node", nodeId: selectedNode.value.id, entryId: relinkEntryId.value === EMPTY_ENTRY ? null : relinkEntryId.value}, "关联条目失败");
}
async function insertColumn(column: number): Promise<void> {
    await graphAction({kind: "insert-graph-column", column}, "插入列失败");
}
async function previewGraphRemove(kind: "node" | "edge", targetId: string): Promise<void> {
    if (!props.planId) return;
    const impact = await actions.run<GraphDeletionImpact>("preview-graph-deletion", {kind, planId: props.planId, targetId},
        {refresh: false, fallback: "读取删除影响失败"});
    if (impact) pending.value = {kind: "remove-graph", impact};
}
async function previewDeleteLine(record: LineRecord): Promise<void> {
    const preview = await actions.run<ObjectPreview>("preview-object-deletion", {targetId: record.value.id},
        {refresh: false, fallback: "读取删除影响失败"});
    if (preview) pending.value = {kind: "delete-line", record, preview};
}

async function confirmPending(): Promise<void> {
    const current = pending.value;
    if (!current) return;
    let result: unknown = null;
    if (current.kind === "remove-graph") {
        const {impact} = current;
        result = await lineAction({kind: impact.kind === "node" ? "remove-graph-node" : "remove-graph-edge", planId: impact.planId,
            expectedGraphVersion: impact.expectedGraphVersion, [impact.kind === "node" ? "nodeId" : "edgeId"]: impact.targetId,
            expectedImpactHash: impact.impactHash, confirmDeletion: true}, "删除失败", impact.expectedRevision);
        if (result) selection.value = null;
    } else if (current.kind === "reopen") {
        result = await lineAction({kind: "reopen-fixed-line", ...lineCas(current.record), confirmReopen: true}, "退回草稿失败");
    } else if (current.kind === "switch-main") {
        const {record, previous} = current;
        result = await lineAction({kind: "switch-main-line", ...lineCas(record), previousLineId: previous.value.id,
            previousVersion: previous.value.version, previousContentHash: previous.contentHash, confirmSwitch: true}, "切换主线失败");
    } else {
        const {preview} = current;
        if (!preview.objectHash || !preview.impact.canDeleteObject) return;
        result = await actions.run("remove-object", {targetId: preview.impact.targetId, expectedRevision: preview.revision,
            expectedObjectHash: preview.objectHash, confirmedTotal: false}, {fallback: "删除线路失败"});
        if (result) selection.value = null;
    }
    if (result) pending.value = null;
}

const lineTitles = computed(() => new Map(planLines.value.map(({value}) => [value.id, value.title])));
const pendingTitle = computed(() => {
    const current = pending.value;
    if (!current) return "";
    if (current.kind === "remove-graph") return current.impact.kind === "node" ? `删除节点「${nodeTitle(current.impact.targetId)}」` : "删除连线";
    if (current.kind === "reopen") return `将「${current.record.value.title}」退回草稿`;
    if (current.kind === "switch-main") return `将「${current.record.value.title}」设为主线`;
    return `删除线路「${current.record.value.title}」`;
});
const pendingBlocked = computed(() => pending.value?.kind === "delete-line"
    && (!pending.value.preview.impact.canDeleteObject || !pending.value.preview.objectHash));
const busy = computed(() => actions.pending.value);
function edgeLabel(edge: Pick<OutlineWorkbenchGraphEdge, "from" | "to">): string {
    return `${nodeTitle(edge.from)} → ${nodeTitle(edge.to)}`;
}
function nodeColumn(nodeId: string): number | undefined {
    return graph.value?.nodes.find(({id}) => id === nodeId)?.column;
}
</script>

<template>
    <div class="line-panel">
        <div class="line-bar">
            <Button size="sm" variant="primary" icon-class="i-lucide-plus" :disabled="busy || !props.planId || !!picking" @click="startCreate">新建线路</Button>
            <span class="bar-hint">方案「{{ plan?.title ?? '未选择' }}」的线路图：横向格号 0…n 就是剧情先后，同一格的节点是并行剧情。双击空白格新建节点，拖动节点换格，从节点右侧圆点拖到右侧节点连线。</span>
        </div>
        <div v-if="actions.error.value" class="panel-error" role="alert"><span class="i-lucide-circle-alert"></span>{{ actions.error.value }}<button type="button" @click="actions.clearError()">知道了</button></div>
        <div v-if="notice" class="panel-notice" role="status"><span class="i-lucide-info"></span>{{ notice }}<button type="button" @click="notice = null">知道了</button></div>

        <section v-if="pending" class="impact-panel" aria-label="操作确认">
            <strong>{{ pendingTitle }}</strong>
            <template v-if="pending.kind === 'remove-graph'">
                <template v-if="pending.impact.removedEdges.length">
                    <p>{{ pending.impact.kind === 'node' ? `同时移除与它相连的 ${pending.impact.removedEdges.length} 条连线：` : '将移除连线：' }}</p>
                    <ul><li v-for="edge in pending.impact.removedEdges" :key="edge.id">{{ edgeLabel(edge) }}</li></ul>
                </template>
                <p v-if="pending.impact.affectedLineIds.length">草稿线路 {{ pending.impact.affectedLineIds.map((id) => `「${lineTitles.get(id) ?? id}」`).join('') }} 会移除这个节点。</p>
                <p>删除后可在操作记录中撤销。</p>
            </template>
            <p v-else-if="pending.kind === 'reopen'">退回草稿后才能修改这条线路的节点。重新分析并固定之前，正文写作不能再读取它。</p>
            <p v-else-if="pending.kind === 'switch-main'">原主线「{{ pending.previous.value.title }}」会改为支线并退回草稿，两条线路都需要重新分析固定。</p>
            <template v-else-if="pending.kind === 'delete-line'">
                <p>只删除线路文件 {{ pending.preview.impact.objectFile ?? '（未找到文件）' }}，线路图中的节点和连线保留。删除后可在操作记录中撤销。</p>
                <template v-if="pending.preview.impact.references.length">
                    <p>以下位置仍引用这条线路，请先处理：</p>
                    <ul><li v-for="(reference, index) in pending.preview.impact.references" :key="index">{{ reference.sourceFile }}</li></ul>
                </template>
            </template>
            <div class="impact-actions">
                <Button size="sm" variant="ghost" @click="pending = null">取消</Button>
                <Button size="sm" :variant="pending.kind === 'remove-graph' || pending.kind === 'delete-line' ? 'danger' : 'primary'" :disabled="pendingBlocked || busy" @click="confirmPending">确认</Button>
            </div>
        </section>

        <EmptyState v-if="!props.planId" icon-class="i-lucide-git-branch" title="请先选择方案" description="线路图属于方案；在大纲库中选择或新建方案后再规划线路。" />
        <div v-else class="line-columns">
            <OutlineLineGraphCanvas ref="canvas" :graph="graph" :node-decor="nodeDecor" :edge-decor="edgeDecor"
                :selected-node-id="selectedNode?.id ?? null" :selected-edge-id="selectedEdge?.id ?? null"
                :picking="!!picking" :disabled="busy"
                @move-node="moveNode" @connect="connectNodes" @create-node="createNode" @node-click="onNodeClick"
                @edge-click="(id) => !picking && select({kind: 'edge', id})" @pane-click="!picking && select(null)" @reject="notice = $event" />

            <aside class="line-side">
                <form v-if="picking" class="line-form" aria-label="线路节点勾选" @submit.prevent="savePicking">
                    <h3>{{ picking.lineId ? '编辑线路' : '新建线路' }}</h3>
                    <p class="detail-hint">在画布上依次点选节点组成线路。线路按格号从左到右排列，每一格只能经过一个节点，相邻节点之间需要已有连线。</p>
                    <FormField label="名称" required><FormInput v-model="picking.title" :disabled="busy" /></FormField>
                    <FormField label="类型" description="每个方案只有一条主线；要更换主线，请在另一条线路上使用「设为主线」。">
                        <FormSelect v-model="picking.type" :options="typeOptions" size="sm" aria-label="线路类型" />
                    </FormField>
                    <div class="pick-summary">
                        <strong>已选 {{ picking.nodeIds.length }} 个节点</strong>
                        <ol v-if="pickingChain?.nodes.length" class="pick-list">
                            <li v-for="node in pickingChain.nodes" :key="node.id">第 {{ node.column }} 格 · {{ nodeTitle(node.id) }}</li>
                        </ol>
                        <p v-if="pickingChain?.problem" class="chain-problem" role="status">{{ chainProblemLabels[pickingChain.problem] }}。草稿可以先保存，分析固定前需要补齐。</p>
                        <p v-else class="chain-ok">节点构成一条连续的线路。</p>
                    </div>
                    <p v-if="pickError" class="form-error" role="alert">{{ pickError }}</p>
                    <div class="detail-actions">
                        <Button size="sm" variant="ghost" @click="cancelPicking">取消</Button>
                        <Button size="sm" variant="primary" type="submit" :loading="busy">保存为草稿</Button>
                    </div>
                </form>

                <template v-else>
                    <nav class="line-list" aria-label="线路列表">
                        <h4>线路</h4>
                        <p v-if="!planLines.length" class="detail-hint">还没有线路。先在画布上建好节点和连线，再新建线路勾选节点。</p>
                        <button v-for="record in planLines" :key="record.value.id" type="button" class="line-row"
                            :class="{'is-selected': selectedLine?.value.id === record.value.id}" @click="select({kind: 'line', id: record.value.id})">
                            <span class="line-swatch" :style="{background: colors.get(record.value.id)}"></span>
                            <span class="row-title">{{ record.value.title }}</span>
                            <Badge tone="neutral">{{ typeLabels[record.value.type] }}</Badge>
                            <Badge :tone="record.value.fixed ? 'success' : 'warning'">{{ record.value.fixed ? '已固定' : '草稿' }}</Badge>
                        </button>
                    </nav>

                    <section v-if="selectedNode" class="detail-section" aria-label="节点详情">
                        <div class="detail-heading">
                            <h3>{{ nodeTitle(selectedNode.id) }}</h3>
                            <Badge tone="neutral">第 {{ selectedNode.column }} 格</Badge>
                        </div>
                        <p v-if="nodeLineIds(selectedNode.id).length" class="detail-hint">属于：{{ nodeLineIds(selectedNode.id).map((id) => `「${lineTitles.get(id)}」`).join('') }}</p>
                        <p v-if="locked.nodeIds.has(selectedNode.id)" class="detail-hint">节点属于已固定的线路，格号与关联条目已锁定；仍可上下换行、连向新节点。</p>
                        <template v-else>
                            <FormField label="关联条目" description="只能关联本方案中的总纲、卷纲或章节；可以先保留为空节点。">
                                <FormSelect v-model="relinkEntryId" :options="entryOptions" size="sm" aria-label="关联条目" />
                            </FormField>
                            <div class="detail-actions">
                                <Button size="sm" variant="secondary" :disabled="busy || relinkEntryId === (selectedNode.entryId ?? EMPTY_ENTRY)" @click="relinkNode">保存关联</Button>
                            </div>
                        </template>
                        <div class="detail-actions">
                            <Button size="sm" variant="ghost" icon-class="i-lucide-between-horizontal-start" :disabled="busy" @click="insertColumn(selectedNode.column)">在此格前插入一列</Button>
                            <Button size="sm" variant="danger" icon-class="i-lucide-trash-2" :disabled="busy || locked.nodeIds.has(selectedNode.id)" @click="previewGraphRemove('node', selectedNode.id)">删除节点</Button>
                        </div>
                    </section>

                    <section v-else-if="selectedEdge" class="detail-section" aria-label="连线详情">
                        <h3>连线</h3>
                        <p class="detail-hint">{{ edgeLabel(selectedEdge) }}（第 {{ nodeColumn(selectedEdge.from) }} 格 → 第 {{ nodeColumn(selectedEdge.to) }} 格）</p>
                        <p v-if="locked.edgeIds.has(selectedEdge.id)" class="detail-hint">这条连线属于已固定的线路，删除前请先将线路退回草稿。</p>
                        <div class="detail-actions">
                            <Button size="sm" variant="danger" icon-class="i-lucide-trash-2" :disabled="busy || locked.edgeIds.has(selectedEdge.id)" @click="previewGraphRemove('edge', selectedEdge.id)">删除连线</Button>
                        </div>
                    </section>

                    <section v-else-if="selectedLine" class="detail-section" aria-label="线路详情">
                        <div class="detail-heading">
                            <h3>{{ selectedLine.value.title }}</h3>
                            <div class="detail-badges">
                                <Badge tone="neutral">{{ typeLabels[selectedLine.value.type] }}</Badge>
                                <Badge :tone="selectedLine.value.fixed ? 'success' : 'warning'">{{ selectedLine.value.fixed ? '已固定' : '草稿' }}</Badge>
                            </div>
                        </div>
                        <ol class="pick-list">
                            <li v-for="node in chains.get(selectedLine.value.id)?.nodes ?? []" :key="node.id">第 {{ node.column }} 格 · {{ nodeTitle(node.id) }}</li>
                        </ol>
                        <p v-if="chains.get(selectedLine.value.id)?.problem" class="chain-problem">{{ chainProblemLabels[chains.get(selectedLine.value.id)!.problem!] }}</p>
                        <p v-if="selectedLine.value.fixed" class="detail-hint">已固定的线路不能直接修改节点；如需调整，请先退回草稿。</p>
                        <p v-if="inspector.error.value" class="form-error" role="alert">{{ inspector.error.value }}</p>
                        <div class="detail-actions">
                            <template v-if="!selectedLine.value.fixed">
                                <Button size="sm" variant="secondary" icon-class="i-lucide-list-checks" :disabled="busy" @click="startEdit(selectedLine)">编辑节点</Button>
                                <Button v-if="selectedLine.value.type !== 'main' && currentMain" size="sm" variant="secondary" icon-class="i-lucide-crown" :disabled="busy"
                                    @click="pending = {kind: 'switch-main', record: selectedLine, previous: currentMain}">设为主线</Button>
                            </template>
                            <Button v-else size="sm" variant="secondary" icon-class="i-lucide-undo-2" :disabled="busy" @click="pending = {kind: 'reopen', record: selectedLine}">退回草稿</Button>
                            <Button size="sm" variant="danger" icon-class="i-lucide-trash-2" :disabled="busy" @click="previewDeleteLine(selectedLine)">删除线路</Button>
                        </div>
                        <OutlineLineAnalysisPanel :actions="actions" :revision="revision" :record="selectedLine" />
                    </section>
                    <EmptyState v-else-if="!graph?.nodes.length" icon-class="i-lucide-mouse-pointer-click" title="线路图还是空的" description="双击画布空白格新建节点，再为节点关联章节等大纲条目。" />
                    <p v-else class="detail-hint">点击画布中的节点或连线查看详情，或在上方选择一条线路。</p>
                </template>
            </aside>
        </div>
    </div>
</template>

<style scoped>
.line-panel { display: flex; min-height: 0; flex: 1; flex-direction: column; gap: var(--space-4); }
.line-bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-4); }
.bar-hint, .detail-hint { margin: 0; color: var(--text-muted); font-size: var(--text-2xs); }
.panel-error, .panel-notice { display: flex; align-items: center; gap: var(--space-3); border-radius: var(--radius-control); padding: var(--space-3) var(--space-5); font-size: var(--text-xs); }
.panel-error { border: 1px solid var(--status-danger-border); background: var(--status-danger-bg); color: var(--status-danger); }
.panel-notice { border: 1px solid var(--status-warning-border); background: var(--status-warning-bg); }
.panel-error button, .panel-notice button { margin-left: auto; border: 0; background: transparent; color: inherit; cursor: pointer; text-decoration: underline; }
.impact-panel { display: grid; gap: var(--space-3); border: 1px solid var(--status-warning-border); border-radius: var(--radius-control); background: var(--status-warning-bg); padding: var(--space-5); font-size: var(--text-xs); }
.impact-panel p { margin: 0; }
.impact-panel ul { display: grid; gap: var(--space-2); margin: 0; padding-left: var(--space-6); }
.impact-actions, .detail-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-3); }
.line-columns { display: grid; min-height: 0; flex: 1; grid-template-columns: minmax(0, 1fr) minmax(260px, 340px); gap: var(--space-5); }
.line-side { display: flex; min-width: 0; min-height: 0; flex-direction: column; gap: var(--space-5); overflow: auto; padding-right: var(--space-2); }
.line-side h3 { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-strong); }
.line-side h4 { margin: 0; font-size: var(--text-xs); font-weight: var(--weight-medium); }
.line-list { display: flex; flex-direction: column; gap: var(--space-2); }
.line-row { display: flex; align-items: center; gap: var(--space-3); border: 1px solid transparent; border-radius: var(--radius-control); background: transparent; color: var(--text-main); cursor: pointer; padding: var(--space-3) var(--space-4); text-align: left; font-size: var(--text-xs); }
.line-row:hover { background: color-mix(in srgb, var(--text-main) 8%, transparent); }
.line-row.is-selected { border-color: var(--accent-main); background: var(--accent-bg); color: var(--accent-text); }
.line-swatch { width: 10px; height: 10px; flex: 0 0 auto; border-radius: 50%; }
.row-title { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.line-form, .detail-section { display: grid; gap: var(--space-4); }
.detail-section { border-top: 1px solid var(--border-color); padding-top: var(--space-4); }
.detail-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); }
.detail-badges { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.pick-summary { display: grid; gap: var(--space-2); font-size: var(--text-xs); }
.pick-list { display: grid; gap: var(--space-1); margin: 0; padding-left: var(--space-6); font-size: var(--text-xs); }
.chain-problem { margin: 0; color: var(--status-warning); font-size: var(--text-xs); }
.chain-ok { margin: 0; color: var(--status-success); font-size: var(--text-xs); }
.form-error { margin: 0; color: var(--status-danger); font-size: var(--text-xs); }
</style>
