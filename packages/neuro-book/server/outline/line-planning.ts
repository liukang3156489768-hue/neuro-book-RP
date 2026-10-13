import {
    contentHash, createStableId, parseGraphYaml, parseLineYaml, resolveLineChain, serializeGraphYaml, serializeLineYaml,
    serializeManifest, stableFileName, validatePlanningGraphs,
    type OutlineGraph, type OutlineGraphEdge, type OutlineGraphNode, type OutlineId, type OutlineLine, type OutlineLineType,
    type OutlineManifest,
} from "./format";
import type {PlanningPublishInput, PlanningSnapshot} from "./index";
import type {OutlineFileMutation} from "./transaction";

export class OutlineLineError extends Error {
    constructor(message: string, readonly code: "INVALID_ACTION" | "CAS_CONFLICT" = "INVALID_ACTION") {
        super(message);
        this.name = "OutlineLineError";
    }
}

/** 图操作以线路图 version 做 CAS；方案尚无线路图时 version 视为 0，首次写入创建 version 1。 */
type GraphCas = Readonly<{planId: string; expectedGraphVersion: number}>;
type LineCas = Readonly<{lineId: OutlineId; expectedVersion: number; expectedContentHash: string}>;

export type LineAction =
    | (GraphCas & Readonly<{kind: "add-graph-node"; column: number; row: number; entryId?: OutlineId | null}>)
    | (GraphCas & Readonly<{kind: "move-graph-node"; nodeId: OutlineId; column: number; row: number}>)
    | (GraphCas & Readonly<{kind: "insert-graph-column"; column: number}>)
    | (GraphCas & Readonly<{kind: "relink-graph-node"; nodeId: OutlineId; entryId: OutlineId | null}>)
    | (GraphCas & Readonly<{kind: "connect-graph-nodes"; from: OutlineId; to: OutlineId}>)
    | (GraphCas & Readonly<{kind: "remove-graph-edge"; edgeId: OutlineId; expectedImpactHash: string; confirmDeletion: true}>)
    | (GraphCas & Readonly<{kind: "remove-graph-node"; nodeId: OutlineId; expectedImpactHash: string; confirmDeletion: true}>)
    | Readonly<{kind: "create-line"; planId: string; title: string; type: OutlineLineType; nodeIds: readonly OutlineId[]}>
    | (LineCas & Readonly<{kind: "edit-draft-line"; title: string; type: OutlineLineType; nodeIds: readonly OutlineId[]}>)
    | (LineCas & Readonly<{kind: "reopen-fixed-line"; confirmReopen: true}>)
    | (LineCas & Readonly<{kind: "switch-main-line"; previousLineId: OutlineId; previousVersion: number;
        previousContentHash: string; confirmSwitch: true}>);

export type LineChange = Readonly<{
    planId: string;
    lineId?: OutlineId;
    graphId?: OutlineId;
    nodeId?: OutlineId;
    edgeId?: OutlineId;
    publish: PlanningPublishInput;
}>;

export type GraphDeletionTarget = Readonly<{planId: string; kind: "node" | "edge"; targetId: OutlineId}>;
export type GraphDeletionImpact = Readonly<{
    planId: string;
    kind: "node" | "edge";
    targetId: OutlineId;
    entryId?: OutlineId | null;
    removedEdges: readonly OutlineGraphEdge[];
    /** 删除节点时会从这些草稿线路中移除该节点。 */
    affectedLineIds: readonly OutlineId[];
    expectedRevision: number;
    expectedGraphVersion: number;
    impactHash: string;
}>;

type SnapshotGraph = PlanningSnapshot["graphs"][number];
type SnapshotLine = PlanningSnapshot["lines"][number];

export function findPlanGraph(snapshot: PlanningSnapshot, planId: string): SnapshotGraph | undefined {
    return snapshot.graphs.find(({value}) => value.planId === planId);
}

/** 线路本身只存节点 id；条目归属经方案线路图解析，空节点与图中缺失的节点不计入。 */
export function lineEntryIds(snapshot: PlanningSnapshot, line: OutlineLine): readonly OutlineId[] {
    const nodes = new Map(findPlanGraph(snapshot, line.planId)?.value.nodes.map((node) => [node.id, node]) ?? []);
    return line.nodeIds.flatMap((id) => {
        const entryId = nodes.get(id)?.entryId;
        return entryId ? [entryId] : [];
    });
}

/**
 * 固定线路锁定的是它自己的结构：节点格号、节点条目和线路内相邻连线。
 * 锁定节点仍可改行号、连向新节点，这样可以从固定主线继续分出支线。
 */
