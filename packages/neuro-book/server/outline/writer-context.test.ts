import {describe, expect, it} from "vitest";
import {link, mkdir, rm, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {absoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import {contentHash, serializeEntryMarkdown, serializeLineYaml, type OutlineEntry, type OutlineId, type OutlineLine} from "./format";
import type {PlanningSnapshot} from "./index";
import {prepareForeshadowingAction} from "./foreshadowing";
import {analyzeLine, confirmLine} from "./line-analysis";
import {analyzeDetail, confirmDetail} from "./detail-analysis";
import {buildDesignGraph, PlanningFixture} from "./line-graph.fixture";
import {readWriterOutlineContext} from "./writer-context";
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

async function fixLine(fixture: PlanningFixture, lineId: OutlineId) {
    const request = fixture.analysisRequest(lineId);
    const issued = await analyzeLine(fixture.snapshot, request, async () => JSON.stringify({summary: "通过", conflicts: []}));
    fixture.publish(confirmLine(fixture.snapshot, request, issued, issued.report.reportId, []));
    return fixture.analysisRequest(lineId);
}

async function adoptDetail(fixture: PlanningFixture, planId: string, chapterId: OutlineId, patch: Partial<OutlineEntry>): Promise<OutlineId> {
    const detailId = fixture.library({kind: "create-entry", planId, parentId: chapterId, entryKind: "detail",
        title: "第一场", body: patch.body ?? "雨中相遇",
        ...(patch.references === undefined ? {} : {references: patch.references})}).entryId!;
    const source = fixture.entry(detailId);
    const request = {planId, entryId: detailId, expectedRevision: fixture.snapshot.manifest.revision,
        expectedVersion: source.value.version, expectedContentHash: source.contentHash};
    const report = await analyzeDetail(fixture.snapshot, request, async () => JSON.stringify({summary: "一致",
        deviations: [], conflicts: []}));
    fixture.publish(confirmDetail(fixture.snapshot, request, report, report.report.reportId, true, []).publish);
    return detailId;
}

/** 总纲 → 第一章的固定主线；细纲须在固定前采用，否则方案上下文变化会让线路变黄。 */
async function fixture(
    withDetail = false, chapterBody?: (foreshadowId: OutlineId) => string, foreshadowStatus: "adopted" | "draft" = "adopted",
    detailPatch: Partial<OutlineEntry> = {},
) {
    const planning = new PlanningFixture();
    const rootId = planning.library({kind: "create-total", title: "总纲", body: "作品背景"}).entryId!;
    const planId = planning.library({kind: "create-plan", title: "方案"}).planId!;
    const root = planning.entry(rootId);
    planning.library({kind: "adopt-entry", planId, entryId: rootId, expectedVersion: root.value.version,
        expectedContentHash: root.contentHash});
    const foreshadowId = chapterBody ? createForeshadowing(planning, foreshadowStatus) : undefined;
    const chapterId = planning.library({kind: "create-entry", planId, parentId: rootId, entryKind: "chapter", title: "第一章",
        body: chapterBody && foreshadowId ? chapterBody(foreshadowId) : "人物相遇", materialRefs: ["lorebook/people/hero.md"],
        references: [{path: "notes/style.md"}], writingGuidance: "用有限视角", targetWords: 2400}).entryId!;
    const chapter = planning.entry(chapterId);
    planning.library({kind: "adopt-entry", planId, entryId: chapterId, expectedVersion: chapter.value.version,
        expectedContentHash: chapter.contentHash});
    const detailId = withDetail ? await adoptDetail(planning, planId, chapterId, detailPatch) : undefined;
    const rootNode = planning.graph("add-graph-node", planId, {column: 0, row: 0, entryId: rootId}).nodeId!;
    const chapterNode = planning.graph("add-graph-node", planId, {column: 1, row: 0, entryId: chapterId}).nodeId!;
    planning.graph("connect-graph-nodes", planId, {from: rootNode, to: chapterNode});
    const lineId = planning.createLine(planId, "主线", "main", [rootNode, chapterNode]);
    const request = await fixLine(planning, lineId);
    return {planning, snapshot: planning.snapshot, request, planId, lineId, rootId, chapterId, detailId, foreshadowId,
        rootNode, chapterNode};
}

describe("writer 只读规划投影", () => {
    it("仅交接固定线路当前章节的有效伏笔标记及规范定义来源", async () => {
        const body = (id: OutlineId) => `${mark("early", id, "recover")} ${mark("plant", id, "plant")} ${mark("late", id, "recover")}`;
        const {snapshot, request, chapterId, foreshadowId} = await fixture(false, body);
        const context = readWriterOutlineContext(snapshot, request);
        const definition = snapshot.foreshadowing.find(({value}) => value.id === foreshadowId)!;
        expect(context.nodes[0]!.foreshadowing).toEqual([]);
        expect(context.nodes[1]!.foreshadowing).toMatchObject([
            {id: foreshadowId, title: "银纹", content: "plant", marker: "fm-plant", action: "plant",
                path: definition.path, version: definition.value.version,
                contentHash: definition.contentHash, entryPath: snapshot.entries.find(({value}) => value.id === chapterId)!.path},
            {id: foreshadowId, marker: "fm-late", action: "recover"},
        ]);
        expect(context.nodes[1]!.foreshadowing).toHaveLength(2);
        expect(context.nodes[1]!.foreshadowing[0]).not.toHaveProperty("body");
        const draft = await fixture(false, body, "draft");
        expect(readWriterOutlineContext(draft.snapshot, draft.request).nodes[1]!.foreshadowing).toEqual([]);
    });

    it("仅从有效固定节点交接正式章节正文、元数据及规范来源", async () => {
        const {snapshot, request, planId, lineId, rootNode, chapterNode, chapterId} = await fixture();
        const context = readWriterOutlineContext(snapshot, request);
        expect(context).toMatchObject({lineId, planId, revision: snapshot.manifest.revision,
            nodes: [{nodeId: rootNode, column: 0, kind: "total", body: "作品背景"},
                {nodeId: chapterNode, column: 1, kind: "chapter", body: "人物相遇", materialRefs: ["lorebook/people/hero.md"],
                    references: [{path: "notes/style.md"}], writingGuidance: "用有限视角", targetWords: 2400,
                    path: snapshot.entries.find(({value}) => value.id === chapterId)!.path, version: 1}]});
        expect(context.nodes[1]).not.toHaveProperty("analysis");
    });

    it("按格号交接线路节点，伏笔来源只取属于本线路的节点", async () => {
        const planning = new PlanningFixture();
        const foreshadowId = createForeshadowing(planning, "adopted");
        const {planId, entries, nodes, lines} = buildDesignGraph(planning);
        // k1 只属于角色线乙，a2 只属于角色线甲，j4 是两者的汇合节点。
        const rewrite = (key: "k1" | "a2" | "j4", body: string) => {
            const source = planning.entry(entries[key]);
            planning.library({kind: "edit-entry", planId, entryId: entries[key], expectedVersion: source.value.version,
                expectedContentHash: source.contentHash, title: source.value.title, body});
            const edited = planning.entry(entries[key]);
            planning.library({kind: "adopt-entry", planId, entryId: entries[key], expectedVersion: edited.value.version,
                expectedContentHash: edited.contentHash});
        };
        rewrite("k1", `k1 ${mark("k1", foreshadowId, "plant")}`);
        rewrite("a2", `a2 ${mark("a2", foreshadowId, "recover")}`);
        rewrite("j4", `j4 ${mark("j4", foreshadowId, "reinforce")}`);
        // 节点按乱序保存，交接顺序仍由格号决定。
        const shuffled = [nodes.m6, nodes.j4, nodes.m0, nodes.k3, nodes.k1];
        planning.line({kind: "edit-draft-line", ...planning.lineCas(lines.characterB), title: "角色线乙", type: "character",
            nodeIds: shuffled});
        await fixLine(planning, lines.characterA);
        const request = await fixLine(planning, lines.characterB);
        const context = readWriterOutlineContext(planning.snapshot, request);
        expect(context.nodes.map(({nodeId}) => nodeId)).toEqual([nodes.m0, nodes.k1, nodes.k3, nodes.j4, nodes.m6]);
        expect(context.nodes.map(({column}) => column)).toEqual([0, 1, 3, 4, 6]);
        const markers = context.nodes.flatMap(({nodeId, foreshadowing}) => foreshadowing.map(({marker, action}) => ({nodeId, marker, action})));
        expect(markers).toEqual([
            {nodeId: nodes.k1, marker: "fm-k1", action: "plant"},
            {nodeId: nodes.j4, marker: "fm-j4", action: "reinforce"},
        ]);
    });

    it("只交接当前方案正式章节所属且报告仍有效的细纲，不混入草稿或旁支", async () => {
        const {snapshot, request, detailId} = await fixture(true);
        const result = readWriterOutlineContext(snapshot, request);
        const detail = snapshot.entries.find(({value}) => value.id === detailId)!;
        expect(result.nodes[0]!.details).toEqual([]);
        expect(result.nodes[1]!.details).toMatchObject([{entryId: detailId, body: "雨中相遇",
            path: detail.path, version: 1}]);
        const draftDetail: OutlineEntry = {...detail.value, id: "ol-other", status: "draft", version: 0,
            analysis: undefined, body: "草稿不应进入正文"};
        const another = {...detail, value: draftDetail, path: "outline/entries/other.md",
            contentHash: contentHash(serializeEntryMarkdown(draftDetail))};
        const withDraft = {...snapshot, entries: [...snapshot.entries, another], manifest: {...snapshot.manifest,
            entries: [...snapshot.manifest.entries, {id: draftDetail.id, path: another.path, version: 0,
                contentHash: another.contentHash}]}};
        expect(readWriterOutlineContext(withDraft, request).nodes[1]!.details).toHaveLength(1);
    });

    it("细纲交接场景写作指导与篇幅预算，待补参考文件作为告警返回", async () => {
        const body = '开场<!-- nb:guidance marker="g1" scene="雨夜" words="800" -->略写环境<!-- /nb:guidance marker="g1" -->';
        const {snapshot, request, detailId} = await fixture(true, undefined, "adopted", {body,
            references: [{path: "notes/style.md"}, {locator: "旧城区地图", purpose: "街道走向", pending: true}]});
        const context = readWriterOutlineContext(snapshot, request);
        expect(context.nodes[1]!.details[0]).toMatchObject({guidance: [{marker: "g1", scene: "雨夜", words: 800, text: "略写环境"}]});
        expect(context.nodes[1]!.guidance).toEqual([]);
        expect(context.warnings).toEqual([{code: "PENDING_REFERENCE", entryId: detailId,
            entryPath: snapshot.entries.find(({value}) => value.id === detailId)!.path,
            locator: "旧城区地图", purpose: "街道走向"}]);
    });

    it("拒绝旧版本、草稿、黄色节点，不回退读取大纲库草稿", async () => {
        const {snapshot, request, lineId, chapterId} = await fixture();
        expect(() => readWriterOutlineContext(snapshot, {...request, expectedRevision: request.expectedRevision - 1})).toThrow(/版本/);
        const line = snapshot.lines.find(({value}) => value.id === lineId)!;
        const draft: OutlineLine = {...line.value, fixed: false};
        const draftHash = contentHash(serializeLineYaml(draft));
        expect(() => readWriterOutlineContext({...snapshot, lines: [{...line, value: draft, contentHash: draftHash}]},
            {...request, expectedContentHash: draftHash})).toThrow(/失效/);
        const changed: PlanningSnapshot = {...snapshot, entries: snapshot.entries.map((entry) => entry.value.id === chapterId
            ? {...entry, value: {...entry.value, body: "未重分析"}, contentHash: contentHash("未重分析")} : entry)};
        expect(() => readWriterOutlineContext(changed, request)).toThrow(/失效/);
    });
});


describe("正式线路素材索引按需读取", () => {
    it("仅读取所选正式素材并返回章节来源与内容 hash", async () => {
        const root = await createTestTmpRoot("outline-material", "writer-material-selection");
        try {
            const {snapshot, request, chapterId, chapterNode} = await fixture();
            const context = readWriterOutlineContext(snapshot, request);
            const material = join(root, "lorebook/people/hero.md");
            await mkdir(dirname(material), {recursive: true});
            await writeFile(material, "角色设定", "utf8");
            const result = await readSelectedWriterMaterials(absoluteFsPath(root), context, ["lorebook/people/hero.md"]);
            expect(result).toEqual([{path: "lorebook/people/hero.md", content: "角色设定",
                contentHash: contentHash("角色设定"), sources: [{nodeId: chapterNode, entryId: chapterId,
                    entryVersion: 1, entryContentHash: context.nodes[1]!.contentHash,
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
            const context = readWriterOutlineContext(snapshot, request);
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
