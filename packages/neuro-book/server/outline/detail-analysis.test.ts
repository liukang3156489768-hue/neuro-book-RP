import fs from "node:fs/promises";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import {describe, expect, it} from "vitest";
import {createEmptyManifest, contentHash, parseEntryMarkdown, parseLineYaml, parseManifest, serializeEntryMarkdown, serializeManifest, type OutlineEntry, type OutlineId, type OutlineLineType} from "./format";
import {analyzeDetail, confirmDetail, detailAnalysisContext, type DetailAnalysisRequest} from "./detail-analysis";
import {invalidateDependentDetails} from "./analysis-invalidation";
import {prepareLibraryAction} from "./library";
import {publishPlanningFiles, readPlanningSnapshot, type PlanningPublishInput, type PlanningSnapshot} from "./index";
import {publishOutlineFiles, recoverOutlineTransactions} from "./transaction";
import {PlanningFixture} from "./line-graph.fixture";
import {detailBody, sceneDetail} from "./detail.fixture";

function fixture(): {snapshot: PlanningSnapshot; request: DetailAnalysisRequest} {
    const root: OutlineEntry = {schema: "nbook.outline-entry/v2", id: "ol-root", kind: "total", version: 0,
        status: "adopted", title: "总纲", parentId: null, chapterId: null, body: "成长"};
    const chapter: OutlineEntry = {...root, id: "ol-chapter", kind: "chapter", status: "adopted",
        title: "第一章", body: "主角获救", parentId: root.id};
    const detail: OutlineEntry = {...chapter, id: "ol-detail", kind: "detail", status: "draft",
        title: "片段", ...sceneDetail("主角逃跑"), chapterId: chapter.id, parentId: chapter.id};
    const resolved = [root, chapter, detail].map((value) => ({
        path: `outline/entries/${value.kind}--${value.id}.md`, contentHash: contentHash(serializeEntryMarkdown(value)), value, markers: [],
    }));
    const manifest = {...createEmptyManifest(), revision: 3,
        entries: resolved.map(({value, path, contentHash: hash}) => ({id: value.id, path, version: value.version, contentHash: hash})),
        plans: [{id: "plan-a", title: "方案", totalId: root.id, placements: [
            {entryId: root.id, parentId: null, position: 0},
            {entryId: chapter.id, parentId: root.id, position: 1},
            {entryId: detail.id, parentId: chapter.id, position: 2},
        ]}],
    };
    return {snapshot: {manifest, entries: resolved, foreshadowing: [], graphs: [], lines: []}, request: {planId: "plan-a", entryId: detail.id,
        expectedRevision: 3, expectedVersion: 0, expectedContentHash: resolved[2]!.contentHash}};
}

/** 创建方案（自带空总纲）、写入总纲正文并正式采用总纲；线路固定只接受正式条目。 */
function adoptedPlan(planning: PlanningFixture, title: string): {rootId: OutlineId; planId: string} {
    const created = planning.library({kind: "create-plan", title});
    const planId = created.planId!;
    const rootId = created.entryId!;
    const empty = planning.entry(rootId);
    planning.library({kind: "edit-entry", planId, entryId: rootId, expectedVersion: empty.value.version,
        expectedContentHash: empty.contentHash, title: empty.value.title, body: "成长"});
    const root = planning.entry(rootId);
    planning.library({kind: "adopt-entry", planId, entryId: rootId, expectedVersion: root.value.version,
        expectedContentHash: root.contentHash});
    return {rootId, planId};
}

