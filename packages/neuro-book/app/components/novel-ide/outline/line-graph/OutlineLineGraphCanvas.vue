<script setup lang="ts">
import {computed, ref, shallowRef, watch} from "vue";
import {Handle, Position, VueFlow, type Connection, type Edge, type Node, type NodeDragEvent, type ViewportTransform} from "@vue-flow/core";
import {Controls} from "@vue-flow/controls";
import type {OutlineWorkbenchGraph} from "nbook/app/composables/useOutlineWorkbenchData";
import {CELL_WIDTH, NODE_HEIGHT, NODE_WIDTH, ROW_HEIGHT, cellToPosition, columnCount, connectionProblem, nodeAt, pointToCell,
    positionToCell, type GraphCell} from "./outline-line-graph";

/** 画布只负责呈现与交互换算；节点文字、状态色与线路色标由线路面板按规范快照计算后传入。 */
export type GraphNodeDecor = Readonly<{
    title: string;
    tone: "none" | "warning" | "danger" | "muted";
    note?: string;
    colors: readonly string[];
    locked: boolean;
    ticked: boolean;
    dimmed: boolean;
}>;
export type GraphEdgeDecor = Readonly<{color: string | null; dimmed: boolean}>;

const props = defineProps<{
    graph: OutlineWorkbenchGraph | null;
    nodeDecor: ReadonlyMap<string, GraphNodeDecor>;
    edgeDecor: ReadonlyMap<string, GraphEdgeDecor>;
    selectedNodeId: string | null;
    selectedEdgeId: string | null;
    /** 勾选线路节点时禁止拖动与连线，点击节点只用于勾选。 */
    picking: boolean;
    disabled: boolean;
}>();

const emit = defineEmits<{
    "move-node": [nodeId: string, cell: GraphCell];
    connect: [from: string, to: string];
    "create-node": [cell: GraphCell];
    "node-click": [nodeId: string];
    "edge-click": [edgeId: string];
    "pane-click": [];
    reject: [message: string];
}>();

const viewport = ref<ViewportTransform>({x: 24, y: 16, zoom: 1});
// 节点数组总是整体替换；深层 ref 会展开 vue-flow 的 Node 泛型导致类型实例化过深。
const flowNodes = shallowRef<Node[]>([]);
const flowEdges = computed<Edge[]>(() => (props.graph?.edges ?? []).map((edge) => {
    const decor = props.edgeDecor.get(edge.id);
    const selected = edge.id === props.selectedEdgeId;
    return {id: edge.id, source: edge.from, target: edge.to, type: "default", selectable: false,
        class: {"is-dimmed": decor?.dimmed ?? false, "is-selected": selected},
        style: {stroke: selected ? "var(--accent-main)" : decor?.color ?? "var(--text-muted)", strokeWidth: selected || decor?.color ? 2.5 : 1.5}};
}));

function buildNodes(): Node[] {
    const editable = !props.disabled && !props.picking;
    return (props.graph?.nodes ?? []).map((node) => ({id: node.id, type: "outline", position: cellToPosition(node),
        draggable: editable, connectable: editable, selectable: false,
        width: NODE_WIDTH, height: NODE_HEIGHT, data: {column: node.column}}));
}
// 每次拖放结束都重建节点数组：被拒绝的拖动回到原单元格，被接受的等待刷新后的规范快照。
function reset(): void {
    flowNodes.value = buildNodes();
}
watch(() => [props.graph, props.picking, props.disabled] as const, reset, {immediate: true});
defineExpose({reset});

function onDragStop({node}: NodeDragEvent): void {
    const source = props.graph?.nodes.find(({id}) => id === node.id);
    const cell = positionToCell(node.position);
    if (source && (cell.column !== source.column || cell.row !== source.row)) {
        const occupant = nodeAt(props.graph, cell);
        if (occupant && occupant.id !== source.id) emit("reject", "该单元格已有节点");
        else if (cell.column !== source.column && props.nodeDecor.get(source.id)?.locked) {
            emit("reject", "节点属于已固定的线路，改变格号前请先将线路退回草稿；上下换行不受限制");
        } else {
            emit("move-node", source.id, cell);
            flowNodes.value = flowNodes.value.map((item) => item.id === source.id ? {...item, position: cellToPosition(cell)} : item);
            return;
        }
    }
    reset();
}

function isValidConnection(connection: Connection): boolean {
    return connectionProblem(props.graph, connection.source, connection.target) === null;
}
function onConnect(connection: Connection): void {
    const problem = connectionProblem(props.graph, connection.source, connection.target);
    if (problem) emit("reject", problem);
    else emit("connect", connection.source, connection.target);
}

const flowElement = ref<HTMLElement | null>(null);
/** vue-flow 没有画布双击事件；在容器上换算屏幕坐标到画布坐标，只响应空白处。 */
function onDoubleClick(event: MouseEvent): void {
    if (props.disabled || props.picking || !flowElement.value) return;
    const target = event.target as HTMLElement | null;
    if (!target?.closest(".vue-flow__pane") || target.closest(".vue-flow__node, .vue-flow__edge, .vue-flow__controls")) return;
    const rect = flowElement.value.getBoundingClientRect();
    const {x, y, zoom} = viewport.value;
    const cell = pointToCell({x: (event.clientX - rect.left - x) / zoom, y: (event.clientY - rect.top - y) / zoom});
    if (nodeAt(props.graph, cell)) return;
    emit("create-node", cell);
}

