import {describe, expect, it} from "vitest";
import type {WritingChapterDto} from "nbook/shared/dto/writing.dto";
import {chapterBlockReasons, groupChaptersByVolume, issueBadge, rewriteRequestText} from "./writing-tree";

const chapter = (entryId: string, volume: string | null, extra: Partial<WritingChapterDto> = {}): WritingChapterDto => ({
    entryId, title: entryId, version: 1, contentHash: "h", volume: volume ? {entryId: volume, title: volume} : null,
    details: [], status: "unwritten", writable: true, prose: [], ...extra,
});

describe("大纲视图投影", () => {
    it("按方案顺序分卷，没有上级卷纲的章节并入未分卷", () => {
        const groups = groupChaptersByVolume([chapter("c1", null), chapter("c2", "v1"), chapter("c3", "v2"), chapter("c4", null), chapter("c5", "v1")]);
        expect(groups.map((group) => [group.title, group.chapters.map(({entryId}) => entryId)])).toEqual([
            ["未分卷", ["c1", "c4"]], ["v1", ["c2", "c5"]], ["v2", ["c3"]],
        ]);
    });

    it("归属冲突与规划阻断同时出现时两个原因都列出", () => {
        expect(chapterBlockReasons(chapter("c", null, {status: "ownership-conflict", writable: false,
            block: {code: "DETAIL_NOT_REVIEWED", message: "x"}}))).toEqual(["归属冲突", "细纲未审阅"]);
        expect(chapterBlockReasons(chapter("c", null, {status: "outline-not-adopted", writable: false,
            block: {code: "OUTLINE_NOT_ADOPTED", message: "x"}}))).toEqual(["大纲未采用"]);
        expect(chapterBlockReasons(chapter("c", null))).toEqual([]);
    });

    it("有阻断问题时徽标为阻断样式，只有提示时为提示样式", () => {
        expect(issueBadge({chapterEntryId: "c", blocking: 1, hint: 2, issues: []})).toEqual({severity: "blocking", count: 3});
        expect(issueBadge({chapterEntryId: "c", blocking: 0, hint: 2, issues: []})).toEqual({severity: "hint", count: 2});
        expect(issueBadge({chapterEntryId: "c", blocking: 0, hint: 0, issues: []})).toBeNull();
        expect(issueBadge(undefined)).toBeNull();
    });

    it("改写请求引用选区并留出修改要求", () => {
        expect(rewriteRequestText("  一段话  ")).toBe("改写选中内容：\n> 一段话\n\n修改要求：");
    });
});
