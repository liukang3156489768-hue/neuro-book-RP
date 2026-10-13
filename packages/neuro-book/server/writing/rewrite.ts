import {markdownBlocks} from "nbook/shared/markdown-structure";
import type {RewriteWindow} from "./structures";

/** 改写目标上下各截取的完整段落数，见 writing.collaboration 结构 D。 */
export const REWRITE_CONTEXT_PARAGRAPHS = 2;

/** 替换前请用户确认的标题；主创工具据此识别，只能转交用户本人的决定。 */
export const REWRITE_CONFIRM_TITLE = "确认替换改写段落";

/** 主创给出的目标：段号（与 read_chapter_prose 的 [n] 同一口径），或从正文中摘出的一段原话。 */
export type RewriteTarget = Readonly<{paragraphs: Readonly<{from: number; to?: number}>}> | Readonly<{quote: string}>;

/** 目标段落的范围，从 1 开始，含两端。 */
export type ParagraphRange = Readonly<{from: number; to: number}>;

export type LocatedRewrite = Readonly<{range: ParagraphRange; window: RewriteWindow}>;

type Located = Readonly<{ok: true; value: LocatedRewrite}> | Readonly<{ok: false; message: string}>;

function paragraphs(body: string): string[] {
    return markdownBlocks(body).map(({start, end}) => body.slice(start, end));
}

/**
 * 编辑器选区是渲染后的文字，与 Markdown 源文在空白、强调和标题记号上不同；
 * 两边都去掉这些字符再比较，每个保留字符记下所在段落，据此换回段号。
 */
const IGNORED = /[\s*_`~#>]/u;

function normalizedParagraphs(body: string): Readonly<{text: string; owner: number[]}> {
    let text = "";
    const owner: number[] = [];
    paragraphs(body).forEach((paragraph, index) => {
        for (const char of paragraph) {
            if (IGNORED.test(char)) continue;
            text += char;
            owner.push(index);
        }
    });
    return {text, owner};
}

function occurrences(text: string, needle: string): number[] {
    const found: number[] = [];
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) found.push(at);
    return found;
}

function locateQuote(body: string, quote: string): Readonly<{ok: true; range: ParagraphRange}> | Readonly<{ok: false; message: string}> {
    const needle = [...quote].filter((char) => !IGNORED.test(char)).join("");
    if (needle === "") return {ok: false, message: "选中的内容为空"};
    const {text, owner} = normalizedParagraphs(body);
    const found = occurrences(text, needle);
    if (found.length === 0) return {ok: false, message: "正文中找不到选中的内容，正文可能已经改动"};
    if (found.length > 1) return {ok: false, message: `选中的内容在正文中出现了 ${found.length} 次，请多选一些上下文或改用段号`};
    const start = found[0]!;
    return {ok: true, range: {from: owner[start]! + 1, to: owner[start + needle.length - 1]! + 1}};
}

/** 目标扩展到涉及的完整段落，并截取上下文；章首或章末不足两段时有多少取多少。 */
export function locateRewrite(body: string, target: RewriteTarget): Located {
    const all = paragraphs(body);
    if (all.length === 0) return {ok: false, message: "正文为空，没有可改写的段落"};
    let range: ParagraphRange;
    if ("quote" in target) {
        const located = locateQuote(body, target.quote);
        if (!located.ok) return located;
        range = located.range;
    } else {
        const from = target.paragraphs.from;
        const to = target.paragraphs.to ?? from;
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > all.length) {
            return {ok: false, message: `段号超出范围：正文共 ${all.length} 段`};
        }
        range = {from, to};
    }
    return {ok: true, value: {range, window: {
        before: all.slice(Math.max(0, range.from - 1 - REWRITE_CONTEXT_PARAGRAPHS), range.from - 1),
        target: body.slice(markdownBlocks(body)[range.from - 1]!.start, markdownBlocks(body)[range.to - 1]!.end),
        after: all.slice(range.to, range.to + REWRITE_CONTEXT_PARAGRAPHS),
    }}};
}

export type RewriteReplacement = Readonly<{ok: true; body: string}> | Readonly<{ok: false; message: string}>;

/**
 * 确认替换时按原文重新找目标：目标之外的改动会移动段号，但不应阻止替换；
 * 目标原文找不到，或在原位置之外出现多处而无法确定时，不替换。
 */
export function replaceRewriteTarget(body: string, input: Readonly<{range: ParagraphRange; target: string; replacement: string}>): RewriteReplacement {
    const blocks = markdownBlocks(body);
    const span = input.range.to - input.range.from;
    const matches: number[] = [];
    for (let index = 0; index + span < blocks.length; index += 1) {
        if (body.slice(blocks[index]!.start, blocks[index + span]!.end) === input.target) matches.push(index);
    }
    const at = matches.includes(input.range.from - 1) ? input.range.from - 1 : matches.length === 1 ? matches[0]! : null;
    if (at === null) {
        return {ok: false, message: matches.length === 0 ? "目标段落已被改动，未替换；请重新发起改写" : "目标段落在正文中出现多处且位置已变化，未替换；请重新发起改写"};
    }
    const replacement = input.replacement.trim();
    if (replacement === "") return {ok: false, message: "改写结果为空，未替换"};
    return {ok: true, body: `${body.slice(0, blocks[at]!.start)}${replacement}${body.slice(blocks[at + span]!.end)}`};
}
