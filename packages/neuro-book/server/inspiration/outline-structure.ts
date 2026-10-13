import {
    INSPIRATION_SOURCE_TARGET_CHARACTERS,
    type InspirationSourceParagraphDto,
} from "nbook/shared/dto/inspiration-source.dto";
import type {
    ChapterCorrectionDto,
    ChapterRecognitionDto,
    ExtractionChapterDto,
    ExtractionStructureDto,
    ExtractionVolumeDto,
    OutlineStructureErrorCode,
    RecognizedChapterDto,
    VolumeDivisionDto,
    VolumeHeadingDto,
    VolumeRangeDto,
} from "nbook/shared/dto/inspiration-outline-structure.dto";
import {chapterTitle, countCharacters, groupSourceUnits, headingLineText, type SourceUnit} from "./source-split";

/**
 * Chapter recognition, user corrections and volume division for outline extraction. Everything here is
 * a pure function over the numbered paragraphs produced by `splitInspirationSource`; the source file is
 * never touched and nothing is persisted, so a correction list can be replayed on the same source hash.
 */

/** Domain failure with a stable code; callers (routes, tasks) map it to their own error contract. */
export class OutlineStructureError extends Error {
    constructor(readonly code: OutlineStructureErrorCode, message: string) {
        super(message);
        this.name = "OutlineStructureError";
    }
}

export type OutlineSourceParagraph = Pick<InspirationSourceParagraphDto, "id" | "text">;

/** Leading text before the first chapter heading is kept as a chapter so no source text is dropped. */
const FRONT_MATTER_TITLE = "章前文字";

/** "第X卷" is a volume heading, matched only after the shared heading pattern accepted the line. */
const VOLUME_HEADING_PATTERN = /^第[〇零一二三四五六七八九十百千万两\d]+卷/u;

/**
 * A line holding only an Arabic number (full-width digits included, at most six digits so years and
 * IDs in the text are not mistaken for chapter numbers).
 */
const NUMERIC_LINE_PATTERN = /^[0-9０-９]{1,6}$/u;

type ParagraphTable = {
    ids: string[];
    indexById: Map<string, number>;
    lines: string[];
    /** prefix[i] is the character count of paragraphs [0, i). */
    prefix: number[];
};

/** One chapter before ids are rendered. `start` precedes `heading` only by adjacent volume-heading lines. */
type ChapterState = {
    start: number;
    heading: number | null;
    title: string;
};

function buildTable(paragraphs: readonly OutlineSourceParagraph[]): ParagraphTable {
    const prefix = [0];
    const indexById = new Map<string, number>();
    paragraphs.forEach((paragraph, index) => {
        indexById.set(paragraph.id, index);
        prefix.push(prefix[index]! + countCharacters(paragraph.text));
    });
    return {ids: paragraphs.map((paragraph) => paragraph.id), indexById, lines: paragraphs.map((paragraph) => headingLineText(paragraph.text)), prefix};
}

function paragraphIndex(table: ParagraphTable, id: string): number {
    const index = table.indexById.get(id);
    if (index === undefined) throw new OutlineStructureError("PARAGRAPH_NOT_FOUND", `来源中没有段落 ${id}。`);
    return index;
}

/**
 * Numeric headings need context: a run of numeric lines is a heading sequence only when consecutive
 * numeric lines in document order increase by exactly 1 and the run has at least 2 members. An isolated
 * numeric line (a page number, a count in the prose) is never a heading.
 */
function numericHeadingIndexes(lines: readonly string[], taken: ReadonlySet<number>): number[] {
    const candidates: Array<{index: number; value: number}> = [];
    lines.forEach((line, index) => {
        if (!taken.has(index) && NUMERIC_LINE_PATTERN.test(line)) candidates.push({index, value: Number(line.normalize("NFKC"))});
    });
    const result: number[] = [];
    let runStart = 0;
    for (let cursor = 1; cursor <= candidates.length; cursor += 1) {
        if (cursor < candidates.length && candidates[cursor]!.value === candidates[cursor - 1]!.value + 1) continue;
        if (cursor - runStart >= 2) {
            for (let member = runStart; member < cursor; member += 1) result.push(candidates[member]!.index);
        }
        runStart = cursor;
    }
    return result;
}

