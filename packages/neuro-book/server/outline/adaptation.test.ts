import fs from "node:fs/promises";
import path from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import {adaptationRecordPath, preparePlanningMaterialMutations} from "./adaptation";
import {contentHash, createEmptyManifest, parseEntryMarkdown, serializeEntryMarkdown, serializeManifest, type OutlineAdaptation, type OutlineId, type OutlineMaterialUpdate} from "./format";
import {parsePlanningFiles, publishPlanningFiles, readPlanningSnapshot} from "./index";
import {forkPlanTotal, prepareLibraryAction, type LibraryAction} from "./library";
import {createOutlineRepository} from "./repository";
import {preparePlanningPlanRemoval} from "./operations";
import {preparePlanningFork} from "./fork";
import {publishOutlineFiles, recoverOutlineTransactions, undoOutlineTransaction} from "./transaction";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true}))));

async function setup() {
    const projectRoot = await createTestTmpRoot("outline-adaptation", "material-plan-transaction");
    roots.push(projectRoot);
    await createOutlineRepository({projectRoot}).ensureLayout(serializeManifest(createEmptyManifest()));
    const perform = async (action: LibraryAction) => {
        const prepared = prepareLibraryAction(await readPlanningSnapshot({projectRoot}), action);
        const receipt = await publishPlanningFiles({projectRoot}, prepared.publish);
        return {...prepared, receipt};
    };
    const source = await perform({kind: "create-plan", title: "原作"});
    const target = await perform({kind: "create-plan", title: "改编"});
    const first = await perform({kind: "create-entry", planId: source.planId!, parentId: source.entryId!, entryKind: "chapter", title: "原作第三章", body: "原作一"});
    const second = await perform({kind: "create-entry", planId: source.planId!, parentId: source.entryId!, entryKind: "chapter", title: "原作第四章", body: "原作二"});
    const bases = ["lorebook/character/主角/index.md", "lorebook/item/钥匙/index.md", "lorebook/location/城门/index.md"];
    for (const base of bases) {
        await fs.mkdir(path.dirname(path.join(projectRoot, base)), {recursive: true});
        await fs.writeFile(path.join(projectRoot, base), "只读基础资料");
    }
    const origin: OutlineAdaptation = {kind: "between", sourcePlanId: source.planId!, beforeEntryId: first.entryId!, afterEntryId: second.entryId!};
    const updates: readonly OutlineMaterialUpdate[] = [
        {kind: "experience", materialPath: bases[0]!, body: "主角决定进城"},
        {kind: "relationship", materialPath: bases[0]!, body: "主角开始怀疑同伴"},
        {kind: "item", materialPath: bases[1]!, body: "钥匙在新章节遗失"},
        {kind: "location", materialPath: bases[2]!, body: "城门在冲突后封闭"},
    ];
    const chapter = (metadata: {adaptation?: OutlineAdaptation; materialUpdates?: readonly OutlineMaterialUpdate[]} = {}) => ({
        kind: "create-entry" as const, planId: target.planId!, parentId: target.entryId!, entryKind: "chapter" as const,
        title: "插入的原创章节", body: "新剧情", ...metadata,
    });
    const edit = async (entryId: OutlineId, metadata: {adaptation?: OutlineAdaptation | null; materialUpdates?: readonly OutlineMaterialUpdate[] | null} = {}, body?: string) => {
        const snapshot = await readPlanningSnapshot({projectRoot});
        const current = snapshot.entries.find(({value}) => value.id === entryId)!;
        return perform({kind: "edit-entry", planId: target.planId!, entryId, title: current.value.title, body: body ?? current.value.body,
            expectedVersion: current.value.version, expectedContentHash: current.contentHash, ...metadata});
    };
    return {projectRoot, perform, source, target, first, second, origin, updates, chapter, edit, bases};
}

