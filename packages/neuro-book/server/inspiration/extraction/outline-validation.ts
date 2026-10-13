import {analyzeDetailStructure, blockingDetailProblems} from "nbook/shared/outline-detail-structure";
import {headingSectionEnd, markdownHeadings} from "nbook/shared/markdown-structure";
import type {ValidationResult} from "./types";

/**
 * 大纲提取产出的校验。错误信息是中文，会原样写入 t04 修复重试的预留位，
 * 因此每条都要说明“哪里不对、应该怎么改”，而不只是报错码。
 */

/** 产出末行的引用标记，例如 `【引用】P3-P8、P12`。 */
export const CITATION_MARKER = "【引用】";

/** 各层条目必须出现且非空的一级标题（取自 outline-entry-templates 的必需章节）。 */
export const CHAPTER_OUTLINE_SECTIONS = ["章节目标", "场景设定", "剧情概要", "章节结尾"] as const;
export const VOLUME_OUTLINE_SECTIONS = ["本卷目标", "起始状态", "核心冲突", "结束状态"] as const;
export const TOTAL_OUTLINE_SECTIONS = ["核心冲突", "主题", "结局方向"] as const;

export type ChapterParagraphRange = Readonly<{first: number; last: number}>;

export function paragraphNumber(id: string): number {
    const match = /^P(\d+)$/u.exec(id);
    if (!match) throw new Error(`无效的段落编号：${id}`);
    return Number(match[1]);
}

export function chapterRange(chapter: Readonly<{firstParagraphId: string; lastParagraphId: string}>): ChapterParagraphRange {
    return {first: paragraphNumber(chapter.firstParagraphId), last: paragraphNumber(chapter.lastParagraphId)};
}

export function formatRange(range: ChapterParagraphRange): string {
    return `P${range.first}-P${range.last}`;
}

/** 去掉模型常见的整体代码围栏（```markdown … ```），其余内容原样保留。 */
function stripOuterFence(output: string): string {
    const trimmed = output.trim();
    const match = /^```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n```$/u.exec(trimmed);
    return match ? match[1]!.trim() : trimmed;
}

export type CitedOutput = Readonly<{body: string; locator: string}>;

const REFERENCE_TOKEN = /^P(\d+)(?:\s*[-~–—]\s*P?(\d+))?$/u;

/**
 * 拆出正文与末尾引用行，并核对 P 范围：每个范围必须有序且整体落在本章内。
 * 正文里夹带的本章以外的 P 编号也视为越界（模型会把相邻章节的引用写进正文）。
 */
export function parseCitedOutput(output: string, range: ChapterParagraphRange): ValidationResult<CitedOutput> {
    const text = stripOuterFence(output);
    const lines = text.split(/\r?\n/u);
    let markerLine = -1;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (lines[index]!.trim().startsWith(CITATION_MARKER)) { markerLine = index; break; }
    }
    if (markerLine < 0) {
        return {ok: false, error: `缺少末尾的原文引用行。请在正文之后另起一行写“${CITATION_MARKER}P3-P8、P12”形式的引用，范围必须在本章 ${formatRange(range)} 之内。`};
    }
    const citation = lines[markerLine]!.trim().slice(CITATION_MARKER.length).trim();
    const body = lines.slice(0, markerLine).join("\n").trim();
    const tokens = citation.split(/[、,，;；\s]+/u).filter(token => token !== "");
    if (tokens.length === 0) return {ok: false, error: `引用行“${CITATION_MARKER}”后没有写任何 P 编号。请写明依据的原文段落，例如 P3-P8。`};
    const normalized: string[] = [];
    for (const token of tokens) {
        const match = REFERENCE_TOKEN.exec(token);
        if (!match) return {ok: false, error: `引用“${token}”格式无效。只能写 P 编号或范围，例如 P12 或 P3-P8。`};
        const start = Number(match[1]);
        const end = match[2] === undefined ? start : Number(match[2]);
        if (start > end) return {ok: false, error: `引用“${token}”的起点大于终点，请改为 P${end}-P${start} 的升序写法。`};
        if (start < range.first || end > range.last) {
            return {ok: false, error: `引用“${token}”超出本章范围 ${formatRange(range)}。引用只能落在本章段落内，请改为本章内的 P 编号。`};
        }
        normalized.push(start === end ? `P${start}` : `P${start}-P${end}`);
    }
    for (const match of body.matchAll(/(?<![A-Za-z0-9])P(\d+)(?![A-Za-z0-9])/gu)) {
        const number = Number(match[1]);
        if (number < range.first || number > range.last) {
            return {ok: false, error: `正文中出现了本章范围 ${formatRange(range)} 之外的段落编号 ${match[0]}。正文不要写 P 编号，引用只写在末尾引用行。`};
        }
    }
    if (body === "") return {ok: false, error: "引用行之前没有正文。请先输出正文，再另起一行写引用。"};
    return {ok: true, value: {body, locator: normalized.join(", ")}};
}

