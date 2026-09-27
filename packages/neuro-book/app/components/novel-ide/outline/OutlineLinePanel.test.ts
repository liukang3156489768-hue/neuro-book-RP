// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {defineComponent, h} from "vue";
import {flushPromises, mount, type VueWrapper} from "@vue/test-utils";
import {FormInput, FormSelect} from "@notnotype/nb-ui/components";
import OutlineLinePanel from "./OutlineLinePanel.vue";
import type {OutlineWorkbenchEntry, OutlineWorkbenchGraph, OutlineWorkbenchLine, OutlineWorkbenchSnapshot} from "nbook/app/composables/useOutlineWorkbenchData";

const hash = (seed: string): string => `sha256:${seed.repeat(64).slice(0, 64)}`;
const entry = (id: string, kind: OutlineWorkbenchEntry["kind"], title: string): OutlineWorkbenchEntry => ({
    id, kind, version: 1, status: "adopted", title, parentId: null, chapterId: null, body: "",
});
const entries = [entry("ol-total", "total", "总纲"), entry("ol-vol", "volume", "第一卷"), entry("ol-ch1", "chapter", "雨夜来客"),
    entry("ol-ch2", "chapter", "旧宅"), entry("ol-ch3", "chapter", "对峙"), entry("ol-detail", "detail", "细纲")];
// 图示结构的缩小版：主线 0→2→4，支线从 0 分出到 2 格另一行，再汇回 4；角色线的节点引用了已删除的条目。
const graph: OutlineWorkbenchGraph = {id: "gr-a", planId: "plan-a", version: 7,
    nodes: [{id: "nd-a", entryId: "ol-ch1", column: 0, row: 0}, {id: "nd-b", entryId: "ol-ch2", column: 2, row: 0},
        {id: "nd-c", entryId: null, column: 2, row: 1}, {id: "nd-d", entryId: "ol-ch3", column: 4, row: 0},
        {id: "nd-e", entryId: "ol-gone", column: 6, row: 0}],
    edges: [{id: "eg-ab", from: "nd-a", to: "nd-b"}, {id: "eg-ac", from: "nd-a", to: "nd-c"}, {id: "eg-bd", from: "nd-b", to: "nd-d"},
        {id: "eg-cd", from: "nd-c", to: "nd-d"}, {id: "eg-de", from: "nd-d", to: "nd-e"}]};
const line = (id: string, title: string, type: OutlineWorkbenchLine["type"], fixed: boolean, nodeIds: string[]): OutlineWorkbenchLine =>
    ({schema: "nbook.outline-line/v3", id, planId: "plan-a", version: 2, title, type, fixed, nodeIds});
const lines: OutlineWorkbenchLine[] = [
    line("ln-main", "主线甲", "main", false, ["nd-a", "nd-b", "nd-d"]),
    line("ln-side", "支线乙", "branch", false, ["nd-a", "nd-c"]),
    {...line("ln-fixed", "角色线丙", "character", true, ["nd-d", "nd-e"]), analysis: {summary: "线路一致", conflicts: [], resolutions: []}},
];
const snapshot: OutlineWorkbenchSnapshot = {
    manifest: {revision: 5, totalId: "ol-total", plans: [{id: "plan-a", title: "方案甲", placements: entries.map(({id}, position) => ({entryId: id, parentId: null, position}))}]},
    entries: entries.map((value, index) => ({path: `outline/entries/${value.id}.md`, contentHash: hash(String(index)), value})),
    foreshadowing: [],
    graphs: [{path: "outline/graphs/fang-an-jia--gr-a.yaml", contentHash: hash("g"), value: graph}],
    lines: lines.map((value, index) => ({path: `outline/storylines/${value.id}.yaml`, contentHash: hash(String.fromCharCode(97 + index)), value})),
};

/** 画布依赖浏览器布局，测试只验证面板如何响应画布事件以及传给画布的装饰数据。 */
const reset = vi.fn();
const CanvasStub = defineComponent({
    name: "OutlineLineGraphCanvas",
    props: ["graph", "nodeDecor", "edgeDecor", "selectedNodeId", "selectedEdgeId", "picking", "disabled"],
    emits: ["move-node", "connect", "create-node", "node-click", "edge-click", "pane-click", "reject"],
    setup(_, {expose}) {
        expose({reset});
        return () => h("div", {class: "canvas-stub"});
    },
});