export function fixedLineLocks(snapshot: PlanningSnapshot, planId: string): Readonly<{
    nodes: ReadonlyMap<OutlineId, readonly OutlineId[]>; edges: ReadonlyMap<OutlineId, readonly OutlineId[]>;
}> {
    const graph = findPlanGraph(snapshot, planId)?.value;
    const nodes = new Map<OutlineId, OutlineId[]>();
    const edges = new Map<OutlineId, OutlineId[]>();
    for (const {value: line} of snapshot.lines) {
        if (line.planId !== planId || !line.fixed) continue;
        for (const nodeId of line.nodeIds) nodes.set(nodeId, [...(nodes.get(nodeId) ?? []), line.id]);
        for (const edge of resolveLineChain(graph, line.nodeIds).edges) edges.set(edge.id, [...(edges.get(edge.id) ?? []), line.id]);
    }
    return {nodes, edges};
}

/** 预览删除范围；确认提交时重新计算同一影响集合并比较 impactHash。 */
export function previewGraphDeletion(snapshot: PlanningSnapshot, target: GraphDeletionTarget): GraphDeletionImpact {
    const graph = findPlanGraph(snapshot, target.planId)?.value;
    if (!graph) throw new OutlineLineError("方案尚无线路图");
    const locks = fixedLineLocks(snapshot, target.planId);
    const node = target.kind === "node" ? graph.nodes.find(({id}) => id === target.targetId) : undefined;
    const edge = target.kind === "edge" ? graph.edges.find(({id}) => id === target.targetId) : undefined;
    if (!node && !edge) throw new OutlineLineError("待删除的节点或连线不存在");
    if (node && locks.nodes.has(node.id)) throw new OutlineLineError("节点属于固定线路，请先重开线路");
    if (edge && locks.edges.has(edge.id)) throw new OutlineLineError("连线是固定线路的相邻连线，请先重开线路");
    const removedEdges = node ? graph.edges.filter(({from, to}) => from === node.id || to === node.id) : [edge!];
    const affectedLineIds = node ? snapshot.lines
        .filter(({value}) => value.planId === target.planId && value.nodeIds.includes(node.id)).map(({value}) => value.id) : [];
    const base = {planId: target.planId, kind: target.kind, targetId: target.targetId,
        ...(node ? {entryId: node.entryId} : {}), removedEdges, affectedLineIds,
        expectedRevision: snapshot.manifest.revision, expectedGraphVersion: graph.version};
    return {...base, impactHash: contentHash(JSON.stringify(base))};
}

export function prepareLineAction(snapshot: PlanningSnapshot, action: LineAction, creationSeed?: string): LineChange {
    switch (action.kind) {
        case "create-line": return createLine(snapshot, action, creationSeed);
        case "edit-draft-line": return editDraftLine(snapshot, action);
        case "reopen-fixed-line": return reopenFixedLine(snapshot, action);
        case "switch-main-line": return switchMainLine(snapshot, action);
        default: return applyGraphAction(snapshot, action, creationSeed);
    }
}