/**
 * Keeps the list valid after every change: no headings means no chapters (not a lone front-matter chapter),
 * and text before the first chapter is chapter "章前文字".
 */
function normalizeStates(states: ChapterState[]): ChapterState[] {
    if (states.every((state) => state.heading === null)) return [];
    if (states[0]!.start > 0) return [{start: 0, heading: null, title: FRONT_MATTER_TITLE}, ...states];
    return states;
}

function renderRecognition(table: ParagraphTable, states: readonly ChapterState[], volumeHeadings: readonly VolumeHeadingDto[]): ChapterRecognitionDto {
    const chapters: RecognizedChapterDto[] = states.map((state, offset) => {
        const last = (states[offset + 1]?.start ?? table.ids.length) - 1;
        return {
            index: offset + 1,
            title: state.title,
            headingParagraphId: state.heading === null ? null : table.ids[state.heading]!,
            firstParagraphId: table.ids[state.start]!,
            lastParagraphId: table.ids[last]!,
            characterCount: table.prefix[last + 1]! - table.prefix[state.start]!,
        };
    });
    return {chapters, volumeHeadings: volumeHeadings.map((heading) => ({...heading}))};
}

/**
 * Recognizes chapters with the shared heading rules (第X章/回/节/部, Chapter N, 序章/楔子/尾声/番外 ...)
 * plus context-supported numeric lines. "第X卷" lines are reported as `volumeHeadings` instead of chapters.
 * Volume-heading lines directly above a chapter heading belong to that chapter's range, so each chapter
 * range starts at its first related line and the ranges tile the whole source.
 */
export function recognizeChapters(paragraphs: readonly OutlineSourceParagraph[]): ChapterRecognitionDto {
    const table = buildTable(paragraphs);
    const headingTitles = new Map<number, string>();
    const volumeTitles = new Map<number, string>();
    paragraphs.forEach((paragraph, index) => {
        const title = chapterTitle(paragraph.text);
        if (title === null) return;
        (VOLUME_HEADING_PATTERN.test(title) ? volumeTitles : headingTitles).set(index, title);
    });
    const taken = new Set([...headingTitles.keys(), ...volumeTitles.keys()]);
    for (const index of numericHeadingIndexes(table.lines, taken)) headingTitles.set(index, table.lines[index]!);

    const states: ChapterState[] = [];
    let previousHeading = -1;
    for (const heading of [...headingTitles.keys()].sort((left, right) => left - right)) {
        let start = heading;
        while (start - 1 > previousHeading && volumeTitles.has(start - 1)) start -= 1;
        states.push({start, heading, title: headingTitles.get(heading)!});
        previousHeading = heading;
    }
    const volumeHeadings = [...volumeTitles].sort(([left], [right]) => left - right)
        .map(([index, title]) => ({paragraphId: table.ids[index]!, title}));
    return renderRecognition(table, normalizeStates(states), volumeHeadings);
}

function statesFromRecognition(table: ParagraphTable, recognition: ChapterRecognitionDto): ChapterState[] {
    return recognition.chapters.map((chapter) => ({
        start: paragraphIndex(table, chapter.firstParagraphId),
        heading: chapter.headingParagraphId === null ? null : paragraphIndex(table, chapter.headingParagraphId),
        title: chapter.title,
    }));
}

/** Index of the chapter whose range contains `paragraph`, or -1 when no chapter starts at or before it. */
function containingChapter(states: readonly ChapterState[], paragraph: number): number {
    let found = -1;
    for (let index = 0; index < states.length && states[index]!.start <= paragraph; index += 1) found = index;
    return found;
}

