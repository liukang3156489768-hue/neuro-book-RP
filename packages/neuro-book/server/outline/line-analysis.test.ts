import {describe, expect, it} from "vitest";
import {contentHash, parseLineYaml, serializeLineYaml, type OutlineId} from "./format";
import type {PlanningSnapshot} from "./index";
import {analyzeLine, confirmLine, inspectFixedLine, lineAnalysisContext, lineStructureHash, readValidFixedLineNodes} from "./line-analysis";
import {findPlanGraph} from "./line-planning";
import {buildDesignGraph} from "./line-graph.fixture";

/** 只改快照中的条目 hash，模拟磁盘条目已变但线路尚未被领域操作撤回的读取场景。 */
function withEntryHash(snapshot: PlanningSnapshot, entryId: OutlineId, marker: string): PlanningSnapshot {
    return {...snapshot, entries: snapshot.entries.map((entry) => entry.value.id === entryId
        ? {...entry, contentHash: contentHash(marker), value: {...entry.value, body: marker}} : entry)};
}

function statuses(snapshot: PlanningSnapshot, lineId: OutlineId) {
    return inspectFixedLine(snapshot, lineId).nodes.map(({status}) => status);
}

describe("线路语义分析与固定", () => {
    it("图示中的五条线路可以分别固定，共享的分叉与汇合节点同时属于多条固定线路", async () => {
        const {fixture, nodes, lines} = buildDesignGraph();
        for (const lineId of Object.values(lines)) await fixture.fix(lineId);
        for (const lineId of Object.values(lines)) {
            expect(fixture.lineSource(lineId).value).toMatchObject({fixed: true, version: 1});
            expect(statuses(fixture.snapshot, lineId).every((status) => status === "valid")).toBe(true);
        }
        // 固定一条线路不会改变其他固定线路的上下文摘要。
        const nodesOf = (lineId: OutlineId) => readValidFixedLineNodes(fixture.snapshot, lineId);
        expect(nodesOf(lines.characterB).map(({nodeId, column}) => [nodeId, column])).toEqual([
            [nodes.m0, 0], [nodes.k1, 1], [nodes.k3, 3], [nodes.j4, 4], [nodes.m6, 6]]);
        expect(nodesOf(lines.characterA).map(({column}) => column)).toEqual([1, 2, 4, 6]);
        expect(fixture.lineSource(lines.characterA).value.analysis!.entryHashes.map(({nodeId}) => nodeId))
            .toEqual([nodes.m1, nodes.a2, nodes.j4, nodes.m6]);
    });

    it("非链、空节点、草稿条目与已固定线路都不进入模型分析", async () => {
        const {fixture, planId, nodes, lines} = buildDesignGraph();
        const never = async () => { throw new Error("不应调用模型"); };
        const draft = (title: string, nodeIds: OutlineId[]) => fixture.createLine(planId, title, "if", nodeIds);
        const expectRejected = async (lineId: OutlineId, message: RegExp) =>
            expect(analyzeLine(fixture.snapshot, fixture.analysisRequest(lineId), never)).rejects.toThrow(message);
        await expectRejected(draft("同格", [nodes.m1, nodes.b2, nodes.a2]), /同一格/);
        await expectRejected(draft("缺连线", [nodes.m0, nodes.b2]), /缺少连线/);
        await expectRejected(draft("单节点", [nodes.m0]), /至少需要 2 个节点/);
        const empty = fixture.graph("add-graph-node", planId, {column: 7, row: 0}).nodeId!;
        fixture.graph("connect-graph-nodes", planId, {from: nodes.m6, to: empty});
        await expectRejected(draft("空节点", [nodes.m6, empty]), /空节点/);
        const totalId = fixture.snapshot.manifest.totalId!;
        const draftEntry = fixture.library({kind: "create-entry", planId, parentId: totalId, entryKind: "chapter",
            title: "草稿章", body: "未采用"}).entryId!;
        fixture.graph("relink-graph-node", planId, {nodeId: empty, entryId: draftEntry});
        await expectRejected(fixture.snapshot.lines.find(({value}) => value.title === "空节点")!.value.id, /正式/);
        await fixture.fix(lines.main);
        await expectRejected(lines.main, /仅草稿线路/);
        expect(() => lineAnalysisContext(fixture.snapshot, {...fixture.analysisRequest(lines.branch), expectedVersion: 9}))
            .toThrow(expect.objectContaining({code: "CAS_CONFLICT"}));
    });

    it("模型失败、错误格式、版本过期与缺少冲突处理不得固定", async () => {
        const {fixture, lines} = buildDesignGraph();
        const request = fixture.analysisRequest(lines.main);
        const snapshot = fixture.snapshot;
        await expect(analyzeLine(snapshot, request, async () => { throw Error("offline"); })).rejects.toMatchObject({code: "MODEL_FAILED"});
        await expect(analyzeLine(snapshot, request, async () => "invalid")).rejects.toMatchObject({code: "INVALID_RESULT"});
        await expect(analyzeLine(snapshot, request, async () => JSON.stringify({summary: "", conflicts: []})))
            .rejects.toMatchObject({code: "INVALID_RESULT"});
        const issued = await analyzeLine(snapshot, request, async () => JSON.stringify({summary: "审查完成", conflicts: ["人物动机矛盾"]}));
        expect(() => confirmLine(snapshot, request, issued, issued.report.reportId, [])).toThrow(/未处理/);
        expect(() => confirmLine(snapshot, request, issued, issued.report.reportId,
            [{index: 0, decision: "resolved", reason: "  "}])).toThrow(/未处理/);
        expect(() => confirmLine(snapshot, request, issued, "not-issued", [{index: 0, decision: "resolved", reason: "已核对"}]))
            .toThrow(/来源无效/);
        const changed = {...snapshot, manifest: {...snapshot.manifest, revision: snapshot.manifest.revision + 1}};
        expect(() => confirmLine(changed, {...request, expectedRevision: changed.manifest.revision}, issued, issued.report.reportId,
            [{index: 0, decision: "resolved", reason: "已核对"}])).toThrow(/重新分析/);
        const publish = confirmLine(snapshot, request, issued, issued.report.reportId, [{index: 0, decision: "resolved", reason: " 已核对 "}]);
        const fixed = parseLineYaml(publish.mutations[0]!.content!);
        expect(fixed).toMatchObject({fixed: true, analysis: {summary: "审查完成", resolutions: [{index: 0, decision: "resolved", reason: "已核对"}]}});
    });

    it("插列与改行不使报告过期；节点顺序、条目、类型或标题变化会改变结构摘要", async () => {
        const {fixture, planId, nodes, lines} = buildDesignGraph();
        await fixture.fix(lines.characterB);
        const graph = () => findPlanGraph(fixture.snapshot, planId)!.value;
        const structure = () => lineStructureHash(fixture.lineSource(lines.characterB).value, graph());
        const before = structure();
        fixture.graph("insert-graph-column", planId, {column: 2});
        fixture.graph("move-graph-node", planId, {nodeId: nodes.k3, column: 4, row: 7});
        expect(structure()).toBe(before);
        expect(statuses(fixture.snapshot, lines.characterB).every((status) => status === "valid")).toBe(true);
        const line = fixture.lineSource(lines.characterB).value;
        expect(lineStructureHash({...line, title: "改名"}, graph())).not.toBe(before);
        expect(lineStructureHash({...line, type: "branch"}, graph())).not.toBe(before);
        expect(lineStructureHash(line, {...graph(), nodes: graph().nodes.map((node) => node.id === nodes.k1
            ? {...node, entryId: null} : node)})).not.toBe(before);
        // 未经重新分析直接改标题（例如原始写入）会让整条线路变黄。
        const forged = {...fixture.snapshot, lines: fixture.snapshot.lines.map((source) => source.value.id === lines.characterB
            ? {...source, value: {...source.value, title: "未重新分析的标题"}} : source)};
        expect(statuses(forged, lines.characterB).every((status) => status === "yellow")).toBe(true);
    });

    it("节点状态：自身条目变化为黄，方案其他条目变化整条线路变黄，条目丢失为红，空节点为 empty", async () => {
        const {fixture, planId, entries, nodes, lines} = buildDesignGraph();
        await fixture.fix(lines.branch);
        const snapshot = fixture.snapshot;
        expect(statuses(withEntryHash(snapshot, entries.b2, "新情节"), lines.branch)).toEqual(["valid", "yellow"]);
        // m6 不在支线上，但属于同方案上下文。
        expect(statuses(withEntryHash(snapshot, entries.m6, "新结局"), lines.branch)).toEqual(["yellow", "yellow"]);
        const missing: PlanningSnapshot = {...snapshot, entries: snapshot.entries.filter(({value}) => value.id !== entries.b2)};
        expect(statuses(missing, lines.branch)).toEqual(["yellow", "red"]);
        expect(() => readValidFixedLineNodes(missing, lines.branch)).toThrow(/失效/);
        const emptied: PlanningSnapshot = {...snapshot, graphs: snapshot.graphs.map((source) => ({...source, value: {...source.value,
            nodes: source.value.nodes.map((node) => node.id === nodes.b2 ? {...node, entryId: null} : node)}}))};
        expect(statuses(emptied, lines.branch)).toEqual(["yellow", "empty"]);
        // 其他方案的变化不影响本方案固定线路。
        const unrelated = {...snapshot, manifest: {...snapshot.manifest, revision: 99,
            plans: [...snapshot.manifest.plans, {id: "plan-other", title: "其他", placements: []}]}};
        expect(readValidFixedLineNodes(unrelated, lines.branch)).toHaveLength(2);
        expect(planId).toBe(fixture.lineSource(lines.branch).value.planId);
    });

    it("重开线路撤回报告，重新分析后才能再次固定；切换主线使两条线路都回到草稿", async () => {
        const {fixture, lines} = buildDesignGraph();
        await fixture.fix(lines.main);
        const firstReport = fixture.lineSource(lines.main).value.analysis!.reportId;
        expect(() => fixture.line({kind: "reopen-fixed-line", ...fixture.lineCas(lines.main), confirmReopen: false as never}))
            .toThrow(/确认/);
        fixture.line({kind: "reopen-fixed-line", ...fixture.lineCas(lines.main), confirmReopen: true});
        expect(() => readValidFixedLineNodes(fixture.snapshot, lines.main)).toThrow(/失效/);
        await fixture.fix(lines.main);
        expect(fixture.lineSource(lines.main).value).toMatchObject({fixed: true, version: 3});
        expect(fixture.lineSource(lines.main).value.analysis!.reportId).not.toBe(firstReport);
        const main = fixture.lineSource(lines.main);
        expect(() => fixture.line({kind: "switch-main-line", ...fixture.lineCas(lines.branch2), previousLineId: lines.main,
            previousVersion: 0, previousContentHash: main.contentHash, confirmSwitch: true})).toThrow(/版本/);
        fixture.line({kind: "switch-main-line", ...fixture.lineCas(lines.branch2), previousLineId: lines.main,
            previousVersion: main.value.version, previousContentHash: main.contentHash, confirmSwitch: true});
        expect(fixture.lineSource(lines.main).value).toMatchObject({type: "branch", fixed: false});
        expect(fixture.lineSource(lines.main).value.analysis).toBeUndefined();
        expect(fixture.lineSource(lines.branch2).value).toMatchObject({type: "main", fixed: false});
        expect(() => readValidFixedLineNodes(fixture.snapshot, lines.main)).toThrow(/失效/);
    });

    it("规范文件拒绝伪造不同节点或方案的固定报告", async () => {
        const {fixture, lines} = buildDesignGraph();
        await fixture.fix(lines.main);
        const valid = fixture.lineSource(lines.main).value;
        expect(() => parseLineYaml(serializeLineYaml({...valid, analysis: {...valid.analysis!, planId: "plan-other"}})))
            .toThrow(/报告与当前/);
        expect(() => parseLineYaml(serializeLineYaml({...valid, analysis: {...valid.analysis!, entryHashes: []}})))
            .toThrow(/报告与当前/);
        expect(() => parseLineYaml(serializeLineYaml({...valid, nodeIds: valid.nodeIds.slice(1)}))).toThrow(/报告与当前/);
    });
});
