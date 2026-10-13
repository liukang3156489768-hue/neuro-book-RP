import {randomUUID} from "node:crypto";
import {once} from "node:events";
import fs from "node:fs/promises";
import {createServer, type Server} from "node:http";
import path from "node:path";
import {testHostPath} from "@notnotype/neuro-book-test-support/test-path";
import {createApp, defineEventHandler, getRequestURL, toNodeListener} from "h3";
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {absoluteFsPath, type AbsoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {closeAllProjects, closeProject, openProject, resetProjectSessionsForTest} from "nbook/server/workspace-files/project-session";
import {projectWorkspaceRef} from "nbook/server/workspace-files/project-identity";
import {writeProjectManifest} from "nbook/server/workspace-files/project-workspace";
import type {PlanningSnapshot} from "nbook/server/outline";
import {contentHash, serializeManifest, type OutlineLineType, type OutlineManifest} from "nbook/server/outline/format";
import {sceneDetail} from "nbook/server/outline/detail.fixture";

vi.mock("nbook/server/outline/direction-model", () => ({completeDirectionWithModel: vi.fn(async () =>
    JSON.stringify({summary: "需要审阅", deviations: ["时间偏差"], conflicts: ["人物已离场"]}))}));

type LineActionResult = {transactionId: string; planId: string; lineId?: string; graphId?: string; nodeId?: string; edgeId?: string};

/** 仅替代 Nitro 的动态路由参数注入；H3 请求解析、ready Project 与规划领域提交均用真实实现。 */
describe("Project 大纲规划真实 H3 HTTP 合同", () => {
    let root: string;
    let workspaceRoot: AbsoluteFsPath;
    let server: Server;
    let baseUrl: string;
    let outlineHandler: (event: never) => unknown;
    const ref = projectWorkspaceRef("outline-h3");

    beforeAll(async () => {
        vi.stubGlobal("defineEventHandler", defineEventHandler);
        outlineHandler = (await import("./[...segments]")).default;
    });
    afterAll(() => vi.unstubAllGlobals());

    beforeEach(async () => {
        resetProjectSessionsForTest();
        root = testHostPath(`neuro-book-outline-h3-${randomUUID()}`);
        workspaceRoot = absoluteFsPath(path.join(root, "workspace"));
        await fs.mkdir(workspaceRoot, {recursive: true});
        await writeProjectManifest(workspaceRoot, ref, {kind: "novel", title: "HTTP 大纲测试", summary: ""});
        await openProject(ref, {kind: "job", source: "outline-http-test"}, workspaceRoot);
        const app = createApp();
        app.use("/api/projects/outline", defineEventHandler((event) => {
            event.context.params = {segments: getRequestURL(event).pathname.slice("/api/projects/outline/".length)};
            return outlineHandler(event as never);
        }));
        server = createServer(toNodeListener(app));
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("HTTP fixture 未获取监听端口");
        baseUrl = `http://127.0.0.1:${address.port}/api/projects/outline`;
    });

    afterEach(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await closeAllProjects();
        resetProjectSessionsForTest();
        await fs.rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
    }, 60_000);

    const endpoint = (baseUrl: string, segment: string) => `${baseUrl}/${segment}?projectRoot=outline-h3`;
    const projectFile = (relativePath: string) => path.join(workspaceRoot, "outline-h3", relativePath);

    /** 线路测试按 create-plan（同时创建该方案的总纲）→ 条目 → 图节点 → 连线 → 线路 → 分析固定 的顺序经真实 HTTP 搭建。 */
    function planningClient() {
        const post = (segment: string, body: unknown) => fetch(endpoint(baseUrl, segment), {
            method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body),
        });
        const client = {
            post,
            snapshot: undefined as unknown as PlanningSnapshot,
            async read(): Promise<PlanningSnapshot> {
                const response = await fetch(endpoint(baseUrl, "snapshot"));
                expect(response.status, await response.clone().text()).toBe(200);
                client.snapshot = await response.json() as PlanningSnapshot;
                return client.snapshot;
            },
            async library(action: object): Promise<{entryId?: string; planId?: string; transactionId?: string}> {
                const response = await post("library-action", {expectedRevision: client.snapshot.manifest.revision, action});
                const result = await response.json() as {entryId?: string; planId?: string};
                expect(response.status, JSON.stringify(result)).toBe(200);
                await client.read();
                return result;
            },
            /** create-plan 的 entryId 是随方案创建的总纲。 */
            async createPlan(title: string): Promise<{planId: string; totalId: string}> {
                const result = await client.library({kind: "create-plan", title});
                return {planId: result.planId!, totalId: result.entryId!};
            },
            async adoptedChapter(planId: string, parentId: string, title: string, body = title, extra: object = {}): Promise<string> {
                const entryId = (await client.library({kind: "create-entry", planId, parentId, entryKind: "chapter",
                    title, body, ...extra})).entryId!;
                const entry = client.entry(entryId);
                await client.library({kind: "adopt-entry", planId, entryId, expectedVersion: entry.value.version,
                    expectedContentHash: entry.contentHash});
                return entryId;
            },
            entry(entryId: string) {
                return client.snapshot.entries.find(({value}) => value.id === entryId)!;
            },
            graphOf(planId: string) {
                return client.snapshot.graphs.find(({value}) => value.planId === planId);
            },
            line(lineId: string) {
                const line = client.snapshot.lines.find(({value}) => value.id === lineId);
                if (!line) throw new Error(`线路不存在：${lineId}`);
                return line;
            },
            lineCas(lineId: string) {
                const line = client.line(lineId);
                return {lineId, expectedVersion: line.value.version, expectedContentHash: line.contentHash};
            },
            request(lineId: string) {
                return {...client.lineCas(lineId), expectedRevision: client.snapshot.manifest.revision};
            },
            lineAction(action: object, revision = client.snapshot.manifest.revision) {
                return post("line-action", {expectedRevision: revision, action});
            },
            graphAction(kind: string, planId: string, input: object) {
                return client.lineAction({kind, planId, expectedGraphVersion: client.graphOf(planId)?.value.version ?? 0, ...input});
            },
            async graph(kind: string, planId: string, input: object): Promise<LineActionResult> {
                const response = await client.graphAction(kind, planId, input);
                const result = await response.json() as LineActionResult;
                expect(response.status, JSON.stringify(result)).toBe(200);
                await client.read();
                return result;
            },
            async createLine(planId: string, title: string, type: OutlineLineType, nodeIds: readonly string[]): Promise<string> {
                const response = await client.lineAction({kind: "create-line", planId, title, type, nodeIds});
                const result = await response.json() as LineActionResult;
                expect(response.status, JSON.stringify(result)).toBe(200);
                await client.read();
                return result.lineId!;
            },
            async fix(lineId: string, summary = "通过"): Promise<string> {
                const {completeDirectionWithModel} = await import("nbook/server/outline/direction-model");
                vi.mocked(completeDirectionWithModel).mockResolvedValueOnce(JSON.stringify({summary, conflicts: []}));
                const request = client.request(lineId);
                const analyzed = await post("analyze-line", request);
                const issued = await analyzed.json() as {report: {reportId: string}};
                expect(analyzed.status, JSON.stringify(issued)).toBe(200);
                const fixed = await post("fix-line", {...request, reportId: issued.report.reportId, resolutions: []});
                expect(fixed.status, await fixed.clone().text()).toBe(200);
                await client.read();
                expect(client.line(lineId).value.fixed).toBe(true);
                return issued.report.reportId;
            },
        };
        return client;
    }

    it("真实 H3 线路图与草稿线路请求经校验、CAS 和 ready Project 关闭重开恢复", async () => {
        const client = planningClient();
        expect((await client.post("open", {})).status).toBe(200);
        await client.read();
        const {planId, totalId} = await client.createPlan("甲方案");
        const chapterId = (await client.library({kind: "create-entry", planId, parentId: totalId,
            entryKind: "chapter", title: "第一章", body: "相遇"})).entryId!;
        expect(client.graphOf(planId)).toBeUndefined();
        const revision = client.snapshot.manifest.revision;
        const add = {kind: "add-graph-node", planId, expectedGraphVersion: 0, column: 0, row: 0, entryId: chapterId};
        expect((await client.lineAction({...add, fixed: true})).status).toBe(400);
        expect((await client.lineAction({...add, column: -1})).status).toBe(400);
        expect((await client.lineAction(add, revision - 1)).status).toBe(409);
        expect((await client.lineAction({...add, expectedGraphVersion: 1})).status).toBe(409);
        expect((await client.lineAction({...add, entryId: "ol-missing"})).status).toBe(422);
        await client.read();
        expect(client.snapshot.manifest.revision).toBe(revision);
        expect(client.snapshot.graphs).toEqual([]);
        const added = await client.lineAction(add);
        expect(added.status).toBe(200);
        const {nodeId: firstId, graphId} = await added.json() as LineActionResult;
        await client.read();
        const graph = client.graphOf(planId)!;
        expect(graph.path).toMatch(/^outline\/graphs\/.+--gr-[a-z0-9-]+\.yaml$/u);
        expect(graph.value).toEqual({schema: "nbook.outline-graph/v1", id: graphId, planId, version: 1,
            nodes: [{id: firstId, entryId: chapterId, column: 0, row: 0}], edges: []});
        expect(client.snapshot.manifest.graphs).toMatchObject([{id: graphId, path: graph.path, version: 1}]);
        expect((await client.graphAction("add-graph-node", planId, {column: 0, row: 0, entryId: null})).status).toBe(422);
        expect((await client.graphAction("add-graph-node", planId, {column: 1, row: 0, entryId: chapterId})).status).toBe(422);
        const secondId = (await client.graph("add-graph-node", planId, {column: 1, row: 0, entryId: null})).nodeId!;
        expect((await client.graphAction("connect-graph-nodes", planId, {from: secondId, to: firstId})).status).toBe(422);
        const {edgeId} = await client.graph("connect-graph-nodes", planId, {from: firstId, to: secondId});
        expect((await client.graphAction("connect-graph-nodes", planId, {from: firstId, to: secondId})).status).toBe(422);
        const lineId = await client.createLine(planId, "主线", "main", [firstId!, secondId]);
        const line = client.line(lineId);
        expect(line.path).toMatch(/^outline\/storylines\/.+--ln-[a-z0-9-]+\.yaml$/u);
        expect(line.value).toEqual({schema: "nbook.outline-line/v3", id: lineId, planId, version: 0, title: "主线",
            type: "main", fixed: false, nodeIds: [firstId, secondId]});
        expect((await client.lineAction({kind: "create-line", planId, title: "第二主线", type: "main", nodeIds: []})).status).toBe(422);

        await closeProject(ref, "shutdown");
        await openProject(ref, {kind: "job", source: "outline-line-http-reopen"}, workspaceRoot);
        await client.read();
        expect(client.graphOf(planId)?.value).toMatchObject({version: 3,
            nodes: [{id: firstId, entryId: chapterId}, {id: secondId, entryId: null, column: 1, row: 0}],
            edges: [{id: edgeId, from: firstId, to: secondId}]});
        const target = {kind: "node", planId, targetId: secondId};
        expect((await client.post("preview-graph-deletion", {...target, targetId: edgeId})).status).toBe(400);
        const previewResponse = await client.post("preview-graph-deletion", target);
        expect(previewResponse.status).toBe(200);
        const preview = await previewResponse.json() as {impactHash: string};
        expect(preview).toMatchObject({expectedRevision: client.snapshot.manifest.revision, expectedGraphVersion: 3,
            entryId: null, removedEdges: [{id: edgeId}], affectedLineIds: [lineId]});
        const removal = {kind: "remove-graph-node", planId, expectedGraphVersion: 3, nodeId: secondId,
            expectedImpactHash: preview.impactHash, confirmDeletion: true};
        expect((await client.lineAction({...removal, confirmDeletion: false})).status).toBe(400);
        expect((await client.lineAction({...removal, expectedImpactHash: contentHash("stale")})).status).toBe(409);
        const removed = await client.lineAction(removal);
        expect(removed.status).toBe(200);
        const {transactionId} = await removed.json() as LineActionResult;
        const staleRevision = client.snapshot.manifest.revision;
        await client.read();
        expect(client.graphOf(planId)?.value).toMatchObject({version: 4, nodes: [{id: firstId}], edges: []});
        expect(client.line(lineId).value).toMatchObject({version: 1, fixed: false, nodeIds: [firstId]});
        expect((await client.lineAction(removal, staleRevision)).status).toBe(409);
        expect((await client.lineAction(removal)).status).toBe(409);
        await closeProject(ref, "shutdown");
        await openProject(ref, {kind: "job", source: "outline-line-http-deletion-reopen"}, workspaceRoot);
        expect((await client.post("undo", {transactionId})).status).toBe(200);
        await client.read();
        expect(client.graphOf(planId)?.value).toMatchObject({version: 3, nodes: [{id: firstId}, {id: secondId}], edges: [{id: edgeId}]});
        expect(client.line(lineId).value).toMatchObject({version: 0, nodeIds: [firstId, secondId]});
    }, 30_000);

    it("线路图节点移动与插列经真实 HTTP 调整，重开和 History 撤销恢复格号", async () => {
        const client = planningClient();
        expect((await client.post("open", {})).status).toBe(200);
        await client.read();
        const {planId, totalId} = await client.createPlan("方案");
        const firstEntry = (await client.library({kind: "create-entry", planId, parentId: totalId,
            entryKind: "chapter", title: "第一章", body: "正文候选"})).entryId!;
        const secondEntry = (await client.library({kind: "create-entry", planId, parentId: totalId,
            entryKind: "chapter", title: "第二章", body: "后续候选"})).entryId!;
        const first = (await client.graph("add-graph-node", planId, {column: 0, row: 0, entryId: firstEntry})).nodeId!;
        const second = (await client.graph("add-graph-node", planId, {column: 1, row: 0, entryId: secondEntry})).nodeId!;
        await client.graph("connect-graph-nodes", planId, {from: first, to: second});
        const lineId = await client.createLine(planId, "主线", "main", [first, second]);
        const graphPath = projectFile(client.graphOf(planId)!.path);
        const oldBytes = await fs.readFile(graphPath, "utf8");
        const version = client.graphOf(planId)!.value.version;
        const move = {kind: "move-graph-node", planId, expectedGraphVersion: version, nodeId: second, column: 3, row: 1};
        expect((await client.lineAction({...move, column: -1})).status).toBe(400);
        expect((await client.lineAction({...move, column: 0, row: 0})).status).toBe(422);
        expect((await client.lineAction({...move, column: 0})).status).toBe(422);
        expect((await client.lineAction({...move, expectedGraphVersion: version - 1})).status).toBe(409);
        expect(await fs.readFile(graphPath, "utf8")).toBe(oldBytes);
        const moved = await client.lineAction(move);
        expect(moved.status).toBe(200);
        const {transactionId: moveTransaction} = await moved.json() as LineActionResult;
        await client.read();
        const cells = () => client.graphOf(planId)!.value.nodes.map(({id, column, row}) => ({id, column, row}));
        expect(cells()).toEqual([{id: first, column: 0, row: 0}, {id: second, column: 3, row: 1}]);
        const {transactionId: insertTransaction} = await client.graph("insert-graph-column", planId, {column: 1});
        expect(cells()).toEqual([{id: first, column: 0, row: 0}, {id: second, column: 4, row: 1}]);
        expect((await client.graphAction("insert-graph-column", planId, {column: 5})).status).toBe(422);
        // 线路只存节点 id，先后由格号决定；移动与插列不改写线路文件。
        expect(client.line(lineId).value).toMatchObject({version: 0, nodeIds: [first, second]});
        await closeProject(ref, "shutdown");
        await openProject(ref, {kind: "job", source: "outline-move-node-reopen"}, workspaceRoot);
        await client.read();
        expect(cells()[1]).toEqual({id: second, column: 4, row: 1});
        expect((await client.post("undo", {transactionId: insertTransaction})).status).toBe(200);
        await client.read();
        expect(cells()[1]).toEqual({id: second, column: 3, row: 1});
        expect((await client.post("undo", {transactionId: moveTransaction})).status).toBe(200);
        expect(await fs.readFile(graphPath, "utf8")).toBe(oldBytes);
    }, 45_000);

    it("旧版 lines 目录与 v1 manifest 线路引用经真实 HTTP 被忽略，旧升级入口不再可用", async () => {
        const client = planningClient();
        expect((await client.post("open", {})).status).toBe(200);
        await client.read();
        const {planId, totalId} = await client.createPlan("方案");
        const legacyPath = "outline/lines/legacy--ln-legacy-http.yaml";
        const legacyBytes = ["schema: nbook.outline-line/v1", "id: ln-legacy-http", "version: 0", "title: 旧固定主线",
            "type: main", "fixed: true", "nodes:", "  - id: nd-origin", `    entryId: ${totalId}`, "    sequence: 0",
            "edges: []", ""].join("\n");
        await fs.mkdir(projectFile("outline/lines"), {recursive: true});
        await fs.writeFile(projectFile(legacyPath), legacyBytes, "utf8");
        // v1 只有顶层全局 totalId，方案条目不带 totalId；读取时会把它注入每个方案。
        const {graphs: _graphs, ...manifest} = client.snapshot.manifest;
        await fs.writeFile(projectFile("outline/manifest.yaml"), serializeManifest({...manifest, schema: "nbook.outline/v1",
            revision: manifest.revision + 1, totalId,
            plans: manifest.plans.map(({totalId: _planTotalId, ...plan}) => plan),
            lines: [{id: "ln-legacy-http", path: legacyPath, version: 0, contentHash: contentHash(legacyBytes)}],
        } as unknown as OutlineManifest), "utf8");
        await client.read();
        expect(client.snapshot.manifest).toMatchObject({schema: "nbook.outline/v3", graphs: [], lines: [],
            plans: [{id: planId, totalId}]});
        expect(client.snapshot.graphs).toEqual([]);
        expect(client.snapshot.lines).toEqual([]);
        expect((await client.post("inspect-line", {lineId: "ln-legacy-http"})).status).toBe(422);
        expect((await client.post("preview-legacy-line-upgrade", {lineId: "ln-legacy-http", planId})).status).toBe(404);
        expect((await client.post("preview-line-deletion", {kind: "node", lineId: "ln-legacy-http", targetId: "nd-origin"})).status).toBe(404);
        expect((await client.lineAction({kind: "upgrade-legacy-line", lineId: "ln-legacy-http", planId, expectedVersion: 0,
            expectedContentHash: contentHash(legacyBytes), confirmUpgrade: true})).status).toBe(400);
        const nodeId = (await client.graph("add-graph-node", planId, {column: 0, row: 0, entryId: totalId})).nodeId!;
        const manifestText = await fs.readFile(projectFile("outline/manifest.yaml"), "utf8");
        expect(manifestText).toContain("nbook.outline/v3");
        expect(manifestText).not.toContain(legacyPath);
        expect(await fs.readFile(projectFile(legacyPath), "utf8")).toBe(legacyBytes);
        expect(client.graphOf(planId)?.value.nodes).toEqual([{id: nodeId, entryId: totalId, column: 0, row: 0}]);
        await closeProject(ref, "shutdown");
        await openProject(ref, {kind: "job", source: "outline-legacy-ignored-reopen"}, workspaceRoot);
        await client.read();
        expect(client.snapshot.lines).toEqual([]);
        expect(client.snapshot.graphs).toHaveLength(1);
    }, 60_000);

    it("真实 H3 固定只读门禁、共享节点多线固定、重开与重新分析", async () => {
        const client = planningClient();
        expect((await client.post("open", {})).status).toBe(200);
        await client.read();
        const {planId, totalId} = await client.createPlan("方案");
        const start = await client.adoptedChapter(planId, totalId, "第一章", "共同起点");
        const mainEntry = await client.adoptedChapter(planId, totalId, "第二章", "主线推进");
        const branchEntry = await client.adoptedChapter(planId, totalId, "岔路章", "支线岔路");
        const n1 = (await client.graph("add-graph-node", planId, {column: 0, row: 0, entryId: start})).nodeId!;
        const n2 = (await client.graph("add-graph-node", planId, {column: 1, row: 0, entryId: mainEntry})).nodeId!;
        const n3 = (await client.graph("add-graph-node", planId, {column: 1, row: 1, entryId: branchEntry})).nodeId!;
        const mainEdge = (await client.graph("connect-graph-nodes", planId, {from: n1, to: n2})).edgeId!;
        await client.graph("connect-graph-nodes", planId, {from: n1, to: n3});
        const mainId = await client.createLine(planId, "主线", "main", [n1, n2]);
        const branchId = await client.createLine(planId, "支线", "branch", [n1, n3]);
        expect((await client.post("read-fixed-line", client.request(mainId))).status).toBe(422);

        const firstReport = await client.fix(mainId);
        const fixedRequest = client.request(mainId);
        const validResponse = await client.post("read-fixed-line", fixedRequest);
        expect(validResponse.status).toBe(200);
        expect(await validResponse.json()).toMatchObject({nodes: [{nodeId: n1, entryId: start, column: 0, status: "valid"},
            {nodeId: n2, entryId: mainEntry, column: 1, status: "valid"}]});

        // 固定线路锁住自身节点的格号、条目与线路内相邻连线。
        expect((await client.graphAction("relink-graph-node", planId, {nodeId: n1, entryId: null})).status).toBe(422);
        expect((await client.graphAction("move-graph-node", planId, {nodeId: n2, column: 2, row: 0})).status).toBe(422);
        expect((await client.post("preview-graph-deletion", {kind: "edge", planId, targetId: mainEdge})).status).toBe(422);
        expect((await client.post("preview-graph-deletion", {kind: "node", planId, targetId: n2})).status).toBe(422);
        expect((await client.lineAction({kind: "edit-draft-line", ...client.lineCas(mainId), title: "改名", type: "main",
            nodeIds: [n1, n2]})).status).toBe(422);
        // 改行与整体插列不改变结构 hash，固定资格保持有效。
        await client.graph("move-graph-node", planId, {nodeId: n2, column: 1, row: 2});
        await client.graph("insert-graph-column", planId, {column: 1});
        expect((await client.post("read-fixed-line", client.request(mainId))).status).toBe(200);

        // 共享节点可同时属于多条固定线路；其他固定线路不进入本线路上下文。
        await client.fix(branchId);
        for (const [lineId, tail] of [[mainId, n2], [branchId, n3]] as const) {
            const inspected = await client.post("inspect-line", {lineId});
            expect(inspected.status).toBe(200);
            expect(await inspected.json()).toMatchObject({chainProblem: null, nodes: [{nodeId: n1, status: "valid"},
                {nodeId: tail, column: 2, status: "valid"}]});
        }
        expect((await client.post("read-fixed-line", client.request(mainId))).status).toBe(200);

        const reopen = {kind: "reopen-fixed-line", ...client.lineCas(mainId), confirmReopen: true};
        expect((await client.lineAction({...reopen, confirmReopen: false})).status).toBe(400);
        expect((await client.lineAction(reopen)).status).toBe(200);
        await client.read();
        expect(client.line(mainId).value.fixed).toBe(false);
        expect(client.line(mainId).value.analysis).toBeUndefined();
        expect((await client.post("read-fixed-line", client.request(mainId))).status).toBe(422);
        expect(client.line(branchId).value.fixed).toBe(true);
        const renewedReport = await client.fix(mainId, "重新审核");
        expect(renewedReport).not.toBe(firstReport);
        await closeProject(ref, "shutdown");
        await openProject(ref, {kind: "job", source: "outline-fixed-http-reopen"}, workspaceRoot);
        await client.read();
        expect((await client.post("read-fixed-line", client.request(mainId))).status).toBe(200);

        await fs.unlink(projectFile(client.entry(start).path));
        const invalid = await client.post("inspect-line", {lineId: mainId});
        expect(invalid.status).toBe(200);
        expect(await invalid.json()).toMatchObject({nodes: [{nodeId: n1, entryId: start, status: "red"}, {nodeId: n2}]});
        expect((await client.post("read-fixed-line", client.request(mainId))).status).not.toBe(200);
        expect((await fetch(endpoint(baseUrl, "snapshot"))).status).not.toBe(200);
    }, 60_000);

    it("真实 H3 请求创建、确认伏笔，重开后派生状态并拒绝过期提交", async () => {
        const post = (segment: string, body: unknown) => fetch(endpoint(baseUrl, segment), {
            method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body),
        });
        expect((await post("open", {})).status).toBe(200);
        const create = await post("foreshadowing-action", {expectedRevision: 0,
            action: {kind: "create-foreshadowing", title: "银纹", body: "待埋设"}});
        expect(create.status).toBe(200);
        const {foreshadowingId} = await create.json() as {foreshadowingId: string};
        const draft = await (await fetch(endpoint(baseUrl, "snapshot"))).json() as PlanningSnapshot;
        const item = draft.foreshadowing.find(({value}) => value.id === foreshadowingId)!;
        expect(item.value).toMatchObject({status: "draft", version: 0});
        const confirmation = {kind: "confirm-foreshadowing", id: foreshadowingId,
            expectedVersion: item.value.version, expectedContentHash: item.contentHash};
        expect((await post("foreshadowing-action", {expectedRevision: 0, action: confirmation})).status).toBe(409);
        expect((await post("foreshadowing-action", {expectedRevision: draft.manifest.revision,
            action: confirmation})).status).toBe(200);
        const state = await fetch(endpoint(baseUrl, "foreshadowing-states"));
        expect(state.status).toBe(200);
        expect(await state.json()).toMatchObject({parserVersion: 1,
            states: [{id: foreshadowingId, status: "pending", sources: []}], markerIssues: []});
        await closeProject(ref, "shutdown");
        await openProject(ref, {kind: "job", source: "outline-http-reopen-foreshadowing"}, workspaceRoot);
        const restored = await (await fetch(endpoint(baseUrl, "foreshadowing-states"))).json() as {states: {status: string}[]};
        expect(restored.states).toMatchObject([{status: "pending"}]);
        expect((await post("foreshadowing-action", {expectedRevision: 2, action: confirmation})).status).toBe(409);
    }, 30_000);

    it("真实请求串联创建、确认、分析、恢复，拒绝旧版本及跳过审阅", async () => {
        const post = (segment: string, body: unknown) => fetch(endpoint(baseUrl, segment), {
            method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body),
        });
        const snapshot = async (): Promise<PlanningSnapshot> => {
            const response = await fetch(endpoint(baseUrl, "snapshot"));
            expect(response.status).toBe(200);
            return await response.json() as PlanningSnapshot;
        };
        const action = async (value: object): Promise<{entryId?: string; planId?: string; transactionId: string}> => {
            const response = await post("library-action", {expectedRevision: (await snapshot()).manifest.revision, action: value});
            expect(response.status).toBe(200);
            return await response.json() as {entryId?: string; planId?: string; transactionId: string};
        };
        expect((await post("open", {})).status).toBe(200);
        const created = await action({kind: "create-plan", title: "主方案"});
        const planId = created.planId!;
        const totalId = created.entryId!;
        const chapterId = (await action({kind: "create-entry", planId, parentId: totalId,
            entryKind: "chapter", title: "第一章", body: "相遇"})).entryId!;
        const chapter = (await snapshot()).entries.find(({value}) => value.id === chapterId)!;
        await action({kind: "adopt-entry", planId, entryId: chapterId, expectedVersion: chapter.value.version,
            expectedContentHash: chapter.contentHash});
        const detailId = (await action({kind: "create-entry", planId, parentId: chapterId,
            entryKind: "detail", title: "细纲", ...sceneDetail("雨夜对话")})).entryId!;
        const draft = await snapshot();
        const detail = draft.entries.find(({value}) => value.id === detailId)!;
        const input = {planId, entryId: detailId, expectedRevision: draft.manifest.revision,
            expectedVersion: detail.value.version, expectedContentHash: detail.contentHash};
        expect((await post("library-action", {expectedRevision: draft.manifest.revision,
            action: {kind: "adopt-entry", planId, entryId: detailId, expectedVersion: input.expectedVersion,
                expectedContentHash: input.expectedContentHash}})).status).toBe(422);
        const reportResponse = await post("analyze-detail", input);
        expect(reportResponse.status).toBe(200);
        const issued = await reportResponse.json() as {report: {reportId: string; conflicts: string[]; deviations: string[]}};
        expect(issued.report).toMatchObject({conflicts: ["人物已离场"], deviations: ["时间偏差"]});
        const adoption = { ...input, reportId: issued.report.reportId, confirmDeviations: true, resolutions: []};
        expect((await post("adopt-detail", adoption)).status).toBe(422);
        expect((await post("adopt-detail", {...adoption, confirmDeviations: false,
            resolutions: [{index: 0, decision: "ignored", reason: "倒叙已确认"}]})).status).toBe(422);
        expect((await post("adopt-detail", {...adoption, resolutions: [
            {index: 0, decision: "ignored", reason: "倒叙已确认"}]})).status).toBe(200);
        const adopted = await snapshot();
        expect(adopted.entries.find(({value}) => value.id === detailId)?.value).toMatchObject({status: "adopted",
            analysis: {reportId: issued.report.reportId}});
        const stale = await post("library-action", {expectedRevision: draft.manifest.revision,
            action: {kind: "rename-plan", planId, title: "过期请求"}});
        expect(stale.status).toBe(409);
        await closeProject(ref, "shutdown");
        expect((await fetch(endpoint(baseUrl, "snapshot"))).status).toBe(409);
        await openProject(ref, {kind: "job", source: "outline-http-reopen"}, workspaceRoot);
        const restored = await snapshot();
        expect(restored.manifest.plans[0]?.title).toBe("主方案");
        expect(restored.entries.find(({value}) => value.id === detailId)?.value.analysis?.reportId).toBe(issued.report.reportId);
    }, 60_000);

    it("真实 H3 正文写作交接按大纲库层级读取章节，不依赖线路，并按引用读取素材", async () => {
        const client = planningClient();
        expect((await client.post("open", {})).status).toBe(200);
        await client.read();
        const {planId, totalId} = await client.createPlan("主方案");
        const total = client.entry(totalId);
        await client.library({kind: "adopt-entry", planId, entryId: totalId, expectedVersion: total.value.version,
            expectedContentHash: total.contentHash});
        const chapterId = await client.adoptedChapter(planId, totalId, "第一章", "相遇", {materialRefs: ["lorebook/hero.md"]});
        const detailId = (await client.library({kind: "create-entry", planId, parentId: chapterId, entryKind: "detail",
            title: "雨夜", ...sceneDetail("雨夜对话")})).entryId!;
        const chapters = async () => {
            const response = await client.post("read-writer-chapters", {planId});
            expect(response.status, await response.clone().text()).toBe(200);
            return (await response.json() as {chapters: {entryId: string; writable: boolean; block?: {code: string}}[]}).chapters;
        };
        expect(await chapters()).toMatchObject([{entryId: chapterId, writable: false, block: {code: "DETAIL_NOT_REVIEWED"}}]);
        const input = {planId, chapterEntryId: chapterId};
        expect((await client.post("read-writer-chapter-context", input)).status).toBe(422);

        const detail = client.entry(detailId);
        const review = {planId, entryId: detailId, expectedRevision: client.snapshot.manifest.revision,
            expectedVersion: detail.value.version, expectedContentHash: detail.contentHash};
        const {completeDirectionWithModel} = await import("nbook/server/outline/direction-model");
        vi.mocked(completeDirectionWithModel).mockResolvedValueOnce(JSON.stringify({summary: "一致", deviations: [], conflicts: []}));
        const analyzed = await client.post("analyze-detail", review);
        const issued = await analyzed.json() as {report: {reportId: string}};
        expect(analyzed.status, JSON.stringify(issued)).toBe(200);
        expect((await client.post("adopt-detail", {...review, reportId: issued.report.reportId, confirmDeviations: true,
            resolutions: []})).status).toBe(200);
        await client.read();
        expect(client.snapshot.lines).toEqual([]);
        expect(await chapters()).toMatchObject([{entryId: chapterId, writable: true, details: [{entryId: detailId}]}]);

        await fs.mkdir(projectFile("lorebook"), {recursive: true});
        await fs.writeFile(projectFile("lorebook/hero.md"), "英雄素材", "utf8");
        const response = await client.post("read-writer-chapter-context", {...input, materialPaths: ["lorebook/hero.md"]});
        expect(response.status, await response.clone().text()).toBe(200);
        const context = await response.json() as {basis: object};
        expect(context).toMatchObject({planId, chapter: {entryId: chapterId, body: "相遇"},
            details: [{entryId: detailId, body: sceneDetail("雨夜对话").body}],
            materials: [{path: "lorebook/hero.md", content: "英雄素材", sources: [{entryId: chapterId, field: "materialRefs"}]}]});
        const unchanged = await client.post("read-writer-chapter-context", {...input, expectedBasis: context.basis});
        expect(await unchanged.json()).toMatchObject({basisChanged: false});
        expect((await client.post("read-writer-chapter-context", {...input, materialPaths: ["lorebook/secret.md"]})).status).toBe(422);
    }, 60_000);

    it("真实 H3 主线切换仅在明确确认下改写同方案两条线路并可撤销", async () => {
        const client = planningClient();
        expect((await client.post("open", {})).status).toBe(200);
        await client.read();
        const {planId} = await client.createPlan("方案");
        const sourceId = await client.createLine(planId, "原主线", "main", []);
        const targetId = await client.createLine(planId, "替代", "branch", []);
        const source = client.line(sourceId);
        const target = client.line(targetId);
        const action = {kind: "switch-main-line", lineId: targetId, expectedVersion: target.value.version,
            expectedContentHash: target.contentHash, previousLineId: sourceId,
            previousVersion: source.value.version, previousContentHash: source.contentHash, confirmSwitch: true};
        expect((await client.lineAction({...action, confirmSwitch: false})).status).toBe(400);
        const changed = await client.lineAction(action);
        expect(changed.status, await changed.clone().text()).toBe(200);
        const {transactionId} = await changed.json() as LineActionResult;
        await client.read();
        expect(client.line(sourceId).value.type).toBe("branch");
        expect(client.line(targetId).value.type).toBe("main");
        expect((await client.lineAction(action, client.snapshot.manifest.revision - 1)).status).toBe(409);
        expect((await client.lineAction(action)).status).toBe(409);
        await closeProject(ref, "shutdown");
        await openProject(ref, {kind: "job", source: "outline-switch-h3-reopen"}, workspaceRoot);
        await client.read();
        expect(client.line(targetId).value.type).toBe("main");
        expect((await client.post("undo", {transactionId})).status).toBe(200);
        await client.read();
        expect(client.line(sourceId).value.type).toBe("main");
        expect(client.line(targetId).value.type).toBe("branch");
    }, 60_000);

    it("真实 H3 缺失条目修复经确认、CAS、文件事务及重开仍可读取", async () => {
        const client = planningClient();
        expect((await client.post("open", {})).status).toBe(200);
        await client.read();
        const {planId, totalId} = await client.createPlan("方案");
        const lost = await client.adoptedChapter(planId, totalId, "丢失章节", "正文");
        const kept = await client.adoptedChapter(planId, totalId, "后续章节", "后续");
        const lostNode = (await client.graph("add-graph-node", planId, {column: 0, row: 0, entryId: lost})).nodeId!;
        const keptNode = (await client.graph("add-graph-node", planId, {column: 1, row: 0, entryId: kept})).nodeId!;
        await client.graph("connect-graph-nodes", planId, {from: lostNode, to: keptNode});
        const lineId = await client.createLine(planId, "主线", "main", [lostNode, keptNode]);
        await client.fix(lineId);
        const entry = client.entry(lost);
        const entryPath = projectFile(entry.path);
        const originalBytes = await fs.readFile(entryPath, "utf8");
        await fs.unlink(entryPath);
        const inspection = await client.post("inspect-line", {lineId});
        expect(inspection.status).toBe(200);
        expect(await inspection.json()).toMatchObject({nodes: [{nodeId: lostNode, entryId: lost, status: "red"}, {nodeId: keptNode}]});
        const input = {missingEntryId: lost, expectedRevision: client.snapshot.manifest.revision,
            expectedMissingHash: entry.contentHash, confirmRepair: true};
        expect((await client.post("repair-missing-entry", {...input, confirmRepair: false})).status).toBe(400);
        expect((await client.post("repair-missing-entry", {...input, replacements: [{lineId, nodeId: lostNode,
            entryId: kept, expectedVersion: 0, expectedContentHash: entry.contentHash}]})).status).toBe(400);
        expect((await client.post("repair-missing-entry", {...input, expectedRevision: input.expectedRevision - 1})).status).toBe(409);
        const repaired = await client.post("repair-missing-entry", input);
        expect(repaired.status).toBe(200);
        const {transactionId} = await repaired.json() as {transactionId: string};
        await client.read();
        expect(client.snapshot.manifest.entries.some(({id}) => id === lost)).toBe(false);
        expect(client.snapshot.manifest.plans[0]!.placements.some(({entryId}) => entryId === lost)).toBe(false);
        expect(client.graphOf(planId)?.value.nodes).toEqual([{id: lostNode, entryId: null, column: 0, row: 0},
            {id: keptNode, entryId: kept, column: 1, row: 0}]);
        expect(client.line(lineId).value).toMatchObject({fixed: false, nodeIds: [lostNode, keptNode]});
        expect(client.line(lineId).value.analysis).toBeUndefined();
        expect((await client.post("repair-missing-entry", input)).status).toBe(409);
        await closeProject(ref, "shutdown");
        await openProject(ref, {kind: "job", source: "outline-repair-h3-reopen"}, workspaceRoot);
        await client.read();
        expect(client.graphOf(planId)?.value.nodes[0]?.entryId).toBeNull();
        expect((await client.post("undo", {transactionId})).status).toBe(409);
        await fs.writeFile(entryPath, originalBytes, "utf8");
        expect((await client.post("undo", {transactionId})).status).toBe(200);
        await client.read();
        expect(client.graphOf(planId)?.value.nodes[0]?.entryId).toBe(lost);
        expect(client.line(lineId).value.fixed).toBe(true);

        // 再次外部丢失：修复后节点为空，需重新关联正式条目并重新分析才能恢复固定资格。
        await fs.unlink(entryPath);
        expect((await client.post("repair-missing-entry", {...input, expectedRevision: client.snapshot.manifest.revision})).status).toBe(200);
        await client.read();
        expect((await client.post("read-fixed-line", client.request(lineId))).status).toBe(422);
        expect((await client.post("analyze-line", client.request(lineId))).status).toBe(422);
        const replacement = await client.adoptedChapter(planId, totalId, "新章节", "代替");
        await client.graph("relink-graph-node", planId, {nodeId: lostNode, entryId: replacement});
        await client.fix(lineId, "确认无冲突");
        const fixedRequest = client.request(lineId);
        const valid = await client.post("read-fixed-line", fixedRequest);
        expect(valid.status).toBe(200);
        expect(await valid.json()).toMatchObject({nodes: [{nodeId: lostNode, entryId: replacement, status: "valid"},
            {nodeId: keptNode, entryId: kept, status: "valid"}]});
        await closeProject(ref, "shutdown");
        await openProject(ref, {kind: "job", source: "outline-repair-h3-fixed-reopen"}, workspaceRoot);
        expect((await client.post("read-fixed-line", fixedRequest)).status).toBe(200);
    }, 60_000);

    it("真实 H3 associate-total 手动共用总纲：有正文须确认替换，重开后保持，可撤销", async () => {
        const client = planningClient();
        expect((await client.post("open", {})).status).toBe(200);
        await client.read();
        const a = await client.createPlan("甲方案");
        const b = await client.createPlan("乙方案");
        const c = await client.createPlan("丙方案");
        const totalOf = (planId: string) => client.snapshot.manifest.plans.find(({id}) => id === planId)!;
        // create-plan 为每个方案各建一个空总纲，创建后互不共享。
        expect(client.snapshot.manifest.plans.map(({id, totalId}) => ({id, totalId}))).toEqual([
            {id: a.planId, totalId: a.totalId}, {id: b.planId, totalId: b.totalId}, {id: c.planId, totalId: c.totalId}]);
        expect(new Set([a.totalId, b.totalId, c.totalId]).size).toBe(3);

        const editTotal = async (plan: {planId: string; totalId: string}, body: string) => {
            const total = client.entry(plan.totalId);
            await client.library({kind: "edit-entry", planId: plan.planId, entryId: plan.totalId, expectedVersion: total.value.version,
                expectedContentHash: total.contentHash, title: total.value.title, body});
        };
        await editTotal(a, "共用的作品总纲");
        await editTotal(c, "丙方案自己的总纲正文");

        const associate = (planId: string, totalId: string, extra: object = {}) =>
            client.post("library-action", {expectedRevision: client.snapshot.manifest.revision,
                action: {kind: "associate-total", planId, totalId, ...extra}});
        expect((await associate("plan-missing", a.totalId)).status).toBe(422);
        expect((await associate(b.planId, b.totalId)).status).toBe(422);
        expect((await associate(b.planId, "not-an-entry-id")).status).toBe(400);

        // 乙方案总纲为空，直接改用甲方案总纲，不需要确认。
        const shared = await associate(b.planId, a.totalId);
        expect(shared.status, await shared.clone().text()).toBe(200);
        await client.read();
        expect(totalOf(b.planId).totalId).toBe(a.totalId);
        expect(totalOf(b.planId).placements.filter(({parentId}) => parentId === null).map(({entryId}) => entryId)).toEqual([a.totalId]);
        // 被替换的旧总纲条目仍保留，是否删除由用户另行决定。
        expect(client.snapshot.entries.some(({value}) => value.id === b.totalId)).toBe(true);

        // 丙方案总纲有正文：未确认时拒绝且不产生新 revision，确认后才替换。
        const revision = client.snapshot.manifest.revision;
        expect((await associate(c.planId, a.totalId)).status).toBe(422);
        expect((await associate(c.planId, a.totalId, {confirmReplace: false})).status).toBe(400);
        await client.read();
        expect(client.snapshot.manifest.revision).toBe(revision);
        const confirmed = await associate(c.planId, a.totalId, {confirmReplace: true});
        expect(confirmed.status, await confirmed.clone().text()).toBe(200);
        const {transactionId} = await confirmed.json() as {transactionId: string};
        await client.read();
        expect(client.snapshot.manifest.plans.map(({totalId}) => totalId)).toEqual([a.totalId, a.totalId, a.totalId]);

        await closeProject(ref, "shutdown");
        await openProject(ref, {kind: "job", source: "outline-associate-total-reopen"}, workspaceRoot);
        await client.read();
        expect(client.snapshot.manifest.plans.map(({totalId}) => totalId)).toEqual([a.totalId, a.totalId, a.totalId]);

        const undone = await client.post("undo", {transactionId});
        expect(undone.status, await undone.clone().text()).toBe(200);
        await client.read();
        expect(totalOf(c.planId).totalId).toBe(c.totalId);
        expect(totalOf(b.planId).totalId).toBe(a.totalId);
    }, 60_000);

    it("真实 H3 unshare-total 为共用总纲的方案分叉专属总纲，内容沿用且其他方案不受影响", async () => {
        const client = planningClient();
        expect((await client.post("open", {})).status).toBe(200);
        await client.read();
        const a = await client.createPlan("甲方案");
        const b = await client.createPlan("乙方案");
        const total = client.entry(a.totalId);
        await client.library({kind: "edit-entry", planId: a.planId, entryId: a.totalId, expectedVersion: total.value.version,
            expectedContentHash: total.contentHash, title: total.value.title, body: "共用的作品总纲"});
        const unshare = (planId: string) => client.post("library-action", {expectedRevision: client.snapshot.manifest.revision,
            action: {kind: "unshare-total", planId}});
        const totalOf = (planId: string) => client.snapshot.manifest.plans.find(({id}) => id === planId)!;

        // 总纲尚未被多个方案共用时，无需也不允许分叉。
        expect((await unshare(a.planId)).status).toBe(422);
        expect((await unshare("plan-missing")).status).toBe(422);
        await client.library({kind: "associate-total", planId: b.planId, totalId: a.totalId});
        expect(totalOf(b.planId).totalId).toBe(a.totalId);

        const split = await unshare(b.planId);
        expect(split.status, await split.clone().text()).toBe(200);
        const result = await split.json() as {planId: string; entryId: string; transactionId: string};
        await client.read();
        const forkedTotalId = totalOf(b.planId).totalId;
        expect(result).toMatchObject({planId: b.planId, entryId: forkedTotalId});
        expect(forkedTotalId).not.toBe(a.totalId);
        expect(totalOf(a.planId).totalId).toBe(a.totalId);
        expect(client.entry(forkedTotalId).value).toMatchObject({kind: "total", body: "共用的作品总纲", version: 0});
        expect(totalOf(b.planId).placements.filter(({parentId}) => parentId === null).map(({entryId}) => entryId)).toEqual([forkedTotalId]);
        // 分叉后已不再共用，再次分叉被拒绝。
        expect((await unshare(b.planId)).status).toBe(422);

        await closeProject(ref, "shutdown");
        await openProject(ref, {kind: "job", source: "outline-unshare-total-reopen"}, workspaceRoot);
        await client.read();
        expect(totalOf(b.planId).totalId).toBe(forkedTotalId);
        expect(totalOf(a.planId).totalId).toBe(a.totalId);

        const undone = await client.post("undo", {transactionId: result.transactionId});
        expect(undone.status, await undone.clone().text()).toBe(200);
        await client.read();
        expect(totalOf(b.planId).totalId).toBe(a.totalId);
    }, 60_000);
});