const cellWidth = computed(() => CELL_WIDTH * viewport.value.zoom);
const rulerColumns = computed(() => {
    const first = Math.max(0, Math.floor(-viewport.value.x / cellWidth.value));
    const count = Math.max(columnCount(props.graph), first + 40);
    return Array.from({length: count - first}, (_, index) => first + index);
});
const gridStyle = computed(() => {
    const {x, y, zoom} = viewport.value;
    return {backgroundSize: `${CELL_WIDTH * zoom}px ${ROW_HEIGHT * zoom}px`, backgroundPosition: `${x}px ${y}px`};
});
</script>

<template>
    <div class="graph-canvas">
        <div class="graph-ruler" aria-hidden="true">
            <span v-for="column in rulerColumns" :key="column" class="ruler-cell"
                :style="{left: `${viewport.x + column * cellWidth}px`, width: `${cellWidth}px`}">{{ column }}</span>
        </div>
        <div ref="flowElement" class="graph-flow" :style="gridStyle" @dblclick="onDoubleClick">
            <VueFlow :nodes="flowNodes" :edges="flowEdges" :default-viewport="viewport" :min-zoom="0.3" :max-zoom="1.6"
                :zoom-on-double-click="false" :delete-key-code="null" :nodes-connectable="!props.disabled && !props.picking"
                :is-valid-connection="isValidConnection" :elevate-edges-on-select="false"
                @viewport-change="viewport = $event" @node-drag-stop="onDragStop" @connect="onConnect"
                @node-click="emit('node-click', $event.node.id)" @edge-click="emit('edge-click', $event.edge.id)" @pane-click="emit('pane-click')">
                <template #node-outline="{id}">
                    <div class="graph-node" :data-tone="props.nodeDecor.get(id)?.tone ?? 'none'"
                        :class="{'is-selected': id === props.selectedNodeId, 'is-ticked': props.nodeDecor.get(id)?.ticked,
                            'is-dimmed': props.nodeDecor.get(id)?.dimmed, 'is-picking': props.picking}">
                        <Handle type="target" :position="Position.Left" />
                        <span class="node-stripes">
                            <span v-for="(color, index) in props.nodeDecor.get(id)?.colors ?? []" :key="index" :style="{background: color}"></span>
                        </span>
                        <span class="node-title">{{ props.nodeDecor.get(id)?.title ?? '' }}</span>
                        <span v-if="props.nodeDecor.get(id)?.note" class="node-note">{{ props.nodeDecor.get(id)!.note }}</span>
                        <span v-if="props.nodeDecor.get(id)?.locked" class="i-lucide-lock node-lock" title="属于已固定的线路"></span>
                        <span v-if="props.picking" class="node-check" :class="props.nodeDecor.get(id)?.ticked ? 'i-lucide-check-square' : 'i-lucide-square'"></span>
                        <Handle type="source" :position="Position.Right" />
                    </div>
                </template>
                <Controls :show-interactive="false" />
            </VueFlow>
        </div>
    </div>
</template>

<style scoped>
.graph-canvas { display: flex; min-height: 0; flex: 1; flex-direction: column; overflow: hidden; border: 1px solid var(--border-color); border-radius: var(--radius-control); background: var(--bg-subtle); }
.graph-ruler { position: relative; height: 24px; flex: 0 0 auto; overflow: hidden; border-bottom: 1px solid var(--border-color); background: var(--bg-panel); }
.ruler-cell { position: absolute; top: 0; display: flex; height: 100%; align-items: center; justify-content: center; border-left: 1px solid var(--border-color); color: var(--text-muted); font-size: var(--text-2xs); font-variant-numeric: tabular-nums; }
.graph-flow { position: relative; min-height: 320px; flex: 1;
    background-image: linear-gradient(to right, color-mix(in srgb, var(--text-main) 12%, transparent) 1px, transparent 1px),
        linear-gradient(to bottom, color-mix(in srgb, var(--text-main) 5%, transparent) 1px, transparent 1px); }
.graph-flow :deep(.vue-flow__node-outline) { padding: 0; border: 0; background: transparent; }
.graph-flow :deep(.vue-flow__edge.is-dimmed) { opacity: 0.25; }
.graph-node { position: relative; display: grid; width: 176px; height: 72px; box-sizing: border-box; align-content: center; gap: 2px; overflow: hidden;
    border: 1px solid var(--border-color); border-radius: var(--radius-control); background: var(--bg-main); color: var(--text-main);
    padding: 6px 10px 6px 14px; font-size: var(--text-xs); }
.graph-node[data-tone="warning"] { border-color: var(--status-warning-border); background: var(--status-warning-bg); }
.graph-node[data-tone="danger"] { border-color: var(--status-danger-border); background: var(--status-danger-bg); }
.graph-node[data-tone="muted"] { border-style: dashed; color: var(--text-muted); }
.graph-node.is-selected { box-shadow: 0 0 0 2px var(--accent-main); }
.graph-node.is-ticked { box-shadow: 0 0 0 2px var(--accent-main); background: var(--accent-bg); }
.graph-node.is-dimmed { opacity: 0.35; }
.graph-node.is-picking { cursor: pointer; }
.node-stripes { position: absolute; top: 0; bottom: 0; left: 0; display: flex; width: 6px; flex-direction: column; }
.node-stripes > span { flex: 1; }
.node-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: var(--weight-medium); }
.node-note { overflow: hidden; color: var(--text-muted); font-size: var(--text-2xs); text-overflow: ellipsis; white-space: nowrap; }
.node-lock { position: absolute; top: 6px; right: 8px; color: var(--text-muted); font-size: 12px; }
.node-check { position: absolute; right: 8px; bottom: 6px; color: var(--accent-main); }
</style>
