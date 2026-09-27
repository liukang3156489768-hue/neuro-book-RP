import fs from "node:fs/promises";
import path from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import {absoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {closeAllProjects, closeProject, openProject, ProjectNotOpenError, requireReadyModuleHandle} from "nbook/server/workspace-files/project-session";
import {PROJECT_HISTORY_MODULE_TOKEN} from "nbook/server/workspace-history/project-history";
import {projectWorkspaceRef} from "nbook/server/workspace-files/project-identity";
import {contentHash, createEmptyManifest, serializeEntryMarkdown, serializeManifest, type OutlineId} from "./format";
import {adoptReadyDetail, analyzeReadyDetail, analyzeReadyLine, applyReadyLibraryAction, applyReadyLineAction, fixReadyLine, forkReadyLibraryEntry, openProjectPlanning, publishProjectPlanning, previewReadyPlanningObjectDeletion, previewReadyPlanningPlacementRemoval, previewReadyPlanningPlanRemoval, removeReadyPlanningObject, removeReadyPlanningPlacement, removeReadyPlanningPlan, undoProjectPlanning, undoReadyPlanningFiles} from "./host";

// 细纲与线路分析共用模型入口但结果 schema 不同，按系统提示区分以走真实固定流程。
vi.mock("./direction-model", () => ({completeDirectionWithModel: vi.fn(async (_ready: unknown, _prompt: string, _signal: unknown, system?: string) =>
    JSON.stringify(system?.includes("线路语义审查")
        ? {summary: "内容一致", conflicts: []}
        : {summary: "内容一致", deviations: [], conflicts: []}))}));

const actor = {kind: "user", userId: "local"} as const;
const roots: string[] = [];

afterEach(async () => {
    await closeAllProjects();
    for (const root of roots.splice(0)) await fs.rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 50});
});

/** 经真实领域入口在方案线路图第 0 行铺一条按格号相连的链，并以无冲突报告固定。 */
async function fixChainLine(ready: Parameters<typeof applyReadyLineAction>[0], ref: Parameters<typeof openProjectPlanning>[0],
    planId: string, entryIds: readonly OutlineId[], title: string): Promise<OutlineId> {
    const lineAction = async (action: Parameters<typeof applyReadyLineAction>[1]) => {
        const snapshot = await openProjectPlanning(ref);
        return applyReadyLineAction(ready, action, snapshot.manifest.revision, actor);
    };
    const graphVersion = async () => (await openProjectPlanning(ref)).graphs
        .find(({value}) => value.planId === planId)?.value.version ?? 0;
    const nodeIds: OutlineId[] = [];
    for (const [column, entryId] of entryIds.entries()) {
        nodeIds.push((await lineAction({kind: "add-graph-node", planId, expectedGraphVersion: await graphVersion(),
            column, row: 0, entryId})).nodeId!);
    }
    for (let index = 1; index < nodeIds.length; index += 1) {
        await lineAction({kind: "connect-graph-nodes", planId, expectedGraphVersion: await graphVersion(),
            from: nodeIds[index - 1]!, to: nodeIds[index]!});
    }
    const {lineId} = await lineAction({kind: "create-line", planId, title, type: "main", nodeIds});
    const snapshot = await openProjectPlanning(ref);
    const source = snapshot.lines.find(({value}) => value.id === lineId)!;
    const request = {lineId: lineId!, expectedRevision: snapshot.manifest.revision,
        expectedVersion: source.value.version, expectedContentHash: source.contentHash};
    const issued = await analyzeReadyLine(ready, request);
    await fixReadyLine(ready, request, issued.report.reportId, [], actor);
    return lineId!;
}