let responses: Record<string, unknown> = {};
const fetchMock = vi.fn((url: string, options: {body?: Record<string, unknown>}) => {
    const response = responses[url.split("/").pop()!];
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(typeof response === "function" ? response(options.body) : response ?? {transactionId: "tx"});
});
const mounted: VueWrapper[] = [];

beforeEach(() => {
    responses = {"inspect-line": (body: {lineId: string}) => {
        const current = lines.find(({id}) => id === body.lineId)!;
        return {lineId: current.id, chainProblem: null, nodes: current.nodeIds.map((nodeId) => {
            const node = graph.nodes.find(({id}) => id === nodeId)!;
            return {nodeId, entryId: node.entryId, column: node.column, status: node.entryId === "ol-gone" ? "red" : "yellow"};
        })};
    }};
    fetchMock.mockClear();
    reset.mockClear();
    vi.stubGlobal("$fetch", fetchMock);
});
afterEach(() => {
    mounted.splice(0).forEach((wrapper) => wrapper.unmount());
    vi.unstubAllGlobals();
});

/** 写入成功后面板等待 refresh；传入 next 模拟刷新得到的新规范快照。 */
function mountPanel(next?: OutlineWorkbenchSnapshot): VueWrapper {
    const wrapper: VueWrapper = mount(OutlineLinePanel, {
        props: {projectRoot: "project", snapshot, planId: "plan-a", refresh: vi.fn(async () => { if (next) await wrapper.setProps({snapshot: next}); })},
        global: {stubs: {OutlineLineGraphCanvas: CanvasStub}},
        attachTo: document.body,
    });
    mounted.push(wrapper);
    return wrapper;
}
const canvas = (wrapper: VueWrapper) => wrapper.findComponent(CanvasStub);
async function emitCanvas(wrapper: VueWrapper, event: string, ...args: unknown[]): Promise<void> {
    canvas(wrapper).vm.$emit(event, ...args);
    await flushPromises();
}
async function click(wrapper: VueWrapper, text: string): Promise<void> {
    const target = wrapper.findAll("button").find((button) => button.text().trim() === text);
    if (!target) throw new Error(`找不到按钮：${text}`);
    await target.trigger("click");
    await flushPromises();
}
async function selectLine(wrapper: VueWrapper, title: string): Promise<void> {
    await wrapper.findAll("button.line-row").find((row) => row.find(".row-title").text() === title)!.trigger("click");
    await flushPromises();
}
function lastBody(segment: string): Record<string, unknown> | undefined {
    return fetchMock.mock.calls.filter(([url]) => url === `/api/projects/outline/${segment}`).at(-1)?.[1].body;
}
const graphCas = {planId: "plan-a", expectedGraphVersion: 7};