describe("规划改编记录与来源定位", () => {
    it("原作章节稳定定位不受目标插入与重排影响，同步四类计划且基础文件保持原样", async () => {
        const {projectRoot, perform, target, origin, updates, chapter, bases} = await setup();
        const made = await perform(chapter({adaptation: origin, materialUpdates: updates}));
        const later = await perform(chapter());
        await perform({kind: "reorder-entry", planId: target.planId!, entryId: later.entryId!, siblingIndex: 0});
        const snapshot = await readPlanningSnapshot({projectRoot});
        expect(snapshot.entries.find(({value}) => value.id === made.entryId)?.value.adaptation).toEqual(origin);
        for (const update of updates) {
            const file = adaptationRecordPath(update, target.planId!, made.entryId!);
            expect(made.receipt.files).toContain(file);
            expect(await fs.readFile(path.join(projectRoot, file), "utf8")).toContain(update.body);
        }
        for (const base of bases) expect(await fs.readFile(path.join(projectRoot, base), "utf8")).toBe("只读基础资料");
    });

    it("编辑未传字段保留，重新提交替换正文，null移除关联，撤销同时恢复规划和记录", async () => {
        const {projectRoot, perform, target, origin, updates, chapter, edit} = await setup();
        const made = await perform(chapter({adaptation: origin, materialUpdates: [updates[0]!]}));
        const file = adaptationRecordPath(updates[0]!, target.planId!, made.entryId!);
        await edit(made.entryId!);
        const retained = (await readPlanningSnapshot({projectRoot})).entries.find(({value}) => value.id === made.entryId)!.value;
        expect(retained.materialUpdates).toEqual([updates[0]]);
        expect(retained.adaptation).toEqual(origin);
        await edit(made.entryId!, {materialUpdates: [{...updates[0]!, body: "新的经历安排"}]});
        expect(await fs.readFile(path.join(projectRoot, file), "utf8")).toContain("新的经历安排");
        expect(await fs.readFile(path.join(projectRoot, file), "utf8")).not.toContain(updates[0]!.body);
        const removed = await edit(made.entryId!, {adaptation: null, materialUpdates: null});
        await expect(fs.stat(path.join(projectRoot, file))).rejects.toMatchObject({code: "ENOENT"});
        await undoOutlineTransaction({projectRoot}, removed.receipt.transactionId);
        expect(await fs.readFile(path.join(projectRoot, file), "utf8")).toContain("新的经历安排");
        const restored = (await readPlanningSnapshot({projectRoot})).entries.find(({value}) => value.id === made.entryId)!.value;
        expect(restored.adaptation).toEqual(origin);
        expect(restored.materialUpdates?.[0]?.body).toBe("新的经历安排");
    });

    it("已有关联计划时正文变化必须显式维护，标题和状态变化仍保留记录", async () => {
        const {projectRoot, perform, target, updates, chapter, edit} = await setup();
        const made = await perform(chapter({materialUpdates: [updates[0]!]}));
        const before = await readPlanningSnapshot({projectRoot});
        await expect(edit(made.entryId!, {}, "主角决定不进城")).rejects.toThrow(/同步提交 materialUpdates/);
        expect((await readPlanningSnapshot({projectRoot})).manifest.revision).toBe(before.manifest.revision);
        const current = before.entries.find(({value}) => value.id === made.entryId)!;
        await perform({kind: "edit-entry", planId: target.planId!, entryId: made.entryId!, title: "新的标题", body: current.value.body,
            expectedVersion: current.value.version, expectedContentHash: current.contentHash});
        const renamed = (await readPlanningSnapshot({projectRoot})).entries.find(({value}) => value.id === made.entryId)!;
        await perform({kind: "adopt-entry", planId: target.planId!, entryId: made.entryId!,
            expectedVersion: renamed.value.version, expectedContentHash: renamed.contentHash});
        expect((await readPlanningSnapshot({projectRoot})).entries.find(({value}) => value.id === made.entryId)?.value.materialUpdates).toEqual([updates[0]]);
        await edit(made.entryId!, {materialUpdates: [{...updates[0]!, body: "主角留下"}]}, "主角决定不进城");
        await edit(made.entryId!, {materialUpdates: null}, "取消此前经历");
    });

    it("同一素材的不同方案计划隔离，改方案名不改变记录路径", async () => {
        const {projectRoot, perform, target, updates, chapter} = await setup();
        const made = await perform(chapter({materialUpdates: [updates[0]!]}));
        const another = await perform({kind: "create-plan", title: "另一改编"});
        await perform({kind: "attach-entry", planId: another.planId!, parentId: another.entryId!, entryId: made.entryId!});
        const fileA = adaptationRecordPath(updates[0]!, target.planId!, made.entryId!);
        const fileB = adaptationRecordPath(updates[0]!, another.planId!, made.entryId!);
        expect(fileA).not.toBe(fileB);
        await perform({kind: "rename-plan", planId: another.planId!, title: "另一路线"});
        expect(await fs.readFile(path.join(projectRoot, fileA), "utf8")).not.toContain("另一路线");
        expect(await fs.readFile(path.join(projectRoot, fileB), "utf8")).toContain("另一路线");
    });

    it("删除改编方案撤下其记录但保留素材与库条目，撤销恢复方案计划", async () => {
        const {projectRoot, perform, target, origin, updates, chapter, bases} = await setup();
        const made = await perform(chapter({adaptation: origin, materialUpdates: [updates[0]!]}));
        const file = adaptationRecordPath(updates[0]!, target.planId!, made.entryId!);
        const input = preparePlanningPlanRemoval(await readPlanningSnapshot({projectRoot}), target.planId!);
        const removed = await publishPlanningFiles({projectRoot}, input);
        await expect(fs.stat(path.join(projectRoot, file))).rejects.toMatchObject({code: "ENOENT"});
        expect((await readPlanningSnapshot({projectRoot})).entries.find(({value}) => value.id === made.entryId)).toBeDefined();
        expect(await fs.readFile(path.join(projectRoot, bases[0]!), "utf8")).toBe("只读基础资料");
        await undoOutlineTransaction({projectRoot}, removed.transactionId);
        expect(await fs.readFile(path.join(projectRoot, file), "utf8")).toContain(updates[0]!.body);
    });

    it("共享章节分叉迁移当前方案记录，其他方案保留原记录与来源锚点", async () => {
        const {projectRoot, perform, target, origin, updates, chapter} = await setup();
        const made = await perform(chapter({adaptation: origin, materialUpdates: [updates[0]!]}));
        const another = await perform({kind: "create-plan", title: "另一改编"});
        await perform({kind: "attach-entry", planId: another.planId!, parentId: another.entryId!, entryId: made.entryId!});
        await expect(preparePlanningFork({projectRoot}, {planId: another.planId!, sourceId: made.entryId!, title: "遗漏记录的分叉", body: "另一计划"}))
            .rejects.toThrow(/同步提交 materialUpdates/);
        const fork = await preparePlanningFork({projectRoot}, {planId: another.planId!, sourceId: made.entryId!, title: "另一版原创章", body: "另一计划",
            materialUpdates: [{...updates[0]!, body: "走另一条路"}]});
        await publishPlanningFiles({projectRoot}, fork.publish);
        const original = adaptationRecordPath(updates[0]!, target.planId!, made.entryId!);
        const removed = adaptationRecordPath(updates[0]!, another.planId!, made.entryId!);
        const current = adaptationRecordPath(updates[0]!, another.planId!, fork.id);
        expect(await fs.readFile(path.join(projectRoot, original), "utf8")).toContain(updates[0]!.body);
        await expect(fs.stat(path.join(projectRoot, removed))).rejects.toMatchObject({code: "ENOENT"});
        expect(await fs.readFile(path.join(projectRoot, current), "utf8")).toContain("走另一条路");
        expect((await readPlanningSnapshot({projectRoot})).entries.find(({value}) => value.id === fork.id)?.value.adaptation).toEqual(origin);
    });

    it("共享总纲改正文分叉同样要求显式核对关联计划，解除共用但正文不变可保留", async () => {
        const {projectRoot, perform, target, updates} = await setup();
        const before = await readPlanningSnapshot({projectRoot});
        const total = before.entries.find(({value}) => value.id === target.entryId)!;
        await perform({kind: "edit-entry", planId: target.planId!, entryId: total.value.id,
            title: total.value.title, body: "总纲中的角色计划", expectedVersion: total.value.version,
            expectedContentHash: total.contentHash, materialUpdates: [updates[0]!]});
        const another = await perform({kind: "create-plan", title: "共享总纲的方案"});
        await perform({kind: "associate-total", planId: another.planId!, totalId: total.value.id});
        const shared = await readPlanningSnapshot({projectRoot});
        expect(() => forkPlanTotal(shared, another.planId!, "另一总纲", "完全不同的剧情"))
            .toThrow(/同步提交 materialUpdates/);
        const unshared = prepareLibraryAction(shared, {kind: "unshare-total", planId: another.planId!}, "unshare:proposal");
        await publishPlanningFiles({projectRoot}, unshared.publish);
        expect((await readPlanningSnapshot({projectRoot})).entries.find(({value}) => value.id === unshared.entryId)?.value.materialUpdates).toEqual([updates[0]]);
    });

    it("缺失素材、类别不符、基础路径与大小写重复均拒绝且规划不落盘", async () => {
        const {projectRoot, perform, updates, chapter} = await setup();
        const before = await readPlanningSnapshot({projectRoot});
        await expect(perform(chapter({materialUpdates: [{...updates[0]!, materialPath: "lorebook/character/新人物/index.md"}]}))).rejects.toThrow(/设计工作台/);
        await expect(perform(chapter({materialUpdates: [{...updates[0]!, kind: "item"}]}))).rejects.toThrow(/基础 index/);
        await expect(perform(chapter({materialUpdates: [{...updates[0]!, materialPath: "lorebook/character/主角/experience/index.md"}]}))).rejects.toThrow(/基础 index/);
        await expect(perform(chapter({materialUpdates: [updates[0]!, {...updates[0]!, materialPath: "lorebook/CHARACTER/主角/index.md"}]}))).rejects.toThrow();
        const after = await readPlanningSnapshot({projectRoot});
        expect(after.manifest.revision).toBe(before.manifest.revision);
        await expect(publishPlanningFiles({projectRoot}, {expectedManifestRevision: after.manifest.revision,
            mutations: [{relativePath: "lorebook/character/主角/index.md", content: "越权"}]})).rejects.toMatchObject({code: "INVALID_PATH"});
    });

    it("来源方案、章节归属与区间顺序校验拒绝错位锚点", async () => {
        const {perform, target, first, origin, chapter} = await setup();
        await expect(perform(chapter({adaptation: {...origin, sourcePlanId: target.planId!}}))).rejects.toThrow(/不同/);
        await expect(perform(chapter({adaptation: {...origin, beforeEntryId: origin.afterEntryId, afterEntryId: origin.beforeEntryId}}))).rejects.toThrow(/顺序/);
        await expect(perform(chapter({adaptation: {kind: "chapter", sourcePlanId: "missing", sourceEntryId: first.entryId!}}))).rejects.toThrow(/不同/);
        await expect(perform(chapter({adaptation: {...origin, afterEntryId: target.entryId!}}))).rejects.toThrow(/顺序/);
    });

    it("预览生成记录变更但不写文件，故障回滚整批文件且外部修改阻止覆盖", async () => {
        const {projectRoot, target, origin, updates, chapter, perform, edit} = await setup();
        const before = await readPlanningSnapshot({projectRoot});
        const prepared = prepareLibraryAction(before, chapter({adaptation: origin, materialUpdates: [updates[0]!]}));
        const files = new Map((await createOutlineRepository({projectRoot}).readCanonicalFiles()).map((file) => [file.relativePath, file]));
        for (const mutation of prepared.publish.mutations) {
            files.set(mutation.relativePath, {relativePath: mutation.relativePath, content: mutation.content!, contentHash: contentHash(mutation.content!)});
        }
        const preview = await preparePlanningMaterialMutations(projectRoot, before, parsePlanningFiles([...files.values()]));
        expect(preview).toHaveLength(1);
        await expect(fs.stat(path.join(projectRoot, preview[0]!.relativePath))).rejects.toMatchObject({code: "ENOENT"});
        await expect(publishPlanningFiles({projectRoot, beforePublishFile: (relativePath) => {
            if (relativePath.startsWith("outline/")) throw new Error("故障");
        }}, prepared.publish)).rejects.toThrow(/失败/);
        await recoverOutlineTransactions(projectRoot);
        expect((await readPlanningSnapshot({projectRoot})).manifest.revision).toBe(before.manifest.revision);
        await expect(fs.stat(path.join(projectRoot, preview[0]!.relativePath))).rejects.toMatchObject({code: "ENOENT"});
        const made = await perform(chapter({materialUpdates: [updates[0]!]}));
        const file = adaptationRecordPath(updates[0]!, target.planId!, made.entryId!);
        await fs.writeFile(path.join(projectRoot, file), "外部修改");
        await expect(edit(made.entryId!)).rejects.toMatchObject({code: "CAS_CONFLICT"});
        expect(await fs.readFile(path.join(projectRoot, file), "utf8")).toBe("外部修改");
        expect(await undoOutlineTransaction({projectRoot}, made.receipt.transactionId)).toMatchObject({kind: "conflict"});
    });

    it("不能经硬链接读取基础对象或覆盖改编文件", async () => {
        const {projectRoot, perform, target, updates, chapter, edit, bases} = await setup();
        const alias = path.join(projectRoot, "base-alias.md");
        await fs.link(path.join(projectRoot, bases[0]!), alias);
        await expect(perform(chapter({materialUpdates: [updates[0]!]}))).rejects.toThrow(/真实文件/);
        await fs.rm(alias);
        const made = await perform(chapter({materialUpdates: [updates[0]!]}));
        const record = path.join(projectRoot, adaptationRecordPath(updates[0]!, target.planId!, made.entryId!));
        await fs.link(record, path.join(projectRoot, "record-alias.md"));
        await expect(edit(made.entryId!)).rejects.toThrow(/硬链接/);
    });

    it("格式往返保留新增字段并拒绝未知锚点字段，事务拒绝路径大小写冲突", async () => {
        const {projectRoot, perform, origin, updates, chapter} = await setup();
        const made = await perform(chapter({adaptation: origin, materialUpdates: [updates[0]!]}));
        const entry = (await readPlanningSnapshot({projectRoot})).entries.find(({value}) => value.id === made.entryId)!.value;
        expect(parseEntryMarkdown(serializeEntryMarkdown(entry))).toEqual(entry);
        await expect(publishOutlineFiles({projectRoot}, [
            {relativePath: "outline/entries/test.md", content: "a"}, {relativePath: "outline/entries/TEST.md", content: "b"},
        ])).rejects.toMatchObject({code: "INVALID_PATH"});
        expect(() => parseEntryMarkdown(serializeEntryMarkdown({...entry, adaptation: {...origin, sourceEntryId: "ol-other"} as OutlineAdaptation}))).toThrow(/不适用/);
    });
});
