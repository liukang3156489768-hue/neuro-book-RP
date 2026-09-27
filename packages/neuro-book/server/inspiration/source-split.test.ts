import {describe, expect, it} from "vitest";
import {splitInspirationSource} from "nbook/server/inspiration/source-split";

describe("Inspiration 作品切分", () => {
    it("在完整章节边界取接近目标的块，保留不足目标的末章", () => {
        const text = [
            "第一章 出门\n", "甲".repeat(25), "\n\n",
            "第二章 相遇\n", "乙".repeat(25), "\n\n",
            "第三章 归来\n", "丙".repeat(15), "\n",
        ].join("");
        const result = splitInspirationSource(text, 65);
        expect(result.mode).toBe("chapters");
        expect(result.chunks.map((chunk) => chunk.chapterIndexes)).toEqual([[1, 2], [3]]);
        expect(result.paragraphs.map((paragraph) => paragraph.text).join("")).toBe(text);
        expect(result.chunks.map((chunk) => text.slice(chunk.startOffset, chunk.endOffset)).join("")).toBe(text);
        for (const chapter of result.chapters) {
            const paragraphs = result.paragraphs.filter((paragraph) => paragraph.chapterIndex === chapter.index);
            expect(new Set(paragraphs.map((paragraph) => paragraph.chunkIndex)).size).toBe(1);
            expect(paragraphs[0]?.id).toBe(chapter.firstParagraphId);
            expect(paragraphs.at(-1)?.id).toBe(chapter.lastParagraphId);
        }
    });

    it("超长单章独立保留，不与前后短章拼接或截断", () => {
        const text = `第一章\n短章\n第二章\n${"长".repeat(90)}\n第三章\n末章`;
        const result = splitInspirationSource(text, 40);
        expect(result.chunks.map((chunk) => chunk.chapterIndexes)).toEqual([[1], [2], [3]]);
        expect(result.chunks[1]?.characterCount).toBe(93);
        expect(result.warnings).toContain("有章节超过目标字数，已完整保留为独立块。");
        expect(result.paragraphs.map((paragraph) => paragraph.text).join("")).toBe(text);
    });

    it("保留前导序言、空白、BOM、CRLF、emoji 和最后无换行的正文", () => {
        const text = "\uFEFF\r\n  序言正文 🌟\r\n\r\n## 第一章 雨夜\r\n  门外。\r\n\r\n第二章 晨光\r\n尾段😀";
        const result = splitInspirationSource(text, 15);
        expect(result.chapters.map((chapter) => chapter.title)).toEqual(["章前文字", "第一章 雨夜", "第二章 晨光"]);
        expect(result.paragraphs.map((paragraph) => paragraph.id)).toEqual(["P1", "P2", "P3", "P4", "P5"]);
        expect(result.paragraphs.map((paragraph) => paragraph.text).join("")).toBe(text);
        expect(result.characterCount).toBe([...text].filter((character) => !/\s/u.test(character)).length);
        for (const paragraph of result.paragraphs) {
            expect(text.slice(paragraph.startOffset, paragraph.endOffset)).toBe(paragraph.text);
        }
    });

    it("无章节时按完整自然段切分，编号在块间连续且重新准备从 P1 开始", () => {
        const text = "\n甲甲甲甲\n\n  乙乙乙乙\n丙丙丙丙\n  \n丁丁丁丁\n";
        const result = splitInspirationSource(text, 8);
        expect(result.mode).toBe("paragraphs");
        expect(result.chapters).toEqual([]);
        expect(result.chunks.map((chunk) => [chunk.firstParagraphId, chunk.lastParagraphId])).toEqual([["P1", "P2"], ["P3", "P4"]]);
        expect(result.paragraphs.map((paragraph) => paragraph.text).join("")).toBe(text);
        expect(result.paragraphs.every((paragraph) => paragraph.chapterIndex === null)).toBe(true);
        expect(result.warnings[0]).toContain("未识别到章节标题");
        expect(splitInspirationSource("另一个文件").paragraphs[0]?.id).toBe("P1");
    });

    it("不把正文内提到的章节当作边界，超长段落完整独立保留", () => {
        const text = `他回想第一章发生的事情。\n${"文".repeat(40)}\n余文`;
        const result = splitInspirationSource(text, 20);
        expect(result.mode).toBe("paragraphs");
        expect(result.chunks).toHaveLength(3);
        expect(result.chunks[1]?.characterCount).toBe(40);
        expect(result.paragraphs.map((paragraph) => paragraph.text).join("")).toBe(text);
    });

    it("识别英文标题和无空格中文章名", () => {
        const result = splitInspirationSource("Chapter 1: Night\nBody\n第二章黎明\n正文\n终章\n结束");
        expect(result.chapters.map((chapter) => chapter.title)).toEqual(["Chapter 1: Night", "第二章黎明", "终章"]);
    });
});
