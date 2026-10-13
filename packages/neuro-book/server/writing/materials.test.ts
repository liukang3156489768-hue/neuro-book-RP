import {describe, expect, it} from "vitest";
import type {WritingChapterDto} from "nbook/shared/dto/writing.dto";
import {
    countWords, extractChapterEnding, findPreviousProse, parseWritingStyle, resolveExcerpt,
    meetsWordLowerBound,
} from "./materials";

describe("字数口径", () => {
    it("计非空白字符与标点，不计 Markdown 标记和注释", () => {
        expect(countWords("# 标题\n\n他说：“走。”")).toBe(9);
        expect(countWords("**加粗**与`代码`<!-- 注释 -->")).toBe(5);
        expect(countWords("> 引用\n- 列表\n1. 编号\n\n---")).toBe(6);
        expect(countWords("[链接](https://a.b)![图](x.png)")).toBe(3);
        expect(countWords("好~ 下_划 \\*星")).toBe(7);
    });

    it("字数只设下限：不少于目标 70%，不设上限", () => {
        expect(meetsWordLowerBound(700, 1000)).toBe(true);
        expect(meetsWordLowerBound(5000, 1000)).toBe(true);
        expect(meetsWordLowerBound(699, 1000)).toBe(false);
    });
});

describe("文风文件", () => {
    it("按二级标题取三个小节，三级标题属于小节正文", () => {
        const result = parseWritingStyle("---\ntitle: 文风\n---\n## 文风要求\n\n冷峻。\n\n### 细则\n\n短句。\n\n## 样文\n\n雪落。");
        expect(result).toEqual({ok: true, style: {requirements: "冷峻。\n\n### 细则\n\n短句。", forbidden: "", sample: "雪落。"}});
    });

    it("缺少或空的文风要求、重复小节报错", () => {
        expect(parseWritingStyle("## 样文\n\n雪落。")).toMatchObject({ok: false, message: expect.stringContaining("缺少")});
        expect(parseWritingStyle("## 文风要求\n\n## 样文\n\n雪")).toMatchObject({ok: false, message: expect.stringContaining("为空")});
        expect(parseWritingStyle("## 文风要求\n\n甲\n\n## 文风要求\n\n乙")).toMatchObject({ok: false, message: expect.stringContaining("多个")});
    });
});

describe("上一章结尾", () => {
    it("从末尾取完整段落，不超过上限", () => {
        const markdown = "---\nnbook: {}\n---\n甲甲甲甲\n\n乙乙乙\n\n丙丙";
        expect(extractChapterEnding(markdown, 6)).toBe("乙乙乙\n\n丙丙");
        expect(extractChapterEnding(markdown, 100)).toBe("甲甲甲甲\n\n乙乙乙\n\n丙丙");
    });

    it("最后一段超长时从句末截断，没有句末则按字数硬截", () => {
        expect(extractChapterEnding("前段\n\n第一句很长很长。第二句。第三句。", 8)).toBe("第二句。第三句。");
        expect(extractChapterEnding("没有句末的一段长文字", 4)).toBe("段长文字");
    });

    it("正文为空时返回空字符串", () => {
        expect(extractChapterEnding("---\na: 1\n---\n\n")).toBe("");
    });
});

function chapter(entryId: string, prose: {path: string; empty?: boolean}[], volume = "卷一"): WritingChapterDto {
    return {entryId, title: entryId, version: 1, contentHash: "h", volume: {entryId: `vol-${volume}`, title: volume}, details: [],
        status: prose.length === 0 ? "unwritten" : "written", writable: true,
        prose: prose.map(({path, empty = false}) => ({path, title: path, empty, hasSource: true}))};
}

describe("上一章正文", () => {
    it("跨卷找最近一个有唯一非空正文的章节，跳过空正文与归属冲突", () => {
        const chapters = [
            chapter("ol-a", [{path: "manuscript/a/index.md"}]),
            chapter("ol-b", [{path: "manuscript/b/index.md"}, {path: "manuscript/b2/index.md"}]),
            chapter("ol-c", [{path: "manuscript/c/index.md", empty: true}], "卷二"),
            chapter("ol-d", [], "卷二"),
            chapter("ol-e", [], "卷二"),
        ];
        expect(findPreviousProse(chapters, "ol-e")).toEqual({entryId: "ol-a", title: "ol-a", path: "manuscript/a/index.md"});
    });

    it("前面没有正文或是第一章时为 null", () => {
        expect(findPreviousProse([chapter("ol-a", []), chapter("ol-b", [])], "ol-b")).toBeNull();
        expect(findPreviousProse([chapter("ol-a", [{path: "x/index.md"}])], "ol-a")).toBeNull();
    });
});

describe("摘录", () => {
    const file = "---\ntitle: 资料\n---\n# 城防\n\n城墙高十丈。\n\n## 城门\n\n四门。\n\n# 城防史\n\n旧城。";

    it("按标题取到下一个同级标题为止，标题精确匹配", () => {
        expect(resolveExcerpt(file, {heading: "城防"})).toEqual({ok: true, text: "# 城防\n\n城墙高十丈。\n\n## 城门\n\n四门。", words: 13});
    });

    it("按段落位置取原文，从 1 计数", () => {
        expect(resolveExcerpt(file, {paragraphs: {from: 2, to: 4}})).toMatchObject({ok: true, text: "城墙高十丈。\n\n## 城门\n\n四门。"});
        expect(resolveExcerpt(file, {paragraphs: {from: 6}})).toMatchObject({ok: true, text: "旧城。"});
    });

    it("位置不存在、标题重复时拒绝", () => {
        expect(resolveExcerpt(file, {heading: "城"})).toMatchObject({ok: false, message: expect.stringContaining("找不到")});
        expect(resolveExcerpt(file, {paragraphs: {from: 7}})).toMatchObject({ok: false, message: expect.stringContaining("共 6 段")});
        expect(resolveExcerpt("# 甲\n\n一\n\n# 甲\n\n二", {heading: "甲"})).toMatchObject({ok: false, message: expect.stringContaining("多次")});
    });

    it("单段摘录超过 1000 字时拒绝", () => {
        expect(resolveExcerpt(`# 长\n\n${"字".repeat(1000)}`, {heading: "长"})).toMatchObject({ok: false, message: expect.stringContaining("1000")});
        expect(resolveExcerpt("字".repeat(1000), {paragraphs: {from: 1}})).toMatchObject({ok: true, words: 1000});
    });
});