/**
 * Applies user corrections, in order, to a recognition result. `chapterIndex` in a correction refers to
 * the list produced by the corrections before it. The input recognition is not mutated and the source is
 * never changed; any invalid correction fails the whole call with an `OutlineStructureError`.
 *
 * - set-heading: the paragraph becomes a chapter heading (title defaults to its text); on an existing
 *   heading it renames the chapter. Volume-heading lines cannot be chapter headings.
 * - unset-heading: removes that chapter; its text joins the previous chapter (or becomes "章前文字").
 * - merge: merges `chapterIndex` with the chapter after it; the earlier chapter keeps its title.
 * - split: starts a new chapter at the paragraph, which must lie inside a chapter after its first line.
 */
export function applyChapterCorrections(
    paragraphs: readonly OutlineSourceParagraph[],
    recognition: ChapterRecognitionDto,
    corrections: readonly ChapterCorrectionDto[],
): ChapterRecognitionDto {
    const table = buildTable(paragraphs);
    const volumeLines = new Set(recognition.volumeHeadings.map((heading) => paragraphIndex(table, heading.paragraphId)));
    let states = statesFromRecognition(table, recognition);

    const startAt = (kind: "set-heading" | "split", paragraphId: string, requestedTitle: string | undefined): ChapterState => {
        const paragraph = paragraphIndex(table, paragraphId);
        if (volumeLines.has(paragraph)) {
            throw new OutlineStructureError("CORRECTION_VOLUME_LINE", `${paragraphId} 是卷标题，不能${kind === "split" ? "在此拆分" : "设为章节标题"}。`);
        }
        const title = (requestedTitle ?? table.lines[paragraph]!).trim();
        if (!title) throw new OutlineStructureError("CHAPTER_TITLE_EMPTY", `${paragraphId} 没有可用作章节标题的文字，请提供标题。`);
        return {start: paragraph, heading: paragraph, title};
    };

    for (const correction of corrections) {
        if (correction.kind === "set-heading") {
            const next = startAt("set-heading", correction.paragraphId, correction.title);
            const owner = containingChapter(states, next.start);
            // Renames an existing heading; the front-matter chapter is the only one starting on a non-heading
            // line, and setting its first line as heading turns it into a titled chapter.
            if (owner >= 0 && (states[owner]!.heading === next.start || states[owner]!.start === next.start)) {
                states[owner] = next;
            } else {
                states.splice(owner + 1, 0, next);
            }
        } else if (correction.kind === "unset-heading") {
            const paragraph = paragraphIndex(table, correction.paragraphId);
            const target = states.findIndex((state) => state.heading === paragraph);
            if (target < 0) {
                throw new OutlineStructureError("CORRECTION_NOT_HEADING", `${correction.paragraphId} 不是章节标题，无法取消。`);
            }
            states.splice(target, 1);
        } else if (correction.kind === "merge") {
            if (!Number.isInteger(correction.chapterIndex) || correction.chapterIndex < 1 || correction.chapterIndex > states.length) {
                throw new OutlineStructureError("CHAPTER_NOT_FOUND", `没有第 ${correction.chapterIndex} 章，当前共 ${states.length} 章。`);
            }
            if (correction.chapterIndex === states.length) {
                throw new OutlineStructureError("CORRECTION_NO_NEXT_CHAPTER", `第 ${correction.chapterIndex} 章是最后一章，没有可合并的后一章。`);
            }
            states.splice(correction.chapterIndex, 1);
        } else {
            const next = startAt("split", correction.paragraphId, correction.title);
            const owner = containingChapter(states, next.start);
            if (owner < 0) {
                throw new OutlineStructureError("CORRECTION_NO_CHAPTER", `${correction.paragraphId} 不在任何章节内，无法拆分；请改用设为章节标题。`);
            }
            if (states.some((state) => state.heading === next.start)) {
                throw new OutlineStructureError("CORRECTION_ALREADY_HEADING", `${correction.paragraphId} 已是章节标题，无需拆分。`);
            }
            if (states[owner]!.start === next.start) {
                throw new OutlineStructureError("CORRECTION_EMPTY_CHAPTER", `${correction.paragraphId} 是所在章节的第一行，拆分会产生空章节。`);
            }
            states.splice(owner + 1, 0, next);
        }
        states = normalizeStates(states);
    }
    return renderRecognition(table, states, recognition.volumeHeadings);
}

