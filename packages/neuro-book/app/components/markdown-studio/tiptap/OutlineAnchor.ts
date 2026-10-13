import {Mark, mergeAttributes} from "@tiptap/core";
import type {MarkdownToken} from "@tiptap/core";
import {parseMarkdownOutlineAnchor, renderMarkdownOutlineAnchor, type OutlineAnchorKind} from "nbook/shared/markdown-workbench";

interface OutlineAnchorToken extends MarkdownToken {
    marker?: string;
    tokens?: MarkdownToken[];
}

/**
 * 细纲锚点的富文本投影。注释是规范来源，元数据在 frontmatter 里按 marker 对应；
 * 编辑器只负责无损显示和回写，否则打开细纲文件再保存会把注释转义成正文，锚点随之丢失。
 */
function createOutlineAnchorMark(kind: OutlineAnchorKind, name: string) {
    const selector = `span[data-nb-outline-anchor="${kind}"]`;
    return Mark.create({
        name,
        priority: 790,
        inclusive: false,

        addAttributes() {
            return {
                marker: {default: "", parseHTML: (element: HTMLElement) => element.getAttribute("data-marker") ?? "", renderHTML: () => ({})},
            };
        },

        parseHTML() {
            return [{tag: selector, getAttrs: (element) => ({marker: (element as HTMLElement).getAttribute("data-marker") ?? ""})}];
        },

        renderHTML({mark, HTMLAttributes}) {
            return ["span", mergeAttributes(HTMLAttributes, {
                class: `nb-outline-anchor nb-outline-anchor--${kind}`,
                "data-nb-outline-anchor": kind,
                "data-marker": String(mark.attrs.marker ?? ""),
            }), 0];
        },

        markdownTokenizer: {
            name,
            level: "inline",
            start(src: string) {
                return src.indexOf("<!--");
            },
            tokenize(src: string, _tokens: unknown, lexer: {inlineTokens: (src: string) => MarkdownToken[]}) {
                const parsed = parseMarkdownOutlineAnchor(src, kind);
                if (!parsed) return undefined;
                return {type: name, raw: parsed.raw, marker: parsed.marker, tokens: lexer.inlineTokens(parsed.text)};
            },
        },

        parseMarkdown: (token, helpers) => {
            const anchor = token as OutlineAnchorToken;
            return helpers.applyMark(name, helpers.parseInline(anchor.tokens ?? []), {marker: anchor.marker ?? ""});
        },

        renderMarkdown: (node, helpers) => renderMarkdownOutlineAnchor(kind, String(node.attrs?.marker ?? ""), helpers.renderChildren(node)),
    });
}

export const OutlineGuidanceAnchor = createOutlineAnchorMark("guidance", "outlineGuidanceAnchor");
export const OutlineReferenceAnchor = createOutlineAnchorMark("reference", "outlineReferenceAnchor");