function applyGraphAction(snapshot: PlanningSnapshot, action: Extract<LineAction, GraphCas>, creationSeed?: string): LineChange {
    const plan = requirePlan(snapshot, action.planId);
    const source = findPlanGraph(snapshot, plan.id);
    if ((source?.value.version ?? 0) !== action.expectedGraphVersion) {
        throw new OutlineLineError("线路图版本已变化，请重新读取", "CAS_CONFLICT");
    }
    const graph: OutlineGraph = source?.value ?? {schema: "nbook.outline-graph/v1", id: createStableId("gr", creationSeed),
        planId: plan.id, version: 0, nodes: [], edges: []};
    const locks = fixedLineLocks(snapshot, plan.id);
    const nodeOf = (id: OutlineId): OutlineGraphNode => {
        const node = graph.nodes.find((item) => item.id === id);
        if (!node) throw new OutlineLineError("线路图节点不存在");
        return node;
    };
    let nodes = graph.nodes;
    let edges = graph.edges;
    let lineWrites: LineWrite[] = [];
    let nodeId: OutlineId | undefined;
    let edgeId: OutlineId | undefined;
    if (action.kind === "add-graph-node") {
        assertCell(action.column, action.row);
        assertCellFree(graph, action.column, action.row);
        const entryId = action.entryId ?? null;
        if (entryId !== null) assertNodeEntry(snapshot, graph, entryId);
        nodeId = createStableId("nd", creationSeed);
        nodes = [...nodes, {id: nodeId, entryId, column: action.column, row: action.row}];
    } else if (action.kind === "move-graph-node") {
        const node = nodeOf(action.nodeId);
        assertCell(action.column, action.row);
        if (node.column === action.column && node.row === action.row) throw new OutlineLineError("节点位置未变化");
        assertCellFree(graph, action.column, action.row, node.id);
        if (node.column !== action.column) {
            if (locks.nodes.has(node.id)) throw new OutlineLineError("节点属于固定线路，改变格号前请先重开线路");
            const byId = new Map(graph.nodes.map((item) => [item.id, item]));
            for (const edge of graph.edges) {
                const from = edge.from === node.id ? action.column : byId.get(edge.from)!.column;
                const to = edge.to === node.id ? action.column : byId.get(edge.to)!.column;
                if (from >= to) throw new OutlineLineError("移动后会出现向左或同格的连线，请先删除相关连线");
            }
        }
        nodeId = node.id;
        nodes = nodes.map((item) => item.id === node.id ? {...item, column: action.column, row: action.row} : item);
    } else if (action.kind === "insert-graph-column") {
        if (!Number.isInteger(action.column) || action.column < 0) throw new OutlineLineError("格号必须是非负整数");
        // 整体右移不改变任何相对顺序，固定线路的结构 hash 不含绝对格号，因此不受锁定限制。
        if (!nodes.some(({column}) => column >= action.column)) throw new OutlineLineError("该格及右侧没有需要右移的节点");
        nodes = nodes.map((item) => item.column >= action.column ? {...item, column: item.column + 1} : item);
    } else if (action.kind === "relink-graph-node") {
        const node = nodeOf(action.nodeId);
        if (node.entryId === action.entryId) throw new OutlineLineError("节点已关联此条目");
        if (locks.nodes.has(node.id)) throw new OutlineLineError("节点属于固定线路，修改关联条目前请先重开线路");
        if (action.entryId !== null) assertNodeEntry(snapshot, graph, action.entryId);
        nodeId = node.id;
        nodes = nodes.map((item) => item.id === node.id ? {...item, entryId: action.entryId} : item);
    } else if (action.kind === "connect-graph-nodes") {
        const from = nodeOf(action.from);
        const to = nodeOf(action.to);
        if (from.column >= to.column) throw new OutlineLineError("连线只能从小格号节点指向大格号节点");
        if (edges.some((edge) => edge.from === from.id && edge.to === to.id)) throw new OutlineLineError("节点间已存在此连线");
        edgeId = createStableId("eg", creationSeed);
        edges = [...edges, {id: edgeId, from: from.id, to: to.id}];
    } else {
        const kind = action.kind === "remove-graph-node" ? "node" : "edge";
        const targetId = action.kind === "remove-graph-node" ? action.nodeId : action.edgeId;
        if (action.confirmDeletion !== true) throw new OutlineLineError("删除节点或连线需要明确确认");
        const impact = previewGraphDeletion(snapshot, {planId: plan.id, kind, targetId});
        if (impact.impactHash !== action.expectedImpactHash) throw new OutlineLineError("删除影响已变化，请重新预览", "CAS_CONFLICT");
        const removed = new Set(impact.removedEdges.map(({id}) => id));
        edges = edges.filter(({id}) => !removed.has(id));
        if (kind === "node") {
            nodes = nodes.filter(({id}) => id !== targetId);
            lineWrites = snapshot.lines.filter(({value}) => impact.affectedLineIds.includes(value.id)).map((line) =>
                ({source: line, value: draftOf(line.value, {nodeIds: line.value.nodeIds.filter((id) => id !== targetId)})}));
        }
    }
    const next: OutlineGraph = {...graph, version: graph.version + 1, nodes, edges};
    const publish = buildPlanningWrite(snapshot, {graphs: [{source, value: next}], lines: lineWrites});
    return {planId: plan.id, graphId: next.id, ...(nodeId ? {nodeId} : {}), ...(edgeId ? {edgeId} : {}), publish};
}

function createLine(snapshot: PlanningSnapshot, action: Extract<LineAction, {kind: "create-line"}>, creationSeed?: string): LineChange {
    const plan = requirePlan(snapshot, action.planId);
    const title = requiredTitle(action.title);
    assertLineMembers(snapshot, plan.id, undefined, action.type, action.nodeIds);
    const id = createStableId("ln", creationSeed);
    const line: OutlineLine = {schema: "nbook.outline-line/v3", id, planId: plan.id, version: 0, title,
        type: action.type, fixed: false, nodeIds: [...action.nodeIds]};
    return {planId: plan.id, lineId: id, publish: buildPlanningWrite(snapshot, {lines: [{value: line}]})};
}