function paragraphNumber(paragraphId: string): number {
    return Number(paragraphId.slice(1));
}

/**
 * Default volume division from "第X卷" lines: a volume begins at the first chapter whose heading is at or
 * after its volume line, and runs to the chapter before the next volume. Chapters ahead of the first volume
 * line form an untitled leading volume; without any usable volume line the whole work is one untitled volume.
 * A volume line with no chapter after it, or one replaced by a later volume line before any chapter, is dropped.
 */
export function suggestVolumeRanges(recognition: ChapterRecognitionDto): VolumeRangeDto[] {
    const chapters = recognition.chapters;
    if (chapters.length === 0) return [];
    const startTitles = new Map<number, string>();
    for (const volume of recognition.volumeHeadings) {
        const line = paragraphNumber(volume.paragraphId);
        const chapter = chapters.find((candidate) => paragraphNumber(candidate.headingParagraphId ?? candidate.firstParagraphId) >= line);
        if (chapter) startTitles.set(chapter.index, volume.title);
    }
    const starts = [...startTitles].sort(([left], [right]) => left - right);
    if (starts[0]?.[0] !== 1) starts.unshift([1, ""]);
    return starts.map(([first, title], offset) => ({
        title: title || null,
        firstChapterIndex: first,
        lastChapterIndex: (starts[offset + 1]?.[0] ?? chapters.length + 1) - 1,
    }));
}

/** Word-count mode: with no recognizable chapter, every split chunk is treated as one chapter. */
export function planChunkChapters(
    paragraphs: readonly OutlineSourceParagraph[],
    targetCharacters = INSPIRATION_SOURCE_TARGET_CHARACTERS,
    recognition?: ChapterRecognitionDto,
): ExtractionChapterDto[] {
    if (!Number.isSafeInteger(targetCharacters) || targetCharacters < 1) {
        throw new OutlineStructureError("TARGET_CHARACTERS_INVALID", "切分目标必须是正整数。");
    }
    const table = buildTable(paragraphs);
    const units: SourceUnit[] = recognition && recognition.chapters.length > 0
        ? recognition.chapters.map(chapter => ({
            firstParagraph: table.indexById.get(chapter.firstParagraphId)!,
            lastParagraph: table.indexById.get(chapter.lastParagraphId)!,
            characterCount: chapter.characterCount,
            chapterIndex: chapter.index,
        }))
        : table.ids.map((_, index) => ({
            firstParagraph: index,
            lastParagraph: index,
            characterCount: table.prefix[index + 1]! - table.prefix[index]!,
            chapterIndex: null,
        }));
    return groupSourceUnits(units, targetCharacters).map((group, offset) => ({
        index: offset + 1,
        title: `第${offset + 1}块`,
        firstParagraphId: table.ids[group.units[0]!.firstParagraph]!,
        lastParagraphId: table.ids[group.units[group.units.length - 1]!.lastParagraph]!,
        characterCount: group.characterCount,
    }));
}

function isPositiveInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 1;
}

/**
 * Validates a volume division and returns the volumes. `unitCount` is the number of chapters (chapters mode)
 * or chunks (chunks mode). Chapter ranges must be given in order and tile 1..unitCount without overlap
 * or gap; chunks mode needs a positive integer N and groups every N chunks (the last volume may be shorter).
 */
