import {beforeEach, describe, expect, it, vi} from "vitest";
import {OutlineFormatError} from "nbook/server/outline/format";
import {OutlineLibraryError} from "nbook/server/outline/library";
import {OutlineTransactionError} from "nbook/server/outline/transaction";

const mocks = vi.hoisted(() => ({
    open: vi.fn(), snapshot: vi.fn(), publish: vi.fn(), undo: vi.fn(),
    previewObject: vi.fn(), removeObject: vi.fn(), previewPlacement: vi.fn(), removePlacement: vi.fn(),
    previewPlan: vi.fn(), removePlan: vi.fn(), previewGraphDeletion: vi.fn(),
    analyzeLine: vi.fn(), fixLine: vi.fn(), inspectLine: vi.fn(), readFixedLine: vi.fn(), readWriterContext: vi.fn(),
    libraryAction: vi.fn(), lineAction: vi.fn(), repairMissing: vi.fn(), repairForeshadowing: vi.fn(), foreshadowingAction: vi.fn(), forkEntry: vi.fn(), generateDirection: vi.fn(), analyzeDetail: vi.fn(), adoptDetail: vi.fn(),
}));
vi.mock("nbook/server/api/projects/project-control-plane", () => ({requireProjectRefQuery: () => ({})}));
vi.mock("nbook/server/api/projects/project-http-error", () => ({withProjectHttpError: (action: () => Promise<unknown>) => action()}));
vi.mock("nbook/server/utils/novel-chapter", () => ({validateBody: (event: {body: unknown}, schema: {parse: (body: unknown) => unknown}) => schema.parse(event.body)}));
vi.mock("nbook/server/workspace-files/project-session", () => ({
    requireActiveReadyProject: () => ({workspace: {root: "unused"}}),
    runReadyProjectOperation: (_ready: unknown, action: (signal: AbortSignal, assert: () => void, revalidate: () => Promise<void>) => Promise<unknown>) =>
        action(new AbortController().signal, () => undefined, async () => undefined),
}));
vi.mock("nbook/server/outline", () => ({readPlanningSnapshot: mocks.snapshot, readForeshadowingSnapshot: mocks.snapshot}));
vi.mock("nbook/server/outline/host", () => ({
    openReadyPlanning: mocks.open,
    publishReadyPlanningFiles: mocks.publish,
    undoReadyPlanningFiles: mocks.undo,
    previewReadyPlanningObjectDeletion: mocks.previewObject,
    removeReadyPlanningObject: mocks.removeObject,
    previewReadyPlanningPlacementRemoval: mocks.previewPlacement,
    removeReadyPlanningPlacement: mocks.removePlacement,
    previewReadyPlanningPlanRemoval: mocks.previewPlan,
    removeReadyPlanningPlan: mocks.removePlan,
    applyReadyLibraryAction: mocks.libraryAction,
    applyReadyLineAction: mocks.lineAction,
    repairReadyMissingEntry: mocks.repairMissing,
    previewReadyForeshadowingMarkerRepair: mocks.repairForeshadowing,
    repairReadyForeshadowingMarker: mocks.repairForeshadowing,
    analyzeReadyLine: mocks.analyzeLine,
    fixReadyLine: mocks.fixLine,
    inspectReadyLine: mocks.inspectLine,
    readReadyFixedLineNodes: mocks.readFixedLine,
    readReadyWriterOutlineContext: mocks.readWriterContext,
    previewReadyGraphDeletion: mocks.previewGraphDeletion,
    applyReadyForeshadowingAction: mocks.foreshadowingAction,
    forkReadyLibraryEntry: mocks.forkEntry,
    generateReadyDirectionDraft: mocks.generateDirection,
    analyzeReadyDetail: mocks.analyzeDetail,
    adoptReadyDetail: mocks.adoptDetail,
}));

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("defineEventHandler", (handler: unknown) => handler);
});

async function request(method: string, segments: string, body?: unknown) {
    const handler = (await import("./[...segments]")).default;
    return handler({method, context: {params: {segments}}, body} as never);
}

