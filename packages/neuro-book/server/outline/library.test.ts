import fs from "node:fs/promises";
import path from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import {createEmptyManifest, serializeManifest, type OutlineId, type OutlineLineType} from "./format";
import {publishPlanningFiles, readPlanningSnapshot} from "./index";
import {getLibraryTrees, prepareLibraryAction, type LibraryAction} from "./library";
import {analyzeLine, confirmLine} from "./line-analysis";
import {findPlanGraph, prepareLineAction, type LineAction} from "./line-planning";
import {inspectPlanningPlan, preparePlanningPlanRemoval} from "./operations";
import {createOutlineRepository} from "./repository";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true}))));

async function setup() {
    const projectRoot = await createTestTmpRoot("outline-library", "outline-phase2-tree");
    roots.push(projectRoot);
    await createOutlineRepository({projectRoot}).ensureLayout(serializeManifest(createEmptyManifest()));
    const perform = async (action: LibraryAction) => {
        const change = prepareLibraryAction(await readPlanningSnapshot({projectRoot}), action);
        await publishPlanningFiles({projectRoot}, change.publish);
        return change;
    };
    const line = async (action: LineAction) => {
        const change = prepareLineAction(await readPlanningSnapshot({projectRoot}), action);
        await publishPlanningFiles({projectRoot}, change.publish);
        return change;
    };
    const adopt = async (planId: string, entryId: OutlineId) => {
        const source = (await readPlanningSnapshot({projectRoot})).entries.find(({value}) => value.id === entryId)!;
        await perform({kind: "adopt-entry", planId, entryId, expectedVersion: source.value.version,
            expectedContentHash: source.contentHash});
    };
    /** 按格号依次放置已采用条目并首尾相连，建出一条经分析固定的线路。 */
    const fixedLine = async (planId: string, entryIds: readonly OutlineId[], type: OutlineLineType = "main") => {
        const nodeIds: OutlineId[] = [];
        for (const [column, entryId] of entryIds.entries()) {
            const graph = findPlanGraph(await readPlanningSnapshot({projectRoot}), planId);
            nodeIds.push((await line({kind: "add-graph-node", planId, expectedGraphVersion: graph?.value.version ?? 0,
                column, row: 0, entryId})).nodeId!);
        }
        for (let index = 1; index < nodeIds.length; index += 1) {
            const graph = findPlanGraph(await readPlanningSnapshot({projectRoot}), planId)!;
            await line({kind: "connect-graph-nodes", planId, expectedGraphVersion: graph.value.version,
                from: nodeIds[index - 1]!, to: nodeIds[index]!});
        }
        const lineId = (await line({kind: "create-line", planId, title: "主线", type, nodeIds})).lineId!;
        const snapshot = await readPlanningSnapshot({projectRoot});
        const source = snapshot.lines.find(({value}) => value.id === lineId)!;
        const request = {lineId, expectedRevision: snapshot.manifest.revision, expectedVersion: source.value.version,
            expectedContentHash: source.contentHash};
        const issued = await analyzeLine(snapshot, request, async () => JSON.stringify({summary: "通过", conflicts: []}));
        await publishPlanningFiles({projectRoot}, confirmLine(snapshot, request, issued, issued.report.reportId, []));
        return lineId;
    };
    return {projectRoot, perform, line, adopt, fixedLine};
}

