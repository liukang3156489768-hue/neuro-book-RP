import fs from "node:fs/promises";
import path from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import {absoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {closeAllProjects, closeProject, openProject, requireActiveReadyProject, requireReadyModuleHandle} from "nbook/server/workspace-files/project-session";
import {projectWorkspaceRef} from "nbook/server/workspace-files/project-identity";
import {PROJECT_HISTORY_MODULE_TOKEN} from "nbook/server/workspace-history/project-history";
import {openProjectPlanning, applyReadyLibraryAction, applyReadyLineAction, previewReadyGraphDeletion, undoProjectPlanning} from "./host";
import {findPlanGraph, prepareLineAction, previewGraphDeletion} from "./line-planning";
import {inspectFixedLine} from "./line-analysis";
import {resolveLineChain} from "./format";
import {buildDesignGraph, PlanningFixture} from "./line-graph.fixture";

const actor = {kind: "user", userId: "local"} as const;
const roots: string[] = [];

afterEach(async () => {
    await closeAllProjects();
    for (const root of roots.splice(0)) await fs.rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 50});
});

describe("方案线路图", () => {
    it("图示结构：主线分出支线与角色线，角色线互相汇合后汇回主线，各线路都是合法链", () => {
        const {fixture, planId, nodes, lines} = buildDesignGraph();
        const graph = findPlanGraph(fixture.snapshot, planId)!.value;
        expect(fixture.snapshot.graphs).toHaveLength(1);
        expect(graph).toMatchObject({version: 21, planId});
        const chain = (lineId: typeof lines.main) =>
            resolveLineChain(graph, fixture.lineSource(lineId).value.nodeIds);
        for (const lineId of Object.values(lines)) expect(chain(lineId).problem).toBeNull();
        expect(chain(lines.characterB).nodes.map(({column}) => column)).toEqual([0, 1, 3, 4, 6]);
        // 汇合节点 j4 同时属于两条角色线，分叉节点 m1 属于主线、支线与角色线甲。
        const owners = (nodeId: string) => fixture.snapshot.lines.filter(({value}) => value.nodeIds.includes(nodeId as never))
            .map(({value}) => value.title).sort();
        expect(owners(nodes.j4)).toEqual(["角色线乙", "角色线甲"].sort());
        expect(owners(nodes.m1)).toEqual(["主线", "支线", "角色线甲"].sort());
        expect([...fixture.files.keys()].filter((key) => key.startsWith("outline/graphs/"))).toHaveLength(1);
        expect([...fixture.files.keys()].filter((key) => key.startsWith("outline/storylines/"))).toHaveLength(5);
    });

    it("首次图操作从 version 0 创建线路图，并按 version 做 CAS", () => {
        const fixture = new PlanningFixture();
        const totalId = fixture.library({kind: "create-total", title: "总纲", body: "开端"}).entryId!;
        const planId = fixture.library({kind: "create-plan", title: "方案"}).planId!;
        expect(fixture.graphVersion(planId)).toBe(0);
        const empty = fixture.graph("add-graph-node", planId, {column: 3, row: 2}).nodeId!;
        expect(findPlanGraph(fixture.snapshot, planId)!.value).toMatchObject({version: 1,
            nodes: [{id: empty, entryId: null, column: 3, row: 2}]});
        expect(() => prepareLineAction(fixture.snapshot, {kind: "add-graph-node", planId, expectedGraphVersion: 0, column: 0, row: 0}))
            .toThrow(expect.objectContaining({code: "CAS_CONFLICT"}));
        // 空节点之后再关联条目；同一图内一个条目只能关联一个节点。
        fixture.graph("relink-graph-node", planId, {nodeId: empty, entryId: totalId});
        expect(() => fixture.graph("add-graph-node", planId, {column: 0, row: 0, entryId: totalId})).toThrow(/已有节点关联此条目/);
        expect(() => fixture.graph("add-graph-node", planId, {column: 3, row: 2})).toThrow(/单元格已有节点/);
        expect(() => fixture.graph("add-graph-node", planId, {column: -1, row: 0})).toThrow(/非负整数/);
        expect(() => fixture.graph("add-graph-node", planId, {column: 1.5, row: 0})).toThrow(/非负整数/);
        expect(() => prepareLineAction(fixture.snapshot, {kind: "add-graph-node", planId: "plan-missing", expectedGraphVersion: 0,
            column: 0, row: 0})).toThrow(/方案不存在/);
    });

    it("节点条目必须属于本方案且不是细纲；同格可并行但同格与向左不能连线", () => {
        const fixture = new PlanningFixture();
        const totalId = fixture.library({kind: "create-total", title: "总纲", body: "开端"}).entryId!;
        const planA = fixture.library({kind: "create-plan", title: "甲"}).planId!;
        const planB = fixture.library({kind: "create-plan", title: "乙"}).planId!;
        const chapterB = fixture.adoptedChapter(planB, totalId, "乙章节");
        expect(() => fixture.graph("add-graph-node", planA, {column: 0, row: 0, entryId: chapterB})).toThrow(/不在本方案/);
        const chapterA = fixture.adoptedChapter(planA, totalId, "甲章节");
        const detailId = fixture.library({kind: "create-entry", planId: planA, parentId: chapterA, entryKind: "detail",
            title: "细纲", body: "细纲"}).entryId!;
        expect(() => fixture.graph("add-graph-node", planA, {column: 0, row: 0, entryId: detailId})).toThrow(/不能独立成为线路节点/);
        const left = fixture.graph("add-graph-node", planA, {column: 2, row: 0}).nodeId!;
        const sameColumn = fixture.graph("add-graph-node", planA, {column: 2, row: 1}).nodeId!;
        const right = fixture.graph("add-graph-node", planA, {column: 5, row: 0}).nodeId!;
        expect(() => fixture.graph("connect-graph-nodes", planA, {from: left, to: sameColumn})).toThrow(/小格号/);
        expect(() => fixture.graph("connect-graph-nodes", planA, {from: right, to: left})).toThrow(/小格号/);
        // 连线可以跨格。
        const edgeId = fixture.graph("connect-graph-nodes", planA, {from: left, to: right}).edgeId!;
        expect(() => fixture.graph("connect-graph-nodes", planA, {from: left, to: right})).toThrow(/已存在/);
        expect(() => fixture.graph("move-graph-node", planA, {nodeId: right, column: 2, row: 3})).toThrow(/向左或同格/);
        fixture.graph("move-graph-node", planA, {nodeId: right, column: 9, row: 4});
        expect(findPlanGraph(fixture.snapshot, planA)!.value.edges).toEqual([{id: edgeId, from: left, to: right}]);
        expect(() => fixture.graph("move-graph-node", planA, {nodeId: right, column: 9, row: 4})).toThrow(/未变化/);
    });

    it("线路勾选同方案节点，每方案一条主线；草稿线路可以暂时不是链", () => {
        const {fixture, planId, nodes, lines} = buildDesignGraph();
        expect(() => fixture.createLine(planId, "第二主线", "main", [nodes.m0, nodes.m1])).toThrow(/已有主线/);
        expect(() => fixture.createLine(planId, "重复", "branch", [nodes.m0, nodes.m0])).toThrow(/重复节点/);
        expect(() => fixture.createLine(planId, "越界", "branch", ["nd-missing"])).toThrow(/不在本方案/);
        expect(() => fixture.createLine(planId, "  ", "branch", [nodes.m0])).toThrow(/标题/);
        // 同格并行的 b2 与 a2 不能在同一线路里，但草稿可以先保存，分析时再拦截。
        const draft = fixture.createLine(planId, "草稿", "if", [nodes.m1, nodes.b2, nodes.a2]);
        expect(resolveLineChain(findPlanGraph(fixture.snapshot, planId)!.value, fixture.lineSource(draft).value.nodeIds).problem)
            .toBe("SAME_COLUMN");
        fixture.line({kind: "edit-draft-line", ...fixture.lineCas(draft), title: "IF 线", type: "if", nodeIds: [nodes.m1, nodes.b2]});
        expect(fixture.lineSource(draft).value).toMatchObject({title: "IF 线", version: 1, nodeIds: [nodes.m1, nodes.b2]});
        expect(() => fixture.line({kind: "edit-draft-line", ...fixture.lineCas(draft), title: "IF 线", type: "if",
            nodeIds: [nodes.m1, nodes.b2]})).toThrow(/未变化/);
        expect(() => fixture.line({kind: "edit-draft-line", ...fixture.lineCas(draft), expectedVersion: 0, title: "改",
            type: "if", nodeIds: [nodes.m1]})).toThrow(expect.objectContaining({code: "CAS_CONFLICT"}));
        const main = fixture.lineSource(lines.main);
        const branch = fixture.lineSource(lines.branch);
        fixture.line({kind: "switch-main-line", ...fixture.lineCas(lines.branch), previousLineId: lines.main,
            previousVersion: main.value.version, previousContentHash: main.contentHash, confirmSwitch: true});
        expect(fixture.lineSource(lines.main).value.type).toBe("branch");
        expect(fixture.lineSource(lines.branch).value).toMatchObject({type: "main", version: branch.value.version + 1});
    });

    it("固定线路锁定节点格号、关联条目与线路内连线，仍允许改行、插列与分出新支线", async () => {
        const {fixture, planId, nodes, lines} = buildDesignGraph();
        await fixture.fix(lines.main);
        const graph = () => findPlanGraph(fixture.snapshot, planId)!.value;
        const mainEdge = graph().edges.find(({from, to}) => from === nodes.m1 && to === nodes.m3)!;
        expect(() => fixture.graph("move-graph-node", planId, {nodeId: nodes.m3, column: 2, row: 0})).toThrow(/先重开线路/);
        expect(() => fixture.graph("relink-graph-node", planId, {nodeId: nodes.m3, entryId: null})).toThrow(/先重开线路/);
        expect(() => previewGraphDeletion(fixture.snapshot, {planId, kind: "edge", targetId: mainEdge.id})).toThrow(/先重开线路/);
        expect(() => previewGraphDeletion(fixture.snapshot, {planId, kind: "node", targetId: nodes.m3})).toThrow(/先重开线路/);
        fixture.graph("move-graph-node", planId, {nodeId: nodes.m3, column: 3, row: 5});
        fixture.graph("insert-graph-column", planId, {column: 2});
        expect(graph().nodes.find(({id}) => id === nodes.m3)).toMatchObject({column: 4, row: 5});
        expect(graph().nodes.find(({id}) => id === nodes.m1)).toMatchObject({column: 1});
        // 从固定主线分出新支线不影响主线固定资格。
        const extra = fixture.graph("add-graph-node", planId, {column: 2, row: 6}).nodeId!;
        fixture.graph("connect-graph-nodes", planId, {from: nodes.m1, to: extra});
        expect(fixture.lineSource(lines.main).value.fixed).toBe(true);
        expect(inspectFixedLine(fixture.snapshot, lines.main).nodes.map(({status}) => status)).toEqual(["valid", "valid", "valid", "valid"]);
        expect(() => fixture.graph("insert-graph-column", planId, {column: 99})).toThrow(/没有需要右移/);
        fixture.line({kind: "reopen-fixed-line", ...fixture.lineCas(lines.main), confirmReopen: true});
        expect(fixture.lineSource(lines.main).value).toMatchObject({fixed: false});
        expect(fixture.lineSource(lines.main).value.analysis).toBeUndefined();
        expect(() => fixture.line({kind: "reopen-fixed-line", ...fixture.lineCas(lines.main), confirmReopen: true})).toThrow(/草稿/);
        fixture.graph("relink-graph-node", planId, {nodeId: nodes.m3, entryId: null});
    });

    it("删除节点须预览影响并确认，涉及的草稿线路随之移除该节点", () => {
        const {fixture, planId, nodes, lines} = buildDesignGraph();
        const preview = previewGraphDeletion(fixture.snapshot, {planId, kind: "node", targetId: nodes.j4});
        expect(preview.affectedLineIds.sort()).toEqual([lines.characterA, lines.characterB].sort());
        expect(preview.removedEdges.map(({from, to}) => [from, to])).toEqual(expect.arrayContaining([
            [nodes.a2, nodes.j4], [nodes.k3, nodes.j4], [nodes.j4, nodes.m6]]));
        expect(() => fixture.graph("remove-graph-node", planId, {nodeId: nodes.j4,
            expectedImpactHash: `sha256:${"0".repeat(64)}`, confirmDeletion: true})).toThrow(expect.objectContaining({code: "CAS_CONFLICT"}));
        fixture.graph("remove-graph-node", planId, {nodeId: nodes.j4, expectedImpactHash: preview.impactHash, confirmDeletion: true});
        const graph = findPlanGraph(fixture.snapshot, planId)!.value;
        expect(graph.nodes.some(({id}) => id === nodes.j4)).toBe(false);
        expect(graph.edges.some(({from, to}) => from === nodes.j4 || to === nodes.j4)).toBe(false);
        expect(fixture.lineSource(lines.characterA).value.nodeIds).toEqual([nodes.m1, nodes.a2, nodes.m6]);
        expect(resolveLineChain(graph, fixture.lineSource(lines.characterA).value.nodeIds).problem).toBe("MISSING_EDGE");
        const edge = graph.edges.find(({from, to}) => from === nodes.m0 && to === nodes.m1)!;
        const edgePreview = previewGraphDeletion(fixture.snapshot, {planId, kind: "edge", targetId: edge.id});
        expect(edgePreview).toMatchObject({removedEdges: [edge], affectedLineIds: []});
    });
});