describe("Project outline HTTP storage routes", () => {
    it("伏笔确认拒绝伪造状态、无效 ID 与版本；只读派生不接受客户端证据", async () => {
        const action = {kind: "confirm-foreshadowing", id: "fo-clue", expectedVersion: 0,
            expectedContentHash: "sha256:" + "0".repeat(64)};
        await expect(request("POST", "foreshadowing-action", {expectedRevision: 0,
            action: {...action, status: "adopted"}})).rejects.toThrow();
        await expect(request("POST", "foreshadowing-action", {expectedRevision: 0,
            action: {...action, id: "ol-chapter"}})).rejects.toThrow();
        expect(mocks.foreshadowingAction).not.toHaveBeenCalled();
        mocks.foreshadowingAction.mockResolvedValue({foreshadowingId: "fo-clue"});
        await expect(request("POST", "foreshadowing-action", {expectedRevision: 0, action}))
            .resolves.toHaveProperty("foreshadowingId", "fo-clue");
        expect(mocks.foreshadowingAction).toHaveBeenCalledWith(expect.anything(), action, 0,
            {kind: "user", userId: "local"});
        mocks.snapshot.mockResolvedValue({snapshot: {manifest: {}, entries: [], foreshadowing: [], lines: []}, markerIssues: []});
        await expect(request("GET", "foreshadowing-states")).resolves.toEqual({parserVersion: 1, states: [], elapsed: [], markerIssues: []});
    });
    it("伏笔标记修复预览与提交使用专用入口并要求完整 CAS", async () => {
        const hash = "sha256:" + "0".repeat(64);
        const input = {expectedRevision: 7, planId: "plan-main", entryId: "ol-chapter", foreshadowingId: "fo-clue",
            expectedVersion: 3, expectedContentHash: hash, body: "修复后的章节正文"};
        for (const invalid of [{...input, expectedRevision: -1}, {...input, entryId: "ol-root", extra: true}, {...input, foreshadowingId: "ol-clue"}]) {
            await expect(request("POST", "preview-foreshadowing-marker-repair", invalid)).rejects.toThrow();
        }
        expect(mocks.repairForeshadowing).not.toHaveBeenCalled();
        mocks.repairForeshadowing.mockResolvedValueOnce({revision: 7, markerIssues: [], files: []});
        await expect(request("POST", "preview-foreshadowing-marker-repair", input)).resolves.toMatchObject({revision: 7});
        expect(mocks.repairForeshadowing).toHaveBeenCalledWith(expect.anything(), {...input, kind: "repair-foreshadowing-marker"});
        mocks.repairForeshadowing.mockResolvedValueOnce({transactionId: "tx-repair", entryId: input.entryId});
        await expect(request("POST", "repair-foreshadowing-marker", input)).resolves.toEqual({transactionId: "tx-repair", entryId: input.entryId});
        expect(mocks.repairForeshadowing).toHaveBeenLastCalledWith(expect.anything(), {...input, kind: "repair-foreshadowing-marker"}, {kind: "user", userId: "local"});
    });
    it("草稿线路操作拒绝固定状态伪造、越界 ID 与无效坐标，并映射领域冲突", async () => {
        const create = {kind: "create-line", planId: "plan-a", title: "甲主线", type: "main", nodeIds: ["nd-one", "nd-two"]};
        for (const invalid of [{...create, fixed: true}, {...create, nodeIds: ["ol-chapter"]}, {...create, nodeIds: undefined}]) {
            await expect(request("POST", "line-action", {expectedRevision: 1, action: invalid})).rejects.toThrow();
        }
        expect(mocks.lineAction).not.toHaveBeenCalled();
        mocks.lineAction.mockResolvedValueOnce({lineId: "ln-created"});
        await expect(request("POST", "line-action", {expectedRevision: 1, action: create}))
            .resolves.toHaveProperty("lineId", "ln-created");
        expect(mocks.lineAction).toHaveBeenCalledWith(expect.anything(), create, 1, {kind: "user", userId: "local"});
        const node = {kind: "add-graph-node", planId: "plan-a", expectedGraphVersion: 0, column: 0, row: 0, entryId: "ol-chapter"};
        for (const invalid of [{...node, entryId: "../outside"}, {...node, column: -1}, {...node, row: 1.5},
            {...node, column: Number.POSITIVE_INFINITY}, {...node, expectedGraphVersion: -1}, {...node, fixed: true},
            {...node, position: {x: 1, y: 1}}]) {
            await expect(request("POST", "line-action", {expectedRevision: 1, action: invalid})).rejects.toThrow();
        }
        expect(mocks.lineAction).toHaveBeenCalledTimes(1);
        const emptyNode = {...node, entryId: null};
        mocks.lineAction.mockResolvedValueOnce({transactionId: "tx", planId: "plan-a", graphId: "gr-a", nodeId: "nd-empty"});
        await expect(request("POST", "line-action", {expectedRevision: 1, action: emptyNode}))
            .resolves.toMatchObject({graphId: "gr-a", nodeId: "nd-empty"});
        expect(mocks.lineAction).toHaveBeenLastCalledWith(expect.anything(), emptyNode, 1, {kind: "user", userId: "local"});
        const {OutlineLineError} = await import("nbook/server/outline/line-planning");
        mocks.lineAction.mockRejectedValueOnce(new OutlineLineError("旧版本", "CAS_CONFLICT"));
        await expect(request("POST", "line-action", {expectedRevision: 1, action: node}))
            .rejects.toMatchObject({statusCode: 409, data: {code: "CAS_CONFLICT"}});
    });
    it("线路图删除必须有独立预览、版本影响摘要与明确确认", async () => {
        const hash = "sha256:" + "0".repeat(64);
        const preview = {kind: "node", planId: "plan-a", targetId: "nd-two"};
        for (const invalid of [{...preview, targetId: "eg-two"}, {...preview, kind: "edge"}, {...preview, planId: ""},
            {...preview, lineId: "ln-graph"}]) {
            await expect(request("POST", "preview-graph-deletion", invalid)).rejects.toThrow();
        }
        expect(mocks.previewGraphDeletion).not.toHaveBeenCalled();
        mocks.previewGraphDeletion.mockResolvedValue({impactHash: hash, removedEdges: [], affectedLineIds: [],
            expectedRevision: 2, expectedGraphVersion: 1});
        await expect(request("POST", "preview-graph-deletion", preview)).resolves.toHaveProperty("impactHash", hash);
        expect(mocks.previewGraphDeletion).toHaveBeenCalledWith(expect.anything(), preview);
        const edgePreview = {kind: "edge", planId: "plan-a", targetId: "eg-one"};
        await request("POST", "preview-graph-deletion", edgePreview);
        expect(mocks.previewGraphDeletion).toHaveBeenLastCalledWith(expect.anything(), edgePreview);
        await expect(request("POST", "preview-line-deletion", {kind: "node", lineId: "ln-graph", targetId: "nd-two"}))
            .rejects.toMatchObject({statusCode: 404});
        const action = {kind: "remove-graph-node", planId: "plan-a", expectedGraphVersion: 1, nodeId: "nd-two",
            expectedImpactHash: hash, confirmDeletion: true};
        for (const invalid of [{...action, confirmDeletion: false}, {...action, expectedImpactHash: "invalid"},
            {...action, expectedGraphVersion: undefined}]) {
            await expect(request("POST", "line-action", {expectedRevision: 2, action: invalid})).rejects.toThrow();
        }
        expect(mocks.lineAction).not.toHaveBeenCalled();
        mocks.lineAction.mockResolvedValue({transactionId: "transaction"});
        await request("POST", "line-action", {expectedRevision: 2, action});
        expect(mocks.lineAction).toHaveBeenCalledWith(expect.anything(), action, 2, {kind: "user", userId: "local"});
        const {nodeId: _nodeId, ...edgeBase} = action;
        const edge = {...edgeBase, kind: "remove-graph-edge", edgeId: "eg-one"};
        await expect(request("POST", "line-action", {expectedRevision: 2, action: {...edge, edgeId: "../escape"}})).rejects.toThrow();
        await expect(request("POST", "line-action", {expectedRevision: 2, action: {...edge, confirmDeletion: undefined}})).rejects.toThrow();
        await request("POST", "line-action", {expectedRevision: 2, action: edge});
        expect(mocks.lineAction).toHaveBeenLastCalledWith(expect.anything(), edge, 2, {kind: "user", userId: "local"});
        expect(mocks.lineAction).toHaveBeenCalledTimes(2);
    });
    it("细纲分析与正式确认必须是不同请求，且拒绝客户端伪造分析结果", async () => {
        const input = {planId: "plan-a", entryId: "ol-detail", expectedRevision: 4, expectedVersion: 2,
            expectedContentHash: "sha256:" + "0".repeat(64)};
        const reportId = "123e4567-e89b-42d3-a456-426614174000";
        await expect(request("POST", "analyze-detail", {...input, analysisPassed: true})).rejects.toThrow();
        expect(mocks.analyzeDetail).not.toHaveBeenCalled();
        mocks.analyzeDetail.mockResolvedValue({report: {reportId, conflicts: [], deviations: []}});
        await expect(request("POST", "analyze-detail", input)).resolves.toHaveProperty("report.reportId", reportId);
        expect(mocks.analyzeDetail).toHaveBeenCalledWith(expect.anything(), input);
        await expect(request("POST", "adopt-detail", {...input, reportId, confirmDeviations: true, resolutions: [],
            analysisPassed: true})).rejects.toThrow();
        expect(mocks.adoptDetail).not.toHaveBeenCalled();
        await request("POST", "adopt-detail", {...input, reportId, confirmDeviations: true, resolutions: []});
        expect(mocks.adoptDetail).toHaveBeenCalledWith(expect.anything(), input, reportId, true, [], {kind: "user", userId: "local"});
        await expect(request("POST", "adopt-detail", {...input, reportId, confirmDeviations: false, resolutions: [
            {index: 0, decision: "ignored", reason: ""},
        ]})).rejects.toThrow();
    });
    it("requires a separate preview and revision for plan removal", async () => {
        mocks.previewPlan.mockResolvedValue({revision: 3, impact: {planId: "plan-a", objectFilesRemain: true}});
        await expect(request("POST", "preview-plan-removal", {planId: "plan-a"})).resolves.toMatchObject({revision: 3});
        expect(mocks.previewPlan).toHaveBeenCalledWith(expect.anything(), "plan-a");
        await expect(request("POST", "remove-plan", {planId: "plan-a"})).rejects.toThrow();
        expect(mocks.removePlan).not.toHaveBeenCalled();
        await request("POST", "remove-plan", {planId: "plan-a", expectedRevision: 3});
        expect(mocks.removePlan).toHaveBeenCalledWith(expect.anything(), "plan-a", 3, {kind: "user", userId: "local"});
        mocks.removePlan.mockRejectedValueOnce(new OutlineLibraryError("方案仍被固定线路引用，请先处理线路影响"));
        await expect(request("POST", "remove-plan", {planId: "plan-a", expectedRevision: 3}))
            .rejects.toMatchObject({statusCode: 422});
    });    it("validates publish bodies and routes object/placement preview and separate removal", async () => {
        await expect(request("POST", "publish", {mutations: []})).rejects.toThrow();
        expect(mocks.publish).not.toHaveBeenCalled();
        mocks.previewObject.mockResolvedValue({revision: 4, impact: {canDeleteObject: true}});
        await expect(request("POST", "preview-object-deletion", {targetId: "ol-01"})).resolves.toMatchObject({revision: 4});
        expect(mocks.previewObject).toHaveBeenCalledWith(expect.anything(), "ol-01");
        await expect(request("POST", "remove-object", {
            targetId: "ol-01", expectedRevision: 4, expectedObjectHash: "sha256:" + "0".repeat(64), confirmedTotal: true,
        })).resolves.toBeUndefined();
        expect(mocks.removeObject).toHaveBeenCalledWith(expect.anything(), "ol-01", 4, "sha256:" + "0".repeat(64), true, {kind: "user", userId: "local"});
        await request("POST", "preview-placement-removal", {planId: "plan-1", targetId: "ol-01"});
        expect(mocks.previewPlacement).toHaveBeenCalledWith(expect.anything(), "plan-1", "ol-01");
        await request("POST", "remove-placement", {planId: "plan-1", targetId: "ol-01", expectedRevision: 4});
        expect(mocks.removePlacement).toHaveBeenCalledWith(expect.anything(), "plan-1", "ol-01", 4, {kind: "user", userId: "local"});
        await expect(request("POST", "remove-object", {targetId: "../bad"})).rejects.toThrow();
        expect(mocks.removeObject).toHaveBeenCalledTimes(1);
    });

    it("校验 Phase 2 类型化草稿/共享分叉入口，不允许跳过用户确认", async () => {
        await expect(request("POST", "library-action", {expectedRevision: 2, action: {
            kind: "create-entry", planId: "plan-a", parentId: "ol-root", entryKind: "chapter", title: "第一章", body: "草稿",
        }})).resolves.toBeUndefined();
        expect(mocks.libraryAction).toHaveBeenCalledWith(expect.anything(), {
            kind: "create-entry", planId: "plan-a", parentId: "ol-root", entryKind: "chapter", title: "第一章", body: "草稿",
        }, 2, {kind: "user", userId: "local"});
        await expect(request("POST", "library-action", {expectedRevision: 2, action: {
            kind: "create-entry", planId: "plan-a", parentId: "ol-root", entryKind: "adopted", title: "无效", body: "",
        }})).rejects.toThrow();
        expect(mocks.libraryAction).toHaveBeenCalledTimes(1);
        await expect(request("POST", "library-action", {expectedRevision: 2, action: {
            kind: "create-entry", planId: "plan-a", parentId: "ol-root", entryKind: "detail",
            title: "场景", body: "雨夜", materialRefs: ["lorebook/人物/阿青.md"],
            writingGuidance: "节制", references: [{path: "research/背景/雨夜.md"}], targetWords: 2400,
        }})).resolves.toBeUndefined();
        expect(mocks.libraryAction).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
            kind: "create-entry", targetWords: 2400, materialRefs: ["lorebook/人物/阿青.md"],
        }), 2, {kind: "user", userId: "local"});
        await expect(request("POST", "library-action", {expectedRevision: 2, action: {
            kind: "create-entry", planId: "plan-a", parentId: "ol-root", entryKind: "detail",
            title: "非法篇幅", body: "", targetWords: -1,
        }})).rejects.toThrow();
        expect(mocks.libraryAction).toHaveBeenCalledTimes(2);

        const rename = {kind: "rename-plan", planId: "plan-a", title: "新方案"};
        await request("POST", "library-action", {expectedRevision: 3, action: rename});
        expect(mocks.libraryAction).toHaveBeenLastCalledWith(expect.anything(), rename, 3, {kind: "user", userId: "local"});
        await expect(request("POST", "library-action", {expectedRevision: 3, action: {...rename, title: 9}})).rejects.toThrow();
        const edit = {kind: "edit-entry", planId: "plan-a", entryId: "ol-chapter", expectedVersion: 1,
            expectedContentHash: "sha256:" + "0".repeat(64), title: "新章节", body: "新稿", materialRefs: null};
        await expect(request("POST", "library-action", {expectedRevision: 3, action: edit})).resolves.toBeUndefined();
        expect(mocks.libraryAction).toHaveBeenLastCalledWith(expect.anything(), edit, 3, {kind: "user", userId: "local"});
        await expect(request("POST", "library-action", {expectedRevision: 3, action: {...edit, expectedVersion: -1}})).rejects.toThrow();
        await expect(request("POST", "library-action", {expectedRevision: 3, action: {...edit, targetWords: -200}})).rejects.toThrow();
        expect(mocks.libraryAction).toHaveBeenCalledTimes(4);
        const adopt = {kind: "adopt-entry", planId: "plan-a", entryId: "ol-chapter",
            expectedVersion: 1, expectedContentHash: "sha256:" + "0".repeat(64)};
        await request("POST", "library-action", {expectedRevision: 3, action: adopt});
        expect(mocks.libraryAction).toHaveBeenLastCalledWith(expect.anything(), adopt, 3, {kind: "user", userId: "local"});
        await expect(request("POST", "library-action", {expectedRevision: 3, action: {...adopt, expectedVersion: -1}})).rejects.toThrow();
        await expect(request("POST", "library-action", {expectedRevision: 3, action: {...adopt, analysisPassed: true}})).rejects.toThrow();
        const fork = {planId: "plan-a", sourceId: "ol-chapter", title: "分叉", body: "草稿", expectedRevision: 3};
        await expect(request("POST", "fork-entry", fork)).rejects.toThrow();
        expect(mocks.forkEntry).not.toHaveBeenCalled();
        await request("POST", "fork-entry", {...fork, confirmShared: true});
        expect(mocks.forkEntry).toHaveBeenCalledWith(expect.anything(), fork, {kind: "user", userId: "local"});
        await request("POST", "fork-entry", {...fork, targetWords: 2300, materialRefs: null, confirmShared: true});
        expect(mocks.forkEntry).toHaveBeenLastCalledWith(expect.anything(), {...fork, targetWords: 2300, materialRefs: null},
            {kind: "user", userId: "local"});
        await expect(request("POST", "fork-entry", {...fork, targetWords: -1, confirmShared: true})).rejects.toThrow();
        const {OutlineLibraryError} = await import("nbook/server/outline/library");
        mocks.forkEntry.mockRejectedValueOnce(new OutlineLibraryError("本方案线路图仍有节点关联共享条目；请先将节点改为空节点或关联其他条目，再分叉"));
        await expect(request("POST", "fork-entry", {...fork, confirmShared: true})).rejects.toMatchObject({
            statusCode: 422, data: {code: "INVALID_ACTION"},
        });
    });
    it("仅接受合法方向请求，返回只读建议，并将模型错误映射到可诊断状态", async () => {
        const input = {planId: "plan-a", parentId: "ol-root", entryKind: "chapter", direction: "对手逼近"};
        mocks.generateDirection.mockResolvedValueOnce({title: "草案", body: "交锋", expectedRevision: 2});
        await expect(request("POST", "generate-direction", input)).resolves.toMatchObject({title: "草案", expectedRevision: 2});
        expect(mocks.generateDirection).toHaveBeenCalledWith(expect.anything(), input);
        await expect(request("POST", "generate-direction", {...input, entryKind: "total"})).rejects.toThrow();
        await expect(request("POST", "generate-direction", {...input, direction: ""})).rejects.toThrow();
        await expect(request("POST", "generate-direction", {...input, analysisPassed: true})).rejects.toThrow();
        expect(mocks.generateDirection).toHaveBeenCalledTimes(1);
        const {OutlineGenerationError} = await import("nbook/server/outline/direction");
        mocks.generateDirection.mockRejectedValueOnce(new OutlineGenerationError("请先配置模型", "MODEL_UNAVAILABLE"));
        await expect(request("POST", "generate-direction", input)).rejects.toMatchObject({statusCode: 503, data: {code: "MODEL_UNAVAILABLE"}});
    });
    it("maps transaction conflicts and format failures to HTTP errors", async () => {
        mocks.libraryAction.mockRejectedValueOnce(new (await import("nbook/server/outline/library")).OutlineLibraryError("stale", "CAS_CONFLICT"));
        await expect(request("POST", "library-action", {expectedRevision: 0, action: {kind: "adopt-entry",
            planId: "plan-a", entryId: "ol-chapter", expectedVersion: 0, expectedContentHash: "sha256:" + "0".repeat(64)}}))
            .rejects.toMatchObject({statusCode: 409, data: {code: "CAS_CONFLICT"}});
        mocks.publish.mockRejectedValueOnce(new OutlineTransactionError("CAS_CONFLICT", "stale"));
        await expect(request("POST", "publish", {
            expectedManifestRevision: 0, mutations: [{relativePath: "outline/manifest.yaml", content: "invalid"}],
        })).rejects.toMatchObject({statusCode: 409, data: {code: "CAS_CONFLICT"}});
        mocks.snapshot.mockRejectedValueOnce(new OutlineFormatError("invalid", [{code: "YAML_PARSE", message: "invalid"}]));
        await expect(request("GET", "snapshot")).rejects.toMatchObject({statusCode: 422});
        await expect(request("GET", "not-found")).rejects.toMatchObject({statusCode: 404});
    });
});