describe("大纲库方案链", () => {
    it("创建唯一总纲、两个方案链与共享章节，关闭后从文件重建阶梯树", async () => {
        const {projectRoot, perform} = await setup();
        const totalId = (await perform({kind: "create-total", title: "总纲", body: "主题"})).entryId!;
        const planA = (await perform({kind: "create-plan", title: "方案甲"})).planId!;
        const planB = (await perform({kind: "create-plan", title: "方案乙"})).planId!;
        await expect(perform({kind: "rename-plan", planId: planA, title: "  "})).rejects.toThrow(/标题/);
        await expect(perform({kind: "rename-plan", planId: planA, title: "方案甲"})).rejects.toThrow(/相同/);
        const renamed = await perform({kind: "rename-plan", planId: planA, title: "  新方案  "});
        expect(renamed.planId).toBe(planA);
        const volumeId = (await perform({kind: "create-entry", planId: planA, parentId: totalId, entryKind: "volume", title: "第一卷", body: "卷简介"})).entryId!;
        const chapterId = (await perform({kind: "create-entry", planId: planA, parentId: volumeId, entryKind: "chapter", title: "第一章", body: "章节情节"})).entryId!;
        await perform({kind: "attach-entry", planId: planB, parentId: totalId, entryId: volumeId});
        await perform({kind: "attach-entry", planId: planB, parentId: volumeId, entryId: chapterId});
        const snapshot = await readPlanningSnapshot({projectRoot});
        expect(snapshot.entries.find((item) => item.value.id === chapterId)?.value.status).toBe("draft");
        expect(snapshot.manifest.plans.map(({title}) => title)).toEqual(["新方案", "方案乙"]);
        expect(getLibraryTrees(snapshot).map((plan) => plan.root.children[0]?.children[0]?.entry.id)).toEqual([chapterId, chapterId]);
        expect(snapshot.entries.filter((item) => item.value.id === totalId)).toHaveLength(1);
        await expect(perform({kind: "create-total", title: "第二总纲", body: ""})).rejects.toThrow(/已经存在/);
        await expect(perform({kind: "attach-entry", planId: planB, parentId: totalId, entryId: chapterId})).rejects.toThrow(/父级关系/);
        await expect(perform({kind: "create-entry", planId: planB, parentId: chapterId, entryKind: "volume", title: "逆序", body: ""})).rejects.toThrow(/层级/);
        const later = (await perform({kind: "create-entry", planId: planA, parentId: volumeId, entryKind: "chapter", title: "第二章", body: ""})).entryId!;
        await perform({kind: "reorder-entry", planId: planA, entryId: later, siblingIndex: 0});
        const reordered = await readPlanningSnapshot({projectRoot});
        expect(getLibraryTrees(reordered).find((plan) => plan.id === planA)?.root.children[0]?.children.map((node) => node.entry.id)).toEqual([later, chapterId]);
        expect(getLibraryTrees(reordered).find((plan) => plan.id === planB)?.root.children[0]?.children.map((node) => node.entry.id)).toEqual([chapterId]);
        expect(reordered.entries.find((item) => item.value.id === chapterId)?.value.version).toBe(0);
    });

    it("方案链标题归一化后保持唯一，重复创建或改名不发布规范文件", async () => {
        const {projectRoot, perform} = await setup();
        await perform({kind: "create-total", title: "总纲", body: ""});
        const first = (await perform({kind: "create-plan", title: "甲"})).planId!;
        const second = (await perform({kind: "create-plan", title: "乙"})).planId!;
        const before = await readPlanningSnapshot({projectRoot});
        await expect(perform({kind: "create-plan", title: " 甲 "})).rejects.toThrow(/同名/);
        await expect(perform({kind: "rename-plan", planId: second, title: " 甲 "})).rejects.toThrow(/同名/);
        const after = await readPlanningSnapshot({projectRoot});
        expect(after.manifest).toEqual(before.manifest);
        expect(after.manifest.plans.map(({id}) => id)).toEqual([first, second]);
    });

    it("预览并移除方案只解除关系，不删除专属或共享条目文件；一并删除其线路图与草稿线路，固定线路阻止移除", async () => {
        const {projectRoot, perform, line, adopt, fixedLine} = await setup();
        const totalId = (await perform({kind: "create-total", title: "总纲", body: ""})).entryId!;
        const planA = (await perform({kind: "create-plan", title: "甲"})).planId!;
        const planB = (await perform({kind: "create-plan", title: "乙"})).planId!;
        const exclusiveId = (await perform({kind: "create-entry", planId: planA, parentId: totalId,
            entryKind: "chapter", title: "专属章", body: ""})).entryId!;
        const sharedId = (await perform({kind: "create-entry", planId: planA, parentId: totalId,
            entryKind: "chapter", title: "共享章", body: ""})).entryId!;
        await perform({kind: "attach-entry", planId: planB, parentId: totalId, entryId: sharedId});
        expect(inspectPlanningPlan(await readPlanningSnapshot({projectRoot}), planA)).toMatchObject({planId: planA,
            exclusiveEntryIds: [exclusiveId], placementIds: [totalId, exclusiveId, sharedId], objectFilesRemain: true,
            canRemovePlan: true, graphId: null, draftLineIds: [], blockingFixedLineIds: []});
        await adopt(planA, exclusiveId);
        await adopt(planA, sharedId);
        const lineId = await fixedLine(planA, [exclusiveId, sharedId]);
        const blocked = await readPlanningSnapshot({projectRoot});
        const graph = findPlanGraph(blocked, planA)!;
        expect(inspectPlanningPlan(blocked, planA)).toMatchObject({canRemovePlan: false, blockingFixedLineIds: [lineId],
            graphId: graph.value.id, draftLineIds: []});
        expect(() => preparePlanningPlanRemoval(blocked, planA)).toThrow(/固定线路/);
        const fixed = blocked.lines.find(({value}) => value.id === lineId)!;
        await line({kind: "reopen-fixed-line", lineId, expectedVersion: fixed.value.version,
            expectedContentHash: fixed.contentHash, confirmReopen: true});
        const before = await readPlanningSnapshot({projectRoot});
        const exclusive = before.entries.find(({value}) => value.id === exclusiveId)!;
        const exclusiveBytes = await fs.readFile(path.join(projectRoot, exclusive.path), "utf8");
        const draftLine = before.lines.find(({value}) => value.id === lineId)!;
        expect(inspectPlanningPlan(before, planA)).toMatchObject({canRemovePlan: true, blockingFixedLineIds: [],
            graphId: graph.value.id, draftLineIds: [lineId]});
        await publishPlanningFiles({projectRoot}, preparePlanningPlanRemoval(before, planA));
        const after = await readPlanningSnapshot({projectRoot});
        expect(getLibraryTrees(after).map(({id}) => id)).toEqual([planB]);
        expect(after.manifest.plans[0]?.placements.map(({entryId}) => entryId)).toEqual([totalId, sharedId]);
        expect(after.entries.find(({value}) => value.id === exclusiveId)?.contentHash).toBe(exclusive.contentHash);
        expect(await fs.readFile(path.join(projectRoot, exclusive.path), "utf8")).toBe(exclusiveBytes);
        expect(after.graphs).toEqual([]);
        expect(after.lines).toEqual([]);
        expect(after.manifest).toMatchObject({graphs: [], lines: []});
        await expect(fs.stat(path.join(projectRoot, graph.path))).rejects.toMatchObject({code: "ENOENT"});
        await expect(fs.stat(path.join(projectRoot, draftLine.path))).rejects.toMatchObject({code: "ENOENT"});
        expect(() => preparePlanningPlanRemoval(after, planA)).toThrow(/不存在/);
    });
    it("只有明确确认的非细纲草稿可正式采用，且过期版本不能改变状态", async () => {
        const {projectRoot, perform} = await setup();
        const totalId = (await perform({kind: "create-total", title: "总纲", body: "主题"})).entryId!;
        const planId = (await perform({kind: "create-plan", title: "方案"})).planId!;
        const chapterId = (await perform({kind: "create-entry", planId, parentId: totalId, entryKind: "chapter", title: "第一章", body: "情节"})).entryId!;
        const detailId = (await perform({kind: "create-entry", planId, parentId: chapterId, entryKind: "detail", title: "片段", body: "场景"})).entryId!;
        const before = await readPlanningSnapshot({projectRoot});
        const chapter = before.entries.find(({value}) => value.id === chapterId)!;
        const adopt = {kind: "adopt-entry" as const, planId, entryId: chapterId,
            expectedVersion: chapter.value.version, expectedContentHash: chapter.contentHash};
        await expect(perform({...adopt, expectedContentHash: "sha256:" + "0".repeat(64)})).rejects.toMatchObject({code: "CAS_CONFLICT"});
        await perform(adopt);
        const adopted = await readPlanningSnapshot({projectRoot});
        expect(adopted.entries.find(({value}) => value.id === chapterId)?.value).toMatchObject({status: "adopted", version: 1, body: "情节"});
        await expect(perform(adopt)).rejects.toMatchObject({code: "CAS_CONFLICT"});
        const detail = adopted.entries.find(({value}) => value.id === detailId)!;
        await expect(perform({kind: "adopt-entry", planId, entryId: detailId,
            expectedVersion: detail.value.version, expectedContentHash: detail.contentHash})).rejects.toThrow(/分析/);
        expect((await readPlanningSnapshot({projectRoot})).entries.find(({value}) => value.id === detailId)?.value.status).toBe("draft");
    });

    it("章节和细纲草稿在关闭重开后保留素材、指导与篇幅，不接受越界引用", async () => {
        const {projectRoot, perform} = await setup();
        const totalId = (await perform({kind: "create-total", title: "总纲", body: ""})).entryId!;
        const planId = (await perform({kind: "create-plan", title: "方案"})).planId!;
        const chapterId = (await perform({kind: "create-entry", planId, parentId: totalId,
            entryKind: "chapter", title: "第一章", body: "概要", materialRefs: ["lorebook/人物/阿青.md"]})).entryId!;
        const detailId = (await perform({kind: "create-entry", planId, parentId: chapterId, entryKind: "detail",
            title: "第一场", body: "雨夜相遇", materialRefs: ["lorebook/人物/阿青.md"],
            writingGuidance: "视角克制", references: [{path: "research/背景/雨夜.md"}], targetWords: 2400})).entryId!;
        const restored = await readPlanningSnapshot({projectRoot});
        expect(restored.entries.find(({value}) => value.id === chapterId)?.value.materialRefs).toEqual(["lorebook/人物/阿青.md"]);
        expect(restored.entries.find(({value}) => value.id === detailId)?.value).toMatchObject({
            status: "draft", chapterId, materialRefs: ["lorebook/人物/阿青.md"],
            writingGuidance: "视角克制", references: [{path: "research/背景/雨夜.md"}], targetWords: 2400,
        });
        const before = restored.manifest.revision;
        await expect(perform({kind: "create-entry", planId, parentId: chapterId, entryKind: "detail",
            title: "越界", body: "", references: [{path: "../private.md"}]})).rejects.toThrow(/文件引用/);
        expect((await readPlanningSnapshot({projectRoot})).manifest.revision).toBe(before);
    });

    it("编辑采用条目会撤回正式状态、失效固定线路并按版本拒绝过期和共享原地修改", async () => {
        const {projectRoot, perform, adopt, fixedLine} = await setup();
        const totalId = (await perform({kind: "create-total", title: "总纲", body: ""})).entryId!;
        const planId = (await perform({kind: "create-plan", title: "方案一"})).planId!;
        const chapterId = (await perform({kind: "create-entry", planId, parentId: totalId, entryKind: "chapter",
            title: "旧章节", body: "旧内容", materialRefs: ["lorebook/人物/阿青.md"]})).entryId!;
        await adopt(planId, totalId);
        await adopt(planId, chapterId);
        const lineId = await fixedLine(planId, [totalId, chapterId]);
        const before = await readPlanningSnapshot({projectRoot});
        const current = before.entries.find(({value}) => value.id === chapterId)!;
        const action = {kind: "edit-entry" as const, planId, entryId: chapterId, title: "新章节", body: "修改内容",
            expectedVersion: current.value.version, expectedContentHash: current.contentHash, materialRefs: null};
        const change = prepareLibraryAction(before, action);
        await publishPlanningFiles({projectRoot}, change.publish);
        const restored = await readPlanningSnapshot({projectRoot});
        expect(restored.entries.find(({value}) => value.id === chapterId)?.value).toMatchObject({
            title: "新章节", body: "修改内容", version: 2, status: "draft",
        });
        expect(restored.entries.find(({value}) => value.id === chapterId)?.value.materialRefs).toBeUndefined();
        const reopened = restored.lines.find(({value}) => value.id === lineId)?.value;
        expect(reopened).toMatchObject({fixed: false, version: 2});
        expect(reopened).not.toHaveProperty("analysis");
        await expect(publishPlanningFiles({projectRoot}, change.publish)).rejects.toMatchObject({code: "MANIFEST_REVISION_CONFLICT"});
        const otherPlanId = (await perform({kind: "create-plan", title: "方案二"})).planId!;
        await perform({kind: "attach-entry", planId: otherPlanId, parentId: totalId, entryId: chapterId});
        const shared = await readPlanningSnapshot({projectRoot});
        const sharedEntry = shared.entries.find(({value}) => value.id === chapterId)!;
        expect(() => prepareLibraryAction(shared, {...action, expectedVersion: sharedEntry.value.version,
            expectedContentHash: sharedEntry.contentHash})).toThrow(/共享/);
    });

    it("共享总纲修改需要显式全局确认，确认后各方案仍引用同一稳定 ID", async () => {
        const {projectRoot, perform} = await setup();
        const totalId = (await perform({kind: "create-total", title: "总纲", body: "旧"})).entryId!;
        await perform({kind: "create-plan", title: "方案甲"});
        await perform({kind: "create-plan", title: "方案乙"});
        const snapshot = await readPlanningSnapshot({projectRoot});
        const total = snapshot.entries.find(({value}) => value.id === totalId)!;
        const edit = {kind: "edit-entry" as const, planId: snapshot.manifest.plans[0]!.id, entryId: totalId,
            title: "总纲", body: "新", expectedVersion: total.value.version, expectedContentHash: total.contentHash};
        expect(() => prepareLibraryAction(snapshot, edit)).toThrow(/全局总纲/);
        await publishPlanningFiles({projectRoot}, prepareLibraryAction(snapshot, {...edit, confirmGlobal: true}).publish);
        expect(getLibraryTrees(await readPlanningSnapshot({projectRoot})).map((tree) => tree.root.entry)).toEqual([
            expect.objectContaining({id: totalId, body: "新"}), expect.objectContaining({id: totalId, body: "新"}),
        ]);
    });

    it("跨父级移动条目保留稳定 ID，撤回正式状态并失效固定线路", async () => {
        const {projectRoot, perform, adopt, fixedLine} = await setup();
        const totalId = (await perform({kind: "create-total", title: "总纲", body: ""})).entryId!;
        const planId = (await perform({kind: "create-plan", title: "方案"})).planId!;
        const volumeId = (await perform({kind: "create-entry", planId, parentId: totalId, entryKind: "volume", title: "第一卷", body: ""})).entryId!;
        const chapterId = (await perform({kind: "create-entry", planId, parentId: totalId, entryKind: "chapter", title: "第一章", body: "章节"})).entryId!;
        await adopt(planId, totalId);
        await adopt(planId, chapterId);
        const lineId = await fixedLine(planId, [totalId, chapterId]);
        const source = (await readPlanningSnapshot({projectRoot})).entries.find(({value}) => value.id === chapterId)!;
        const current = await readPlanningSnapshot({projectRoot});
        const entry = current.entries.find(({value}) => value.id === chapterId)!;
        await perform({kind: "move-entry", planId, entryId: chapterId, parentId: volumeId,
            expectedVersion: entry.value.version, expectedContentHash: entry.contentHash});
        const moved = await readPlanningSnapshot({projectRoot});
        expect(moved.entries.find(({value}) => value.id === chapterId)).toMatchObject({path: source.path,
            value: {id: chapterId, parentId: volumeId, version: 2, status: "draft"}});
        expect(getLibraryTrees(moved)[0]?.root.children[0]?.children[0]?.entry.id).toBe(chapterId);
        const reopened = moved.lines.find(({value}) => value.id === lineId)?.value;
        expect(reopened).toMatchObject({fixed: false, version: 2});
        expect(reopened).not.toHaveProperty("analysis");
        await expect(perform({kind: "move-entry", planId, entryId: chapterId, parentId: totalId,
            expectedVersion: entry.value.version, expectedContentHash: entry.contentHash})).rejects.toMatchObject({code: "CAS_CONFLICT"});
    });

    it("移动共享条目或移到不兼容父级时不改动方案关系", async () => {
        const {projectRoot, perform} = await setup();
        const totalId = (await perform({kind: "create-total", title: "总纲", body: ""})).entryId!;
        const first = (await perform({kind: "create-plan", title: "方案甲"})).planId!;
        const second = (await perform({kind: "create-plan", title: "方案乙"})).planId!;
        const volumeId = (await perform({kind: "create-entry", planId: first, parentId: totalId,
            entryKind: "volume", title: "卷", body: ""})).entryId!;
        const chapterId = (await perform({kind: "create-entry", planId: first, parentId: totalId,
            entryKind: "chapter", title: "章", body: ""})).entryId!;
        const initial = await readPlanningSnapshot({projectRoot});
        const chapter = initial.entries.find(({value}) => value.id === chapterId)!;
        const move = {kind: "move-entry" as const, planId: first, entryId: chapterId, parentId: volumeId,
            expectedVersion: chapter.value.version, expectedContentHash: chapter.contentHash};
        await expect(perform({...move, parentId: chapterId})).rejects.toThrow(/父级/);
        await perform({kind: "attach-entry", planId: second, parentId: totalId, entryId: chapterId});
        await expect(perform(move)).rejects.toThrow(/共享/);
        const unchanged = await readPlanningSnapshot({projectRoot});
        expect(unchanged.entries.find(({value}) => value.id === chapterId)?.value.parentId).toBe(totalId);
        expect(unchanged.manifest.plans.flatMap((plan) => plan.placements.filter((place) => place.entryId === chapterId))).toHaveLength(2);
    });

    it("并发准备的方案变更只能提交一份，写失败不留半成品", async () => {
        const {projectRoot, perform} = await setup();
        await perform({kind: "create-total", title: "唯一总纲", body: ""});
        const snapshot = await readPlanningSnapshot({projectRoot});
        const first = prepareLibraryAction(snapshot, {kind: "create-plan", title: "A"});
        const second = prepareLibraryAction(snapshot, {kind: "create-plan", title: "B"});
        await publishPlanningFiles({projectRoot}, first.publish);
        await expect(publishPlanningFiles({projectRoot}, second.publish)).rejects.toMatchObject({code: "MANIFEST_REVISION_CONFLICT"});
        expect(getLibraryTrees(await readPlanningSnapshot({projectRoot}))).toHaveLength(1);
    });
    it("写作指导场景标注只能落在细纲，章节大纲携带时整批发布被拒绝", async () => {
        const {perform} = await setup();
        const guidance = '<!-- nb:guidance marker="g1" scene="雨夜" words="600" -->略写<!-- /nb:guidance marker="g1" -->';
        const totalId = (await perform({kind: "create-total", title: "总纲", body: ""})).entryId!;
        const planId = (await perform({kind: "create-plan", title: "方案"})).planId!;
        await expect(perform({kind: "create-entry", planId, parentId: totalId, entryKind: "chapter", title: "章", body: guidance}))
            .rejects.toThrow(/只能属于细纲/);
        const chapterId = (await perform({kind: "create-entry", planId, parentId: totalId, entryKind: "chapter", title: "章", body: ""})).entryId!;
        await expect(perform({kind: "create-entry", planId, parentId: chapterId, entryKind: "detail", title: "片段", body: guidance}))
            .resolves.toMatchObject({entryId: expect.any(String)});
    });
});