export function divideVolumes(
    mode: ExtractionStructureDto["mode"],
    unitCount: number,
    division: VolumeDivisionDto,
): ExtractionVolumeDto[] {
    if (division.mode !== mode) {
        throw new OutlineStructureError("VOLUME_MODE_MISMATCH", mode === "chapters"
            ? "来源已识别出章节，请按章节范围划卷。"
            : "来源没有可识别章节，请按每卷的切分块数划卷。");
    }
    if (unitCount < 1) throw new OutlineStructureError("VOLUME_NO_CHAPTERS", "没有可划分的章节，无法划卷。");
    if (division.mode === "chunks") {
        const perVolume = division.chunksPerVolume;
        if (!isPositiveInteger(perVolume)) {
            throw new OutlineStructureError("VOLUME_CHUNKS_PER_VOLUME_INVALID", "每卷的切分块数必须是正整数。");
        }
        const volumes: ExtractionVolumeDto[] = [];
        for (let first = 1; first <= unitCount; first += perVolume) {
            volumes.push({index: volumes.length + 1, title: null, firstChapterIndex: first, lastChapterIndex: Math.min(first + perVolume - 1, unitCount)});
        }
        return volumes;
    }
    if (division.volumes.length === 0) throw new OutlineStructureError("VOLUME_NO_VOLUMES", "至少需要一个卷。");
    const volumes: ExtractionVolumeDto[] = [];
    let expectedFirst = 1;
    for (const [offset, volume] of division.volumes.entries()) {
        const label = `第 ${offset + 1} 卷`;
        const {firstChapterIndex: first, lastChapterIndex: last} = volume;
        if (!isPositiveInteger(first) || !isPositiveInteger(last) || first > unitCount || last > unitCount) {
            throw new OutlineStructureError("VOLUME_OUT_OF_RANGE", `${label}的章节范围 ${first}–${last} 超出 1–${unitCount} 章。`);
        }
        if (first > last) throw new OutlineStructureError("VOLUME_EMPTY", `${label}的起始章 ${first} 晚于结束章 ${last}，卷不能为空。`);
        if (first < expectedFirst) {
            throw new OutlineStructureError("VOLUME_OVERLAP", `${label}从第 ${first} 章开始，与前一卷重叠。`);
        }
        if (first > expectedFirst) {
            throw new OutlineStructureError("VOLUME_GAP", `第 ${expectedFirst}–${first - 1} 章没有划入任何卷。`);
        }
        volumes.push({index: offset + 1, title: volume.title?.trim() || null, firstChapterIndex: first, lastChapterIndex: last});
        expectedFirst = last + 1;
    }
    if (expectedFirst <= unitCount) {
        throw new OutlineStructureError("VOLUME_GAP", `第 ${expectedFirst}–${unitCount} 章没有划入任何卷。`);
    }
    return volumes;
}

export type BuildExtractionStructureInput = {
    sourceSha256: string;
    paragraphs: readonly OutlineSourceParagraph[];
    /** Recognition after user corrections; zero chapters selects word-count (chunks) mode. */
    recognition: ChapterRecognitionDto;
    division: VolumeDivisionDto;
    /** Explicit mode lets the UI preview word-count chunks even when chapters were recognized. */
    mode?: ExtractionStructureDto["mode"];
    /** Chunk size for word-count mode; defaults to the shared source target. */
    targetCharacters?: number;
};

/**
 * Produces the deterministic extraction structure (source hash, chapters with P ranges and character
 * counts, volumes) that the extraction task persists. Rejects invalid divisions with `OutlineStructureError`.
 */
export function buildExtractionStructure(input: BuildExtractionStructureInput): ExtractionStructureDto {
    if (!/^[0-9a-f]{64}$/u.test(input.sourceSha256)) {
        throw new OutlineStructureError("SOURCE_HASH_INVALID", "来源哈希必须是 64 位小写十六进制。");
    }
    const mode = input.mode ?? (input.recognition.chapters.length > 0 ? "chapters" : "chunks");
    const chapters: ExtractionChapterDto[] = mode === "chapters"
        ? input.recognition.chapters.map(({index, title, firstParagraphId, lastParagraphId, characterCount}) => ({index, title, firstParagraphId, lastParagraphId, characterCount}))
        : planChunkChapters(input.paragraphs, input.targetCharacters, input.recognition);
    return {
        sourceSha256: input.sourceSha256,
        mode,
        chapters,
        volumes: divideVolumes(mode, chapters.length, input.division),
    };
}
