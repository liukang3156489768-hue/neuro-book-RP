import type {OutlineWorkbenchGraph, OutlineWorkbenchGraphEdge, OutlineWorkbenchGraphNode, OutlineWorkbenchLine}
    from "nbook/app/composables/useOutlineWorkbenchData";

/** 一格的宽度与一行的高度（画布坐标）；节点卡片在单元格内居中。 */
export const CELL_WIDTH = 220;
export const ROW_HEIGHT = 110;
export const NODE_WIDTH = 176;
export const NODE_HEIGHT = 72;
const OFFSET_X = (CELL_WIDTH - NODE_WIDTH) / 2;
const OFFSET_Y = (ROW_HEIGHT - NODE_HEIGHT) / 2;

export type GraphCell = Readonly<{column: number; row: number}>;

export function cellToPosition({column, row}: GraphCell): Readonly<{x: number; y: number}> {
    return {x: column * CELL_WIDTH + OFFSET_X, y: row * ROW_HEIGHT + OFFSET_Y};
}

/** 节点左上角坐标换算为最近的单元格；负坐标吸附到 0 格 0 行。 */
export function positionToCell({x, y}: Readonly<{x: number; y: number}>): GraphCell {
    return {column: Math.max(0, Math.round((x - OFFSET_X) / CELL_WIDTH)), row: Math.max(0, Math.round((y - OFFSET_Y) / ROW_HEIGHT))};
}

/** 画布中任意一点所在的单元格，用于双击空白处新建节点。 */
export function pointToCell({x, y}: Readonly<{x: number; y: number}>): GraphCell {
    return {column: Math.max(0, Math.floor(x / CELL_WIDTH)), row: Math.max(0, Math.floor(y / ROW_HEIGHT))};
}

export function nodeAt(graph: OutlineWorkbenchGraph | null, cell: GraphCell): OutlineWorkbenchGraphNode | undefined {
    return graph?.nodes.find(({column, row}) => column === cell.column && row === cell.row);
}

/** 与服务端连线规则一致的前端预检；返回 null 表示可以提交。 */
export function connectionProblem(graph: OutlineWorkbenchGraph | null, from: string, to: string): string | null {
    const byId = new Map((graph?.nodes ?? []).map((node) => [node.id, node]));
    const source = byId.get(from);
    const target = byId.get(to);
    if (!source || !target) return "节点不存在";
    if (from === to) return "不能连接节点自身";
    if (source.column >= target.column) return "连线只能从小格号指向大格号，同一格的节点不能相连";
    if (graph!.edges.some((edge) => edge.from === from && edge.to === to)) return "这两个节点之间已存在连线";
    return null;
}

export type LineChainProblem = "TOO_SHORT" | "UNKNOWN_NODE" | "SAME_COLUMN" | "MISSING_EDGE";

/** 与服务端 resolveLineChain 相同：按格号排序后格号严格递增、相邻节点有连线、至少 2 个节点。 */
export function resolveLineChain(graph: OutlineWorkbenchGraph | null, nodeIds: readonly string[]): Readonly<{
    nodes: readonly OutlineWorkbenchGraphNode[];
    edges: readonly OutlineWorkbenchGraphEdge[];
    problem: LineChainProblem | null;
}> {
    const byId = new Map((graph?.nodes ?? []).map((node) => [node.id, node]));
    const nodes = nodeIds.flatMap((id) => byId.get(id) ?? []).sort((a, b) => a.column - b.column || a.row - b.row);
    const edges: OutlineWorkbenchGraphEdge[] = [];
    let problem: LineChainProblem | null = nodes.length !== nodeIds.length ? "UNKNOWN_NODE" : nodes.length < 2 ? "TOO_SHORT" : null;
    for (let index = 1; index < nodes.length; index += 1) {
        const from = nodes[index - 1]!;
        const to = nodes[index]!;
        if (from.column === to.column) {
            problem ??= "SAME_COLUMN";
            continue;
        }
        const edge = graph?.edges.find((item) => item.from === from.id && item.to === to.id);
        if (edge) edges.push(edge);
        else problem ??= "MISSING_EDGE";
    }
    return {nodes, edges, problem};
}

export const chainProblemLabels: Record<LineChainProblem, string> = {
    TOO_SHORT: "线路至少需要 2 个节点",
    UNKNOWN_NODE: "线路包含已删除的节点",
    SAME_COLUMN: "同一格只能选一个节点",
    MISSING_EDGE: "相邻节点之间缺少连线",
};

/** 固定线路锁定自己节点的格号与关联条目，以及线路内相邻节点之间的连线。 */
export function lockedGraphParts(graph: OutlineWorkbenchGraph | null, lines: readonly OutlineWorkbenchLine[]): Readonly<{
    nodeIds: ReadonlySet<string>;
    edgeIds: ReadonlySet<string>;
}> {
    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();
    for (const line of lines) {
        if (!line.fixed) continue;
        const chain = resolveLineChain(graph, line.nodeIds);
        for (const node of chain.nodes) nodeIds.add(node.id);
        for (const edge of chain.edges) edgeIds.add(edge.id);
    }
    return {nodeIds, edgeIds};
}

const LINE_COLORS = ["#2563eb", "#16a34a", "#d97706", "#db2777", "#7c3aed", "#0891b2", "#dc2626", "#65a30d"];

/** 主线固定用第一种颜色，其余线路按列表顺序循环取色，让同一线路在画布与列表中颜色一致。 */
export function lineColors(lines: readonly OutlineWorkbenchLine[]): ReadonlyMap<string, string> {
    const ordered = [...lines].sort((a, b) => Number(b.type === "main") - Number(a.type === "main"));
    return new Map(ordered.map((line, index) => [line.id, LINE_COLORS[index % LINE_COLORS.length]!]));
}

/** 画布右侧至少多留一格空列，方便向后延伸。 */
export function columnCount(graph: OutlineWorkbenchGraph | null): number {
    return Math.max(0, ...(graph?.nodes ?? []).map(({column}) => column)) + 2;
}