describe("线路图编辑面板", () => {
    it("双击空白格新建节点并选中，拖动失败时画布回到原位", async () => {
        responses["line-action"] = {transactionId: "tx", nodeId: "nd-new"};
        const next = {...snapshot, graphs: [{...snapshot.graphs[0]!, value: {...graph, version: 8,
            nodes: [...graph.nodes, {id: "nd-new", entryId: null, column: 3, row: 2}]}}]};
        const wrapper = mountPanel(next);
        await emitCanvas(wrapper, "create-node", {column: 3, row: 2});
        expect(lastBody("line-action")).toEqual({expectedRevision: 5, action: {kind: "add-graph-node", ...graphCas, column: 3, row: 2}});
        expect(canvas(wrapper).props("selectedNodeId")).toBe("nd-new");

        responses["line-action"] = Object.assign(new Error("冲突"), {data: {message: "线路图已被修改"}});
        await emitCanvas(wrapper, "move-node", "nd-c", {column: 3, row: 1});
        expect(lastBody("line-action")).toEqual({expectedRevision: 5, action: {kind: "move-graph-node", planId: "plan-a", expectedGraphVersion: 8,
            nodeId: "nd-c", column: 3, row: 1}});
        expect(reset).toHaveBeenCalledOnce();
        expect(wrapper.find(".panel-error").exists()).toBe(true);
    });

    it("连线提交到服务端，画布拦截的连线只提示原因", async () => {
        const wrapper = mountPanel();
        await emitCanvas(wrapper, "connect", "nd-c", "nd-e");
        expect(lastBody("line-action")).toEqual({expectedRevision: 5, action: {kind: "connect-graph-nodes", ...graphCas, from: "nd-c", to: "nd-e"}});
        fetchMock.mockClear();
        await emitCanvas(wrapper, "reject", "连线只能从小格号指向大格号");
        expect(fetchMock).not.toHaveBeenCalled();
        expect(wrapper.find(".panel-notice").text()).toContain("连线只能从小格号指向大格号");
    });

    it("勾选节点组成线路：同格改选另一个节点，按格号排序后保存", async () => {
        responses["line-action"] = {transactionId: "tx", lineId: "ln-new"};
        const wrapper = mountPanel();
        await click(wrapper, "新建线路");
        expect(canvas(wrapper).props("picking")).toBe(true);
        // 已有主线，新线路默认为支线。
        expect(wrapper.findAllComponents(FormSelect).find((item) => item.vm.$attrs["aria-label"] === "线路类型")!.props("modelValue")).toBe("branch");
        await wrapper.findComponent(FormInput).vm.$emit("update:modelValue", "支线丁");
        await emitCanvas(wrapper, "node-click", "nd-d");
        expect(wrapper.find(".chain-problem").text()).toContain("线路至少需要 2 个节点");
        await emitCanvas(wrapper, "node-click", "nd-a");
        expect(wrapper.find(".chain-problem").text()).toContain("相邻节点之间缺少连线");
        await emitCanvas(wrapper, "node-click", "nd-b");
        expect(wrapper.find(".chain-ok").exists()).toBe(true);
        await emitCanvas(wrapper, "node-click", "nd-c");
        expect(canvas(wrapper).props("nodeDecor").get("nd-b").ticked).toBe(false);
        expect(canvas(wrapper).props("nodeDecor").get("nd-c").ticked).toBe(true);
        await wrapper.find("form").trigger("submit");
        await flushPromises();
        expect(lastBody("line-action")).toEqual({expectedRevision: 5, action: {kind: "create-line", planId: "plan-a", title: "支线丁",
            type: "branch", nodeIds: ["nd-a", "nd-c", "nd-d"]}});
        expect(canvas(wrapper).props("picking")).toBe(false);
    });

    it("草稿线路编辑节点时带上线路版本", async () => {
        const wrapper = mountPanel();
        await selectLine(wrapper, "支线乙");
        await click(wrapper, "编辑节点");
        await emitCanvas(wrapper, "node-click", "nd-d");
        await wrapper.find("form").trigger("submit");
        await flushPromises();
        expect(lastBody("line-action")).toEqual({expectedRevision: 5, action: {kind: "edit-draft-line", lineId: "ln-side", expectedVersion: 2,
            expectedContentHash: hash("b"), title: "支线乙", type: "branch", nodeIds: ["nd-a", "nd-c", "nd-d"]}});
    });

    it("节点可关联条目，删除节点先预览受影响的连线和草稿线路", async () => {
        responses["preview-graph-deletion"] = {planId: "plan-a", kind: "node", targetId: "nd-c", entryId: null,
            removedEdges: [{id: "eg-ac", from: "nd-a", to: "nd-c"}, {id: "eg-cd", from: "nd-c", to: "nd-d"}], affectedLineIds: ["ln-side"],
            expectedRevision: 6, expectedGraphVersion: 8, impactHash: hash("f")};
        const wrapper = mountPanel();
        await emitCanvas(wrapper, "node-click", "nd-c");
        const entrySelect = wrapper.findAllComponents(FormSelect).find((item) => item.vm.$attrs["aria-label"] === "关联条目")!;
        // 细纲不能成为节点，已被其他节点关联的条目也不能重复关联。
        expect(entrySelect.props("options")).toEqual([{value: "__empty__", label: "（空节点）"}, {value: "ol-total", label: "总纲"}, {value: "ol-vol", label: "第一卷"}]);
        entrySelect.vm.$emit("update:modelValue", "ol-vol");
        await flushPromises();
        await click(wrapper, "保存关联");
        expect(lastBody("line-action")).toEqual({expectedRevision: 5, action: {kind: "relink-graph-node", ...graphCas, nodeId: "nd-c", entryId: "ol-vol"}});

        await click(wrapper, "在此格前插入一列");
        expect(lastBody("line-action")).toEqual({expectedRevision: 5, action: {kind: "insert-graph-column", ...graphCas, column: 2}});

        await click(wrapper, "删除节点");
        expect(lastBody("preview-graph-deletion")).toEqual({kind: "node", planId: "plan-a", targetId: "nd-c"});
        const impact = wrapper.find(".impact-panel").text();
        expect(impact).toContain("同时移除与它相连的 2 条连线");
        expect(impact).toContain("雨夜来客 → 空节点");
        expect(impact).toContain("草稿线路 「支线乙」");
        await click(wrapper, "确认");
        expect(lastBody("line-action")).toEqual({expectedRevision: 6, action: {kind: "remove-graph-node", planId: "plan-a", expectedGraphVersion: 8,
            nodeId: "nd-c", expectedImpactHash: hash("f"), confirmDeletion: true}});
    });

    it("固定线路的节点与连线锁定，条目已删除的节点标红，只能确认后退回草稿", async () => {
        const wrapper = mountPanel();
        await selectLine(wrapper, "角色线丙");
        const decor = canvas(wrapper).props("nodeDecor");
        expect(decor.get("nd-e")).toMatchObject({tone: "danger", note: "条目已删除", locked: true});
        expect(decor.get("nd-d")).toMatchObject({tone: "warning", locked: true});
        expect(decor.get("nd-a").dimmed).toBe(true);
        expect(canvas(wrapper).props("edgeDecor").get("eg-de").dimmed).toBe(false);
        expect(wrapper.findAll("button").some((button) => button.text().trim() === "编辑节点")).toBe(false);
        expect(wrapper.text()).toContain("线路一致");
        await click(wrapper, "退回草稿");
        await click(wrapper, "确认");
        expect(lastBody("line-action")).toEqual({expectedRevision: 5, action: {kind: "reopen-fixed-line", lineId: "ln-fixed",
            expectedVersion: 2, expectedContentHash: hash("c"), confirmReopen: true}});

        await emitCanvas(wrapper, "edge-click", "eg-de");
        const remove = wrapper.findAll("button").find((button) => button.text().trim() === "删除连线")!;
        expect(remove.attributes("disabled")).toBeDefined();
    });

    it("设为主线需要确认，并同时提交原主线的版本", async () => {
        const wrapper = mountPanel();
        await selectLine(wrapper, "支线乙");
        await click(wrapper, "设为主线");
        expect(wrapper.find(".impact-panel").text()).toContain("原主线「主线甲」会改为支线并退回草稿");
        await click(wrapper, "确认");
        expect(lastBody("line-action")).toEqual({expectedRevision: 5, action: {kind: "switch-main-line", lineId: "ln-side", expectedVersion: 2,
            expectedContentHash: hash("b"), previousLineId: "ln-main", previousVersion: 2, previousContentHash: hash("a"), confirmSwitch: true}});
    });

    it("固定前逐条说明分析出的冲突", async () => {
        responses["analyze-line"] = {lineId: "ln-main", expectedRevision: 5, expectedVersion: 2,
            report: {reportId: "00000000-0000-4000-8000-000000000002", planId: "plan-a", sourceHash: hash("a"), contextHash: "c",
                summary: "整体顺畅", conflicts: ["与支线时间重叠"], resolutions: [], entryHashes: []}};
        const wrapper = mountPanel();
        await selectLine(wrapper, "主线甲");
        expect(lastBody("inspect-line")).toEqual({lineId: "ln-main"});
        // 草稿线路未经分析，服务端的黄色判定不展示为「需重新固定」。
        expect(canvas(wrapper).props("nodeDecor").get("nd-b").tone).toBe("none");
        await click(wrapper, "开始分析");
        expect(lastBody("analyze-line")).toEqual({lineId: "ln-main", expectedRevision: 5, expectedVersion: 2, expectedContentHash: hash("a")});
        const fix = () => wrapper.findAll("button").find((button) => button.text().trim() === "固定线路")!;
        expect(fix().attributes("disabled")).toBeDefined();
        await wrapper.find(".conflict-row textarea").setValue("支线改到第二卷");
        await click(wrapper, "固定线路");
        expect(lastBody("fix-line")).toEqual({lineId: "ln-main", expectedRevision: 5, expectedVersion: 2, expectedContentHash: hash("a"),
            reportId: "00000000-0000-4000-8000-000000000002", resolutions: [{index: 0, decision: "resolved", reason: "支线改到第二卷"}]});
    });
});
