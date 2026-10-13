import {Extension} from "@tiptap/core";
import type {MarkdownToken} from "@tiptap/core";

/** 伏笔标记与细纲锚点的开始注释；它们是行内结构，只是恰好写在段首。 */
const LEADING_MARKER = /^ {0,3}<!--\s*nb:(?:foreshadow|guidance|reference)\s/u;
const MARKER_PAIRS = [
    /<!--\s*nb:foreshadow\s+marker="([^"]+)"[^>]*?-->[\s\S]*?<!--\s*\/nb:foreshadow\s+marker="\1"\s*-->/gu,
    /<!--\s*nb:guidance\s+marker="([^"]+)"\s*-->[\s\S]*?<!--\s*\/nb:guidance\s+marker="\1"\s*-->/gu,
    /<!--\s*nb:reference\s+marker="([^"]+)"\s*-->[\s\S]*?<!--\s*\/nb:reference\s+marker="\1"\s*-->/gu,
];
/** 这些行会打断段落，与 marked 段落规则保持同一组边界。 */
const BLOCK_START = /^(?:\s*$| {0,3}(?:#{1,6}(?:\s|$)|[-*+]\s|\d{1,9}[.)]\s|>|```|~~~|<(?!!--\s*\/?nb:)))/u;

/**
 * 段内每条注释都属于成对的标记才接管。损坏或普通注释在行内解析里会被丢掉，
 * 这类段落继续交给 HtmlBlock 保留源码。
 */
function onlyPairedMarkers(text: string): boolean {
    const comments = text.match(/<!--[\s\S]*?-->/gu)?.length ?? 0;
    const paired = MARKER_PAIRS.reduce((count, pattern) => count + [...text.matchAll(pattern)].length * 2, 0);
    return comments === paired;
}

/**
 * 段首是伏笔标记或细纲锚点注释时，按普通段落切分。CommonMark 把 `<!--` 开头的行当作 HTML 块，
 * 不接管的话整段会落进 HtmlBlock 源码卡片，标注不显示、正文也无法按富文本编辑。
 *
 * marked 扩展 tokenizer 后注册先执行；本扩展保持默认 priority，排在 HtmlBlock 兜底之后注册，
 * 从而先于它和 marked 原生 html 规则认领这类段落。
 */
export const MarkerParagraph = Extension.create({
    name: "markerParagraph",

    markdownTokenizer: {
        name: "markerParagraph",
        level: "block",
        start(src: string) {
            const matched = /\n {0,3}<!--\s*nb:(?:foreshadow|guidance|reference)\s/u.exec(src);
            return matched ? matched.index + 1 : -1;
        },
        tokenize(src: string, _tokens: unknown, lexer: {inlineTokens: (src: string) => MarkdownToken[]}) {
            if (!LEADING_MARKER.test(src)) return undefined;
            const lines = src.split("\n");
            let count = 1;
            while (count < lines.length && !BLOCK_START.test(lines[count] ?? "")) count += 1;
            const text = lines.slice(0, count).join("\n").trim();
            if (!onlyPairedMarkers(text)) return undefined;
            const raw = lines.slice(0, count).join("\n") + (count < lines.length ? "\n" : "");
            return {type: "paragraph", raw, text, tokens: lexer.inlineTokens(text)};
        },
    },
});
