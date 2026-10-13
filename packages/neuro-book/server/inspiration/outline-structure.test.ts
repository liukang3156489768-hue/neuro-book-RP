import {describe, expect, it} from "vitest";
import {
    ChapterCorrectionSchema,
    ExtractionStructureSchema,
    VolumeDivisionSchema,
    type ChapterCorrectionDto,
} from "nbook/shared/dto/inspiration-outline-structure.dto";
import {
    OutlineStructureError,
    applyChapterCorrections,
    buildExtractionStructure,
    divideVolumes,
    planChunkChapters,
    recognizeChapters,
    suggestVolumeRanges,
} from "nbook/server/inspiration/outline-structure";
import {splitInspirationSource} from "nbook/server/inspiration/source-split";

const HASH = "a".repeat(64);

function paragraphsOf(text: string) {
    return splitInspirationSource(text).paragraphs;
}

function failure(run: () => unknown): OutlineStructureError {
    try {
        run();
    } catch (error) {
        if (error instanceof OutlineStructureError) return error;
        throw error;
    }
    throw new Error("expected OutlineStructureError");
}

const CHINESE_NUMBERS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

/** 10 chapters; volume lines sit before chapters 1 and 6. */
function twoVolumeSource(): string {
    const lines: string[] = [];
    for (let chapter = 1; chapter <= 10; chapter += 1) {
        if (chapter === 1) lines.push("第一卷 风起");
        if (chapter === 6) lines.push("第二卷 云涌");
        lines.push(`第${CHINESE_NUMBERS[chapter - 1]}章 标题${chapter}`, `正文${chapter}`);
    }
    return lines.join("\n");
}