function editDraftLine(snapshot: PlanningSnapshot, action: Extract<LineAction, {kind: "edit-draft-line"}>): LineChange {
    const source = requireLine(snapshot, action);
    if (source.value.fixed) throw new OutlineLineError("固定线路不能直接编辑，请先重开");
    const title = requiredTitle(action.title);
    if (title === source.value.title && action.type === source.value.type
        && JSON.stringify(action.nodeIds) === JSON.stringify(source.value.nodeIds)) {
        throw new OutlineLineError("线路内容未变化");
    }
    assertLineMembers(snapshot, source.value.planId, source.value.id, action.type, action.nodeIds);
    const next = draftOf(source.value, {title, type: action.type, nodeIds: [...action.nodeIds]});
    return {planId: next.planId, lineId: next.id, publish: buildPlanningWrite(snapshot, {lines: [{source, value: next}]})};
}

function reopenFixedLine(snapshot: PlanningSnapshot, action: Extract<LineAction, {kind: "reopen-fixed-line"}>): LineChange {
    const source = requireLine(snapshot, action);
    if (!source.value.fixed || action.confirmReopen !== true) {
        throw new OutlineLineError("退回已固定线路需要明确确认，草稿不可重复退回");
    }
    const next = draftOf(source.value, {});
    return {planId: next.planId, lineId: next.id, publish: buildPlanningWrite(snapshot, {lines: [{source, value: next}]})};
}

function switchMainLine(snapshot: PlanningSnapshot, action: Extract<LineAction, {kind: "switch-main-line"}>): LineChange {
    const target = requireLine(snapshot, action);
    if (target.value.fixed) throw new OutlineLineError("目标线路须为草稿；类型变化会使固定分析失效");
    const previous = snapshot.lines.find(({value}) => value.id === action.previousLineId);
    if (!previous || previous.value.planId !== target.value.planId || previous.value.type !== "main"
        || target.value.type === "main") {
        throw new OutlineLineError("主线切换必须指定同方案的当前主线和另一条草稿线路");
    }
    if (action.confirmSwitch !== true) throw new OutlineLineError("主线切换及旧固定资格撤回需要明确确认");
    if (previous.value.version !== action.previousVersion || previous.contentHash !== action.previousContentHash) {
        throw new OutlineLineError("线路版本已变化，请重新读取", "CAS_CONFLICT");
    }
    // 类型进入分析 sourceHash；旧主线降为支线后原报告不再对应当前结构，必须回到草稿。
    const demoted = draftOf(previous.value, {type: "branch"});
    const promoted = draftOf(target.value, {type: "main"});
    return {planId: promoted.planId, lineId: promoted.id, publish: buildPlanningWrite(snapshot, {lines: [
        {source: previous, value: demoted}, {source: target, value: promoted},
    ]})};
}

export type GraphWrite = Readonly<{source?: SnapshotGraph; value: OutlineGraph}>;
export type LineWrite = Readonly<{source?: SnapshotLine; value: OutlineLine}>;

/**
 * 统一生成线路图与线路的发布批次：逐文件重解析，再对整套候选执行跨文件不变量。
 * removed 中的文件随 manifest 引用一起删除；manifest 可由调用方先行改写（例如移除条目或方案）。
 */
