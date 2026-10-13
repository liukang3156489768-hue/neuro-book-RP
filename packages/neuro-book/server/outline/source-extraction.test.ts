import {describe, expect, it} from "vitest";
import {parseEntryMarkdown, serializeEntryMarkdown, type OutlineEntry, type OutlineId} from "./format";
import {assertNonDestructivePlanningEdit} from "./index";
import {invalidateDependentDetails} from "./analysis-invalidation";
import {prepareSourceExtractionDetail} from "./library";
import {PlanningFixture} from "./line-graph.fixture";
import {sceneDetail} from "./detail.fixture";
import {readWriterChapterContext, readWriterChapterDirectory} from "./writer-context";

const sources = [{path: "reference/novel.txt", locator: "P1-P3"}];

function adopt(fixture: PlanningFixture, planId: string, entryId: OutlineId): void {
    const source = fixture.entry(entryId);
    fixture.library({kind: "adopt-entry", planId, entryId, expectedVersion: source.value.version, expectedContentHash: source.contentHash});
}

function edit(fixture: PlanningFixture, planId: string, entryId: OutlineId, body: string) {
    const source = fixture.entry(entryId);
    return fixture.library({kind: "edit-entry", planId, entryId, expectedVersion: source.value.version,
        expectedContentHash: source.contentHash, title: source.value.title, body});
}

/** 总纲 → 第一章（章节大纲草稿）→ 一份来源提取细纲。 */
function extracted() {
    const fixture = new PlanningFixture();
    const created = fixture.library({kind: "create-plan", title: "提取方案"});
    const planId = created.planId!;
    const rootId = created.entryId!;
    adopt(fixture, planId, rootId);
    const chapterId = fixture.library({kind: "create-entry", planId, parentId: rootId, entryKind: "chapter", title: "第一章", body: "相遇"}).entryId!;
    const change = prepareSourceExtractionDetail(fixture.snapshot, {planId, chapterId, title: "第一场", body: sceneDetail("雨中相遇").body, sources});
    fixture.publish(change.publish);
    return {fixture, planId, rootId, chapterId, detailId: change.entryId!};
}

