import fs from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {testHostPath} from "@notnotype/neuro-book-test-support/test-path";
import {absoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {projectWorkspaceRef} from "nbook/server/workspace-files/project-identity";
import {writeProjectManifest} from "nbook/server/workspace-files/project-workspace";
import {closeAllProjects, openProject, resetProjectSessionsForTest} from "nbook/server/workspace-files/project-session";
import {applyReadyForeshadowingAction, applyReadyLibraryAction, openReadyPlanning} from "nbook/server/outline/host";
import {publishPlanningFiles, readPlanningSnapshot} from "nbook/server/outline/index";
import {prepareDetailAdoption} from "nbook/server/outline/library";
import {contentHash, type OutlineId} from "nbook/server/outline/format";
import type {ReadyProjectSessionRef} from "nbook/server/workspace-files/project-session-types";
import {createPlanningTools} from "./planning-tools";
import type {NeuroToolResult, ToolExecutionContext} from "./types";

const tools = new Map(createPlanningTools().map(tool => [tool.key, tool]));
const payload = (output: NeuroToolResult) => JSON.parse(output.content[0]!.type === "text" ? output.content[0]!.text : "{}");

describe("素材改编的真实工具预览与发布", () => {
    let root: string;
    let ready: ReadyProjectSessionRef;
    let context: ToolExecutionContext;
    let sourcePlanId: string;
    let sourceChapterId: OutlineId;
    let targetPlanId: string;
    let targetTotalId: OutlineId;

    const actor = {kind: "user" as const, userId: "local"};
    const invoke = async (key: string, input: unknown) => payload(await tools.get(key)!.executeWithContext!(context, key, input));
    const current = () => readPlanningSnapshot({projectRoot: ready.workspace.root});

    beforeEach(async () => {
        resetProjectSessionsForTest();
        root = testHostPath(`neuro-book-adaptation-tools-${randomUUID()}`);
        const workspaceRoot = absoluteFsPath(path.join(root, "workspace"));
        await fs.mkdir(workspaceRoot, {recursive: true});
        const ref = projectWorkspaceRef("adaptation-tools");
        await writeProjectManifest(workspaceRoot, ref, {kind: "novel", title: "改编工具测试", summary: ""});
        ready = await openProject(ref, {kind: "job", source: "adaptation-tools-test"}, workspaceRoot);
        await openReadyPlanning(ready);
        const source = await applyReadyLibraryAction(ready, {kind: "create-plan", title: "原作"}, 0, actor);
        sourcePlanId = source.planId!;
        const chapter = await applyReadyLibraryAction(ready, {kind: "create-entry", planId: sourcePlanId,
            parentId: source.entryId!, entryKind: "chapter", title: "原作章节", body: "原作任务"}, 1, actor);
        sourceChapterId = chapter.entryId!;
        const target = await applyReadyLibraryAction(ready, {kind: "create-plan", title: "改编"}, 2, actor);
        targetPlanId = target.planId!;
        targetTotalId = target.entryId!;
        const material = path.join(ready.workspace.root, "lorebook/character/甲/index.md");
        await fs.mkdir(path.dirname(material), {recursive: true});
        await fs.writeFile(material, "原作角色基础资料");
        context = {sessionId: 901, profileKey: "outline.planner", currentProject: ready,
            workspaceRoot, agentMode: "discuss"} as ToolExecutionContext;
    });

    afterEach(async () => {
        await closeAllProjects();
        resetProjectSessionsForTest();
        await fs.rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
    });

    const updates = [{materialPath: "lorebook/character/甲/index.md", kind: "experience", body: "甲计划拒绝任务"}];
    const createAction = () => ({kind: "create-entry", planId: targetPlanId, parentId: targetTotalId,
        entryKind: "chapter", title: "改编第一章", body: "甲拒绝任务",
        adaptation: {kind: "chapter", sourcePlanId, sourceEntryId: sourceChapterId}, materialUpdates: updates});

    it("重复预览不落盘，实际保存的全部路径与字节哈希等于预览，撤销同时撤下新经历", async () => {
        const change = {operation: "mutate", expectedRevision: 3, action: createAction()};
        const first = await invoke("preview_planning_change", change);
        const second = await invoke("preview_planning_change", change);
        expect(second).toMatchObject({proposalId: first.proposalId, files: first.files});
        expect(first.files).toEqual(expect.arrayContaining([expect.objectContaining({
            relativePath: expect.stringContaining(`/改编中的新经历/${targetPlanId}/`),
        })]));
        expect((await current()).manifest.revision).toBe(3);
        const record = first.files.find((file: {relativePath: string}) => file.relativePath.startsWith("lorebook/"));
        await expect(fs.access(path.join(ready.workspace.root, record.relativePath))).rejects.toThrow();
        const applied = await invoke("apply_planning_change", {changes: [{...change, proposalId: first.proposalId}]});
        expect(applied.partialFailure).toBe(false);
        for (const file of first.files) {
            const content = await fs.readFile(path.join(ready.workspace.root, file.relativePath), "utf8");
            expect(contentHash(content)).toBe(file.contentHash);
            expect(Buffer.byteLength(content)).toBe(file.bytes);
        }
        expect(await fs.readFile(path.join(ready.workspace.root, updates[0]!.materialPath), "utf8")).toBe("原作角色基础资料");
        const saved = await current();
        expect(saved.entries.find(entry => entry.value.title === "改编第一章")!.value.adaptation).toEqual(change.action.adaptation);
        await invoke("undo_planning_change", {transactionId: applied.results[0].transactionId});
        expect((await current()).entries.some(entry => entry.value.title === "改编第一章")).toBe(false);
        await expect(fs.access(path.join(ready.workspace.root, record.relativePath))).rejects.toThrow();
    });

    it("审批后的素材正文被更换会拒绝，缺失对象的预览不会创建素材", async () => {
        const change = {operation: "mutate", expectedRevision: 3, action: createAction()};
        const preview = await invoke("preview_planning_change", change);
        const modified = {...change, action: {...change.action, materialUpdates: [{...updates[0], body: "未经预览的经历"}]}};
        const applied = await invoke("apply_planning_change", {changes: [{...modified, proposalId: preview.proposalId}]});
        expect(applied.partialFailure).toBe(true);
        expect(applied.results[0].error).toContain("预览");
        expect((await current()).manifest.revision).toBe(3);
        await expect(invoke("preview_planning_change", {...change, action: {...change.action,
            materialUpdates: [{...updates[0], materialPath: "lorebook/character/不存在/index.md"}]}})).rejects.toThrow();
        await expect(fs.access(path.join(ready.workspace.root, "lorebook/character/不存在"))).rejects.toThrow();
    });

    it("修改上游的预览包含已采用细纲失效及它的关联记录，实际字节与预览一致", async () => {
        const chapterId = (await applyReadyLibraryAction(ready, {kind: "create-entry", planId: targetPlanId,
            parentId: targetTotalId, entryKind: "chapter", title: "上游章节", body: "原剧情"}, 3, actor)).entryId!;
        const detailId = (await applyReadyLibraryAction(ready, {kind: "create-entry", planId: targetPlanId,
            parentId: chapterId, entryKind: "detail", title: "关联细纲", body: "细纲剧情",
            materialUpdates: [{materialPath: updates[0]!.materialPath, kind: "experience", body: "细纲中的新经历"}]}, 4, actor)).entryId!;
        const beforeAdoption = await current();
        const detail = beforeAdoption.entries.find(entry => entry.value.id === detailId)!;
        // 存储fixture签发报告，验证上游改动的发布集合，不调用真实语义审阅模型。
        const adoption = prepareDetailAdoption(beforeAdoption, detailId, targetPlanId, {
            reportId: randomUUID(), planId: targetPlanId, sourceHash: detail.contentHash,
            contextHash: contentHash("fixture-context"), summary: "fixture无冲突", deviations: [], conflicts: [], resolutions: [],
        });
        await publishPlanningFiles({projectRoot: ready.workspace.root}, adoption.publish);
        const before = await current();
        const chapter = before.entries.find(entry => entry.value.id === chapterId)!;
        const change = {operation: "mutate", expectedRevision: before.manifest.revision, action: {
            kind: "edit-entry", planId: targetPlanId, entryId: chapterId, expectedVersion: chapter.value.version,
            expectedContentHash: chapter.contentHash, title: chapter.value.title, body: "修改后的剧情",
        }};
        const preview = await invoke("preview_planning_change", change);
        expect(preview.files).toEqual(expect.arrayContaining([
            expect.objectContaining({relativePath: detail.path}),
            expect.objectContaining({relativePath: expect.stringContaining(`/改编中的新经历/${targetPlanId}/${detailId}.md`)}),
        ]));
        expect((await current()).entries.find(entry => entry.value.id === detailId)!.value.status).toBe("adopted");
        const applied = await invoke("apply_planning_change", {changes: [{...change, proposalId: preview.proposalId}]});
        expect(applied.partialFailure).toBe(false);
        expect((await current()).entries.find(entry => entry.value.id === detailId)!.value.status).toBe("draft");
        for (const file of preview.files) {
            expect(contentHash(await fs.readFile(path.join(ready.workspace.root, file.relativePath), "utf8"))).toBe(file.contentHash);
        }
    });

    it("有改编记录的章节仍能经伏笔建议同步核对并提交，上下文暴露待维护信息", async () => {
        const change = {operation: "mutate", expectedRevision: 3, action: createAction()};
        const preview = await invoke("preview_planning_change", change);
        expect((await invoke("apply_planning_change", {changes: [{...change, proposalId: preview.proposalId}]})).partialFailure).toBe(false);
        const foreshadowingId = (await applyReadyForeshadowingAction(ready,
            {kind: "create-foreshadowing", title: "拒绝的缘由", body: "任务背后的秘密"}, 4, actor)).foreshadowingId;
        const before = await current();
        const chapter = before.entries.find(entry => entry.value.title === change.action.title)!;
        const read = await invoke("get_foreshadowing_context", {entryIds: [chapter.value.id]});
        expect(read.entries[0].materialUpdates).toEqual(updates);
        const input = {action: "plant", expectedRevision: before.manifest.revision, planId: targetPlanId,
            entryId: chapter.value.id, foreshadowingId, expectedVersion: chapter.value.version,
            expectedContentHash: chapter.contentHash,
            body: `${chapter.value.body}<!-- nb:foreshadow marker="fm-secret" foreshadow="${foreshadowingId}" action="plant" -->甲发现秘密<!-- /nb:foreshadow marker="fm-secret" -->`,
            rationale: "解释拒绝的原因",
        };
        await expect(invoke("suggest_foreshadowing_marker", input)).rejects.toThrow(/materialUpdates/);
        const suggested = await invoke("suggest_foreshadowing_marker", {...input,
            materialUpdates: [{...updates[0], body: "甲发现任务的秘密，决定拒绝"}]});
        const mutation = {operation: suggested.change.operation, expectedRevision: suggested.change.expectedRevision, action: suggested.change.action};
        const materialPreview = await invoke("preview_planning_change", mutation);
        const applied = await invoke("apply_planning_change", {changes: [{...mutation, proposalId: materialPreview.proposalId}]});
        expect(applied.partialFailure).toBe(false);
        expect((await current()).entries.find(entry => entry.value.id === chapter.value.id)!.value.materialUpdates?.[0]?.body).toBe("甲发现任务的秘密，决定拒绝");
    });
});