export function buildPlanningWrite(snapshot: PlanningSnapshot, writes: Readonly<{
    graphs?: readonly GraphWrite[]; lines?: readonly LineWrite[];
    removed?: readonly Readonly<{path: string; contentHash: string; id: OutlineId}>[];
    manifest?: OutlineManifest;
}>): PlanningPublishInput {
    const manifest = writes.manifest ?? snapshot.manifest;
    const mutations: OutlineFileMutation[] = [];
    const graphRefs = new Map(manifest.graphs.map((ref) => [ref.id, ref]));
    const lineRefs = new Map(manifest.lines.map((ref) => [ref.id, ref]));
    const graphs = new Map(snapshot.graphs.map(({value}) => [value.id, value]));
    const lines = new Map(snapshot.lines.map(({value}) => [value.id, value]));
    for (const write of writes.graphs ?? []) {
        const planTitle = manifest.plans.find(({id}) => id === write.value.planId)?.title ?? write.value.planId;
        const path = write.source?.path ?? `outline/graphs/${stableFileName(planTitle, write.value.id, "yaml")}`;
        const content = serializeGraphYaml(write.value);
        graphs.set(write.value.id, parseGraphYaml(content, path));
        mutations.push({relativePath: path, content, expectedHash: write.source?.contentHash ?? null});
        graphRefs.set(write.value.id, {id: write.value.id, path, version: write.value.version, contentHash: contentHash(content)});
    }
    for (const write of writes.lines ?? []) {
        const path = write.source?.path ?? `outline/storylines/${stableFileName(write.value.title, write.value.id, "yaml")}`;
        const content = serializeLineYaml(write.value);
        lines.set(write.value.id, parseLineYaml(content, path));
        mutations.push({relativePath: path, content, expectedHash: write.source?.contentHash ?? null});
        lineRefs.set(write.value.id, {id: write.value.id, path, version: write.value.version, contentHash: contentHash(content)});
    }
    for (const removed of writes.removed ?? []) {
        graphs.delete(removed.id);
        lines.delete(removed.id);
        graphRefs.delete(removed.id);
        lineRefs.delete(removed.id);
        mutations.push({relativePath: removed.path, content: null, expectedHash: removed.contentHash});
    }
    validatePlanningGraphs([...graphs.values()], [...lines.values()], manifest.plans,
        new Map(snapshot.entries.map(({value}) => [value.id, value.kind])));
    mutations.push({relativePath: "outline/manifest.yaml", content: serializeManifest({...manifest,
        revision: snapshot.manifest.revision + 1, graphs: [...graphRefs.values()], lines: [...lineRefs.values()]})});
    return {expectedManifestRevision: snapshot.manifest.revision, mutations};
}

/** 任何线路编辑都回到草稿并丢弃分析：报告只对应固定时的结构与条目。 */
export function draftOf(line: OutlineLine, patch: Partial<Pick<OutlineLine, "title" | "type" | "nodeIds">>): OutlineLine {
    const {analysis: _analysis, ...rest} = line;
    return {...rest, ...patch, fixed: false, version: line.version + 1};
}

function requirePlan(snapshot: PlanningSnapshot, planId: string): OutlineManifest["plans"][number] {
    const plan = snapshot.manifest.plans.find(({id}) => id === planId);
    if (!plan) throw new OutlineLineError("所属方案不存在");
    return plan;
}

function requireLine(snapshot: PlanningSnapshot, cas: LineCas): SnapshotLine {
    const source = snapshot.lines.find(({value}) => value.id === cas.lineId);
    if (!source) throw new OutlineLineError("线路不存在");
    if (source.value.version !== cas.expectedVersion || source.contentHash !== cas.expectedContentHash) {
        throw new OutlineLineError("线路版本已变化，请重新读取", "CAS_CONFLICT");
    }
    return source;
}

function assertLineMembers(snapshot: PlanningSnapshot, planId: string, lineId: OutlineId | undefined,
    type: OutlineLineType, nodeIds: readonly OutlineId[]): void {
    if (new Set(nodeIds).size !== nodeIds.length) throw new OutlineLineError("线路中存在重复节点");
    const graph = findPlanGraph(snapshot, planId)?.value;
    if (nodeIds.some((id) => !graph?.nodes.some((node) => node.id === id))) throw new OutlineLineError("线路节点不在本方案线路图中");
    if (type === "main" && snapshot.lines.some(({value}) => value.planId === planId && value.type === "main" && value.id !== lineId)) {
        throw new OutlineLineError("本方案已有主线，请使用切换主线");
    }
}

function assertCell(column: number, row: number): void {
    if (!Number.isInteger(column) || column < 0 || !Number.isInteger(row) || row < 0) {
        throw new OutlineLineError("格号与行号必须是非负整数");
    }
}

function assertCellFree(graph: OutlineGraph, column: number, row: number, except?: OutlineId): void {
    if (graph.nodes.some((node) => node.id !== except && node.column === column && node.row === row)) {
        throw new OutlineLineError("该单元格已有节点");
    }
}

function assertNodeEntry(snapshot: PlanningSnapshot, graph: OutlineGraph, entryId: OutlineId): void {
    const plan = requirePlan(snapshot, graph.planId);
    const entry = snapshot.entries.find(({value}) => value.id === entryId)?.value;
    if (!plan.placements.some((placement) => placement.entryId === entryId) || !entry || entry.kind === "detail") {
        throw new OutlineLineError("大纲条目不存在、不在本方案中或不能独立成为线路节点");
    }
    if (graph.nodes.some((node) => node.entryId === entryId)) throw new OutlineLineError("线路图中已有节点关联此条目");
}

function requiredTitle(value: string): string {
    const title = value.trim();
    if (!title) throw new OutlineLineError("线路标题不能为空");
    return title;
}
