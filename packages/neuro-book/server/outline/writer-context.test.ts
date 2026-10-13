import {describe, expect, it} from "vitest";
import {link, mkdir, rm, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {absoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import {contentHash, serializeLineYaml, type OutlineEntry, type OutlineId, type OutlineLine} from "./format";
import type {PlanningSnapshot} from "./index";
import {prepareForeshadowingAction} from "./foreshadowing";
import {analyzeLine, confirmLine} from "./line-analysis";
import {analyzeDetail, confirmDetail} from "./detail-analysis";
import {invalidateDependentDetails} from "./analysis-invalidation";
import {PlanningFixture} from "./line-graph.fixture";
import {detailBody, sceneDetail} from "./detail.fixture";
import {readWriterChapterContext, readWriterChapterDirectory} from "./writer-context";
import {readSelectedWriterMaterials} from "./writer-materials";

const mark = (id: string, foreshadowId: OutlineId, action: string) =>
    `<!-- nb:foreshadow marker="fm-${id}" foreshadow="${foreshadowId}" action="${action}" -->${id}<!-- /nb:foreshadow marker="fm-${id}" -->`;

/** 创建伏笔定义；adopted 时再走确认，正文标记只对正式伏笔生效。 */
function createForeshadowing(fixture: PlanningFixture, status: "adopted" | "draft"): OutlineId {
    const created = prepareForeshadowingAction(fixture.snapshot, {kind: "create-foreshadowing", title: "银纹", body: "与失踪者有关"});
    fixture.publish(created.publish);
    if (status === "adopted") {
        const source = fixture.snapshot.foreshadowing.find(({value}) => value.id === created.id)!;
        fixture.publish(prepareForeshadowingAction(fixture.snapshot, {kind: "confirm-foreshadowing", id: created.id,
            expectedVersion: source.value.version, expectedContentHash: source.contentHash}).publish);
    }
    return created.id;
}

function adoptEntry(fixture: PlanningFixture, planId: string, entryId: OutlineId): void {
    const source = fixture.entry(entryId);
    fixture.library({kind: "adopt-entry", planId, entryId, expectedVersion: source.value.version,
        expectedContentHash: source.contentHash});
}

function createEntry(fixture: PlanningFixture, planId: string, parentId: OutlineId, entryKind: "volume" | "chapter" | "detail",
    title: string, body = title, patch: Partial<OutlineEntry> = {}): OutlineId {
    // 细纲要通过结构检查才能审阅；给的正文不是模板时包成单场景细纲。
    const detailText = entryKind === "detail" && !body.startsWith("# 章节总览") ? sceneDetail(body).body : body;
    return fixture.library({kind: "create-entry", planId, parentId, entryKind, title, body: detailText,
        ...(patch.materialRefs === undefined ? {} : {materialRefs: patch.materialRefs}),
        ...(patch.references === undefined ? {} : {references: patch.references}),
        ...(patch.writingGuidance === undefined ? {} : {writingGuidance: patch.writingGuidance}),
        ...(patch.targetWords === undefined ? {} : {targetWords: patch.targetWords})}).entryId!;
}

/** 与 host 一样经撤回逻辑发布，才能验证审阅其他细纲不会撤回已审阅细纲。 */
async function reviewDetail(fixture: PlanningFixture, planId: string, detailId: OutlineId): Promise<void> {
    const source = fixture.entry(detailId);
    const request = {planId, entryId: detailId, expectedRevision: fixture.snapshot.manifest.revision,
        expectedVersion: source.value.version, expectedContentHash: source.contentHash};
    const report = await analyzeDetail(fixture.snapshot, request, async () => JSON.stringify({summary: "一致",
        deviations: [], conflicts: []}));
    fixture.publish(invalidateDependentDetails(fixture.snapshot,
        confirmDetail(fixture.snapshot, request, report, report.report.reportId, true, []).publish));
}

function createPlan(fixture: PlanningFixture, title = "方案") {
    const created = fixture.library({kind: "create-plan", title});
    const planId = created.planId!;
    const rootId = created.entryId!;
    adoptEntry(fixture, planId, rootId);
    return {rootId, planId};
}

/** 总纲 → 第一章 → 一份已审阅细纲；不建线路图，证明写作资格与线路无关。 */
async function fixture(options: Readonly<{
    chapterBody?: (foreshadowId: OutlineId) => string;
    foreshadowStatus?: "adopted" | "draft";
    detail?: Partial<OutlineEntry>;
}> = {}) {
    const planning = new PlanningFixture();
    const {rootId, planId} = createPlan(planning);
    const foreshadowId = options.chapterBody ? createForeshadowing(planning, options.foreshadowStatus ?? "adopted") : undefined;
    const chapterId = createEntry(planning, planId, rootId, "chapter", "第一章",
        options.chapterBody && foreshadowId ? options.chapterBody(foreshadowId) : "人物相遇",
        {materialRefs: ["lorebook/people/hero.md"], references: [{path: "notes/style.md"}], writingGuidance: "用有限视角", targetWords: 2400});
    adoptEntry(planning, planId, chapterId);
    const detailId = createEntry(planning, planId, chapterId, "detail", "第一场", options.detail?.body ?? "雨中相遇", options.detail);
    await reviewDetail(planning, planId, detailId);
    const request = {planId, chapterEntryId: chapterId};
    return {planning, snapshot: planning.snapshot, request, planId, rootId, chapterId, detailId, foreshadowId};
}

describe("正文写作章节目录", () => {
    it("按卷纲顺序、卷内章节顺序排列，直属总纲的章节排在最后，并逐章给出资格", () => {
        const planning = new PlanningFixture();
        const {rootId, planId} = createPlan(planning);
        const loose = createEntry(planning, planId, rootId, "chapter", "番外");
        const first = createEntry(planning, planId, rootId, "volume", "第一卷");
        const second = createEntry(planning, planId, rootId, "volume", "第二卷");
        const c1 = createEntry(planning, planId, first, "chapter", "一之一");
        const c3 = createEntry(planning, planId, second, "chapter", "二之一");
        const c2 = createEntry(planning, planId, first, "chapter", "一之二");
        const c4 = createEntry(planning, planId, second, "chapter", "二之二");
        adoptEntry(planning, planId, c1);
        const directory = readWriterChapterDirectory(planning.snapshot, {planId});
        expect(directory.chapters.map(({entryId}) => entryId)).toEqual([c1, c2, c3, c4, loose]);
        expect(directory.chapters.map(({volume}) => volume?.title ?? null)).toEqual(["第一卷", "第一卷", "第二卷", "第二卷", null]);
        // 卷纲本身是草稿不影响章节资格，章节只看自身与细纲。
        expect(directory.chapters[0]).toMatchObject({writable: false, block: {code: "DETAIL_NOT_REVIEWED", message: "本章还没有细纲"}});
        expect(directory.chapters[1]).toMatchObject({writable: false, block: {code: "OUTLINE_NOT_ADOPTED"}});
    });

    it("每个方案读取自己总纲下的章节目录，互不串到对方方案", async () => {
        const planning = new PlanningFixture();
        const a = createPlan(planning, "甲方案");
        const b = createPlan(planning, "乙方案");
        expect(a.rootId).not.toBe(b.rootId);
        const chapterA = createEntry(planning, a.planId, a.rootId, "chapter", "甲章");
        const volumeB = createEntry(planning, b.planId, b.rootId, "volume", "乙卷");
        const chapterB1 = createEntry(planning, b.planId, volumeB, "chapter", "乙章一");
        const chapterB2 = createEntry(planning, b.planId, b.rootId, "chapter", "乙番外");
        const directoryA = readWriterChapterDirectory(planning.snapshot, {planId: a.planId});
        const directoryB = readWriterChapterDirectory(planning.snapshot, {planId: b.planId});
        expect(directoryA.chapters.map(({entryId}) => entryId)).toEqual([chapterA]);
        expect(directoryB.chapters.map(({entryId}) => entryId)).toEqual([chapterB1, chapterB2]);
        expect(directoryB.chapters.map(({volume}) => volume?.title ?? null)).toEqual(["乙卷", null]);
        // 章节只属于创建它的方案，用另一方案的 planId 请求上下文会被拒绝。
        adoptEntry(planning, b.planId, chapterB1);
        await reviewDetail(planning, b.planId, createEntry(planning, b.planId, chapterB1, "detail", "乙场景"));
        expect(readWriterChapterContext(planning.snapshot, {planId: b.planId, chapterEntryId: chapterB1}).chapter.entryId).toBe(chapterB1);
        expect(() => readWriterChapterContext(planning.snapshot, {planId: a.planId, chapterEntryId: chapterB1}))
            .toThrow(/不在该写作方案中/);
    });

    it("手动共用同一总纲的方案各自挂载的章节仍按方案隔离", () => {
        const planning = new PlanningFixture();
        const a = createPlan(planning, "甲方案");
        const planB = planning.library({kind: "create-plan", title: "乙方案"}).planId!;
        planning.library({kind: "associate-total", planId: planB, totalId: a.rootId});
        const chapterA = createEntry(planning, a.planId, a.rootId, "chapter", "甲章");
        const chapterB = createEntry(planning, planB, a.rootId, "chapter", "乙章");
        expect(readWriterChapterDirectory(planning.snapshot, {planId: a.planId}).chapters.map(({entryId}) => entryId)).toEqual([chapterA]);
        expect(readWriterChapterDirectory(planning.snapshot, {planId: planB}).chapters.map(({entryId}) => entryId)).toEqual([chapterB]);
    });

    it("可写章节不依赖线路；细纲按方案顺序列出，任一细纲未审阅则整章不可写", async () => {
        const {planning, planId, chapterId, detailId} = await fixture();
        expect(readWriterChapterDirectory(planning.snapshot, {planId}).chapters).toMatchObject([{entryId: chapterId,
            writable: true, details: [{entryId: detailId, status: "adopted", version: 1}]}]);
        expect(planning.snapshot.lines).toEqual([]);
        const second = createEntry(planning, planId, chapterId, "detail", "第二场");
        const chapter = readWriterChapterDirectory(planning.snapshot, {planId}).chapters[0]!;
        expect(chapter.details.map(({entryId}) => entryId)).toEqual([detailId, second]);
        expect(chapter).toMatchObject({writable: false, block: {code: "DETAIL_NOT_REVIEWED", message: "细纲「第二场」未审阅"}});
    });

    it("同章两份细纲依次审阅后都保持已审阅，多个章节可同时可写", async () => {
        const {planning, planId, rootId, chapterId, detailId, request} = await fixture();
        const second = createEntry(planning, planId, chapterId, "detail", "第二场", "巷口追逐");
        await reviewDetail(planning, planId, second);
        const otherChapter = createEntry(planning, planId, rootId, "chapter", "第二章");
        adoptEntry(planning, planId, otherChapter);
        await reviewDetail(planning, planId, createEntry(planning, planId, otherChapter, "detail", "第三场"));
        expect(readWriterChapterDirectory(planning.snapshot, {planId}).chapters).toMatchObject([
            {entryId: chapterId, writable: true, details: [{entryId: detailId, status: "adopted"}, {entryId: second, status: "adopted"}]},
            {entryId: otherChapter, writable: true}]);
        expect(readWriterChapterContext(planning.snapshot, request).details.map(({entryId, body}) => [entryId, body]))
            .toEqual([[detailId, sceneDetail("雨中相遇").body], [second, sceneDetail("巷口追逐").body]]);
    });

    it("章节大纲回到草稿后撤销资格，写作方案不存在时拒绝", async () => {
        const {planning, planId, chapterId, request} = await fixture();
        const source = planning.entry(chapterId);
        planning.library({kind: "edit-entry", planId, entryId: chapterId, expectedVersion: source.value.version,
            expectedContentHash: source.contentHash, title: source.value.title, body: "改写"});
        expect(readWriterChapterDirectory(planning.snapshot, {planId}).chapters[0]).toMatchObject({writable: false,
            block: {code: "OUTLINE_NOT_ADOPTED"}});
        expect(() => readWriterChapterContext(planning.snapshot, request)).toThrow(/不可写/);
        expect(() => readWriterChapterDirectory(planning.snapshot, {planId: "missing"})).toThrow(/方案不存在/);
    });
});

describe("正文写作章节上下文", () => {
    it("返回正式章节大纲、本章细纲与卷纲，不含分析报告", async () => {
        const {snapshot, request, planId, chapterId, detailId} = await fixture();
        const context = readWriterChapterContext(snapshot, request);
        const chapter = snapshot.entries.find(({value}) => value.id === chapterId)!;
        const detail = snapshot.entries.find(({value}) => value.id === detailId)!;
        expect(context).toMatchObject({planId, revision: snapshot.manifest.revision, volume: null,
            chapter: {entryId: chapterId, kind: "chapter", body: "人物相遇", materialRefs: ["lorebook/people/hero.md"],
                references: [{path: "notes/style.md"}], writingGuidance: "用有限视角", targetWords: 2400,
                path: chapter.path, version: 1},
            details: [{entryId: detailId, body: sceneDetail("雨中相遇").body, path: detail.path, version: 1}],
            basis: {chapterVersion: 1, chapterContentHash: chapter.contentHash,
                details: [{entryId: detailId, version: 1, contentHash: detail.contentHash}]}});
        expect(context.details[0]).not.toHaveProperty("analysis");
        expect(context).not.toHaveProperty("basisChanged");
        expect(() => readWriterChapterContext(snapshot, {...request, chapterEntryId: "ol-missing"})).toThrow(/不在该写作方案/);
    });

    it("附带的依据与当前一致时标记未变化，不一致时返回当前依据与变化标记", async () => {
        const {snapshot, request} = await fixture();
        const {basis} = readWriterChapterContext(snapshot, request);
        expect(readWriterChapterContext(snapshot, {...request, expectedBasis: basis}).basisChanged).toBe(false);
        const stale = {...basis, chapterVersion: basis.chapterVersion - 1};
        expect(readWriterChapterContext(snapshot, {...request, expectedBasis: stale})).toMatchObject({basisChanged: true, basis});
        expect(readWriterChapterContext(snapshot, {...request, expectedBasis: {...basis, details: []}}).basisChanged).toBe(true);
    });

    it("伏笔标记取自章节大纲，只含已确认伏笔，不按线路判定先后，不含定义正文", async () => {
        const body = (id: OutlineId) => `${mark("early", id, "recover")} ${mark("plant", id, "plant")}`;
        const {snapshot, request, chapterId, foreshadowId} = await fixture({chapterBody: body});
        const context = readWriterChapterContext(snapshot, request);
        const definition = snapshot.foreshadowing.find(({value}) => value.id === foreshadowId)!;
        expect(context.foreshadowing).toMatchObject([
            {id: foreshadowId, marker: "fm-early", action: "recover", content: "early"},
            {id: foreshadowId, title: "银纹", marker: "fm-plant", action: "plant", content: "plant",
                path: definition.path, version: definition.value.version, contentHash: definition.contentHash,
                entryPath: snapshot.entries.find(({value}) => value.id === chapterId)!.path},
        ]);
        expect(context.foreshadowing[0]).not.toHaveProperty("body");
        const draft = await fixture({chapterBody: body, foreshadowStatus: "draft"});
        expect(readWriterChapterContext(draft.snapshot, draft.request).foreshadowing).toEqual([]);
    });

    it("关联的线路未固定或节点失效时，章节资格与上下文不受影响", async () => {
        const {planning, planId, rootId, chapterId, request} = await fixture();
        const before = readWriterChapterContext(planning.snapshot, request);
        const rootNode = planning.graph("add-graph-node", planId, {column: 0, row: 0, entryId: rootId}).nodeId!;
        const chapterNode = planning.graph("add-graph-node", planId, {column: 1, row: 0, entryId: chapterId}).nodeId!;
        planning.graph("connect-graph-nodes", planId, {from: rootNode, to: chapterNode});
        const lineId = planning.createLine(planId, "主线", "main", [rootNode, chapterNode]);
        const lineRequest = planning.analysisRequest(lineId);
        const issued = await analyzeLine(planning.snapshot, lineRequest, async () => JSON.stringify({summary: "通过", conflicts: []}));
        planning.publish(confirmLine(planning.snapshot, lineRequest, issued, issued.report.reportId, []));
        // 伪造固定线路引用了已被改动的内容，线路检查会把节点标黄；写作交接不读取它。
        const snapshot = planning.snapshot;
        const line = snapshot.lines.find(({value}) => value.id === lineId)!;
        const broken: OutlineLine = {...line.value, analysis: {...line.value.analysis!, entryHashes: []}};
        const withBrokenLine: PlanningSnapshot = {...snapshot,
            lines: [{...line, value: broken, contentHash: contentHash(serializeLineYaml(broken))}]};
        expect(readWriterChapterContext(withBrokenLine, request)).toMatchObject({chapter: before.chapter, details: before.details,
            foreshadowing: before.foreshadowing});
        expect(readWriterChapterDirectory(withBrokenLine, {planId}).chapters[0]!.writable).toBe(true);
    });

    it("细纲参考资料取自正文各场景：有链接的给路径，没有链接的作为待补告警返回", async () => {
        const body = detailBody({scenes: [{plot: ["相遇"], references: ["[文风](notes/style.md)", "旧城区地图"]},
            {plot: ["追逐"], references: ["[城](notes/city.md)"]}]});
        const {snapshot, request, detailId} = await fixture({detail: {body}});
        const detail = readWriterChapterContext(snapshot, request).details[0]!;
        expect(detail.references).toEqual([{path: "notes/style.md", purpose: "文风"}, {pending: true, locator: "旧城区地图"},
            {path: "notes/city.md", purpose: "城"}]);
        expect(readWriterChapterContext(snapshot, request).warnings).toEqual([{code: "PENDING_REFERENCE", entryId: detailId,
            entryPath: snapshot.entries.find(({value}) => value.id === detailId)!.path, locator: "旧城区地图"}]);
    });

    it("细纲来源被绕过领域操作改动时拒绝整份上下文", async () => {
        const {snapshot, request, detailId} = await fixture();
        const changed: PlanningSnapshot = {...snapshot, entries: snapshot.entries.map((entry) => entry.value.id === detailId
            ? {...entry, value: {...entry.value, body: "未重审"}} : entry)};
        expect(() => readWriterChapterContext(changed, request)).toThrow(/不可写.*来源已变化/);
    });
});

describe("章节素材按需读取", () => {
    it("仅读取本章正式条目引用的素材，并返回来源与内容 hash", async () => {
        const root = await createTestTmpRoot("outline-material", "writer-material-selection");
        try {
            const {snapshot, request, chapterId} = await fixture();
            const context = readWriterChapterContext(snapshot, request);
            const material = join(root, "lorebook/people/hero.md");
            await mkdir(dirname(material), {recursive: true});
            await writeFile(material, "角色设定", "utf8");
            const result = await readSelectedWriterMaterials(absoluteFsPath(root), context, ["lorebook/people/hero.md"]);
            expect(result).toEqual([{path: "lorebook/people/hero.md", content: "角色设定",
                contentHash: contentHash("角色设定"), sources: [{entryId: chapterId,
                    entryVersion: 1, entryContentHash: context.chapter.contentHash,
                    entryPath: snapshot.entries.find(({value}) => value.id === chapterId)!.path, field: "materialRefs"}]}]);
            await expect(readSelectedWriterMaterials(absoluteFsPath(root), context, ["lorebook/people/secret.md"]))
                .rejects.toThrow(/正式/);
            await expect(readSelectedWriterMaterials(absoluteFsPath(root), context, ["../private.md"]))
                .rejects.toThrow();
        } finally {
            await rm(root, {recursive: true, force: true});
        }
    });

    it("拒绝丢失、超大文件和硬链接别名，不返回部分成功内容", async () => {
        const root = await createTestTmpRoot("outline-material", "writer-material-security");
        try {
            const {snapshot, request} = await fixture();
            const context = readWriterChapterContext(snapshot, request);
            const material = join(root, "lorebook/people/hero.md");
            await mkdir(dirname(material), {recursive: true});
            await expect(readSelectedWriterMaterials(absoluteFsPath(root), context, ["lorebook/people/hero.md"]))
                .rejects.toThrow();
            await writeFile(material, "x".repeat(65_537), "utf8");
            await expect(readSelectedWriterMaterials(absoluteFsPath(root), context, ["lorebook/people/hero.md"]))
                .rejects.toThrow(/过大/);
            await rm(material);
            const hidden = join(root, "outline/entries/hidden.md");
            await mkdir(dirname(hidden), {recursive: true});
            await writeFile(hidden, "隐藏规划", "utf8");
            await link(hidden, material);
            await expect(readSelectedWriterMaterials(absoluteFsPath(root), context, ["lorebook/people/hero.md"]))
                .rejects.toThrow(/链接/);
        } finally {
            await rm(root, {recursive: true, force: true});
        }
    });
});