describe("章节识别", () => {
    it("10 章加 2 个卷标题得到 10 章，卷标题不计章节并给出默认划卷建议", () => {
        const paragraphs = paragraphsOf(twoVolumeSource());
        const recognition = recognizeChapters(paragraphs);
        expect(recognition.chapters).toHaveLength(10);
        expect(recognition.chapters.map((chapter) => chapter.title)).toEqual(
            Array.from({length: 10}, (_, index) => `第${CHINESE_NUMBERS[index]}章 标题${index + 1}`),
        );
        expect(recognition.volumeHeadings).toEqual([
            {paragraphId: "P1", title: "第一卷 风起"},
            {paragraphId: "P12", title: "第二卷 云涌"},
        ]);
        // The volume line directly above a chapter heading belongs to that chapter's range, so ranges tile the text.
        expect(recognition.chapters[0]).toMatchObject({headingParagraphId: "P2", firstParagraphId: "P1", lastParagraphId: "P3"});
        expect(recognition.chapters[5]).toMatchObject({headingParagraphId: "P13", firstParagraphId: "P12"});
        expect(recognition.chapters[4]!.lastParagraphId).toBe("P11");
        const nextFirst = recognition.chapters.map((chapter) => Number(chapter.firstParagraphId.slice(1)));
        const lastOf = recognition.chapters.map((chapter) => Number(chapter.lastParagraphId.slice(1)));
        expect(lastOf.slice(0, -1)).toEqual(nextFirst.slice(1).map((first) => first - 1));
        expect(lastOf.at(-1)).toBe(paragraphs.length);
        expect(recognition.chapters.reduce((sum, chapter) => sum + chapter.characterCount, 0))
            .toBe(splitInspirationSource(twoVolumeSource()).characterCount);
        expect(suggestVolumeRanges(recognition)).toEqual([
            {title: "第一卷 风起", firstChapterIndex: 1, lastChapterIndex: 5},
            {title: "第二卷 云涌", firstChapterIndex: 6, lastChapterIndex: 10},
        ]);
    });

    it("无卷标题时建议整部作品一卷，章前有正文时补“章前文字”章", () => {
        const recognition = recognizeChapters(paragraphsOf("前言一段\n第一章 起\n甲\n第二章 承\n乙"));
        expect(recognition.chapters.map((chapter) => chapter.title)).toEqual(["章前文字", "第一章 起", "第二章 承"]);
        expect(recognition.chapters[0]).toMatchObject({headingParagraphId: null, firstParagraphId: "P1", lastParagraphId: "P1"});
        expect(suggestVolumeRanges(recognition)).toEqual([{title: null, firstChapterIndex: 1, lastChapterIndex: 3}]);
    });

    it("首卷之前的章节组成无标题的前置卷，仅有卷标题而无章节时不识别章节", () => {
        const leading = recognizeChapters(paragraphsOf("第一章 甲\n正文\n第二卷 后\n第二章 乙\n正文"));
        expect(suggestVolumeRanges(leading)).toEqual([
            {title: null, firstChapterIndex: 1, lastChapterIndex: 1},
            {title: "第二卷 后", firstChapterIndex: 2, lastChapterIndex: 2},
        ]);
        const volumesOnly = recognizeChapters(paragraphsOf("第一卷\n正文\n第二卷\n正文"));
        expect(volumesOnly.chapters).toEqual([]);
        expect(volumesOnly.volumeHeadings).toHaveLength(2);
        expect(suggestVolumeRanges(volumesOnly)).toEqual([]);
    });

    it("单独数字行 1…10 连续递增时识别为 10 章", () => {
        const lines = ["简介"];
        for (let number = 1; number <= 10; number += 1) lines.push(String(number), `正文${number}`);
        const recognition = recognizeChapters(paragraphsOf(lines.join("\n")));
        expect(recognition.chapters.map((chapter) => chapter.title)).toEqual(["章前文字", ...Array.from({length: 10}, (_, index) => String(index + 1))]);
        expect(recognition.chapters[1]).toMatchObject({headingParagraphId: "P2", firstParagraphId: "P2", lastParagraphId: "P3"});
    });

    it("孤立数字行不是标题；非步长 1 的数字序列也不是标题", () => {
        expect(recognizeChapters(paragraphsOf("他数到\n7\n然后离开\n正文")).chapters).toEqual([]);
        expect(recognizeChapters(paragraphsOf("1\n甲\n3\n乙\n5\n丙")).chapters).toEqual([]);
        expect(recognizeChapters(paragraphsOf("1\n甲\n2\n乙\n10\n丙\n12\n丁")).chapters.map((chapter) => chapter.title)).toEqual(["1", "2"]);
    });

    it("数字行以相邻数字行为上下文：夹杂孤立数字时只取连续段，全角数字和 Markdown 标记同样识别", () => {
        const recognition = recognizeChapters(paragraphsOf("９\n甲\n# １\n乙\n２\n丙\n３\n丁"));
        expect(recognition.chapters.map((chapter) => chapter.title)).toEqual(["章前文字", "１", "２", "３"]);
        expect(recognition.chapters[0]).toMatchObject({lastParagraphId: "P2"});
    });

    it("数字行不会覆盖已由其他规则识别的标题", () => {
        const recognition = recognizeChapters(paragraphsOf("第一章 甲\n1\n2\n第二章 乙\n3"));
        expect(recognition.chapters.map((chapter) => chapter.headingParagraphId)).toEqual(["P1", "P2", "P3", "P4", "P5"]);
        const mixed = recognizeChapters(paragraphsOf("第一章 甲\n正文\n第二章 乙\n正文"));
        expect(mixed.chapters).toHaveLength(2);
    });
});

