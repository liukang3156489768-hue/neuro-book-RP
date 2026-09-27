import {
    INSPIRATION_SOURCE_TARGET_CHARACTERS,
    type InspirationSourceChapterDto,
    type InspirationSourceChunkDto,
    type InspirationSourceParagraphDto,
} from "nbook/shared/dto/inspiration-source.dto";

type SourceUnit = {
    firstParagraph: number;
    lastParagraph: number;
    characterCount: number;
    chapterIndex: number | null;
};

export type InspirationSourceSplit = {
    mode: "chapters" | "paragraphs";
    characterCount: number;
    paragraphs: InspirationSourceParagraphDto[];
    chapters: InspirationSourceChapterDto[];
    chunks: InspirationSourceChunkDto[];
    warnings: string[];
};

const CHAPTER_HEADING_PATTERN = /^(?:第[〇零一二三四五六七八九十百千万两\d]+[章节回部卷](?:\s|[：:、.．\-—]|$).{0,100}|第[〇零一二三四五六七八九十百千万两\d]+[章节回部卷][^。！？!?]{0,60}|(?:chapter|book|part)\s+(?:\d+|[ivxlcdm]+)(?:\s|[.:\-—]|$).{0,100}|(?:序章|序言|楔子|引子|尾声|终章|后记|番外)(?:\s|[：:、.．\-—]|$).{0,100})$/iu;

/** Counts Unicode characters, excluding whitespace; offsets remain UTF-16 positions. */
function countCharacters(text: string): number {
    let count = 0;
    for (const character of text) {
        if (!/\s/u.test(character)) count += 1;
    }
    return count;
}

function chapterTitle(text: string): string | null {
    const line = text.trim().replace(/^#{1,6}\s+/u, "").replace(/\s+#+$/u, "");
    return CHAPTER_HEADING_PATTERN.test(line) ? line : null;
}

/**
 * Natural nonempty lines are numbered, including headings. Empty lines attach to the preceding
 * paragraph (leading whitespace attaches to P1), so IDs never require dropping source bytes.
 * A whole chapter is the indivisible unit whenever recognized headings are present.
 */
export function splitInspirationSource(
    text: string,
    targetCharacters = INSPIRATION_SOURCE_TARGET_CHARACTERS,
): InspirationSourceSplit {
    if (!Number.isSafeInteger(targetCharacters) || targetCharacters < 1) {
        throw new Error("切分目标必须是正整数");
    }
    const paragraphs: InspirationSourceParagraphDto[] = [];
    const paragraphCounts: number[] = [];
    const titles = new Map<number, string>();
    const nonemptyLines: Array<{start: number; text: string}> = [];
    const linePattern = /[^\r\n]*(?:\r\n|\n|\r|$)/gu;
    for (const match of text.matchAll(linePattern)) {
        if (match[0].trim()) nonemptyLines.push({start: match.index, text: match[0]});
    }
    for (let index = 0; index < nonemptyLines.length; index += 1) {
        const line = nonemptyLines[index]!;
        const startOffset = index === 0 ? 0 : line.start;
        const endOffset = nonemptyLines[index + 1]?.start ?? text.length;
        const paragraphText = text.slice(startOffset, endOffset);
        paragraphs.push({
            id: `P${index + 1}`,
            text: paragraphText,
            startOffset,
            endOffset,
            chapterIndex: null,
            chunkIndex: 1,
        });
        paragraphCounts.push(countCharacters(paragraphText));
        const title = chapterTitle(line.text);
        if (title !== null) titles.set(index, title);
    }

    const chapters: InspirationSourceChapterDto[] = [];
    const units: SourceUnit[] = [];
    if (titles.size > 0) {
        const chapterStarts = [...titles.keys()];
        if (chapterStarts[0] !== 0) chapterStarts.unshift(0);
        for (let index = 0; index < chapterStarts.length; index += 1) {
            const firstParagraph = chapterStarts[index]!;
            const lastParagraph = (chapterStarts[index + 1] ?? paragraphs.length) - 1;
            const chapterIndex = index + 1;
            let characterCount = 0;
            for (let paragraph = firstParagraph; paragraph <= lastParagraph; paragraph += 1) {
                characterCount += paragraphCounts[paragraph]!;
                paragraphs[paragraph]!.chapterIndex = chapterIndex;
            }
            const first = paragraphs[firstParagraph]!;
            const last = paragraphs[lastParagraph]!;
            chapters.push({
                index: chapterIndex,
                title: titles.get(firstParagraph) ?? "章前文字",
                startOffset: first.startOffset,
                endOffset: last.endOffset,
                firstParagraphId: first.id,
                lastParagraphId: last.id,
                characterCount,
            });
            units.push({firstParagraph, lastParagraph, characterCount, chapterIndex});
        }
    } else {
        for (let index = 0; index < paragraphs.length; index += 1) {
            units.push({firstParagraph: index, lastParagraph: index, characterCount: paragraphCounts[index]!, chapterIndex: null});
        }
    }

    const chunks: InspirationSourceChunkDto[] = [];
    let pending: SourceUnit[] = [];
    let pendingCharacters = 0;
    const flush = () => {
        if (pending.length === 0) return;
        const first = paragraphs[pending[0]!.firstParagraph]!;
        const last = paragraphs[pending[pending.length - 1]!.lastParagraph]!;
        const chunkIndex = chunks.length + 1;
        for (const unit of pending) {
            for (let index = unit.firstParagraph; index <= unit.lastParagraph; index += 1) {
                paragraphs[index]!.chunkIndex = chunkIndex;
            }
        }
        chunks.push({
            index: chunkIndex,
            startOffset: first.startOffset,
            endOffset: last.endOffset,
            firstParagraphId: first.id,
            lastParagraphId: last.id,
            characterCount: pendingCharacters,
            chapterIndexes: pending.flatMap((unit) => unit.chapterIndex === null ? [] : [unit.chapterIndex]),
        });
        pending = [];
        pendingCharacters = 0;
    };
    for (const unit of units) {
        // Oversized chapters/paragraphs stand alone; smaller units choose the nearer whole boundary.
        if (unit.characterCount > targetCharacters) {
            flush();
            pending.push(unit);
            pendingCharacters = unit.characterCount;
            flush();
            continue;
        }
        if (pending.length > 0
            && Math.abs(targetCharacters - pendingCharacters) <= Math.abs(targetCharacters - pendingCharacters - unit.characterCount)) {
            flush();
        }
        pending.push(unit);
        pendingCharacters += unit.characterCount;
        if (pendingCharacters >= targetCharacters) flush();
    }
    flush();

    const warnings: string[] = [];
    if (titles.size === 0 && paragraphs.length > 0) warnings.push("未识别到章节标题，已按完整自然段切分；每个非空自然行编号为一个段落。");
    if (units.some((unit) => unit.characterCount > targetCharacters)) {
        warnings.push(titles.size > 0
            ? "有章节超过目标字数，已完整保留为独立块。"
            : "有段落超过目标字数，已完整保留为独立块。");
    }
    return {
        mode: titles.size > 0 ? "chapters" : "paragraphs",
        characterCount: paragraphCounts.reduce((sum, count) => sum + count, 0),
        paragraphs,
        chapters,
        chunks,
        warnings,
    };
}
