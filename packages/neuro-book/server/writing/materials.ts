import type {WritingChapterDto} from "nbook/shared/dto/writing.dto";
import {FRONTMATTER_PATTERN} from "./prose-binding";
import {headingSectionEnd, markdownBlocks, markdownHeadings} from "nbook/shared/markdown-structure";

/** 写手产出的字数下限：场景与整章都只要求不少于目标的这个比例，不设上限，避免篇幅超出触发重写。 */
export const WORD_LOWER_BOUND = 0.7;
export const PREVIOUS_ENDING_WORDS = 1500;
export const EXCERPT_MAX_WORDS = 1000;
export const SCENE_EXCERPT_MAX_WORDS = 3000;

export function stripFrontmatter(markdown: string): string {
    const match = markdown.match(FRONTMATTER_PATTERN);
    return match ? markdown.slice(match[0].length) : markdown;
}

const LINE_MARKUP = /^[ \t]{0,3}(?:#{1,6}(?=\s|$)|(?:>[ \t]?)+|[-*+](?=\s)|\d{1,9}[.)](?=\s))/gmu;
const THEMATIC_BREAK = /^[ \t]{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/gmu;
const FENCE_LINE = /^[ \t]{0,3}(?:`{3,}|~{3,}).*$/gmu;
// 单个 `~` 和 `_` 在中文正文里常作普通字符（“好~”），只去掉成对的删除线与强调符号。
const INLINE_MARKUP = /\\([\\`*_~#>[\]()!|+.-])|\*+|`+|~~|__/gu;

/** 字数：非空白字符，含标点，不计 Markdown 标记与 HTML 注释。 */
export function countWords(markdown: string): number {
    const text = markdown
        .replace(/<!--[\s\S]*?-->/gu, "")
        .replace(FENCE_LINE, "")
        .replace(THEMATIC_BREAK, "")
        .replace(LINE_MARKUP, "")
        .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
        .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
        .replace(INLINE_MARKUP, (_match, escaped: string | undefined) => escaped ?? "");
    let count = 0;
    for (const char of text) if (!/\s/u.test(char)) count += 1;
    return count;
}

export function meetsWordLowerBound(actual: number, target: number): boolean {
    return actual >= target * WORD_LOWER_BOUND;
}


export type WritingStyle = Readonly<{requirements: string; forbidden: string; sample: string}>;
export type WritingStyleResult = Readonly<{ok: true; style: WritingStyle}> | Readonly<{ok: false; message: string}>;

const STYLE_SECTIONS = {文风要求: "requirements", 禁用写法: "forbidden", 样文: "sample"} as const;

/** 文风文件按二级标题取三个小节；小节内的三级及以下标题属于小节正文。 */
export function parseWritingStyle(markdown: string): WritingStyleResult {
    const body = stripFrontmatter(markdown);
    const headings = markdownHeadings(body);
    const found: Partial<Record<keyof WritingStyle, string>> = {};
    for (const [index, heading] of headings.entries()) {
        if (heading.level !== 2 || !(heading.text in STYLE_SECTIONS)) continue;
        const key = STYLE_SECTIONS[heading.text as keyof typeof STYLE_SECTIONS];
        if (found[key] !== undefined) return {ok: false, message: `文风文件有多个「${heading.text}」小节`};
        const next = headings.slice(index + 1).find(({level}) => level <= 2);
        found[key] = body.slice(heading.end, next?.start ?? body.length).trim();
    }
    if (found.requirements === undefined) return {ok: false, message: "文风文件缺少「## 文风要求」小节"};
    if (found.requirements === "") return {ok: false, message: "文风文件的「文风要求」小节为空"};
    return {ok: true, style: {requirements: found.requirements, forbidden: found.forbidden ?? "", sample: found.sample ?? ""}};
}

const SENTENCE_END = /[。！？!?…」』”）)]+/gu;

/** 只剩一个超长段落时从句末处截断，找不到句末再按字数硬截。 */
function paragraphTail(text: string, limit: number): string {
    for (const match of text.matchAll(SENTENCE_END)) {
        const tail = text.slice(match.index + match[0].length).trim();
        if (tail !== "" && countWords(tail) <= limit) return tail;
    }
    const chars = [...text];
    let kept = 0;
    let index = chars.length;
    while (index > 0 && kept < limit) {
        index -= 1;
        if (!/\s/u.test(chars[index]!)) kept += 1;
    }
    return chars.slice(index).join("").trim();
}

/** 上一章结尾：从末尾取完整段落，累计不超过 limit 字；至少带最后一段。 */
export function extractChapterEnding(markdown: string, limit = PREVIOUS_ENDING_WORDS): string {
    const body = stripFrontmatter(markdown);
    const blocks = markdownBlocks(body);
    let start: number | null = null;
    let total = 0;
    for (const block of [...blocks].reverse()) {
        const words = countWords(body.slice(block.start, block.end));
        if (words === 0) continue;
        if (start === null && words > limit) return paragraphTail(body.slice(block.start, block.end), limit);
        if (start !== null && total + words > limit) break;
        start = block.start;
        total += words;
    }
    return start === null ? "" : body.slice(start).trim();
}

/**
 * 上一章：方案顺序中排在本章之前、最近一个有唯一非空正文的章节，可跨卷。
 * 归属冲突的章节无法确定用哪份正文，跳过。
 */
export function findPreviousProse(chapters: readonly WritingChapterDto[], chapterEntryId: string):
    Readonly<{entryId: string; title: string; path: string}> | null {
    const index = chapters.findIndex(({entryId}) => entryId === chapterEntryId);
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const chapter = chapters[cursor]!;
        const prose = chapter.prose[0];
        if (chapter.prose.length === 1 && prose && !prose.empty) return {entryId: chapter.entryId, title: chapter.title, path: prose.path};
    }
    return null;
}

/** 摘录位置：标题按全文精确匹配；段落按空行分块从 1 计数，含 from 到 to。 */
export type ExcerptLocator = Readonly<{heading: string}> | Readonly<{paragraphs: Readonly<{from: number; to?: number}>}>;
export type ExcerptResult = Readonly<{ok: true; text: string; words: number}> | Readonly<{ok: false; message: string}>;

export function describeExcerptLocator(locator: ExcerptLocator): string {
    if ("heading" in locator) return `标题「${locator.heading}」`;
    const {from, to = from} = locator.paragraphs;
    return from === to ? `第 ${from} 段` : `第 ${from}–${to} 段`;
}

export function resolveExcerpt(markdown: string, locator: ExcerptLocator): ExcerptResult {
    const body = stripFrontmatter(markdown);
    let text: string;
    if ("heading" in locator) {
        const headings = markdownHeadings(body);
        const matches = headings.flatMap((heading, index) => heading.text === locator.heading.trim() ? [index] : []);
        if (matches.length === 0) return {ok: false, message: `找不到${describeExcerptLocator(locator)}`};
        if (matches.length > 1) return {ok: false, message: `${describeExcerptLocator(locator)}出现多次，请改用段落位置`};
        const index = matches[0]!;
        text = body.slice(headings[index]!.start, headingSectionEnd(body, headings, index)).trim();
    } else {
        const {from, to = from} = locator.paragraphs;
        const blocks = markdownBlocks(body);
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > blocks.length) {
            return {ok: false, message: `${describeExcerptLocator(locator)}超出范围，文件共 ${blocks.length} 段`};
        }
        text = body.slice(blocks[from - 1]!.start, blocks[to - 1]!.end).trim();
    }
    const words = countWords(text);
    if (words > EXCERPT_MAX_WORDS) {
        return {ok: false, message: `${describeExcerptLocator(locator)}有 ${words} 字，单段摘录不能超过 ${EXCERPT_MAX_WORDS} 字`};
    }
    return {ok: true, text, words};
}