describe("ready Project 线路图", () => {
    it("图操作与线路经文件事务落盘，版本冲突不写入，关闭重开后可撤销并记录 History 归因", async () => {
        const root = await createTestTmpRoot("outline-line-planning", "outline-graph-ready");
        roots.push(root);
        const workspaceRoot = absoluteFsPath(path.join(root, "workspace"));
        const projectRoot = path.join(workspaceRoot, "novel");
        await fs.mkdir(projectRoot, {recursive: true});
        await fs.writeFile(path.join(projectRoot, "project.yaml"), "kind: novel\ntitle: novel\nsummary: ''\n", "utf8");
        const ref = projectWorkspaceRef("novel");
        const ready = await openProject(ref, {kind: "job", source: "outline-line-test"}, workspaceRoot);
        let snapshot = await openProjectPlanning(ref);
        const library = async (action: Parameters<typeof applyReadyLibraryAction>[1]) => {
            const result = await applyReadyLibraryAction(ready, action, snapshot.manifest.revision, actor);
            snapshot = await openProjectPlanning(ref);
            return result;
        };
        const apply = async (action: Parameters<typeof applyReadyLineAction>[1]) => {
            const result = await applyReadyLineAction(requireActiveReadyProject(ref), action, snapshot.manifest.revision, actor);
            snapshot = await openProjectPlanning(ref);
            return result;
        };
        const totalId = (await library({kind: "create-total", title: "总纲", body: "开端"})).entryId!;
        const planId = (await library({kind: "create-plan", title: "甲方案"})).planId!;
        const version = () => findPlanGraph(snapshot, planId)?.value.version ?? 0;
        const first = await apply({kind: "add-graph-node", planId, expectedGraphVersion: 0, column: 0, row: 0, entryId: totalId});
        const graphPath = findPlanGraph(snapshot, planId)!.path;
        expect(graphPath).toMatch(/^outline\/graphs\/.+--gr-[0-9a-f-]+\.yaml$/u);
        expect(await fs.readFile(path.join(projectRoot, graphPath), "utf8")).toContain("nbook.outline-graph/v1");
        const second = await apply({kind: "add-graph-node", planId, expectedGraphVersion: version(), column: 2, row: 1});
        const original = await fs.readFile(path.join(projectRoot, graphPath), "utf8");
        await expect(applyReadyLineAction(ready, {kind: "connect-graph-nodes", planId, expectedGraphVersion: 1,
            from: first.nodeId!, to: second.nodeId!}, snapshot.manifest.revision, actor)).rejects.toMatchObject({code: "CAS_CONFLICT"});
        await expect(applyReadyLineAction(ready, {kind: "connect-graph-nodes", planId, expectedGraphVersion: version(),
            from: second.nodeId!, to: first.nodeId!}, snapshot.manifest.revision, actor)).rejects.toThrow(/小格号/);
        expect(await fs.readFile(path.join(projectRoot, graphPath), "utf8")).toBe(original);
        const linked = await apply({kind: "connect-graph-nodes", planId, expectedGraphVersion: version(),
            from: first.nodeId!, to: second.nodeId!});
        expect(linked).toMatchObject({planId, graphId: first.graphId, edgeId: expect.stringMatching(/^eg-/u)});
        const created = await apply({kind: "create-line", planId, title: "主线", type: "main", nodeIds: [first.nodeId!, second.nodeId!]});
        const line = snapshot.lines.find(({value}) => value.id === created.lineId)!;
        expect(line.path).toMatch(/^outline\/storylines\//u);
        expect(line.value).toMatchObject({schema: "nbook.outline-line/v3", planId, fixed: false, nodeIds: [first.nodeId, second.nodeId]});
        const history = await requireReadyModuleHandle(ready, PROJECT_HISTORY_MODULE_TOKEN).history;
        expect((await history!.timeline(graphPath)).at(-1)?.entry.actor).toEqual(actor);

        const preview = await previewReadyGraphDeletion(ready, {planId, kind: "edge", targetId: linked.edgeId!});
        expect(preview).toMatchObject({expectedGraphVersion: version(), removedEdges: [{id: linked.edgeId}]});
        const removed = await apply({kind: "remove-graph-edge", planId, expectedGraphVersion: version(), edgeId: linked.edgeId!,
            expectedImpactHash: preview.impactHash, confirmDeletion: true});
        expect(findPlanGraph(snapshot, planId)!.value.edges).toEqual([]);
        await closeProject(ref, "shutdown");
        await openProject(ref, {kind: "job", source: "outline-line-reopen"}, workspaceRoot);
        snapshot = await openProjectPlanning(ref);
        expect(findPlanGraph(snapshot, planId)!.value.edges).toEqual([]);
        expect(await undoProjectPlanning(ref, removed.transactionId, actor)).toMatchObject({kind: "undone"});
        expect(findPlanGraph(await openProjectPlanning(ref), planId)!.value.edges).toEqual([{id: linked.edgeId,
            from: first.nodeId, to: second.nodeId}]);
    }, 30_000);

    it("旧 outline/lines 文件保留在磁盘但不再读取", async () => {
        const root = await createTestTmpRoot("outline-line-planning", "outline-legacy-lines");
        roots.push(root);
        const workspaceRoot = absoluteFsPath(path.join(root, "workspace"));
        const projectRoot = path.join(workspaceRoot, "novel");
        await fs.mkdir(path.join(projectRoot, "outline", "lines"), {recursive: true});
        await fs.writeFile(path.join(projectRoot, "project.yaml"), "kind: novel\ntitle: novel\nsummary: ''\n", "utf8");
        const legacy = "schema: nbook.outline-line/v2\nid: ln-old\nplanId: plan-old\nversion: 0\ntitle: 旧线\ntype: main\nfixed: false\nnodes: []\nedges: []\n";
        await fs.writeFile(path.join(projectRoot, "outline", "lines", "old--ln-old.yaml"), legacy, "utf8");
        const ref = projectWorkspaceRef("novel");
        await openProject(ref, {kind: "job", source: "outline-legacy-lines"}, workspaceRoot);
        const snapshot = await openProjectPlanning(ref);
        expect(snapshot.lines).toEqual([]);
        expect(snapshot.graphs).toEqual([]);
        expect(await fs.readFile(path.join(projectRoot, "outline", "lines", "old--ln-old.yaml"), "utf8")).toBe(legacy);
    }, 30_000);
});