/** 走真实分析与确认流程采用细纲，报告绑定签发方案。 */
async function adoptDetail(planning: PlanningFixture, planId: string, chapterId: OutlineId, title: string): Promise<OutlineId> {
    const detailId = planning.library({kind: "create-entry", planId, parentId: chapterId, entryKind: "detail",
        title, ...sceneDetail("主角逃跑")}).entryId!;
    const source = planning.entry(detailId);
    const request: DetailAnalysisRequest = {planId, entryId: detailId, expectedRevision: planning.snapshot.manifest.revision,
        expectedVersion: source.value.version, expectedContentHash: source.contentHash};
    const issued = await analyzeDetail(planning.snapshot, request, async () => JSON.stringify({summary: "审阅通过",
        deviations: [], conflicts: []}));
    planning.publish(confirmDetail(planning.snapshot, request, issued, issued.report.reportId, true, []).publish);
    return detailId;
}

/** 按顺序把条目放到第 0 行的相邻格号并依次连线，返回节点 ID。 */
function chainNodes(planning: PlanningFixture, planId: string, entryIds: readonly OutlineId[]): OutlineId[] {
    const nodes = entryIds.map((entryId, column) =>
        planning.graph("add-graph-node", planId, {column, row: 0, entryId}).nodeId!);
    for (let index = 1; index < nodes.length; index += 1) {
        planning.graph("connect-graph-nodes", planId, {from: nodes[index - 1]!, to: nodes[index]!});
    }
    return nodes;
}

function chainLine(planning: PlanningFixture, planId: string, title: string, type: OutlineLineType,
    entryIds: readonly OutlineId[]): OutlineId {
    return planning.createLine(planId, title, type, chainNodes(planning, planId, entryIds));
}

