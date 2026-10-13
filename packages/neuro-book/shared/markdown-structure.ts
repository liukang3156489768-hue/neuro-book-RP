export type MarkdownHeading = Readonly<{level: number; text: string; start: number; end: number}>;
export type MarkdownBlock = Readonly<{start: number; end: number}>;

type Line = Readonly<{text: string; start: number; end: number; fenced: boolean}>;

const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/u;
const HEADING = /^[ \t]{0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/u;

/** 逐行标出代码块：代码块里的 `#` 和空行都不是 Markdown 结构。 */
function scanLines(body: string): Line[] {
    const lines: Line[] = [];
    let fence: string | null = null;
    let start = 0;
    for (const raw of body.split("\n")) {
        const end = start + raw.length;
        const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        const marker = FENCE.exec(text)?.[1];
        const inFence = fence !== null;
        if (marker && fence === null) fence = marker;
        else if (marker && fence !== null && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        lines.push({text, start, end, fenced: inFence || marker !== undefined});
        start = end + 1;
    }
    return lines;
}

/** ATX 标题；start/end 是标题行在正文中的偏移，不含换行。 */
export function markdownHeadings(body: string): MarkdownHeading[] {
    return scanLines(body).flatMap((line) => {
        if (line.fenced) return [];
        const match = HEADING.exec(line.text);
        return match ? [{level: match[1]!.length, text: (match[2] ?? "").trim(), start: line.start, end: line.end}] : [];
    });
}

/** 以空行分隔的块；代码块内的空行不分块。 */
export function markdownBlocks(body: string): MarkdownBlock[] {
    const blocks: MarkdownBlock[] = [];
    let current: {start: number; end: number} | null = null;
    for (const line of scanLines(body)) {
        if (!line.fenced && line.text.trim() === "") {
            if (current) blocks.push(current);
            current = null;
            continue;
        }
        if (current) current.end = line.end;
        else current = {start: line.start, end: line.end};
    }
    if (current) blocks.push(current);
    return blocks;
}

/** 标题小节：从标题行开始，到下一个同级或更高级标题为止。 */
export function headingSectionEnd(body: string, headings: readonly MarkdownHeading[], index: number): number {
    const heading = headings[index]!;
    const next = headings.slice(index + 1).find(({level}) => level <= heading.level);
    return next?.start ?? body.length;
}