describe("章节修正", () => {
    const source = "第一章 甲\n甲一\n甲二\n第二章 乙\n乙一\n第三章 丙\n丙一\n丙二";

    it("set-heading 把某行设为章节标题，缺省取该行文本，也可指定标题或改名", () => {
        const paragraphs = paragraphsOf(source);
        const base = recognizeChapters(paragraphs);
        const result = applyChapterCorrections(paragraphs, base, [{kind: "set-heading", paragraphId: "P3"}]);
        expect(result.chapters.map((chapter) => [chapter.title, chapter.firstParagraphId, chapter.lastParagraphId])).toEqual([
            ["第一章 甲", "P1", "P2"], ["甲二", "P3", "P3"], ["第二章 乙", "P4", "P5"], ["第三章 丙", "P6", "P8"],
        ]);
        const renamed = applyChapterCorrections(paragraphs, base, [
            {kind: "set-heading", paragraphId: "P3", title: "插入章"},
            {kind: "set-heading", paragraphId: "P4", title: "改名"},
        ]);
        expect(renamed.chapters.map((chapter) => chapter.title)).toEqual(["第一章 甲", "插入章", "改名", "第三章 丙"]);
        expect(base.chapters).toHaveLength(3);
    });

    it("unset-heading 取消章节标题，正文并入前一章；取消首章标题后成为章前文字", () => {
        const paragraphs = paragraphsOf(source);
        const base = recognizeChapters(paragraphs);
        const second = applyChapterCorrections(paragraphs, base, [{kind: "unset-heading", paragraphId: "P4"}]);
        expect(second.chapters.map((chapter) => [chapter.title, chapter.lastParagraphId])).toEqual([["第一章 甲", "P5"], ["第三章 丙", "P8"]]);
        const first = applyChapterCorrections(paragraphs, base, [{kind: "unset-heading", paragraphId: "P1"}]);
        expect(first.chapters.map((chapter) => [chapter.title, chapter.firstParagraphId, chapter.lastParagraphId])).toEqual([
            ["章前文字", "P1", "P3"], ["第二章 乙", "P4", "P5"], ["第三章 丙", "P6", "P8"],
        ]);
        const none = applyChapterCorrections(paragraphs, base, ["P1", "P4", "P6"].map((paragraphId): ChapterCorrectionDto => ({kind: "unset-heading", paragraphId})));
        expect(none.chapters).toEqual([]);
    });

    it("merge 合并章节与其后一章，保留前一章标题", () => {
        const paragraphs = paragraphsOf(source);
        const result = applyChapterCorrections(paragraphs, recognizeChapters(paragraphs), [{kind: "merge", chapterIndex: 1}]);
        expect(result.chapters.map((chapter) => [chapter.index, chapter.title, chapter.firstParagraphId, chapter.lastParagraphId])).toEqual([
            [1, "第一章 甲", "P1", "P5"], [2, "第三章 丙", "P6", "P8"],
        ]);
        expect(result.chapters[0]!.characterCount).toBe(recognizeChapters(paragraphs).chapters.slice(0, 2).reduce((sum, chapter) => sum + chapter.characterCount, 0));
    });

    it("split 在某个 P 处拆开，该 P 成为新章节标题；按顺序重放后序号以前序修正后的列表为准", () => {
        const paragraphs = paragraphsOf(source);
        const result = applyChapterCorrections(paragraphs, recognizeChapters(paragraphs), [
            {kind: "split", paragraphId: "P8", title: "丙下"},
            {kind: "merge", chapterIndex: 3},
        ]);
        expect(result.chapters.map((chapter) => [chapter.title, chapter.firstParagraphId, chapter.lastParagraphId])).toEqual([
            ["第一章 甲", "P1", "P3"], ["第二章 乙", "P4", "P5"], ["第三章 丙", "P6", "P8"],
        ]);
    });

    it("在没有章节的来源上 set-heading 创建章节，并补章前文字", () => {
        const paragraphs = paragraphsOf("甲\n乙\n丙");
        const result = applyChapterCorrections(paragraphs, recognizeChapters(paragraphs), [{kind: "set-heading", paragraphId: "P2"}]);
        expect(result.chapters.map((chapter) => [chapter.title, chapter.firstParagraphId, chapter.lastParagraphId])).toEqual([
            ["章前文字", "P1", "P1"], ["乙", "P2", "P3"],
        ]);
        const fromTop = applyChapterCorrections(paragraphs, recognizeChapters(paragraphs), [{kind: "set-heading", paragraphId: "P1", title: "开篇"}]);
        expect(fromTop.chapters).toHaveLength(1);
        expect(fromTop.chapters[0]).toMatchObject({title: "开篇", firstParagraphId: "P1", lastParagraphId: "P3"});
    });

    it("修正只作用于识别结果：来源段落不变，卷标题行不能设为章节标题", () => {
        const text = twoVolumeSource();
        const paragraphs = paragraphsOf(text);
        const before = JSON.stringify(paragraphs);
        const base = recognizeChapters(paragraphs);
        applyChapterCorrections(paragraphs, base, [{kind: "set-heading", paragraphId: "P3"}]);
        expect(JSON.stringify(paragraphs)).toBe(before);
        expect(paragraphs.map((paragraph) => paragraph.text).join("")).toBe(text);
        expect(failure(() => applyChapterCorrections(paragraphs, base, [{kind: "set-heading", paragraphId: "P1"}])).code).toBe("CORRECTION_VOLUME_LINE");
    });

    it("对不存在的 P、越界章号和会产生空章节的修正给出明确错误", () => {
        const paragraphs = paragraphsOf(source);
        const base = recognizeChapters(paragraphs);
        const code = (correction: ChapterCorrectionDto) => failure(() => applyChapterCorrections(paragraphs, base, [correction])).code;
        expect(code({kind: "set-heading", paragraphId: "P99"})).toBe("PARAGRAPH_NOT_FOUND");
        expect(code({kind: "unset-heading", paragraphId: "P99"})).toBe("PARAGRAPH_NOT_FOUND");
        expect(code({kind: "unset-heading", paragraphId: "P2"})).toBe("CORRECTION_NOT_HEADING");
        expect(code({kind: "merge", chapterIndex: 4})).toBe("CHAPTER_NOT_FOUND");
        expect(code({kind: "merge", chapterIndex: 3})).toBe("CORRECTION_NO_NEXT_CHAPTER");
        expect(code({kind: "split", paragraphId: "P99"})).toBe("PARAGRAPH_NOT_FOUND");
        expect(code({kind: "split", paragraphId: "P4"})).toBe("CORRECTION_ALREADY_HEADING");
        expect(failure(() => applyChapterCorrections(paragraphsOf("前文\n第一章\n正文"), recognizeChapters(paragraphsOf("前文\n第一章\n正文")), [{kind: "split", paragraphId: "P1"}])).code)
            .toBe("CORRECTION_EMPTY_CHAPTER");
        const plain = paragraphsOf("甲\n乙");
        expect(failure(() => applyChapterCorrections(plain, recognizeChapters(plain), [{kind: "split", paragraphId: "P2"}])).code).toBe("CORRECTION_NO_CHAPTER");
        const blank = paragraphsOf("甲\n---\n乙");
        expect(failure(() => applyChapterCorrections(blank, recognizeChapters(blank), [{kind: "set-heading", paragraphId: "P2", title: "  "}])).code)
            .toBe("CHAPTER_TITLE_EMPTY");
    });

    it("修正不改变已有章节的字数守恒：章节字数之和等于来源字数", () => {
        const paragraphs = paragraphsOf(source);
        const result = applyChapterCorrections(paragraphs, recognizeChapters(paragraphs), [
            {kind: "split", paragraphId: "P7"}, {kind: "unset-heading", paragraphId: "P1"}, {kind: "merge", chapterIndex: 2},
        ]);
        expect(result.chapters.reduce((sum, chapter) => sum + chapter.characterCount, 0)).toBe(splitInspirationSource(source).characterCount);
    });
});

