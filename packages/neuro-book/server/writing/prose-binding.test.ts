import {describe, expect, it} from "vitest";
import YAML from "yaml";
import type {WriterChapterSummary} from "nbook/server/outline/writer-context";
import {
    deriveWritingOverview, EMPTY_WRITING_SETTINGS, parseWritingSettings, readWritingField, resolveVolumeTarget,
    sanitizeDirectoryName, setFrontmatterField, uniqueDirectoryName, WritingError, writingFieldValue, type ProseFile,
} from "./prose-binding";

const hash = (digit: string) => `sha256:${digit.repeat(64)}`;

function chapter(entryId: string, patch: Partial<WriterChapterSummary> = {}): WriterChapterSummary {
    return {entryId, title: entryId, status: "adopted", version: 1, contentHash: hash("1"), volume: null,
        details: [{entryId: `${entryId}-d`, title: "细纲", status: "adopted", version: 2, contentHash: hash("2")}],
        writable: true, ...patch};
}

function prose(path: string, field: ProseFile["field"], empty = false): ProseFile {
    return {path: `${path}/index.md`, dirPath: path, title: path.split("/").at(-1)!, empty, field};
}

const linked = (chapterEntryId: string, source?: Parameters<typeof writingFieldValue>[1]): ProseFile["field"] =>
    ({kind: "linked", value: writingFieldValue(chapterEntryId, source)});

const settings = {...EMPTY_WRITING_SETTINGS, writingPlanId: "plan-a"};
const ready = (chapters: WriterChapterSummary[]) =>
    ({kind: "ready" as const, plans: [{id: "plan-a", title: "主方案"}], revision: 3, chapters});

describe("正文文件头 writing 字段", () => {
    it("只改写 writing 字段，保留其他字段、注释与正文", () => {
        const before = "---\n# 用户注释\ntitle: 第一章\ntags: [a, b]\n---\n\n正文第一段\n";
        const after = setFrontmatterField(before, "writing", writingFieldValue("ol-ch1"));
        expect(after).toContain("# 用户注释");
        expect(after).toContain("tags: [a, b]");
        expect(after.endsWith("\n正文第一段\n")).toBe(true);
        const yaml = YAML.parse(after.split("---")[1]!);
        expect(yaml).toMatchObject({title: "第一章", writing: {schema: "nbook.writing-source/v1", chapterEntryId: "ol-ch1"}});
        const removed = setFrontmatterField(after, "writing", null);
        expect(removed).toBe(before);
        expect(setFrontmatterField(removed, "writing", null)).toBe(removed);
    });

    it("没有文件头时新建；文件头无法解析时拒绝改写", () => {
        const created = setFrontmatterField("正文", "writing", writingFieldValue("ol-ch1"));
        expect(created.startsWith("---\nwriting:\n")).toBe(true);
        expect(created.endsWith("---\n\n正文")).toBe(true);
        expect(setFrontmatterField("正文", "writing", null)).toBe("正文");
        expect(() => setFrontmatterField("---\ntitle: [\n---\n正文", "writing", null)).toThrow(WritingError);
    });

    it("字段形状不对或文件头损坏都归为格式错误，不猜测归属", () => {
        expect(readWritingField({}, null)).toEqual({kind: "none"});
        expect(readWritingField({writing: {schema: "nbook.writing-source/v1", chapterEntryId: "ol-a"}}, null).kind).toBe("linked");
        expect(readWritingField({writing: {chapterEntryId: "ol-a"}}, null).kind).toBe("invalid");
        expect(readWritingField({writing: {schema: "nbook.writing-source/v1", chapterEntryId: "ol-a",
            source: {planId: "p", chapterVersion: 1}}}, null).kind).toBe("invalid");
        expect(readWritingField({}, "bad yaml")).toMatchObject({kind: "invalid"});
    });

    it("写作设置格式非法时返回空设置与错误说明", () => {
        expect(parseWritingSettings("schema: nbook.writing-settings/v1\nwritingPlanId: p\nstylePath: null\n"))
            .toEqual({settings: {schema: "nbook.writing-settings/v1", writingPlanId: "p", stylePath: null}});
        const invalid = parseWritingSettings("schema: other\n");
        expect(invalid.settings).toEqual(EMPTY_WRITING_SETTINGS);
        expect(invalid.error).toContain("写作设置格式非法");
        expect(parseWritingSettings("a: [").error).toContain("无法解析");
    });
});