describe("细纲审阅与正式采用", () => {
    it("审阅摘要只随上游链变化：其他方案、方案标题和同方案链外条目不影响，章节改动必须改变摘要", () => {
        const {snapshot, request} = fixture();
        const initial = detailAnalysisContext(snapshot, request).contextHash;
        const withOtherPlan: PlanningSnapshot = {...snapshot, manifest: {...snapshot.manifest, revision: 4,
            plans: [...snapshot.manifest.plans, {id: "plan-b", title: "另一方案", totalId: "ol-root", placements: [
                {entryId: "ol-root", parentId: null, position: 0},
            ]}],
        }};
        expect(detailAnalysisContext(withOtherPlan, {...request, expectedRevision: 4}).contextHash).toBe(initial);
        const renamedOther: PlanningSnapshot = {...withOtherPlan, manifest: {...withOtherPlan.manifest, revision: 5,
            plans: withOtherPlan.manifest.plans.map((plan) => plan.id === "plan-b" ? {...plan, title: "改名方案"} : plan),
        }};
        expect(detailAnalysisContext(renamedOther, {...request, expectedRevision: 5}).contextHash).toBe(initial);
        const renamedOwn: PlanningSnapshot = {...renamedOther, manifest: {...renamedOther.manifest, revision: 6,
            plans: renamedOther.manifest.plans.map((plan) => plan.id === "plan-a" ? {...plan, title: "改名甲方案"} : plan),
        }};
        expect(detailAnalysisContext(renamedOwn, {...request, expectedRevision: 6}).contextHash).toBe(initial);
        const withSibling: PlanningSnapshot = {...snapshot, manifest: {...snapshot.manifest, revision: 7,
            entries: [...snapshot.manifest.entries, {id: "ol-other", path: "outline/entries/chapter--ol-other.md", version: 0,
                contentHash: "sha256:" + "3".repeat(64)}],
            plans: snapshot.manifest.plans.map((plan) => ({...plan, placements: [
                ...plan.placements.map((place) => ({...place, position: place.position + 1})),
                {entryId: "ol-other", parentId: "ol-root", position: 0}]})),
        }};
        expect(detailAnalysisContext(withSibling, {...request, expectedRevision: 7}).contextHash).toBe(initial);
        const chapter = snapshot.entries.find(({value}) => value.id === "ol-chapter")!;
        const revisedChapter = {...chapter.value, version: chapter.value.version + 1, body: "另一版章节"};
        const revisedHash = contentHash(serializeEntryMarkdown(revisedChapter));
        const changedSibling: PlanningSnapshot = {...withOtherPlan,
            entries: withOtherPlan.entries.map((entry) => entry === chapter
                ? {...entry, value: revisedChapter, contentHash: revisedHash} : entry),
            manifest: {...withOtherPlan.manifest, revision: 6,
                entries: withOtherPlan.manifest.entries.map((ref) => ref.id === chapter.value.id
                    ? {...ref, version: revisedChapter.version, contentHash: revisedHash} : ref),
            },
        };
        expect(detailAnalysisContext(changedSibling, {...request, expectedRevision: 6}).contextHash).not.toBe(initial);
    });
    it("修改所属章节或改挂到其他章节时，已采用细纲在同批次撤回并清除旧报告；仅调整顺序不撤回", () => {
        const {snapshot} = fixture();
        const detail = snapshot.entries[2]!;
        const adopted = {...detail.value, version: 1, status: "adopted" as const, analysis: {
            reportId: "report-a", planId: "plan-a", sourceHash: detail.contentHash,
            contextHash: "sha256:" + "1".repeat(64), summary: "审阅通过", deviations: [], conflicts: [], resolutions: [],
        }};
        const adoptedHash = contentHash(serializeEntryMarkdown(adopted));
        const current: PlanningSnapshot = {...snapshot, entries: snapshot.entries.map((entry) => entry === detail
            ? {...entry, value: adopted, contentHash: adoptedHash} : entry), manifest: {...snapshot.manifest,
            entries: snapshot.manifest.entries.map((ref) => ref.id === detail.value.id ? {...ref, version: 1, contentHash: adoptedHash} : ref),
        }};
        const chapter = current.entries[1]!;
        const edit = prepareLibraryAction(current, {kind: "edit-entry", planId: "plan-a", entryId: chapter.value.id,
            expectedVersion: chapter.value.version, expectedContentHash: chapter.contentHash, title: "新章节", body: "改写"});
        const updated = invalidateDependentDetails(current, edit.publish);
        const withdrawn = updated.mutations.find(({relativePath}) => relativePath === detail.path)!;
        expect(parseEntryMarkdown(withdrawn.content!)).toMatchObject({status: "draft", version: 2});
        expect(parseEntryMarkdown(withdrawn.content!).analysis).toBeUndefined();
        
        expect(parseManifest(updated.mutations.find(({relativePath}) => relativePath === "outline/manifest.yaml")!.content!)
            .entries.find(({id}) => id === detail.value.id)?.contentHash).toBe(contentHash(withdrawn.content!));
        const movedManifest = {...current.manifest, revision: current.manifest.revision + 1, plans: current.manifest.plans.map((plan) => ({
            ...plan, placements: plan.placements.map((placement) => placement.entryId === detail.value.id
                ? {...placement, position: placement.position + 1} : placement),
        }))};
        const reordered = invalidateDependentDetails(current, {expectedManifestRevision: current.manifest.revision, mutations: [{
            relativePath: "outline/manifest.yaml", content: serializeManifest(movedManifest),
        }]});
        expect(reordered.mutations.some(({relativePath}) => relativePath === detail.path)).toBe(false);
        const reparentedManifest = {...current.manifest, revision: current.manifest.revision + 1, plans: current.manifest.plans.map((plan) => ({
            ...plan, placements: plan.placements.map((placement) => placement.entryId === detail.value.id
                ? {...placement, parentId: "ol-root" as OutlineId} : placement),
        }))};
        const reparented = invalidateDependentDetails(current, {expectedManifestRevision: current.manifest.revision, mutations: [{
            relativePath: "outline/manifest.yaml", content: serializeManifest(reparentedManifest),
        }]});
        expect(reparented.mutations.some(({relativePath}) => relativePath === detail.path)).toBe(true);
    });
    it("将已采用细纲新挂到另一方案时，先撤回报告并解固定章节线路", async () => {
        const planning = new PlanningFixture();
        const {rootId, planId: planA} = adoptedPlan(planning, "方案");
        const chapterId = planning.adoptedChapter(planA, rootId, "第一章", "主角获救");
        const detailId = await adoptDetail(planning, planA, chapterId, "片段");
        const lineId = chainLine(planning, planA, "章节线", "main", [rootId, chapterId]);
        await planning.fix(lineId);
        const createdB = planning.library({kind: "create-plan", title: "另一方案"});
        const planB = createdB.planId!;
        const totalB = createdB.entryId!;
        planning.library({kind: "attach-entry", planId: planB, parentId: totalB, entryId: chapterId});
        const current = planning.snapshot;
        const detail = planning.entry(detailId);
        const line = planning.lineSource(lineId);
        const action = prepareLibraryAction(current, {kind: "attach-entry", planId: planB, parentId: chapterId, entryId: detailId});
        const invalidated = invalidateDependentDetails(current, action.publish);
        const changed = invalidated.mutations.find(({relativePath}) => relativePath === detail.path);
        expect(changed).toBeDefined();
        expect(parseEntryMarkdown(changed!.content!)).toMatchObject({status: "draft", version: 2});
        expect(parseEntryMarkdown(changed!.content!).analysis).toBeUndefined();
        const lineChange = invalidated.mutations.find(({relativePath}) => relativePath === line.path);
        expect(parseLineYaml(lineChange!.content!)).toMatchObject({fixed: false, version: line.value.version + 1});
        expect(parseLineYaml(lineChange!.content!).analysis).toBeUndefined();
        const manifest = parseManifest(invalidated.mutations.find(({relativePath}) => relativePath === "outline/manifest.yaml")!.content!);
        expect(manifest.entries.find(({id}) => id === detailId)?.contentHash).toBe(contentHash(changed!.content!));
        expect(manifest.lines.find(({id}) => id === lineId)?.contentHash).toBe(contentHash(lineChange!.content!));
        expect(manifest.plans.find(({id}) => id === planA)?.placements.some(({entryId}) => entryId === detailId)).toBe(true);
        expect(manifest.plans.find(({id}) => id === planB)?.placements.some(({entryId}) => entryId === detailId)).toBe(true);
    });
    it("撤回细纲时解固定其章节节点所在的线路，而非只查细纲节点", async () => {
        const planning = new PlanningFixture();
        const {rootId, planId} = adoptedPlan(planning, "方案");
        const chapterId = planning.adoptedChapter(planId, rootId, "第一章", "主角获救");
        const otherId = planning.adoptedChapter(planId, rootId, "另一章", "旁支");
        const detailId = await adoptDetail(planning, planId, chapterId, "片段");
        // 两条线路共享总纲节点；只有承载细纲所属章节的线路应被解固定。
        const [rootNode, chapterNode] = chainNodes(planning, planId, [rootId, chapterId]);
        const otherNode = planning.graph("add-graph-node", planId, {column: 1, row: 1, entryId: otherId}).nodeId!;
        planning.graph("connect-graph-nodes", planId, {from: rootNode!, to: otherNode});
        const chapterLineId = planning.createLine(planId, "章节线", "main", [rootNode!, chapterNode!]);
        const unrelatedLineId = planning.createLine(planId, "另一条线", "branch", [rootNode!, otherNode]);
        await planning.fix(chapterLineId);
        await planning.fix(unrelatedLineId);
        const current = planning.snapshot;
        const detail = planning.entry(detailId);
        const chapterLine = planning.lineSource(chapterLineId);
        const unrelatedLine = planning.lineSource(unrelatedLineId);
        const directEdit = prepareLibraryAction(current, {kind: "edit-entry", planId, entryId: detailId,
            expectedVersion: detail.value.version, expectedContentHash: detail.contentHash, title: "修改片段", body: "主角改道"});
        const editedLine = directEdit.publish.mutations.find(({relativePath}) => relativePath === chapterLine.path);
        expect(editedLine).toBeDefined();
        expect(parseLineYaml(editedLine!.content!)).toMatchObject({fixed: false, version: chapterLine.value.version + 1});
        expect(directEdit.publish.mutations.some(({relativePath}) => relativePath === unrelatedLine.path)).toBe(false);
        // 仅在 manifest 中把细纲改挂到另一章：上游链变化，撤回并解固定原章节所在线路。
        const next = {...current.manifest, revision: current.manifest.revision + 1, plans: current.manifest.plans.map((plan) => ({
            ...plan, placements: plan.placements.map((place) => place.entryId === detailId
                ? {...place, parentId: otherId} : place),
        }))};
        const result = invalidateDependentDetails(current, {expectedManifestRevision: current.manifest.revision, mutations: [
            {relativePath: "outline/manifest.yaml", content: serializeManifest(next)},
        ]});
        const manifest = parseManifest(result.mutations.find(({relativePath}) => relativePath === "outline/manifest.yaml")!.content!);
        const chapterLineMutation = result.mutations.find(({relativePath}) => relativePath === chapterLine.path);
        expect(chapterLineMutation).toBeDefined();
        expect(parseLineYaml(chapterLineMutation!.content!)).toMatchObject({fixed: false, version: chapterLine.value.version + 1});
        expect(manifest.lines.find(({id}) => id === chapterLineId)).toMatchObject({version: chapterLine.value.version + 1,
            contentHash: contentHash(chapterLineMutation!.content!)});
        expect(result.mutations.some(({relativePath}) => relativePath === unrelatedLine.path)).toBe(false);
    });
    it("改写甲的章节只撤回甲的细纲与固定线路，新增同级章节或改名不撤回，改动共享总纲时两方案均撤回", async () => {
        const planning = new PlanningFixture();
        const {rootId, planId: planA} = adoptedPlan(planning, "方案");
        const chapterA = planning.adoptedChapter(planA, rootId, "第一章", "主角获救");
        const detailA = await adoptDetail(planning, planA, chapterA, "片段");
        // 乙方案手动改用甲的总纲（空总纲无需确认替换），两方案才共用同一总纲。
        const planB = planning.library({kind: "create-plan", title: "乙方案"}).planId!;
        planning.library({kind: "associate-total", planId: planB, totalId: rootId});
        const chapterB = planning.adoptedChapter(planB, rootId, "乙章节", "主角获救");
        const detailB = await adoptDetail(planning, planB, chapterB, "乙细纲");
        const lineA = chainLine(planning, planA, "甲", "main", [rootId, chapterA]);
        const lineB = chainLine(planning, planB, "乙", "branch", [rootId, chapterB]);
        await planning.fix(lineA);
        await planning.fix(lineB);
        const current = planning.snapshot;
        const root = planning.entry(rootId);
        const [detailAPath, detailBPath] = [planning.entry(detailA).path, planning.entry(detailB).path];
        const lines = [planning.lineSource(lineA), planning.lineSource(lineB)];
        const create = prepareLibraryAction(current, {kind: "create-entry", planId: planA, parentId: rootId,
            entryKind: "chapter", title: "甲新增章节", body: ""});
        const sibling = invalidateDependentDetails(current, create.publish);
        expect(sibling.mutations.some(({relativePath}) => relativePath === detailAPath)).toBe(false);
        expect(sibling.mutations.some(({relativePath}) => lines.some((line) => line.path === relativePath))).toBe(false);
        const chapter = planning.entry(chapterA);
        const chapterEdit = invalidateDependentDetails(current, prepareLibraryAction(current, {kind: "edit-entry", planId: planA,
            entryId: chapterA, expectedVersion: chapter.value.version, expectedContentHash: chapter.contentHash,
            title: "改写第一章", body: "主角脱险"}).publish);
        expect(chapterEdit.mutations.some(({relativePath}) => relativePath === detailAPath)).toBe(true);
        expect(chapterEdit.mutations.some(({relativePath}) => relativePath === detailBPath)).toBe(false);
        expect(chapterEdit.mutations.some(({relativePath}) => relativePath === lines[0]!.path)).toBe(true);
        expect(chapterEdit.mutations.some(({relativePath}) => relativePath === lines[1]!.path)).toBe(false);
        // 乙的章节与细纲同时挂入甲方案；乙细纲的报告仍只绑定乙方案，甲方案改名不影响任何报告。
        const shared: PlanningSnapshot = {...current, manifest: {...current.manifest, plans: current.manifest.plans.map((plan) =>
            plan.id !== planA ? plan : {...plan, placements: [...plan.placements,
                {entryId: chapterB, parentId: rootId, position: 100},
                {entryId: detailB, parentId: chapterB, position: 101}]})}};
        const rename = invalidateDependentDetails(shared, prepareLibraryAction(shared,
            {kind: "rename-plan", planId: planA, title: "甲新方案"}).publish);
        expect(rename.mutations.some(({relativePath}) => relativePath === detailAPath || relativePath === detailBPath)).toBe(false);
        // 共用总纲不能经领域操作原地修改；这里直接构造改写共用总纲的发布批次，验证撤回波及所有共用方案。
        expect(() => prepareLibraryAction(current, {kind: "edit-entry", planId: planA, entryId: rootId,
            expectedVersion: root.value.version, expectedContentHash: root.contentHash, title: "新总纲", body: "改写"}))
            .toThrow(/多个方案共用/);
        const editedRoot = serializeEntryMarkdown({...root.value, version: root.value.version + 1, status: "draft",
            title: "新总纲", body: "改写"});
        const globalEdit: PlanningPublishInput = {expectedManifestRevision: current.manifest.revision, mutations: [
            {relativePath: root.path, content: editedRoot, expectedHash: root.contentHash},
            {relativePath: "outline/manifest.yaml", content: serializeManifest({...current.manifest,
                revision: current.manifest.revision + 1, entries: current.manifest.entries.map((ref) => ref.id === rootId
                    ? {...ref, version: root.value.version + 1, contentHash: contentHash(editedRoot)} : ref)})},
        ]};
        const global = invalidateDependentDetails(current, globalEdit);
        for (const path of [detailAPath, detailBPath]) {
            expect(parseEntryMarkdown(global.mutations.find(({relativePath}) => relativePath === path)!.content!))
                .toMatchObject({status: "draft", version: 2});
        }
        for (const line of lines) {
            expect(parseLineYaml(global.mutations.find(({relativePath}) => relativePath === line.path)!.content!))
                .toMatchObject({fixed: false, version: line.value.version + 1});
        }
    });

    it("章节编辑、细纲撤回与 manifest 同事务失败后重开恢复，重试才完整提交", async () => {
        const {snapshot} = fixture();
        const detail = snapshot.entries[2]!;
        const adopted: OutlineEntry = {...detail.value, status: "adopted", version: 1, analysis: {
            reportId: "report-a", planId: "plan-a", sourceHash: detail.contentHash,
            contextHash: "sha256:" + "1".repeat(64), summary: "已审阅", deviations: [], conflicts: [], resolutions: [],
        }};
        const entries = snapshot.entries.map((entry) => entry === detail ? {...entry, value: adopted,
            contentHash: contentHash(serializeEntryMarkdown(adopted))} : entry);
        const manifest = {...snapshot.manifest, entries: entries.map(({path, value, contentHash: hash}) => ({
            path, id: value.id, version: value.version, contentHash: hash,
        }))};
        const projectRoot = await createTestTmpRoot("outline-detail", "detail-rollback");
        try {
            await publishOutlineFiles({projectRoot}, [...entries.map(({path: relativePath, value}) => ({
                relativePath, content: serializeEntryMarkdown(value),
            })), {relativePath: "outline/manifest.yaml", content: serializeManifest(manifest)}]);
            const before = await readPlanningSnapshot({projectRoot});
            const chapter = before.entries.find(({value}) => value.id === "ol-chapter")!;
            const change = prepareLibraryAction(before, {kind: "edit-entry", planId: "plan-a", entryId: chapter.value.id,
                expectedVersion: chapter.value.version, expectedContentHash: chapter.contentHash, title: "重写章节", body: "改写"});
            const batch = invalidateDependentDetails(before, change.publish);
            expect(batch.mutations.map(({relativePath}) => relativePath)).toContain(detail.path);
            await expect(publishPlanningFiles({projectRoot, beforePublishFile: (relativePath) => {
                if (relativePath === "outline/manifest.yaml") throw Error("模拟发布中断");
            }}, batch)).rejects.toMatchObject({code: "PUBLISH_FAILED"});
            await recoverOutlineTransactions(projectRoot);
            expect(await readPlanningSnapshot({projectRoot})).toEqual(before);
            await publishPlanningFiles({projectRoot}, batch);
            const after = await readPlanningSnapshot({projectRoot});
            expect(after.entries.find(({value}) => value.id === "ol-chapter")!.value).toMatchObject({title: "重写章节", version: 1});
            expect(after.entries.find(({value}) => value.id === "ol-detail")!.value).toMatchObject({status: "draft", version: 2});
            expect(after.entries.find(({value}) => value.id === "ol-detail")!.value.analysis).toBeUndefined();
        } finally {
            await fs.rm(projectRoot, {recursive: true, force: true});
        }
    });

    it("生成报告不改变草稿；确认偏差和逐项处理冲突后写入可往返的正式报告", async () => {
        const {snapshot, request} = fixture();
        const issued = await analyzeDetail(snapshot, request, async (prompt) => {
            expect(JSON.parse(prompt)).toMatchObject({total: {title: "总纲"}, volume: null, chapter: {title: "第一章"}, detail: {title: "片段"}});
            expect(JSON.parse(prompt)).not.toHaveProperty("plan");
            return JSON.stringify({summary: "节奏冲突", deviations: ["偏离章纲"], conflicts: ["主角去向矛盾"]});
        });
        expect(snapshot.entries[2]!.value.status).toBe("draft");
        expect(() => confirmDetail(snapshot, request, issued, issued.report.reportId, false,
            [{index: 0, decision: "resolved", reason: "已修正"}])).toThrow(/偏差/);
        expect(() => confirmDetail(snapshot, request, issued, issued.report.reportId, true, [])).toThrow(/未处理冲突/);
        const result = confirmDetail(snapshot, request, issued, issued.report.reportId, true,
            [{index: 0, decision: "ignored", reason: "倒叙设计已确认"}]);
        const saved = result.publish.mutations.find(({relativePath}) => relativePath === snapshot.entries[2]!.path)!.content!;
        expect(parseEntryMarkdown(saved)).toMatchObject({status: "adopted", version: 1, analysis: {
            reportId: issued.report.reportId, resolutions: [{index: 0, decision: "ignored", reason: "倒叙设计已确认"}],
        }});
    });
    it("细纲结构不完整时不调用模型，直接拒绝分析", async () => {
        const {snapshot, request} = fixture();
        const detail = snapshot.entries[2]!;
        const value: OutlineEntry = {...detail.value, body: `前言\n\n${sceneDetail("主角逃跑").body}`};
        const hash = contentHash(serializeEntryMarkdown(value));
        const current: PlanningSnapshot = {...snapshot, entries: [...snapshot.entries.slice(0, 2), {...detail, value, contentHash: hash}],
            manifest: {...snapshot.manifest, entries: snapshot.manifest.entries.map((ref) => ref.id === value.id ? {...ref, contentHash: hash} : ref)}};
        let called = false;
        await expect(analyzeDetail(current, {...request, expectedContentHash: hash}, async () => {
            called = true;
            return JSON.stringify({summary: "一致", deviations: [], conflicts: []});
        })).rejects.toThrow(/细纲结构不完整：第一个一级标题之前不能有内容/);
        expect(called).toBe(false);
    });
    it("待补参考文件作为程序告警随报告返回，不阻止采用也不写入正式报告", async () => {
        const {snapshot, request} = fixture();
        const detail = snapshot.entries[2]!;
        // 细纲的参考资料写在场景正文里，没有链接的项是待补资料。
        const value: OutlineEntry = {...detail.value, body: detailBody({scenes: [{plot: ["主角逃跑"],
            references: ["[雨夜](research/雨夜.md)", "旧城区地图"]}]})};
        const hash = contentHash(serializeEntryMarkdown(value));
        const current: PlanningSnapshot = {...snapshot, entries: [...snapshot.entries.slice(0, 2), {...detail, value, contentHash: hash}],
            manifest: {...snapshot.manifest, entries: snapshot.manifest.entries.map((ref) => ref.id === value.id ? {...ref, contentHash: hash} : ref)}};
        const input = {...request, expectedContentHash: hash};
        const issued = await analyzeDetail(current, input, async () => JSON.stringify({summary: "一致", deviations: [], conflicts: []}));
        expect(issued.warnings).toEqual([{code: "PENDING_REFERENCE", entryId: value.id, entryPath: detail.path, locator: "旧城区地图"}]);
        const saved = confirmDetail(current, input, issued, issued.report.reportId, false, []).publish.mutations
            .find(({relativePath}) => relativePath === detail.path)!.content!;
        expect(parseEntryMarkdown(saved).analysis).not.toHaveProperty("warnings");
    });
    it("非规范格式的细纲草稿在分析前被拒绝，避免采用后正文交接才失效", () => {
        const {snapshot, request} = fixture();
        const detail = snapshot.entries[2]!;
        const legacy = serializeEntryMarkdown(detail.value).replace("nbook.outline-entry/v2", "nbook.outline-entry/v1");
        const value = parseEntryMarkdown(legacy, detail.path);
        const hash = contentHash(legacy);
        const current: PlanningSnapshot = {...snapshot, entries: [...snapshot.entries.slice(0, 2), {...detail, value, contentHash: hash}],
            manifest: {...snapshot.manifest, entries: snapshot.manifest.entries.map((ref) => ref.id === value.id ? {...ref, contentHash: hash} : ref)}};
        expect(() => detailAnalysisContext(current, {...request, expectedContentHash: hash})).toThrow(/规范格式/);
    });
    it("模型失败或输出损坏时不允许确认；伪造 ID 和变化的方案版本无法采用", async () => {
        const {snapshot, request} = fixture();
        await expect(analyzeDetail(snapshot, request, async () => "{}" )).rejects.toThrow(/格式无效/);
        await expect(analyzeDetail(snapshot, request, async () => {throw Error("offline");})).rejects.toThrow(/分析失败/);
        const issued = await analyzeDetail(snapshot, request, async () => JSON.stringify({summary: "可用", deviations: [], conflicts: []}));
        expect(() => confirmDetail(snapshot, request, issued, "other-report", true, [])).toThrow(/来源无效/);
        expect(() => confirmDetail({...snapshot, manifest: {...snapshot.manifest, revision: 4}},
            {...request, expectedRevision: 4}, issued, issued.report.reportId, true, [])).toThrow(/过期/);
        expect(() => confirmDetail(snapshot, {...request, expectedContentHash: "sha256:" + "0".repeat(64)},
            issued, issued.report.reportId, true, [])).toThrow(/重新分析/);
        expect(() => prepareLibraryAction(snapshot, {kind: "adopt-entry", planId: request.planId, entryId: request.entryId,
            expectedVersion: 0, expectedContentHash: request.expectedContentHash})).toThrow(/分析/);
    });
});