describe("细纲来源提取依据", () => {
    it("不经分析即为正式细纲，章节大纲采用后整章可写", () => {
        const {fixture, planId, chapterId, detailId} = extracted();
        const detail = fixture.entry(detailId).value;
        expect(detail).toMatchObject({kind: "detail", status: "adopted", version: 1, chapterId, basis: {kind: "source-extraction", sources}});
        expect(detail.analysis).toBeUndefined();
        expect(readWriterChapterDirectory(fixture.snapshot, {planId}).chapters[0]).toMatchObject({
            writable: false, block: {code: "OUTLINE_NOT_ADOPTED"}, details: [{entryId: detailId, status: "adopted"}]});
        adopt(fixture, planId, chapterId);
        expect(readWriterChapterDirectory(fixture.snapshot, {planId}).chapters[0]).toMatchObject({writable: true});
        expect(readWriterChapterContext(fixture.snapshot, {planId, chapterEntryId: chapterId}).details.map(({entryId}) => entryId))
            .toEqual([detailId]);
    });

    it("上游条目被改后，来源提取细纲不被撤回并仍可写", () => {
        const {fixture, planId, rootId, chapterId, detailId} = extracted();
        adopt(fixture, planId, chapterId);
        const change = edit(fixture, planId, rootId, "改写总纲");
        // 与 host 一样经撤回逻辑发布：来源提取细纲不应出现在额外改写里。
        const reconciled = invalidateDependentDetails(fixture.snapshot, change.publish);
        expect(reconciled.mutations.map(({relativePath}) => relativePath)).not.toContain(fixture.entry(detailId).path);
        expect(fixture.entry(detailId).value).toMatchObject({status: "adopted", basis: {kind: "source-extraction"}});
        expect(readWriterChapterDirectory(fixture.snapshot, {planId}).chapters[0]).toMatchObject({writable: true});
    });

    it("用户编辑正文后回到草稿并清除依据，之后须按常规流程审阅", () => {
        const {fixture, planId, chapterId, detailId} = extracted();
        adopt(fixture, planId, chapterId);
        edit(fixture, planId, detailId, sceneDetail("改写后的场景").body);
        const edited = fixture.entry(detailId);
        expect(edited.value).toMatchObject({status: "draft", version: 2});
        expect(edited.value.basis).toBeUndefined();
        expect(readWriterChapterDirectory(fixture.snapshot, {planId}).chapters[0]).toMatchObject({
            writable: false, block: {code: "DETAIL_NOT_REVIEWED"}});
        expect(() => fixture.library({kind: "adopt-entry", planId, entryId: detailId, expectedVersion: edited.value.version,
            expectedContentHash: edited.contentHash})).toThrow(/分析/);
    });

    it("仅移动不改变依据与正式状态", () => {
        const {fixture, planId, rootId, detailId} = extracted();
        const other = fixture.library({kind: "create-entry", planId, parentId: rootId, entryKind: "chapter", title: "第二章", body: "追逐"}).entryId!;
        const source = fixture.entry(detailId);
        fixture.library({kind: "move-entry", planId, entryId: detailId, parentId: other, expectedVersion: source.value.version,
            expectedContentHash: source.contentHash});
        expect(fixture.entry(detailId).value).toMatchObject({status: "adopted", chapterId: other, version: 2,
            basis: {kind: "source-extraction"}});
    });

    it("缺少原文引用或挂载位置无效时拒绝", () => {
        const {fixture, planId, rootId, chapterId} = extracted();
        const base = {planId, chapterId, title: "无依据", body: sceneDetail("x").body};
        expect(() => prepareSourceExtractionDetail(fixture.snapshot, {...base, sources: []})).toThrow(/原文引用/);
        expect(() => prepareSourceExtractionDetail(fixture.snapshot, {...base, chapterId: rootId, sources})).toThrow(/章节大纲/);
        expect(() => prepareSourceExtractionDetail(fixture.snapshot, {...base, planId: "plan-missing", sources})).toThrow(/方案链不存在/);
    });

    it("格式层只接受带引用、无分析报告的正式细纲上的 basis", () => {
        const detail: OutlineEntry = {schema: "nbook.outline-entry/v2", id: "ol-detail", version: 1, kind: "detail", status: "adopted",
            title: "细纲", parentId: "ol-chapter", chapterId: "ol-chapter", body: "正文", basis: {kind: "source-extraction", sources}};
        expect(parseEntryMarkdown(serializeEntryMarkdown(detail)).basis).toEqual(detail.basis);
        const invalid: OutlineEntry[] = [
            {...detail, status: "draft"},
            {...detail, kind: "chapter", chapterId: null},
            {...detail, basis: {kind: "source-extraction", sources: []}},
            {...detail, basis: {kind: "source-extraction", sources: [{path: "reference/a.txt", locator: ""}]}},
        ];
        for (const bad of invalid) expect(() => parseEntryMarkdown(serializeEntryMarkdown(bad))).toThrow();
    });

    it("旧细纲（无 basis）序列化不含该字段，读取不变", () => {
        const {fixture, detailId} = extracted();
        const content = serializeEntryMarkdown({...fixture.entry(detailId).value, basis: undefined, status: "draft"});
        expect(content).not.toContain("basis");
        expect(parseEntryMarkdown(content).basis).toBeUndefined();
    });

    it("原始发布不能改写细纲文件，因此无法伪造来源提取依据", () => {
        const {fixture, detailId} = extracted();
        const source = fixture.entry(detailId);
        const forged = serializeEntryMarkdown({...source.value, version: source.value.version + 1, body: "伪造"});
        expect(() => assertNonDestructivePlanningEdit(fixture.snapshot, {expectedManifestRevision: fixture.snapshot.manifest.revision,
            mutations: [{relativePath: source.path, content: forged, expectedHash: source.contentHash}]})).toThrow();
    });
});