describe("outline real Project lifecycle", () => {
    it("recovers canonical files and a discarded index after close/reopen, rejecting a stale generation", async () => {
        const root = await createTestTmpRoot("outline-lifecycle", "outline-real-project");
        roots.push(root);
        const workspaceRoot = absoluteFsPath(path.join(root, "workspace"));
        const projectRoot = path.join(workspaceRoot, "novel");
        await fs.mkdir(projectRoot, {recursive: true});
        await fs.writeFile(path.join(projectRoot, "project.yaml"), "kind: novel\ntitle: novel\nsummary: ''\n", "utf8");
        const ref = projectWorkspaceRef("novel");
        const first = await openProject(ref, {kind: "job", source: "outline-lifecycle-test"}, workspaceRoot);
        const initial = await openProjectPlanning(ref);
        expect(initial.manifest.revision).toBe(0);
        const next = serializeManifest({...createEmptyManifest(), revision: 1});
        const receipt = await publishProjectPlanning(ref, {
            expectedManifestRevision: 0,
            mutations: [{relativePath: "outline/manifest.yaml", content: next}],
        }, actor);
        expect(receipt.files).toEqual(["outline/manifest.yaml"]);
        await closeProject(ref, "shutdown");
        expect(() => openProjectPlanning(ref)).toThrow(ProjectNotOpenError);
        const indexPath = path.join(projectRoot, ".nbook", "outline-index.sqlite");
        await fs.rm(indexPath, {force: true});
        const second = await openProject(ref, {kind: "job", source: "outline-lifecycle-test"}, workspaceRoot);
        expect(second.publicId).not.toBe(first.publicId);
        await expect(undoReadyPlanningFiles(first, receipt.transactionId, actor)).rejects.toThrow();
        expect((await openProjectPlanning(ref)).manifest.revision).toBe(1);
        expect(await fs.stat(indexPath)).toBeDefined();
        expect(await fs.readFile(path.join(projectRoot, "outline", "manifest.yaml"), "utf8")).toBe(next);
        expect(await undoProjectPlanning(ref, receipt.transactionId, actor)).toMatchObject({kind: "undone"});
        expect((await openProjectPlanning(ref)).manifest.revision).toBe(0);
    });

    it("requires a separate total-outline confirmation and restores the deletion through History-owned Project", async () => {
        const root = await createTestTmpRoot("outline-lifecycle", "outline-total-confirmation");
        roots.push(root);
        const workspaceRoot = absoluteFsPath(path.join(root, "workspace"));
        const projectRoot = path.join(workspaceRoot, "novel");
        await fs.mkdir(projectRoot, {recursive: true});
        await fs.writeFile(path.join(projectRoot, "project.yaml"), "kind: novel\ntitle: novel\nsummary: ''\n", "utf8");
        const ref = projectWorkspaceRef("novel");
        const ready = await openProject(ref, {kind: "job", source: "outline-lifecycle-test"}, workspaceRoot);
        await openProjectPlanning(ref);
        const {entryId: totalId} = await applyReadyLibraryAction(ready,
            {kind: "create-total", title: "Total", body: "Total\n"}, 0, actor);
        const before = await openProjectPlanning(ref);
        const source = before.entries.find(({value}) => value.id === totalId)!;
        const relativePath = source.path;
        const changed = serializeEntryMarkdown({...source.value, version: source.value.version + 1, body: "绕过领域编辑"});
        await expect(publishProjectPlanning(ref, {expectedManifestRevision: before.manifest.revision, mutations: [
            {relativePath, content: changed},
            {relativePath: "outline/manifest.yaml", content: serializeManifest({...before.manifest,
                revision: before.manifest.revision + 1, entries: before.manifest.entries.map((item) => item.id === totalId
                    ? {...item, version: item.version + 1, contentHash: contentHash(changed)} : item)}),
            },
        ]}, actor)).rejects.toMatchObject({code: "PUBLISH_FAILED"});
        expect((await openProjectPlanning(ref)).entries.find(({value}) => value.id === totalId)?.value.body).toBe("Total\n");
        const preview = await previewReadyPlanningObjectDeletion(ready, totalId!);
        expect(preview).toMatchObject({revision: 1, impact: {canDeleteObject: true}});
        await expect(removeReadyPlanningObject(ready, totalId!, preview.revision, preview.objectHash!, false, actor))
            .rejects.toThrow(/二次确认/);
        expect((await openProjectPlanning(ref)).manifest.totalId).toBe(totalId!);
        const receipt = await removeReadyPlanningObject(ready, totalId!, preview.revision, preview.objectHash!, true, actor);
        expect((await openProjectPlanning(ref)).manifest.totalId).toBeNull();
        await expect(fs.stat(path.join(projectRoot, relativePath))).rejects.toMatchObject({code: "ENOENT"});
        expect(await undoProjectPlanning(ref, receipt.transactionId, actor)).toMatchObject({kind: "undone"});
        expect((await openProjectPlanning(ref)).manifest.totalId).toBe(totalId!);
    });
    it("removes only a confirmed placement while retaining the shared object", async () => {
        const root = await createTestTmpRoot("outline-lifecycle", "outline-relation-removal");
        roots.push(root);
        const workspaceRoot = absoluteFsPath(path.join(root, "workspace"));
        const projectRoot = path.join(workspaceRoot, "novel");
        await fs.mkdir(projectRoot, {recursive: true});
        await fs.writeFile(path.join(projectRoot, "project.yaml"), "kind: novel\ntitle: novel\nsummary: ''\n", "utf8");
        const ref = projectWorkspaceRef("novel");
        const ready = await openProject(ref, {kind: "job", source: "outline-lifecycle-test"}, workspaceRoot);
        await openProjectPlanning(ref);
        const {entryId: totalId} = await applyReadyLibraryAction(ready,
            {kind: "create-total", title: "Total", body: "Total\n"}, 0, actor);
        const {planId} = await applyReadyLibraryAction(ready, {kind: "create-plan", title: "A"}, 1, actor);
        const {entryId: volumeId} = await applyReadyLibraryAction(ready,
            {kind: "create-entry", planId: planId!, parentId: totalId!, entryKind: "volume", title: "Volume", body: "Volume\n"}, 2, actor);
        const volumePath = (await openProjectPlanning(ref)).entries.find(({value}) => value.id === volumeId)!.path;
        const volume = await fs.readFile(path.join(projectRoot, volumePath), "utf8");
        const preview = await previewReadyPlanningPlacementRemoval(ready, planId!, volumeId!);
        expect(preview.impact).toMatchObject({objectFileRemains: true, childReferences: []});
        await expect(removeReadyPlanningPlacement(ready, planId!, volumeId!, 0, actor)).rejects.toMatchObject({code: "CAS_CONFLICT"});
        const receipt = await removeReadyPlanningPlacement(ready, planId!, volumeId!, preview.revision, actor);
        expect((await openProjectPlanning(ref)).manifest.plans[0]?.placements.map((item) => item.entryId)).toEqual([totalId]);
        expect(await fs.readFile(path.join(projectRoot, volumePath), "utf8")).toBe(volume);
        expect((await previewReadyPlanningObjectDeletion(ready, volumeId!)).impact.canDeleteObject).toBe(true);
        expect(await undoProjectPlanning(ref, receipt.transactionId, actor)).toMatchObject({kind: "undone"});
        expect((await openProjectPlanning(ref)).manifest.plans[0]?.placements).toHaveLength(2);
    });
    it("预览删除方案保留条目文件，过期预览拒绝，重开后可跨 generation 撤销", async () => {
        const root = await createTestTmpRoot("outline-lifecycle", "outline-plan-removal");
        roots.push(root);
        const workspaceRoot = absoluteFsPath(path.join(root, "workspace"));
        const projectRoot = path.join(workspaceRoot, "novel");
        await fs.mkdir(projectRoot, {recursive: true});
        await fs.writeFile(path.join(projectRoot, "project.yaml"), "kind: novel\ntitle: novel\nsummary: ''\n", "utf8");
        const ref = projectWorkspaceRef("novel");
        const ready = await openProject(ref, {kind: "job", source: "outline-plan-removal"}, workspaceRoot);
        await openProjectPlanning(ref);
        const apply = async (action: Parameters<typeof applyReadyLibraryAction>[1]) =>
            applyReadyLibraryAction(ready, action, (await openProjectPlanning(ref)).manifest.revision, actor);
        const {entryId: totalId} = await apply({kind: "create-total", title: "总纲", body: ""});
        const {planId: planA} = await apply({kind: "create-plan", title: "甲"});
        const {planId: planB} = await apply({kind: "create-plan", title: "乙"});
        const {entryId: exclusiveId} = await apply({kind: "create-entry", planId: planA!, parentId: totalId!,
            entryKind: "chapter", title: "仅甲章", body: "原文"});
        const before = await openProjectPlanning(ref);
        const exclusive = before.entries.find(({value}) => value.id === exclusiveId)!;
        const original = await fs.readFile(path.join(projectRoot, exclusive.path), "utf8");
        const preview = await previewReadyPlanningPlanRemoval(ready, planA!);
        expect(preview.impact).toMatchObject({exclusiveEntryIds: [exclusiveId], objectFilesRemain: true, canRemovePlan: true});
        await expect(removeReadyPlanningPlan(ready, planA!, preview.revision - 1, actor)).rejects.toMatchObject({code: "CAS_CONFLICT"});
        expect((await openProjectPlanning(ref)).manifest.plans).toHaveLength(2);
        const removal = await removeReadyPlanningPlan(ready, planA!, preview.revision, actor);
        expect((await openProjectPlanning(ref)).manifest.plans.map(({id}) => id)).toEqual([planB]);
        expect(await fs.readFile(path.join(projectRoot, exclusive.path), "utf8")).toBe(original);
        const history = await requireReadyModuleHandle(ready, PROJECT_HISTORY_MODULE_TOKEN).history;
        expect((await history!.timeline("outline/manifest.yaml")).at(-1)?.entry.actor).toEqual(actor);
        await closeProject(ref, "shutdown");
        await openProject(ref, {kind: "job", source: "outline-plan-removal"}, workspaceRoot);
        expect((await openProjectPlanning(ref)).manifest.plans.map(({id}) => id)).toEqual([planB]);
        expect(await undoProjectPlanning(ref, removal.transactionId, actor)).toMatchObject({kind: "undone"});
        expect((await openProjectPlanning(ref)).manifest.plans.map(({id}) => id)).toEqual([planA, planB]);
        expect(await fs.readFile(path.join(projectRoot, exclusive.path), "utf8")).toBe(original);
    });
    it("线路图节点引用的方案关系必须阻断移除，其他方案的共享关系仍可移除", async () => {
        const root = await createTestTmpRoot("outline-lifecycle", "outline-fixed-placement-guard");
        roots.push(root);
        const workspaceRoot = absoluteFsPath(path.join(root, "workspace"));
        const projectRoot = path.join(workspaceRoot, "novel");
        await fs.mkdir(projectRoot, {recursive: true});
        await fs.writeFile(path.join(projectRoot, "project.yaml"), "kind: novel\ntitle: novel\nsummary: ''\n", "utf8");
        const ref = projectWorkspaceRef("novel");
        const ready = await openProject(ref, {kind: "job", source: "outline-fixed-placement-test"}, workspaceRoot);
        await openProjectPlanning(ref);
        const apply = async (action: Parameters<typeof applyReadyLibraryAction>[1]) =>
            applyReadyLibraryAction(ready, action, (await openProjectPlanning(ref)).manifest.revision, actor);
        const {entryId: totalId} = await apply({kind: "create-total", title: "总纲", body: "故事"});
        const {planId: planA} = await apply({kind: "create-plan", title: "方案甲"});
        const adoptChapter = async (title: string) => {
            const {entryId} = await apply({kind: "create-entry", planId: planA!, parentId: totalId!,
                entryKind: "chapter", title, body: title + "内容"});
            const chapter = (await openProjectPlanning(ref)).entries.find(({value}) => value.id === entryId)!;
            await apply({kind: "adopt-entry", planId: planA!, entryId: entryId!,
                expectedVersion: chapter.value.version, expectedContentHash: chapter.contentHash});
            return entryId!;
        };
        const chapterId = await adoptChapter("章节");
        const nextId = await adoptChapter("后续章节");
        const lineId = await fixChainLine(ready, ref, planA!, [chapterId, nextId], "固定线路");
        const exclusive = await previewReadyPlanningPlacementRemoval(ready, planA!, chapterId);
        expect(exclusive.impact).toMatchObject({blockingFixedLineIds: [lineId], canRemovePlacement: false});
        expect(exclusive.impact.graphNodeIds).toHaveLength(1);
        await expect(removeReadyPlanningPlacement(ready, planA!, chapterId, exclusive.revision, actor))
            .rejects.toThrow(/线路图/);
        expect((await openProjectPlanning(ref)).manifest.revision).toBe(exclusive.revision);
        // 线路图按方案隔离：另一方案挂载同一条目时没有节点引用，可以直接移除该关系。
        const {planId: planB} = await apply({kind: "create-plan", title: "方案乙"});
        await apply({kind: "attach-entry", planId: planB!, parentId: totalId!, entryId: chapterId});
        const shared = await previewReadyPlanningPlacementRemoval(ready, planB!, chapterId);
        expect(shared.impact).toMatchObject({blockingFixedLineIds: [], graphNodeIds: [], canRemovePlacement: true});
        await removeReadyPlanningPlacement(ready, planB!, chapterId, shared.revision, actor);
        const remaining = await previewReadyPlanningPlacementRemoval(ready, planA!, chapterId);
        expect(remaining.impact).toMatchObject({blockingFixedLineIds: [lineId], canRemovePlacement: false});
        await closeProject(ref, "shutdown");
        const reopened = await openProject(ref, {kind: "job", source: "outline-fixed-placement-test"}, workspaceRoot);
        expect((await openProjectPlanning(ref)).lines.find(({value}) => value.id === lineId)?.value.fixed).toBe(true);
        await expect(removeReadyPlanningPlacement(reopened, planA!, chapterId, remaining.revision, actor))
            .rejects.toThrow(/线路图/);
    }, 20_000);
    it("真实 Project 关闭重开后草稿报告须重新签发，正式报告从规范文件恢复", async () => {
        const root = await createTestTmpRoot("outline-lifecycle", "outline-detail-reopen");
        roots.push(root);
        const workspaceRoot = absoluteFsPath(path.join(root, "workspace"));
        const projectRoot = path.join(workspaceRoot, "novel");
        await fs.mkdir(projectRoot, {recursive: true});
        await fs.writeFile(path.join(projectRoot, "project.yaml"), "kind: novel\ntitle: novel\nsummary: ''\n", "utf8");
        const ref = projectWorkspaceRef("novel");
        const first = await openProject(ref, {kind: "job", source: "outline-detail-reopen-test"}, workspaceRoot);
        await openProjectPlanning(ref);
        const apply = async (action: Parameters<typeof applyReadyLibraryAction>[1]) =>
            applyReadyLibraryAction(first, action, (await openProjectPlanning(ref)).manifest.revision, actor);
        const {entryId: totalId} = await apply({kind: "create-total", title: "总纲", body: "故事"});
        const {planId} = await apply({kind: "create-plan", title: "方案"});
        const {entryId: chapterId} = await apply({kind: "create-entry", planId: planId!, parentId: totalId!,
            entryKind: "chapter", title: "第一章", body: "章节情节"});
        const chapter = (await openProjectPlanning(ref)).entries.find(({value}) => value.id === chapterId)!;
        await apply({kind: "adopt-entry", planId: planId!, entryId: chapterId!,
            expectedVersion: chapter.value.version, expectedContentHash: chapter.contentHash});
        const {entryId: detailId} = await apply({kind: "create-entry", planId: planId!, parentId: chapterId!,
            entryKind: "detail", title: "细纲", body: "场景"});
        const initial = await openProjectPlanning(ref);
        const detail = initial.entries.find(({value}) => value.id === detailId)!;
        const request = {planId: planId!, entryId: detailId!, expectedRevision: initial.manifest.revision,
            expectedVersion: detail.value.version, expectedContentHash: detail.contentHash};
        const issued = await analyzeReadyDetail(first, request);
        await closeProject(ref, "shutdown");
        const second = await openProject(ref, {kind: "job", source: "outline-detail-reopen-test"}, workspaceRoot);
        expect(second.publicId).not.toBe(first.publicId);
        expect((await openProjectPlanning(ref)).entries.find(({value}) => value.id === detailId)?.value.status).toBe("draft");
        await expect(adoptReadyDetail(second, request, issued.report.reportId, true, [], actor))
            .rejects.toThrow(/没有当前会话/);
        const reissued = await analyzeReadyDetail(second, request);
        expect(reissued.report.reportId).not.toBe(issued.report.reportId);
        await adoptReadyDetail(second, request, reissued.report.reportId, true, [], actor);
        const history = await requireReadyModuleHandle(second, PROJECT_HISTORY_MODULE_TOKEN).history;
        expect(history).not.toBeNull();
        const detailTimeline = await history!.timeline(detail.path);
        expect(detailTimeline.map(({entry}) => entry.operation.type)).toEqual(["file.create", "file.edit"]);
        expect(detailTimeline.at(-1)?.entry.actor).toEqual(actor);
        expect((await history!.timeline("outline/manifest.yaml")).at(-1)?.entry.actor).toEqual(actor);
        const {planId: unrelatedPlan} = await applyReadyLibraryAction(second,
            {kind: "create-plan", title: "独立方案"}, (await openProjectPlanning(ref)).manifest.revision, actor);
        await applyReadyLibraryAction(second, {kind: "create-entry", planId: unrelatedPlan!, parentId: totalId!,
            entryKind: "chapter", title: "独立章节", body: "不影响原方案"}, (await openProjectPlanning(ref)).manifest.revision, actor);
        expect((await openProjectPlanning(ref)).entries.find(({value}) => value.id === detailId)?.value.analysis?.reportId)
            .toBe(reissued.report.reportId);
        await closeProject(ref, "shutdown");
        const reopened = await openProject(ref, {kind: "job", source: "outline-detail-reopen-test"}, workspaceRoot);
        const adopted = (await openProjectPlanning(ref)).entries.find(({value}) => value.id === detailId)!;
        expect(adopted.value).toMatchObject({status: "adopted", analysis: {reportId: reissued.report.reportId}});
        const beforeRename = (await openProjectPlanning(ref)).manifest.revision;
        await applyReadyLibraryAction(reopened, {kind: "rename-plan", planId: unrelatedPlan!, title: "独立新方案"}, beforeRename, actor);
        expect((await openProjectPlanning(ref)).entries.find(({value}) => value.id === detailId)?.value.analysis?.reportId)
            .toBe(reissued.report.reportId);
        await expect(applyReadyLibraryAction(reopened, {kind: "rename-plan", planId: planId!, title: "主方案"}, beforeRename, actor))
            .rejects.toMatchObject({code: "MANIFEST_REVISION_CONFLICT"});
        const renamed = await applyReadyLibraryAction(reopened, {kind: "rename-plan", planId: planId!, title: "主方案"},
            (await openProjectPlanning(ref)).manifest.revision, actor);
        const updated = await openProjectPlanning(ref);
        expect(updated.manifest.plans.find(({id}) => id === planId)?.title).toBe("主方案");
        expect(updated.entries.find(({value}) => value.id === detailId)?.value).toMatchObject({status: "draft"});
        expect(updated.entries.find(({value}) => value.id === detailId)?.value.analysis).toBeUndefined();
        expect((await history!.timeline(detail.path)).at(-1)?.entry.actor).toEqual(actor);
        await closeProject(ref, "shutdown");
        await openProject(ref, {kind: "job", source: "outline-detail-rename-test"}, workspaceRoot);
        expect((await openProjectPlanning(ref)).entries.find(({value}) => value.id === detailId)?.value.status).toBe("draft");
        await undoProjectPlanning(ref, renamed.transactionId, actor);
        expect((await openProjectPlanning(ref)).entries.find(({value}) => value.id === detailId)?.value.analysis?.reportId)
            .toBe(reissued.report.reportId);
    }, 20_000);
    it("attaching an adopted detail to a second plan revokes its analysis and fixed chapter line across reopen", async () => {
        const root = await createTestTmpRoot("outline-lifecycle", "outline-detail-attach");
        roots.push(root);
        const workspaceRoot = absoluteFsPath(path.join(root, "workspace"));
        const projectRoot = path.join(workspaceRoot, "novel");
        await fs.mkdir(projectRoot, {recursive: true});
        await fs.writeFile(path.join(projectRoot, "project.yaml"), "kind: novel\ntitle: novel\nsummary: ''\n", "utf8");
        const ref = projectWorkspaceRef("novel");
        const ready = await openProject(ref, {kind: "job", source: "outline-detail-attach-test"}, workspaceRoot);
        await openProjectPlanning(ref);
        const apply = async (action: Parameters<typeof applyReadyLibraryAction>[1]) =>
            applyReadyLibraryAction(ready, action, (await openProjectPlanning(ref)).manifest.revision, actor);
        const {entryId: totalId} = await apply({kind: "create-total", title: "总纲", body: "故事"});
        const {planId: planA} = await apply({kind: "create-plan", title: "甲"});
        const {planId: planB} = await apply({kind: "create-plan", title: "乙"});
        const {entryId: chapterId} = await apply({kind: "create-entry", planId: planA!, parentId: totalId!,
            entryKind: "chapter", title: "第一章", body: "事件"});
        const {entryId: nextId} = await apply({kind: "create-entry", planId: planA!, parentId: totalId!,
            entryKind: "chapter", title: "第二章", body: "后续"});
        for (const id of [chapterId!, nextId!]) {
            const chapter = (await openProjectPlanning(ref)).entries.find(({value}) => value.id === id)!;
            await apply({kind: "adopt-entry", planId: planA!, entryId: id,
                expectedVersion: chapter.value.version, expectedContentHash: chapter.contentHash});
        }
        await apply({kind: "attach-entry", planId: planB!, parentId: totalId!, entryId: chapterId!});
        const {entryId: detailId} = await apply({kind: "create-entry", planId: planA!, parentId: chapterId!,
            entryKind: "detail", title: "片段", body: "行动"});
        const before = await openProjectPlanning(ref);
        const detail = before.entries.find(({value}) => value.id === detailId)!;
        const request = {planId: planA!, entryId: detailId!, expectedRevision: before.manifest.revision,
            expectedVersion: detail.value.version, expectedContentHash: detail.contentHash};
        const issued = await analyzeReadyDetail(ready, request);
        await adoptReadyDetail(ready, request, issued.report.reportId, true, [], actor);
        const lineId = await fixChainLine(ready, ref, planA!, [chapterId!, nextId!], "固定章节线");
        const adopted = (await openProjectPlanning(ref)).entries.find(({value}) => value.id === detailId)!;
        expect(adopted.value.analysis?.reportId).toBe(issued.report.reportId);
        await apply({kind: "attach-entry", planId: planB!, parentId: chapterId!, entryId: detailId!});
        await closeProject(ref, "shutdown");
        await openProject(ref, {kind: "job", source: "outline-detail-attach-test"}, workspaceRoot);
        const restored = await openProjectPlanning(ref);
        expect(restored.manifest.plans.find(({id}) => id === planA)?.placements.some(({entryId}) => entryId === detailId)).toBe(true);
        expect(restored.manifest.plans.find(({id}) => id === planB)?.placements.some(({entryId}) => entryId === detailId)).toBe(true);
        expect(restored.entries.find(({value}) => value.id === detailId)?.value).toMatchObject({status: "draft", version: 2});
        expect(restored.entries.find(({value}) => value.id === detailId)?.value.analysis).toBeUndefined();
        expect(restored.lines.find(({value}) => value.id === lineId)?.value).toMatchObject({fixed: false, version: 2});
        expect(await fs.readFile(path.join(projectRoot, adopted.path), "utf8")).not.toContain(issued.report.reportId);
    }, 30_000);
    it("moves an adopted chapter across parents in a ready Project, invalidates its fixed line and restores through undo", async () => {
        const root = await createTestTmpRoot("outline-lifecycle", "outline-ready-move");
        roots.push(root);
        const workspaceRoot = absoluteFsPath(path.join(root, "workspace"));
        const projectRoot = path.join(workspaceRoot, "novel");
        await fs.mkdir(projectRoot, {recursive: true});
        await fs.writeFile(path.join(projectRoot, "project.yaml"), "kind: novel\ntitle: novel\nsummary: ''\n", "utf8");
        const ref = projectWorkspaceRef("novel");
        const ready = await openProject(ref, {kind: "job", source: "outline-ready-move-test"}, workspaceRoot);
        await openProjectPlanning(ref);
        const apply = async (action: Parameters<typeof applyReadyLibraryAction>[1]) =>
            applyReadyLibraryAction(ready, action, (await openProjectPlanning(ref)).manifest.revision, actor);
        const {entryId: totalId} = await apply({kind: "create-total", title: "总纲", body: "故事"});
        const {planId} = await apply({kind: "create-plan", title: "方案"});
        const {entryId: volumeId} = await apply({kind: "create-entry", planId: planId!, parentId: totalId!,
            entryKind: "volume", title: "第一卷", body: "第一卷情节"});
        const {entryId: chapterId} = await apply({kind: "create-entry", planId: planId!, parentId: totalId!,
            entryKind: "chapter", title: "第一章", body: "第一章情节"});
        const {entryId: nextId} = await apply({kind: "create-entry", planId: planId!, parentId: totalId!,
            entryKind: "chapter", title: "第二章", body: "第二章情节"});
        for (const id of [chapterId!, nextId!]) {
            const draft = (await openProjectPlanning(ref)).entries.find(({value}) => value.id === id)!;
            await apply({kind: "adopt-entry", planId: planId!, entryId: id,
                expectedVersion: draft.value.version, expectedContentHash: draft.contentHash});
        }
        const lineId = await fixChainLine(ready, ref, planId!, [chapterId!, nextId!], "固定章节");
        const adopted = (await openProjectPlanning(ref)).entries.find(({value}) => value.id === chapterId)!;
        const oldBytes = await fs.readFile(path.join(projectRoot, adopted.path), "utf8");
        const {planId: secondPlan} = await apply({kind: "create-plan", title: "备用方案"});
        await apply({kind: "attach-entry", planId: secondPlan!, parentId: totalId!, entryId: chapterId!});
        await expect(apply({kind: "move-entry", planId: planId!, entryId: chapterId!, parentId: volumeId!,
            expectedVersion: adopted.value.version, expectedContentHash: adopted.contentHash})).rejects.toThrow(/共享/);
        expect(await fs.readFile(path.join(projectRoot, adopted.path), "utf8")).toBe(oldBytes);
        const preview = await previewReadyPlanningPlacementRemoval(ready, secondPlan!, chapterId!);
        expect(preview.impact).toMatchObject({objectFileRemains: true, childReferences: []});
        await removeReadyPlanningPlacement(ready, secondPlan!, chapterId!, preview.revision, actor);
        await expect(applyReadyLibraryAction(ready, {kind: "move-entry", planId: planId!, entryId: chapterId!,
            parentId: volumeId!, expectedVersion: -1, expectedContentHash: adopted.contentHash},
        (await openProjectPlanning(ref)).manifest.revision, actor)).rejects.toMatchObject({code: "CAS_CONFLICT"});
        expect(await fs.readFile(path.join(projectRoot, adopted.path), "utf8")).toBe(oldBytes);
        const receipt = await apply({kind: "move-entry", planId: planId!, entryId: chapterId!, parentId: volumeId!,
            expectedVersion: adopted.value.version, expectedContentHash: adopted.contentHash});
        await closeProject(ref, "shutdown");
        await openProject(ref, {kind: "job", source: "outline-ready-move-test"}, workspaceRoot);
        const moved = await openProjectPlanning(ref);
        expect(moved.entries.find(({value}) => value.id === chapterId)).toMatchObject({path: adopted.path,
            value: {parentId: volumeId, version: 2, status: "draft"}});
        expect(moved.manifest.plans[0]?.placements.find(({entryId}) => entryId === chapterId)?.parentId).toBe(volumeId);
        expect(moved.lines.find(({value}) => value.id === lineId)?.value).toMatchObject({fixed: false, version: 2});
        expect(await undoProjectPlanning(ref, receipt.transactionId, actor)).toMatchObject({kind: "undone"});
        const restored = await openProjectPlanning(ref);
        expect(restored.entries.find(({value}) => value.id === chapterId)).toMatchObject({path: adopted.path,
            value: {parentId: totalId, version: 1, status: "adopted"}});
        expect(restored.manifest.plans[0]?.placements.find(({entryId}) => entryId === chapterId)?.parentId).toBe(totalId);
        expect(restored.lines.find(({value}) => value.id === lineId)?.value).toMatchObject({fixed: true, version: 1});
        expect(await fs.readFile(path.join(projectRoot, adopted.path), "utf8")).toBe(oldBytes);
    }, 30_000);
    it("forks a shared detail through the ready Project, survives reopen and can undo without touching the source", async () => {
        const root = await createTestTmpRoot("outline-lifecycle", "outline-ready-detail-fork");
        roots.push(root);
        const workspaceRoot = absoluteFsPath(path.join(root, "workspace"));
        const projectRoot = path.join(workspaceRoot, "novel");
        await fs.mkdir(projectRoot, {recursive: true});
        await fs.writeFile(path.join(projectRoot, "project.yaml"), "kind: novel\ntitle: novel\nsummary: ''\n", "utf8");
        const ref = projectWorkspaceRef("novel");
        const ready = await openProject(ref, {kind: "job", source: "outline-lifecycle-test"}, workspaceRoot);
        await openProjectPlanning(ref);
        const {entryId: totalId} = await applyReadyLibraryAction(ready,
            {kind: "create-total", title: "总纲", body: "起点"}, 0, actor);
        const {planId: planA} = await applyReadyLibraryAction(ready, {kind: "create-plan", title: "A"}, 1, actor);
        const {planId: planB} = await applyReadyLibraryAction(ready, {kind: "create-plan", title: "B"}, 2, actor);
        const {entryId: chapterId} = await applyReadyLibraryAction(ready,
            {kind: "create-entry", planId: planA!, parentId: totalId!, entryKind: "chapter", title: "章节", body: "进展"}, 3, actor);
        const {entryId: detailId} = await applyReadyLibraryAction(ready,
            {kind: "create-entry", planId: planA!, parentId: chapterId!, entryKind: "detail", title: "细纲", body: "初稿"}, 4, actor);
        await applyReadyLibraryAction(ready, {kind: "attach-entry", planId: planB!, parentId: totalId!, entryId: chapterId!}, 5, actor);
        await applyReadyLibraryAction(ready, {kind: "attach-entry", planId: planB!, parentId: chapterId!, entryId: detailId!}, 6, actor);
        const before = await openProjectPlanning(ref);
        const source = before.entries.find(({value}) => value.id === detailId)!;
        const sourceBytes = await fs.readFile(path.join(projectRoot, source.path), "utf8");
        await expect(forkReadyLibraryEntry(ready, {planId: planB!, sourceId: detailId!, title: "另一版细纲",
            body: "新初稿", expectedRevision: 6}, actor)).rejects.toMatchObject({code: "MANIFEST_REVISION_CONFLICT"});
        const fork = await forkReadyLibraryEntry(ready, {planId: planB!, sourceId: detailId!, title: "另一版细纲",
            body: "新初稿", expectedRevision: before.manifest.revision}, actor);
        await closeProject(ref, "shutdown");
        await openProject(ref, {kind: "job", source: "outline-lifecycle-test"}, workspaceRoot);
        const restored = await openProjectPlanning(ref);
        expect(restored.manifest.plans.find(({id}) => id === planA)?.placements.some(({entryId}) => entryId === detailId)).toBe(true);
        expect(restored.manifest.plans.find(({id}) => id === planB)?.placements.some(({entryId}) => entryId === fork.entryId)).toBe(true);
        expect(restored.entries.find(({value}) => value.id === fork.entryId)?.value).toMatchObject({
            parentId: chapterId, chapterId, status: "draft", version: 0,
        });
        expect(await fs.readFile(path.join(projectRoot, source.path), "utf8")).toBe(sourceBytes);
        expect(await undoProjectPlanning(ref, fork.transactionId, actor)).toMatchObject({kind: "undone"});
        const undone = await openProjectPlanning(ref);
        expect(undone.entries.some(({value}) => value.id === fork.entryId)).toBe(false);
        expect(undone.manifest.plans.find(({id}) => id === planB)?.placements.some(({entryId}) => entryId === detailId)).toBe(true);
        expect(await fs.readFile(path.join(projectRoot, source.path), "utf8")).toBe(sourceBytes);
    });
});