describe("划卷", () => {
    it("章节模式：连续不重叠不遗漏的卷通过，可整部作品一卷，标题去除空白", () => {
        expect(divideVolumes("chapters", 10, {mode: "chapters", volumes: [{title: null, firstChapterIndex: 1, lastChapterIndex: 10}]}))
            .toEqual([{index: 1, title: null, firstChapterIndex: 1, lastChapterIndex: 10}]);
        expect(divideVolumes("chapters", 10, {mode: "chapters", volumes: [
            {title: " 上 ", firstChapterIndex: 1, lastChapterIndex: 4}, {title: null, firstChapterIndex: 5, lastChapterIndex: 10},
        ]})).toEqual([
            {index: 1, title: "上", firstChapterIndex: 1, lastChapterIndex: 4},
            {index: 2, title: null, firstChapterIndex: 5, lastChapterIndex: 10},
        ]);
    });

    it("章节模式：重叠、遗漏、越界、反向和空划卷被拒绝", () => {
        const divide = (volumes: Array<[number, number]>, count = 10) => failure(() => divideVolumes("chapters", count, {
            mode: "chapters",
            volumes: volumes.map(([first, last]) => ({title: null, firstChapterIndex: first, lastChapterIndex: last})),
        })).code;
        expect(divide([[1, 5], [5, 10]])).toBe("VOLUME_OVERLAP");
        expect(divide([[1, 4], [6, 10]])).toBe("VOLUME_GAP");
        expect(divide([[2, 10]])).toBe("VOLUME_GAP");
        expect(divide([[1, 8]])).toBe("VOLUME_GAP");
        expect(divide([[1, 5], [6, 11]])).toBe("VOLUME_OUT_OF_RANGE");
        expect(divide([[0, 5], [6, 10]])).toBe("VOLUME_OUT_OF_RANGE");
        expect(divide([[1.5, 10]])).toBe("VOLUME_OUT_OF_RANGE");
        expect(divide([[6, 5]])).toBe("VOLUME_EMPTY");
        expect(divide([])).toBe("VOLUME_NO_VOLUMES");
        expect(divide([[1, 1]], 0)).toBe("VOLUME_NO_CHAPTERS");
    });

    it("字数模式：每 N 个块一卷，最后一卷可较短；N 必须是正整数", () => {
        const volumes = divideVolumes("chunks", 7, {mode: "chunks", chunksPerVolume: 3});
        expect(volumes).toEqual([
            {index: 1, title: null, firstChapterIndex: 1, lastChapterIndex: 3},
            {index: 2, title: null, firstChapterIndex: 4, lastChapterIndex: 6},
            {index: 3, title: null, firstChapterIndex: 7, lastChapterIndex: 7},
        ]);
        for (const invalid of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(failure(() => divideVolumes("chunks", 7, {mode: "chunks", chunksPerVolume: invalid})).code).toBe("VOLUME_CHUNKS_PER_VOLUME_INVALID");
        }
        expect(failure(() => divideVolumes("chunks", 0, {mode: "chunks", chunksPerVolume: 3})).code).toBe("VOLUME_NO_CHAPTERS");
    });

    it("划卷方式与来源模式不一致时被拒绝", () => {
        expect(failure(() => divideVolumes("chapters", 3, {mode: "chunks", chunksPerVolume: 3})).code).toBe("VOLUME_MODE_MISMATCH");
        expect(failure(() => divideVolumes("chunks", 3, {mode: "chapters", volumes: []})).code).toBe("VOLUME_MODE_MISMATCH");
    });
});