describe("章节写作状态派生", () => {
    it("按依据派生未写、已写、依据已过期，灰显章节仍列出正文", () => {
        const source = {planId: "plan-other", chapterVersion: 1, chapterContentHash: hash("1"),
            details: [{entryId: "ol-a-d", version: 2, contentHash: hash("2")}], generatedAt: "2026-09-29T00:00:00.000Z"};
        const chapters = [
            chapter("ol-a"), chapter("ol-b"), chapter("ol-c"), chapter("ol-d"), chapter("ol-e"),
            chapter("ol-f", {writable: false, status: "draft", block: {code: "OUTLINE_NOT_ADOPTED", message: "章节大纲未采用"}}),
        ];
        const overview = deriveWritingOverview({settings, planning: ready(chapters), proseFiles: [
            prose("manuscript/a", linked("ol-a", source)),
            prose("manuscript/b", linked("ol-b", {...source, details: [...source.details, {entryId: "ol-x", version: 0, contentHash: hash("3")}]})),
            prose("manuscript/c", linked("ol-c")),
            prose("manuscript/d", linked("ol-d"), true),
            prose("manuscript/f", linked("ol-f")),
        ]});
        const status = Object.fromEntries(overview.chapters.map(({entryId, status: value}) => [entryId, value]));
        // ol-a 的依据来自另一方案，但章节与细纲版本一致，不算过期。
        expect(status).toEqual({"ol-a": "written", "ol-b": "source-stale", "ol-c": "written", "ol-d": "unwritten",
            "ol-e": "unwritten", "ol-f": "outline-not-adopted"});
        expect(overview.chapters.find(({entryId}) => entryId === "ol-f")).toMatchObject({writable: false,
            prose: [{path: "manuscript/f/index.md", hasSource: false}]});
        expect(overview.plan).toEqual({state: "ready", planId: "plan-a", title: "主方案", revision: 3});
    });

    it("两份正文归属同一章时归属冲突且不可写", () => {
        const overview = deriveWritingOverview({settings, planning: ready([chapter("ol-a")]),
            proseFiles: [prose("manuscript/a", linked("ol-a")), prose("manuscript/a2", linked("ol-a"))]});
        expect(overview.chapters[0]).toMatchObject({status: "ownership-conflict", writable: false});
        expect(overview.chapters[0]!.prose).toHaveLength(2);
    });

    it("无归属、格式非法、不在方案中的正文进入未关联正文", () => {
        const overview = deriveWritingOverview({settings, planning: ready([chapter("ol-a")]), proseFiles: [
            prose("manuscript/x", {kind: "none"}),
            prose("manuscript/y", {kind: "invalid", message: "writing 字段格式非法"}),
            prose("manuscript/z", linked("ol-gone")),
        ]});
        expect(overview.unlinkedProse).toEqual([
            {path: "manuscript/x/index.md", title: "x", reason: "no-link"},
            {path: "manuscript/y/index.md", title: "y", reason: "invalid-link", message: "writing 字段格式非法"},
            {path: "manuscript/z/index.md", title: "z", reason: "not-in-plan", chapterEntryId: "ol-gone"},
        ]);
    });

    it("方案为空、已删除或大纲不可读时不列章节，已有正文仍列出", () => {
        const files = [prose("manuscript/a", linked("ol-a"))];
        const unset = deriveWritingOverview({settings: EMPTY_WRITING_SETTINGS, planning: ready([chapter("ol-a")]), proseFiles: files});
        expect(unset).toMatchObject({plan: {state: "unset"}, chapters: [], unlinkedProse: [{reason: "plan-unavailable"}]});
        const missing = deriveWritingOverview({settings, planning: {...ready([]), chapters: null}, proseFiles: files});
        expect(missing.plan).toMatchObject({state: "missing", planId: "plan-a"});
        const unreadable = deriveWritingOverview({settings, planning: {kind: "unreadable", message: "大纲数据不可读：坏了"}, proseFiles: files});
        expect(unreadable).toMatchObject({plan: {state: "unreadable"}, plans: [], chapters: [],
            unlinkedProse: [{reason: "plan-unavailable", chapterEntryId: "ol-a"}]});
    });
});

describe("正文位置", () => {
    it("目录名去掉非法字符，同名不区分大小写追加序号", () => {
        expect(sanitizeDirectoryName(" 第一章：雨/夜? ")).toBe("第一章：雨 夜");
        expect(sanitizeDirectoryName("...")).toBe("未命名");
        expect(sanitizeDirectoryName("CON")).toBe("_CON");
        expect(sanitizeDirectoryName("结尾.")).toBe("结尾");
        expect([...sanitizeDirectoryName("长".repeat(200))]).toHaveLength(80);
        expect(uniqueDirectoryName("Rain", ["rain", "Rain-2"])).toBe("Rain-3");
        expect(uniqueDirectoryName("雨", ["雪"])).toBe("雨");
    });

    it("卷目录先认对应标记，再认同卷正文所在卷目录，都没有才新建", () => {
        const volume = {entryId: "ol-v", title: "卷一"};
        const target = chapter("ol-b", {volume});
        const chapters = [chapter("ol-a", {volume}), target];
        const volumeDirectories = [{dirPath: "manuscript/旧卷", volumeEntryId: null}, {dirPath: "manuscript/卷一", volumeEntryId: "ol-v"}];
        expect(resolveVolumeTarget({chapter: target, chapters, volumeDirectories, proseFiles: []}))
            .toEqual({kind: "existing", dirPath: "manuscript/卷一"});
        const unmarked = [{dirPath: "manuscript/旧卷", volumeEntryId: null}];
        expect(resolveVolumeTarget({chapter: target, chapters, volumeDirectories: unmarked,
            proseFiles: [prose("manuscript/旧卷/a", linked("ol-a"))]})).toEqual({kind: "existing", dirPath: "manuscript/旧卷"});
        expect(resolveVolumeTarget({chapter: target, chapters, volumeDirectories: unmarked,
            proseFiles: [prose("manuscript/a", linked("ol-a"))]})).toEqual({kind: "create"});
        expect(resolveVolumeTarget({chapter: chapter("ol-c"), chapters, volumeDirectories, proseFiles: []})).toEqual({kind: "root"});
    });
});
