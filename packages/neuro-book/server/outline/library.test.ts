import fs from "node:fs/promises";
import path from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import {createEmptyManifest, serializeManifest, type OutlineId, type OutlineLineType} from "./format";
import {publishPlanningFiles, readPlanningSnapshot} from "./index";
import {preparePlanningFork} from "./fork";
import {getLibraryTrees, prepareAdaptationWorkspace, prepareLibraryAction, prepareSourceExtractionDetail, type LibraryAction} from "./library";
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
    /** create-plan 同时诞生该方案的空总纲；断言返回值非空，供测试直接取用。 */
    const createPlan = async (title: string) => {
        const change = await perform({kind: "create-plan", title});
        return {planId: change.planId!, totalId: change.entryId!};
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
    return {projectRoot, perform, createPlan, line, adopt, fixedLine};
}

describe("大纲库方案链", () => {
    it("改编工作区一次创建方案、总纲、第一卷和第一章并固定来源章节", async () => {
        const {projectRoot, perform, createPlan} = await setup();
        const source = await createPlan("提取方案1");
        const sourceChapter = (await perform({kind: "create-entry", planId: source.planId, parentId: source.totalId, entryKind: "chapter", title: "原作第一章", body: "原作正文"})).entryId!;
        const sourceSnapshot = await readPlanningSnapshot({projectRoot});
        const extracted = prepareSourceExtractionDetail(sourceSnapshot, {planId: source.planId, chapterId: sourceChapter, title: "原作第一章细纲", body: "提取细纲", sources: [{path: "source.txt", locator: "P1"}]});
        await publishPlanningFiles({projectRoot}, extracted.publish);
        const change = prepareAdaptationWorkspace(await readPlanningSnapshot({projectRoot}), {sourcePlanId: source.planId, title: "改编方案1新作"});
        await publishPlanningFiles({projectRoot}, change.publish);
        const snapshot = await readPlanningSnapshot({projectRoot});
        const plan = snapshot.manifest.plans.find((item) => item.id === change.planId)!;
        expect(plan.title).toBe("改编方案1新作");
        expect(plan.placements.map(({entryId}) => entryId)).toEqual([plan.totalId, change.volumeId, change.chapterId]);
        expect(snapshot.entries.find((item) => item.value.id === change.chapterId)?.value.adaptation).toEqual({kind: "chapter", sourcePlanId: source.planId, sourceEntryId: sourceChapter});
    });

    it("两个方案经手动关联共用总纲与共享章节，关闭后从文件重建阶梯树", async () => {
        const {projectRoot, perform, createPlan} = await setup();
        const {planId: planA, totalId} = await createPlan("方案甲");
        const planB = (await perform({kind: "create-plan", title: "方案乙"})).planId!;
        await perform({kind: "associate-total", planId: planB, totalId: totalId});
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
        expect(snapshot.manifest.plans.map(({totalId: id}) => id)).toEqual([totalId, totalId]);
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
        const {projectRoot, perform, createPlan} = await setup();
        const {planId: first} = await createPlan("甲");
        const {planId: second} = await createPlan("乙");
        const before = await readPlanningSnapshot({projectRoot});
        await expect(perform({kind: "create-plan", title: " 甲 "})).rejects.toThrow(/同名/);
        await expect(perform({kind: "rename-plan", planId: second, title: " 甲 "})).rejects.toThrow(/同名/);
        const after = await readPlanningSnapshot({projectRoot});
        expect(after.manifest).toEqual(before.manifest);
        expect(after.manifest.plans.map(({id}) => id)).toEqual([first, second]);
    });

    it("预览并删除方案会递归删除专属条目，保留共享条目，并删除其线路图与草稿线路", async () => {
        const {projectRoot, perform, createPlan, line, adopt, fixedLine} = await setup();
        const {planId: planA, totalId} = await createPlan("甲");
        const planB = (await perform({kind: "create-plan", title: "乙"})).planId!;
        await perform({kind: "associate-total", planId: planB, totalId});
        const exclusiveId = (await perform({kind: "create-entry", planId: planA, parentId: totalId,
            entryKind: "chapter", title: "专属章", body: ""})).entryId!;
        const sharedId = (await perform({kind: "create-entry", planId: planA, parentId: totalId,
            entryKind: "chapter", title: "共享章", body: ""})).entryId!;
        await perform({kind: "attach-entry", planId: planB, parentId: totalId, entryId: sharedId});
        expect(inspectPlanningPlan(await readPlanningSnapshot({projectRoot}), planA)).toMatchObject({planId: planA,
            exclusiveEntryIds: [exclusiveId], placementIds: [totalId, exclusiveId, sharedId], objectFilesRemain: false,
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
        const draftLine = before.lines.find(({value}) => value.id === lineId)!;
        expect(inspectPlanningPlan(before, planA)).toMatchObject({canRemovePlan: true, blockingFixedLineIds: [],
            graphId: graph.value.id, draftLineIds: [lineId]});
        await publishPlanningFiles({projectRoot}, preparePlanningPlanRemoval(before, planA));
        const after = await readPlanningSnapshot({projectRoot});
        expect(getLibraryTrees(after).map(({id}) => id)).toEqual([planB]);
        expect(after.manifest.plans[0]?.placements.map(({entryId}) => entryId)).toEqual([totalId, sharedId]);
        expect(after.entries.find(({value}) => value.id === exclusiveId)).toBeUndefined();
        await expect(fs.stat(path.join(projectRoot, exclusive.path))).rejects.toMatchObject({code: "ENOENT"});
        expect(after.graphs).toEqual([]);
        expect(after.lines).toEqual([]);
        expect(after.manifest).toMatchObject({graphs: [], lines: []});
        await expect(fs.stat(path.join(projectRoot, graph.path))).rejects.toMatchObject({code: "ENOENT"});
        await expect(fs.stat(path.join(projectRoot, draftLine.path))).rejects.toMatchObject({code: "ENOENT"});
        expect(() => preparePlanningPlanRemoval(after, planA)).toThrow(/不存在/);
    });
    it("只有明确确认的非细纲草稿可正式采用，且过期版本不能改变状态", async () => {
        const {projectRoot, perform, createPlan} = await setup();
        const {planId, totalId} = await createPlan("方案");
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

    it("章节草稿在关闭重开后保留素材、指导与篇幅，不接受越界引用；细纲只保留素材索引", async () => {
        const {projectRoot, perform, createPlan} = await setup();
        const {planId, totalId} = await createPlan("方案");
        const chapterId = (await perform({kind: "create-entry", planId, parentId: totalId,
            entryKind: "chapter", title: "第一章", body: "概要", materialRefs: ["lorebook/人物/阿青.md"],
            writingGuidance: "视角克制", references: [{path: "research/背景/雨夜.md"}], targetWords: 2400})).entryId!;
        // 细纲的写作指导、参考与字数写在正文模板里；随动作传入的这三项不落盘。
        const detailId = (await perform({kind: "create-entry", planId, parentId: chapterId, entryKind: "detail",
            title: "第一场", body: "雨夜相遇", materialRefs: ["lorebook/人物/阿青.md"],
            writingGuidance: "视角克制", references: [{path: "research/背景/雨夜.md"}], targetWords: 2400})).entryId!;
        const restored = await readPlanningSnapshot({projectRoot});
        expect(restored.entries.find(({value}) => value.id === chapterId)?.value).toMatchObject({
            materialRefs: ["lorebook/人物/阿青.md"], writingGuidance: "视角克制", references: [{path: "research/背景/雨夜.md"}], targetWords: 2400,
        });
        const detail = restored.entries.find(({value}) => value.id === detailId)!.value;
        expect(detail).toMatchObject({status: "draft", chapterId, materialRefs: ["lorebook/人物/阿青.md"]});
        for (const key of ["writingGuidance", "references", "targetWords"]) expect(detail).not.toHaveProperty(key);
        const before = restored.manifest.revision;
        await expect(perform({kind: "create-entry", planId, parentId: totalId, entryKind: "chapter",
            title: "越界", body: "", references: [{path: "../private.md"}]})).rejects.toThrow(/文件引用/);
        expect((await readPlanningSnapshot({projectRoot})).manifest.revision).toBe(before);
    });

    it("编辑采用条目会撤回正式状态、失效固定线路并按版本拒绝过期和共享原地修改", async () => {
        const {projectRoot, perform, createPlan, adopt, fixedLine} = await setup();
        const {planId, totalId} = await createPlan("方案一");
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
        const {planId: otherPlanId, totalId: otherTotalId} = await createPlan("方案二");
        await perform({kind: "attach-entry", planId: otherPlanId, parentId: otherTotalId, entryId: chapterId});
        const shared = await readPlanningSnapshot({projectRoot});
        const sharedEntry = shared.entries.find(({value}) => value.id === chapterId)!;
        expect(() => prepareLibraryAction(shared, {...action, expectedVersion: sharedEntry.value.version,
            expectedContentHash: sharedEntry.contentHash})).toThrow(/共享/);
    });

    it("每个方案创建时各得一个空总纲，两棵树各自以自己的总纲为根", async () => {
        const {projectRoot, createPlan} = await setup();
        const {planId: planA, totalId: totalA} = await createPlan("方案甲");
        const {planId: planB, totalId: totalB} = await createPlan("方案乙");
        expect(totalA).not.toBe(totalB);
        const snapshot = await readPlanningSnapshot({projectRoot});
        expect(snapshot.manifest.plans.map(({id, totalId}) => ({id, totalId}))).toEqual([
            {id: planA, totalId: totalA}, {id: planB, totalId: totalB},
        ]);
        expect(snapshot.entries.filter(({value}) => value.kind === "total")).toHaveLength(2);
        expect(snapshot.entries.filter(({value}) => value.kind === "total").map(({value}) => ({id: value.id, title: value.title, body: value.body})))
            .toEqual(expect.arrayContaining([{id: totalA, title: "方案甲·总纲", body: ""}, {id: totalB, title: "方案乙·总纲", body: ""}]));
        expect(getLibraryTrees(snapshot).map((tree) => [tree.id, tree.root.entry.id, tree.root.children])).toEqual([
            [planA, totalA, []], [planB, totalB, []],
        ]);
    });

    it("attach-entry 在两个总纲不同的方案之间挂载卷纲，父级取目标方案自己的总纲", async () => {
        const {projectRoot, perform, createPlan} = await setup();
        const {planId: planA, totalId: totalA} = await createPlan("方案甲");
        const {planId: planB, totalId: totalB} = await createPlan("方案乙");
        const volumeId = (await perform({kind: "create-entry", planId: planA, parentId: totalA, entryKind: "volume", title: "第一卷", body: ""})).entryId!;
        // 乙只能把卷纲挂在乙自己的总纲下；乙并不包含甲的总纲。
        await expect(perform({kind: "attach-entry", planId: planB, parentId: totalA, entryId: volumeId})).rejects.toThrow(/父级/);
        await perform({kind: "attach-entry", planId: planB, parentId: totalB, entryId: volumeId});
        const snapshot = await readPlanningSnapshot({projectRoot});
        expect(getLibraryTrees(snapshot).map((tree) => [tree.root.entry.id, tree.root.children.map((node) => node.entry.id)])).toEqual([
            [totalA, [volumeId]], [totalB, [volumeId]],
        ]);
        expect(snapshot.entries.find(({value}) => value.id === volumeId)?.value.parentId).toBe(totalA);
        await expect(perform({kind: "attach-entry", planId: planB, parentId: totalB, entryId: volumeId})).rejects.toThrow(/已在此方案链/);
    });

    it("associate-total 让两个方案共用同一总纲；共用总纲不能原地编辑，写时分叉只影响当前方案", async () => {
        const {projectRoot, perform, createPlan} = await setup();
        const {planId: planA, totalId: totalA} = await createPlan("方案甲");
        const {planId: planB} = await createPlan("方案乙");
        await perform({kind: "associate-total", planId: planB, totalId: totalA});
        const shared = await readPlanningSnapshot({projectRoot});
        expect(shared.manifest.plans.map(({totalId}) => totalId)).toEqual([totalA, totalA]);
        expect(getLibraryTrees(shared).map((tree) => tree.root.entry.id)).toEqual([totalA, totalA]);
        await expect(perform({kind: "associate-total", planId: planB, totalId: totalA})).rejects.toThrow(/已在使用/);
        await expect(perform({kind: "associate-total", planId: planB, totalId: "ol-missing"})).rejects.toThrow(/不存在/);

        const total = shared.entries.find(({value}) => value.id === totalA)!;
        await expect(perform({kind: "edit-entry", planId: planA, entryId: totalA, title: "共用总纲", body: "新正文",
            expectedVersion: total.value.version, expectedContentHash: total.contentHash})).rejects.toThrow(/共用|分叉/);
        expect((await readPlanningSnapshot({projectRoot})).manifest.revision).toBe(shared.manifest.revision);

        const fork = await preparePlanningFork({projectRoot}, {planId: planA, sourceId: totalA, title: "甲的总纲", body: "新正文"});
        await publishPlanningFiles({projectRoot}, fork.publish);
        const forked = await readPlanningSnapshot({projectRoot});
        const [forkedA, untouchedB] = forked.manifest.plans;
        expect(forkedA).toMatchObject({id: planA, totalId: fork.id});
        expect(untouchedB).toMatchObject({id: planB, totalId: totalA});
        expect(forkedA!.placements.filter(({parentId}) => parentId === null).map(({entryId}) => entryId)).toEqual([fork.id]);
        expect(forked.entries.find(({value}) => value.id === fork.id)?.value).toMatchObject({kind: "total", title: "甲的总纲", body: "新正文", version: 0});
        expect(forked.entries.find(({value}) => value.id === totalA)?.contentHash).toBe(total.contentHash);
        // 分叉后总纲不再共用，甲可直接编辑自己的专属总纲。
        const own = forked.entries.find(({value}) => value.id === fork.id)!;
        await perform({kind: "edit-entry", planId: planA, entryId: fork.id, title: "甲的总纲", body: "再改",
            expectedVersion: own.value.version, expectedContentHash: own.contentHash});
    });

    it("方案当前总纲有正文时，改用其他总纲须 confirmReplace；旧总纲条目保留", async () => {
        const {projectRoot, perform, createPlan} = await setup();
        const {totalId: totalA} = await createPlan("方案甲");
        const {planId: planB, totalId: totalB} = await createPlan("方案乙");
        const snapshot = await readPlanningSnapshot({projectRoot});
        const own = snapshot.entries.find(({value}) => value.id === totalB)!;
        await perform({kind: "edit-entry", planId: planB, entryId: totalB, title: "方案乙·总纲", body: "乙的总纲正文",
            expectedVersion: own.value.version, expectedContentHash: own.contentHash});
        const before = await readPlanningSnapshot({projectRoot});
        await expect(perform({kind: "associate-total", planId: planB, totalId: totalA})).rejects.toThrow(/确认/);
        expect((await readPlanningSnapshot({projectRoot})).manifest).toEqual(before.manifest);
        await perform({kind: "associate-total", planId: planB, totalId: totalA, confirmReplace: true});
        const after = await readPlanningSnapshot({projectRoot});
        expect(after.manifest.plans.map(({totalId}) => totalId)).toEqual([totalA, totalA]);
        expect(after.entries.find(({value}) => value.id === totalB)?.value.body).toBe("乙的总纲正文");
    });

    it("associate-total 改用总纲时，方案原有的总纲直属条目随根一起切换", async () => {
        const {projectRoot, perform, createPlan} = await setup();
        const {totalId: totalA} = await createPlan("方案甲");
        const {planId: planB, totalId: totalB} = await createPlan("方案乙");
        const volumeId = (await perform({kind: "create-entry", planId: planB, parentId: totalB, entryKind: "volume", title: "乙卷", body: ""})).entryId!;
        await perform({kind: "associate-total", planId: planB, totalId: totalA});
        const tree = getLibraryTrees(await readPlanningSnapshot({projectRoot}))[1]!;
        expect(tree.root.entry.id).toBe(totalA);
        expect(tree.root.children.map((node) => node.entry.id)).toEqual([volumeId]);
    });

    it("unshare-total 为方案分叉出专属总纲，其他共用该总纲的方案不变", async () => {
        const {projectRoot, perform, createPlan} = await setup();
        const {planId: planA, totalId: totalA} = await createPlan("方案甲");
        const {planId: planB} = await createPlan("方案乙");
        const {planId: planC} = await createPlan("方案丙");
        await perform({kind: "associate-total", planId: planB, totalId: totalA});
        await perform({kind: "associate-total", planId: planC, totalId: totalA});
        const volumeId = (await perform({kind: "create-entry", planId: planA, parentId: totalA, entryKind: "volume", title: "共用卷", body: ""})).entryId!;
        await perform({kind: "attach-entry", planId: planB, parentId: totalA, entryId: volumeId});
        const before = await readPlanningSnapshot({projectRoot});
        const source = before.entries.find(({value}) => value.id === totalA)!;

        const change = await perform({kind: "unshare-total", planId: planB});
        const after = await readPlanningSnapshot({projectRoot});
        const forkId = change.entryId!;
        expect(forkId).not.toBe(totalA);
        expect(after.manifest.plans.map(({id, totalId}) => [id, totalId])).toEqual([[planA, totalA], [planB, forkId], [planC, totalA]]);
        expect(after.entries.find(({value}) => value.id === forkId)?.value).toMatchObject({kind: "total", body: source.value.body, version: 0});
        expect(after.entries.find(({value}) => value.id === totalA)?.contentHash).toBe(source.contentHash);
        // 乙的直属条目改挂到专属总纲，甲丙的树不变。
        expect(getLibraryTrees(after).map((tree) => [tree.root.entry.id, tree.root.children.map((node) => node.entry.id)])).toEqual([
            [totalA, [volumeId]], [forkId, [volumeId]], [totalA, []],
        ]);
        // 已无人共用的专属总纲不能再次分叉。
        await expect(perform({kind: "unshare-total", planId: planB})).rejects.toThrow(/无需分叉/);
    });

    it("跨父级移动条目保留稳定 ID，撤回正式状态并失效固定线路", async () => {
        const {projectRoot, perform, createPlan, adopt, fixedLine} = await setup();
        const {planId, totalId} = await createPlan("方案");
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
        const {projectRoot, perform, createPlan} = await setup();
        const {planId: first, totalId} = await createPlan("方案甲");
        const {planId: second, totalId: secondTotalId} = await createPlan("方案乙");
        const volumeId = (await perform({kind: "create-entry", planId: first, parentId: totalId,
            entryKind: "volume", title: "卷", body: ""})).entryId!;
        const chapterId = (await perform({kind: "create-entry", planId: first, parentId: totalId,
            entryKind: "chapter", title: "章", body: ""})).entryId!;
        const initial = await readPlanningSnapshot({projectRoot});
        const chapter = initial.entries.find(({value}) => value.id === chapterId)!;
        const move = {kind: "move-entry" as const, planId: first, entryId: chapterId, parentId: volumeId,
            expectedVersion: chapter.value.version, expectedContentHash: chapter.contentHash};
        await expect(perform({...move, parentId: chapterId})).rejects.toThrow(/父级/);
        await perform({kind: "attach-entry", planId: second, parentId: secondTotalId, entryId: chapterId});
        await expect(perform(move)).rejects.toThrow(/共享/);
        const unchanged = await readPlanningSnapshot({projectRoot});
        expect(unchanged.entries.find(({value}) => value.id === chapterId)?.value.parentId).toBe(totalId);
        expect(unchanged.manifest.plans.flatMap((plan) => plan.placements.filter((place) => place.entryId === chapterId))).toHaveLength(2);
    });

    it("并发准备的方案变更只能提交一份，写失败不留半成品", async () => {
        const {projectRoot, perform} = await setup();
        const snapshot = await readPlanningSnapshot({projectRoot});
        const first = prepareLibraryAction(snapshot, {kind: "create-plan", title: "A"});
        const second = prepareLibraryAction(snapshot, {kind: "create-plan", title: "B"});
        await publishPlanningFiles({projectRoot}, first.publish);
        await expect(publishPlanningFiles({projectRoot}, second.publish)).rejects.toMatchObject({code: "MANIFEST_REVISION_CONFLICT"});
        expect(getLibraryTrees(await readPlanningSnapshot({projectRoot}))).toHaveLength(1);
    });
});