describe("提取结构", () => {
    it("章节模式：使用默认卷建议产出稳定结构，并满足 DTO schema", () => {
        const paragraphs = paragraphsOf(twoVolumeSource());
        const recognition = recognizeChapters(paragraphs);
        const division = {mode: "chapters" as const, volumes: suggestVolumeRanges(recognition)};
        const structure = buildExtractionStructure({sourceSha256: HASH, paragraphs, recognition, division});
        expect(structure.mode).toBe("chapters");
        expect(structure.chapters).toHaveLength(10);
        expect(structure.chapters[0]).toEqual({index: 1, title: "第一章 标题1", firstParagraphId: "P1", lastParagraphId: "P3", characterCount: expect.any(Number)});
        expect(structure.volumes).toEqual([
            {index: 1, title: "第一卷 风起", firstChapterIndex: 1, lastChapterIndex: 5},
            {index: 2, title: "第二卷 云涌", firstChapterIndex: 6, lastChapterIndex: 10},
        ]);
        expect(ExtractionStructureSchema.parse(structure)).toEqual(structure);
        expect(buildExtractionStructure({sourceSha256: HASH, paragraphs, recognition, division})).toEqual(structure);
    });

    it("字数模式：无章节时每块一章、每 3 块一卷", () => {
        const paragraphs = paragraphsOf(Array.from({length: 7}, (_, index) => "文".repeat(10) + (index % 2 ? "。" : "")).join("\n"));
        const recognition = recognizeChapters(paragraphs);
        expect(recognition.chapters).toEqual([]);
        const chapters = planChunkChapters(paragraphs, 10);
        expect(chapters.map((chapter) => [chapter.title, chapter.firstParagraphId, chapter.lastParagraphId, chapter.characterCount]))
            .toEqual(Array.from({length: 7}, (_, index) => [`第${index + 1}块`, `P${index + 1}`, `P${index + 1}`, index % 2 ? 11 : 10]));
        const structure = buildExtractionStructure({sourceSha256: HASH, paragraphs, recognition, division: {mode: "chunks", chunksPerVolume: 3}, targetCharacters: 10});
        expect(structure.mode).toBe("chunks");
        expect(structure.chapters).toHaveLength(7);
        expect(structure.volumes.map((volume) => [volume.firstChapterIndex, volume.lastChapterIndex])).toEqual([[1, 3], [4, 6], [7, 7]]);
        expect(ExtractionStructureSchema.parse(structure)).toEqual(structure);
    });

    it("字数模式的块与 splitInspirationSource 在无章节来源上的分块一致", () => {
        const text = Array.from({length: 40}, (_, index) => `${"句".repeat(7 + (index % 5))}`).join("\n");
        const split = splitInspirationSource(text, 50);
        expect(split.mode).toBe("paragraphs");
        expect(planChunkChapters(split.paragraphs, 50).map((chapter) => [chapter.firstParagraphId, chapter.lastParagraphId, chapter.characterCount]))
            .toEqual(split.chunks.map((chunk) => [chunk.firstParagraphId, chunk.lastParagraphId, chunk.characterCount]));
    });

    it("仅有卷标题而无章节的来源进入字数模式；非法划卷、坏哈希和坏目标字数被拒绝", () => {
        const paragraphs = paragraphsOf("第一卷\n甲甲\n第二卷\n乙乙");
        const recognition = recognizeChapters(paragraphs);
        const structure = buildExtractionStructure({sourceSha256: HASH, paragraphs, recognition, division: {mode: "chunks", chunksPerVolume: 2}});
        expect(structure.mode).toBe("chunks");
        expect(structure.chapters).toHaveLength(1);
        expect(failure(() => buildExtractionStructure({sourceSha256: HASH, paragraphs, recognition, division: {mode: "chapters", volumes: []}})).code).toBe("VOLUME_MODE_MISMATCH");
        expect(failure(() => buildExtractionStructure({sourceSha256: "XYZ", paragraphs, recognition, division: {mode: "chunks", chunksPerVolume: 2}})).code).toBe("SOURCE_HASH_INVALID");
        expect(failure(() => planChunkChapters(paragraphs, 0)).code).toBe("TARGET_CHARACTERS_INVALID");
        const chapterParagraphs = paragraphsOf(twoVolumeSource());
        expect(failure(() => buildExtractionStructure({
            sourceSha256: HASH,
            paragraphs: chapterParagraphs,
            recognition: recognizeChapters(chapterParagraphs),
            division: {mode: "chapters", volumes: [{title: null, firstChapterIndex: 1, lastChapterIndex: 9}]},
        })).code).toBe("VOLUME_GAP");
    });

    it("来源没有任何正文时划卷报章节为空", () => {
        const recognition = recognizeChapters([]);
        expect(failure(() => buildExtractionStructure({sourceSha256: HASH, paragraphs: [], recognition, division: {mode: "chunks", chunksPerVolume: 1}})).code)
            .toBe("VOLUME_NO_CHAPTERS");
    });
});

describe("修正与划卷的 DTO schema", () => {
    it("接受合法的修正与划卷，拒绝未知字段、非法 P 编号和非正整数", () => {
        expect(ChapterCorrectionSchema.parse({kind: "split", paragraphId: "P3", title: "新章"})).toEqual({kind: "split", paragraphId: "P3", title: "新章"});
        expect(ChapterCorrectionSchema.safeParse({kind: "merge", chapterIndex: 0}).success).toBe(false);
        expect(ChapterCorrectionSchema.safeParse({kind: "set-heading", paragraphId: "p3"}).success).toBe(false);
        expect(ChapterCorrectionSchema.safeParse({kind: "unset-heading", paragraphId: "P3", extra: 1}).success).toBe(false);
        expect(VolumeDivisionSchema.safeParse({mode: "chunks", chunksPerVolume: 2.5}).success).toBe(false);
        expect(VolumeDivisionSchema.safeParse({mode: "chapters", volumes: [{title: null, firstChapterIndex: 1, lastChapterIndex: 2}]}).success).toBe(true);
    });
});