describe("线路审阅和固定 HTTP 边界", () => {
    it("节点换关联只接受图版本绑定的操作与规范稳定 ID，允许改为空节点", async () => {
        const base = {kind: "relink-graph-node", planId: "plan-a", expectedGraphVersion: 2, nodeId: "nd-chapter", entryId: "ol-next"};
        const submit = (action: unknown) => request("POST", "line-action", {expectedRevision: 3, action});
        for (const action of [{...base, fixed: true}, {...base, entryId: "fo-bad"}, {...base, entryId: undefined},
            {...base, nodeId: "ol-bad"}, {...base, expectedGraphVersion: -1}, {...base, lineId: "ln-main"}]) {
            await expect(submit(action)).rejects.toThrow();
        }
        expect(mocks.lineAction).not.toHaveBeenCalled();
        mocks.lineAction.mockResolvedValue({planId: base.planId, nodeId: base.nodeId});
        await expect(submit(base)).resolves.toEqual({planId: base.planId, nodeId: base.nodeId});
        expect(mocks.lineAction).toHaveBeenCalledWith(expect.anything(), base, 3, {kind: "user", userId: "local"});
        const empty = {...base, entryId: null};
        await submit(empty);
        expect(mocks.lineAction).toHaveBeenLastCalledWith(expect.anything(), empty, 3, {kind: "user", userId: "local"});
    });

    it("图编辑与草稿线路编辑须携带版本，拒绝伪造 fixed 状态与已废弃的旧线路动作", async () => {
        const hash = "sha256:" + "0".repeat(64);
        const submit = (value: unknown) => request("POST", "line-action", {expectedRevision: 1, action: value});
        const graphCas = {planId: "plan-a", expectedGraphVersion: 1};
        const move = {kind: "move-graph-node", ...graphCas, nodeId: "nd-one", column: 2, row: 1};
        const insert = {kind: "insert-graph-column", ...graphCas, column: 1};
        const connect = {kind: "connect-graph-nodes", ...graphCas, from: "nd-one", to: "nd-two"};
        const edit = {kind: "edit-draft-line", lineId: "ln-draft", expectedVersion: 1, expectedContentHash: hash,
            title: "支线", type: "branch", nodeIds: ["nd-one", "nd-two"]};
        const invalid = [
            {...move, column: -1}, {...insert, column: 0.5}, {...connect, to: "ol-two"}, {...connect, expectedGraphVersion: undefined},
            {...edit, type: "side"}, {...edit, expectedContentHash: "bad"}, {...edit, fixed: true},
            {kind: "upgrade-legacy-line", lineId: "ln-old", planId: "plan-a", expectedVersion: 0, expectedContentHash: hash, confirmUpgrade: true},
            {kind: "add-line-node", lineId: "ln-draft", expectedVersion: 0, expectedContentHash: hash, entryId: "ol-chapter"},
        ];
        for (const action of invalid) await expect(submit(action)).rejects.toThrow();
        expect(mocks.lineAction).not.toHaveBeenCalled();
        mocks.lineAction.mockResolvedValue({transactionId: "tx"});
        for (const action of [move, insert, connect, edit]) {
            await submit(action);
            expect(mocks.lineAction).toHaveBeenLastCalledWith(expect.anything(), action, 1, {kind: "user", userId: "local"});
        }
        expect(mocks.lineAction).toHaveBeenCalledTimes(4);
    });

    it("主线切换必须明确确认并携带两条线路的版本与 hash", async () => {
        const hash = "sha256:" + "0".repeat(64);
        const action = {kind: "switch-main-line", lineId: "ln-new", expectedVersion: 1,
            expectedContentHash: hash, previousLineId: "ln-old", previousVersion: 2,
            previousContentHash: hash, confirmSwitch: true};
        const submit = (value: unknown) => request("POST", "line-action", {expectedRevision: 3, action: value});
        for (const invalid of [{...action, confirmSwitch: false}, {...action, previousLineId: "ol-wrong"},
            {...action, previousContentHash: "invalid"}, {...action, previousVersion: -1},
            {...action, fixed: true}]) await expect(submit(invalid)).rejects.toThrow();
        expect(mocks.lineAction).not.toHaveBeenCalled();
        mocks.lineAction.mockResolvedValue({lineId: action.lineId});
        await expect(submit(action)).resolves.toEqual({lineId: action.lineId});
        expect(mocks.lineAction).toHaveBeenCalledWith(expect.anything(), action, 3, {kind: "user", userId: "local"});
    });

    it("严格校验撤回确认与只读查询的节点版本，领域失效映射 422", async () => {
        const base = {lineId: "ln-main", expectedRevision: 2, expectedVersion: 1,
            expectedContentHash: "sha256:" + "0".repeat(64)};
        const action = {kind: "reopen-fixed-line", lineId: base.lineId, expectedVersion: base.expectedVersion,
            expectedContentHash: base.expectedContentHash, confirmReopen: true};
        await expect(request("POST", "line-action", {expectedRevision: 2,
            action: {...action, confirmReopen: false}})).rejects.toThrow();
        await expect(request("POST", "line-action", {expectedRevision: 2,
            action: {...action, fixed: false}})).rejects.toThrow();
        expect(mocks.lineAction).not.toHaveBeenCalled();
        mocks.lineAction.mockResolvedValue({lineId: base.lineId});
        await request("POST", "line-action", {expectedRevision: 2, action});
        expect(mocks.lineAction).toHaveBeenCalledWith(expect.anything(), action, 2, {kind: "user", userId: "local"});
        await expect(request("POST", "inspect-line", {lineId: "ol-wrong"})).rejects.toThrow();
        await expect(request("POST", "read-fixed-line", {...base, fixed: true})).rejects.toThrow();
        expect(mocks.readFixedLine).not.toHaveBeenCalled();
        mocks.inspectLine.mockResolvedValue({nodes: [{status: "yellow"}]});
        await expect(request("POST", "inspect-line", {lineId: base.lineId}))
            .resolves.toEqual({nodes: [{status: "yellow"}]});
        mocks.readFixedLine.mockRejectedValueOnce(new (await import("nbook/server/outline/line-planning")).OutlineLineError("线路失效"));
        await expect(request("POST", "read-fixed-line", base)).rejects.toMatchObject({statusCode: 422});
        mocks.readFixedLine.mockResolvedValue({nodes: [{entryId: "ol-root"}]});
        await expect(request("POST", "read-fixed-line", base)).resolves.toHaveProperty("nodes");
        expect(mocks.readFixedLine).toHaveBeenCalledWith(expect.anything(), base);
        await expect(request("POST", "read-writer-context", {...base, draft: true})).rejects.toThrow();
        expect(mocks.readWriterContext).not.toHaveBeenCalled();
        mocks.readWriterContext.mockRejectedValueOnce(new (await import("nbook/server/outline/line-planning")).OutlineLineError("线路失效"));
        await expect(request("POST", "read-writer-context", base)).rejects.toMatchObject({statusCode: 422});
        mocks.readWriterContext.mockResolvedValueOnce({lineId: base.lineId, nodes: [{body: "正式章节"}]});
        await expect(request("POST", "read-writer-context", base)).resolves.toHaveProperty("nodes.0.body", "正式章节");
        expect(mocks.readWriterContext).toHaveBeenCalledWith(expect.anything(), base);
        const selectedMaterials = ["lorebook/hero.md"];
        mocks.readWriterContext.mockResolvedValueOnce({lineId: base.lineId, materials: [{path: selectedMaterials[0], content: "正式素材"}]});
        await expect(request("POST", "read-writer-context", {...base, materialPaths: selectedMaterials}))
            .resolves.toHaveProperty("materials.0.content", "正式素材");
        expect(mocks.readWriterContext).toHaveBeenCalledWith(expect.anything(), base, selectedMaterials);
        await expect(request("POST", "read-writer-context", {...base, materialPaths: ["lorebook/hero.md", "lorebook/hero.md"]}))
            .rejects.toThrow();
    });
    it("丢失条目修复请求严格校验 hash 与明确确认，不再接受节点替换映射", async () => {
        const hash = "sha256:" + "0".repeat(64);
        const input = {missingEntryId: "ol-lost", expectedRevision: 7, expectedMissingHash: hash, confirmRepair: true};
        for (const invalid of [{...input, confirmRepair: false}, {...input, missingEntryId: "../outside"},
            {...input, fixed: true}, {...input, expectedMissingHash: "bad"}, {...input, expectedRevision: -1},
            {...input, replacements: [{lineId: "ln-one", nodeId: "nd-one", entryId: "ol-new", expectedVersion: 3, expectedContentHash: hash}]}]) {
            await expect(request("POST", "repair-missing-entry", invalid)).rejects.toThrow();
        }
        expect(mocks.repairMissing).not.toHaveBeenCalled();
        mocks.repairMissing.mockResolvedValue({transactionId: "done"});
        await expect(request("POST", "repair-missing-entry", input)).resolves.toEqual({transactionId: "done"});
        expect(mocks.repairMissing).toHaveBeenCalledWith(expect.anything(), input, {kind: "user", userId: "local"});
        mocks.repairMissing.mockRejectedValueOnce(new OutlineTransactionError("CAS_CONFLICT", "文件已恢复"));
        await expect(request("POST", "repair-missing-entry", input))
            .rejects.toMatchObject({statusCode: 409, data: {code: "CAS_CONFLICT"}});
    });

    it("请求体严格拒绝客户端伪造报告、固定状态与遗漏确认，合法输入委托 ready 领域入口", async () => {
        const base = {lineId: "ln-main", expectedRevision: 1, expectedVersion: 0,
            expectedContentHash: "sha256:" + "1".repeat(64)};
        await expect(request("POST", "analyze-line", {...base, fixed: true})).rejects.toThrow();
        await expect(request("POST", "analyze-line", {...base, lineId: "ol-root"})).rejects.toThrow();
        await expect(request("POST", "fix-line", {...base, reportId: "123e4567-e89b-42d3-a456-426614174000",
            resolutions: [], analysis: {summary: "绕过"}})).rejects.toThrow();
        await expect(request("POST", "fix-line", {...base, reportId: "123e4567-e89b-42d3-a456-426614174000",
            resolutions: [{index: 0, decision: "ignored", reason: " "}]})).rejects.toThrow();
        expect(mocks.analyzeLine).not.toHaveBeenCalled();
        expect(mocks.fixLine).not.toHaveBeenCalled();
        mocks.analyzeLine.mockResolvedValue({report: {reportId: "123e4567-e89b-42d3-a456-426614174000"}});
        await request("POST", "analyze-line", base);
        expect(mocks.analyzeLine).toHaveBeenCalledWith(expect.anything(), base);
        const resolutions = [{index: 0, decision: "resolved", reason: "人工核对"}];
        mocks.fixLine.mockResolvedValue({lineId: base.lineId});
        await request("POST", "fix-line", {...base, reportId: "123e4567-e89b-42d3-a456-426614174000", resolutions});
        expect(mocks.fixLine).toHaveBeenCalledWith(expect.anything(), base,
            "123e4567-e89b-42d3-a456-426614174000", resolutions, {kind: "user", userId: "local"});
    });
});
