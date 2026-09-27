import {Mark, mergeAttributes} from "@tiptap/core";
import type {MarkdownToken} from "@tiptap/core";
import {parseMarkdownForeshadowMarker, renderMarkdownForeshadowMarker, type ForeshadowMarkerAction} from "nbook/shared/markdown-workbench";

interface ForeshadowMarkerToken extends MarkdownToken {
    marker?: string;
    foreshadowId?: string;
    action?: ForeshadowMarkerAction;
    tokens?: MarkdownToken[];
}

/**
 * 章节大纲伏笔标记的富文本投影。注释仍是 Markdown 规范来源，编辑器只把包围文本
 * 显示为带下划线的可交互标记，保存时原样回写结构化注释，不把状态写进正文。
 */
export const ForeshadowMarker = Mark.create({
    name: "foreshadowMarker",
    priority: 790,
    inclusive: false,

    addAttributes() {
        return {
            marker: {default: "", parseHTML: (element: HTMLElement) => element.getAttribute("data-marker") ?? "", renderHTML: () => ({})},
            foreshadowId: {default: "", parseHTML: (element: HTMLElement) => element.getAttribute("data-foreshadow") ?? "", renderHTML: () => ({})},
            action: {default: "plant", parseHTML: (element: HTMLElement) => element.getAttribute("data-action") ?? "plant", renderHTML: () => ({})},
        };
    },

    parseHTML() {
        return [{tag: "span[data-nb-foreshadow-marker]", getAttrs: (element) => ({
            marker: (element as HTMLElement).getAttribute("data-marker") ?? "",
            foreshadowId: (element as HTMLElement).getAttribute("data-foreshadow") ?? "",
            action: (element as HTMLElement).getAttribute("data-action") ?? "plant",
        })}];
    },

    renderHTML({mark, HTMLAttributes}) {
        const action = String(mark.attrs.action ?? "plant");
        return ["span", mergeAttributes(HTMLAttributes, {
            class: `nb-foreshadow-marker nb-foreshadow-marker--${action}`,
            "data-nb-foreshadow-marker": "true",
            "data-marker": String(mark.attrs.marker ?? ""),
            "data-foreshadow": String(mark.attrs.foreshadowId ?? ""),
            "data-action": action,
            title: `${String(mark.attrs.foreshadowId ?? "")} · ${action}`,
        }), 0];
    },

    markdownTokenizer: {
        name: "foreshadowMarker",
        level: "inline",
        start(src: string) {
            return src.indexOf("<!--");
        },
        tokenize(src: string, _tokens: unknown, lexer: {inlineTokens: (src: string) => MarkdownToken[]}) {
            const parsed = parseMarkdownForeshadowMarker(src);
            if (!parsed) return undefined;
            return {
                type: "foreshadowMarker",
                raw: parsed.raw,
                marker: parsed.marker,
                foreshadowId: parsed.foreshadowId,
                action: parsed.action,
                tokens: lexer.inlineTokens(parsed.text),
            };
        },
    },

    parseMarkdown: (token, helpers) => {
        const marker = token as ForeshadowMarkerToken;
        return helpers.applyMark("foreshadowMarker", helpers.parseInline(marker.tokens ?? []), {
            marker: marker.marker ?? "",
            foreshadowId: marker.foreshadowId ?? "",
            action: marker.action ?? "plant",
        });
    },

    renderMarkdown: (node, helpers) => renderMarkdownForeshadowMarker({
        marker: String(node.attrs?.marker ?? ""),
        foreshadowId: String(node.attrs?.foreshadowId ?? ""),
        action: (node.attrs?.action === "reinforce" || node.attrs?.action === "recover" ? node.attrs.action : "plant"),
    }, helpers.renderChildren(node)),
});