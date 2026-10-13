import {parseMarkdownForeshadowMarker, type ForeshadowMarkerAction} from "nbook/shared/markdown-workbench";

/** 章节大纲正文里的一处伏笔标记；细纲场景的“伏笔”小节用 marker 认领由自己执行。 */
export type ChapterForeshadowMarker = Readonly<{marker: string; action: ForeshadowMarkerAction; text: string}>;

export function chapterForeshadowMarkers(body: string): ChapterForeshadowMarker[] {
    const markers: ChapterForeshadowMarker[] = [];
    for (const matched of body.matchAll(/<!--\s*nb:foreshadow\b/gu)) {
        const token = parseMarkdownForeshadowMarker(body.slice(matched.index));
        if (token) markers.push({marker: token.marker, action: token.action, text: token.text.replace(/<!--[\s\S]*?-->/gu, "")});
    }
    return markers;
}