/** 去掉围栏并确认存在正文；用于不要求原文引用的卷纲与总纲。 */
export function plainOutput(output: string): ValidationResult<string> {
    const body = stripOuterFence(output);
    if (body === "") return {ok: false, error: "产出为空。请按模板输出完整正文。"};
    if (body.split(/\r?\n/u).some(line => line.trim().startsWith(CITATION_MARKER))) {
        return {ok: false, error: `卷纲与总纲不需要原文引用，请删除“${CITATION_MARKER}”行，只输出正文。`};
    }
    return {ok: true, value: body};
}

/** 必需的一级标题缺失或内容为空时返回问题列表。 */
export function missingSections(body: string, required: readonly string[]): string[] {
    const headings = markdownHeadings(body);
    const problems: string[] = [];
    for (const name of required) {
        const index = headings.findIndex(heading => heading.level === 1 && heading.text === name);
        if (index < 0) { problems.push(`缺少一级标题“# ${name}”`); continue; }
        const content = body.slice(headings[index]!.end, headingSectionEnd(body, headings, index)).trim();
        if (content === "") problems.push(`“# ${name}”下没有内容`);
    }
    return problems;
}

function sectionResult(body: string, required: readonly string[], label: string): ValidationResult<string> {
    const problems = missingSections(body, required);
    if (problems.length === 0) return {ok: true, value: body};
    return {ok: false, error: `${label}不符合模板：${problems.join("；")}。必需的一级标题依次为：${required.map(name => `# ${name}`).join("、")}，每个标题下都要有内容。`};
}

export function validateDetailBody(body: string): ValidationResult<string> {
    const structure = analyzeDetailStructure({body});
    const blocking = blockingDetailProblems(structure);
    if (blocking.length > 0) {
        return {ok: false, error: `细纲不符合模板：${blocking.map(problem => problem.message).join("；")}`};
    }
    // 伏笔库与线路不属于提取范围；细纲里的伏笔条目会指向并不存在的伏笔对象。
    if (structure.scenes.some(scene => scene.foreshadowing.length > 0) || /^#{1,6}\s*伏笔/mu.test(body)) {
        return {ok: false, error: "细纲不要写“伏笔”小节：提取不处理伏笔。请删除伏笔小节，把相关情节写进“具体情节”。"};
    }
    return {ok: true, value: body};
}

export const validateChapterOutlineBody = (body: string) => sectionResult(body, CHAPTER_OUTLINE_SECTIONS, "章节大纲");
export const validateVolumeBody = (body: string) => sectionResult(body, VOLUME_OUTLINE_SECTIONS, "卷纲");
export const validateTotalBody = (body: string) => sectionResult(body, TOTAL_OUTLINE_SECTIONS, "总纲");

type BodyValidator = (body: string) => ValidationResult<string>;

/** 带引用的产出（细纲、章节大纲）：先核引用范围，再核模板。 */
export function validateCitedOutput(range: ChapterParagraphRange, validateBody: BodyValidator): (output: string) => ValidationResult<CitedOutput> {
    return output => {
        const cited = parseCitedOutput(output, range);
        if (!cited.ok) return cited;
        const body = validateBody(cited.value.body);
        return body.ok ? cited : body;
    };
}

/** 不带引用的产出（卷纲、总纲）。 */
export function validatePlainOutput(validateBody: BodyValidator): (output: string) => ValidationResult<string> {
    return output => {
        const plain = plainOutput(output);
        if (!plain.ok) return plain;
        return validateBody(plain.value);
    };
}
