import type {ForeshadowAction, OutlineId, OutlineReference} from "nbook/server/outline/format";
import {
    analyzeDetailStructure, blockingDetailProblems, FORESHADOW_STATUS_LABELS,
    type DetailCharacter, type DetailOverview,
} from "nbook/shared/outline-detail-structure";
import type {WriterChapterContext} from "nbook/server/outline/writer-context";
import type {WritingIssueDraft} from "nbook/shared/dto/writing.dto";

export const FORESHADOW_ACTION: Readonly<Record<ForeshadowAction, string>> = FORESHADOW_STATUS_LABELS;

/** 场景执行的一个伏笔：原文取自章节大纲标记，状态、作用与效果取自细纲。 */
export type SceneForeshadow = Readonly<{
    marker: string;
    name: string;
    action: ForeshadowAction;
    /** 章节大纲中标记包围的原文。 */
    text: string;
    /** 只给助手审阅；写手看不到。 */
    purpose: string;
    effect: string;
}>;

export type SceneSource = Readonly<{
    index: number;
    detailEntryId: OutlineId;
    heading: string;
    name: string;
    /** 场景在细纲中的原文，只用于续写时判断已通过场景是否仍与当前细纲一致。 */
    source: string;
    summary: string;
    perspective: string;
    targetWords: number;
    mood: string;
    pacing: string;
    location?: string;
    attire?: string;
    characters: readonly DetailCharacter[];
    plot: readonly string[];
    description: string;
    guidance: string;
    references: readonly OutlineReference[];
    foreshadowing: readonly SceneForeshadow[];
    /** 作者锁定的要素：具体情节逐条在前，执行的伏笔在后；助手只能在其后追加。 */
    requiredElements: readonly string[];
    /** 具体情节最后一条，写手只能写到这里。 */
    ending: string;
    /** 本章禁止事项；每个场景都带上，审阅逐条检查。 */
    forbidden: readonly string[];
}>;

export type ForeshadowingText = Readonly<{marker: string; action: ForeshadowAction; text: string}>;

export type ChapterMaterials = Readonly<{
    detailEntryId: OutlineId;
    overview: DetailOverview;
    /** 章节大纲的 writingGuidance 原文；没有时为空数组。 */
    chapterGuidance: readonly Readonly<{entryId: OutlineId; title: string; text: string}>[];
    /** 章节大纲中伏笔标记处的原文和动作，按出现顺序；不含伏笔定义。 */
    foreshadowing: readonly ForeshadowingText[];
    forbidden: readonly string[];
    /** 总览的目标字数，即整章正文目标。 */
    targetWords: number;
    scenes: readonly SceneSource[];
}>;

export type ChapterMaterialsResult =
    | Readonly<{ok: true; materials: ChapterMaterials; issues: readonly WritingIssueDraft[]}>
    | Readonly<{ok: false; issues: readonly WritingIssueDraft[]}>;

export function foreshadowElement({action, text, effect}: Pick<SceneForeshadow, "action" | "text" | "effect">): string {
    return `伏笔（${FORESHADOW_ACTION[action]}）：${text}${effect === "" ? "" : `；效果：${effect}`}`;
}

/**
 * 把交接结果整理成场景与本章级素材。一章只用一份细纲：总览描述整章，多份细纲的总览和禁止事项无法合并。
 * 细纲结构不完整就整章失败，缺少场景结构时不能靠猜测切分。伏笔只取已确认伏笔的标记，
 * 标记是否存在、状态是否一致已在细纲分析时按章节大纲检查。
 */
export function buildChapterMaterials(context: WriterChapterContext): ChapterMaterialsResult {
    const issues: WritingIssueDraft[] = context.warnings.map((warning) => ({code: "PENDING_REFERENCE", severity: "hint",
        message: `参考资料待补：${[warning.path, warning.locator, warning.purpose].filter(Boolean).join("，") || "未注明"}`,
        location: {entryId: warning.entryId}}));
    if (context.details.length !== 1) {
        issues.push({code: "MISSING_SCENE_STRUCTURE", severity: "blocking",
            message: `本章有 ${context.details.length} 份细纲，写作只能使用一份；请把细纲合并为一份`,
            location: {entryId: context.chapter.entryId}});
        return {ok: false, issues};
    }
    const detail = context.details[0]!;
    const structure = analyzeDetailStructure(detail);
    const blocking = blockingDetailProblems(structure);
    if (blocking.length > 0 || structure.overview === null || structure.overview.targetWords === null) {
        issues.push({code: "MISSING_SCENE_STRUCTURE", severity: "blocking",
            message: `细纲「${detail.title}」结构不完整，请修改或重新生成：${blocking.map(({message}) => message).join("；")}`,
            location: {entryId: detail.entryId}});
        return {ok: false, issues};
    }
    for (const problem of structure.problems) {
        if (problem.code !== "WORD_TARGET_MISMATCH") continue;
        issues.push({code: "WORD_TARGET_MISMATCH", severity: "hint", message: problem.message, location: {entryId: detail.entryId}});
    }
    const foreshadowing = context.foreshadowing.map(({marker, action, content}) => ({marker, action, text: content}));
    const byMarker = new Map(foreshadowing.map((item) => [item.marker, item]));
    const forbidden = structure.forbidden;
    const scenes = structure.scenes.map((scene): SceneSource => {
        const executed = scene.foreshadowing.flatMap((item): SceneForeshadow[] => {
            const marker = item.marker === null ? undefined : byMarker.get(item.marker);
            if (!marker) {
                // 交接只带已确认伏笔的标记；草稿伏笔的标记在大纲里合法，但写作不执行，必须让作者知道。
                issues.push({code: "UNASSIGNED_FORESHADOW", severity: "hint", location: {entryId: detail.entryId, sceneIndex: scene.index},
                    message: `场景${scene.index}的伏笔「${item.name || item.marker}」对应的伏笔尚未确认，写手不会执行；请先在伏笔库确认该伏笔`});
                return [];
            }
            return [{marker: marker.marker, name: item.name, action: marker.action, text: marker.text,
                purpose: item.purpose, effect: item.effect}];
        });
        return {
            index: scene.index, detailEntryId: detail.entryId, heading: scene.heading, name: scene.name,
            source: detail.body.slice(scene.start, scene.end).trim(),
            summary: scene.summary, perspective: scene.perspective, targetWords: scene.words!,
            mood: scene.mood, pacing: scene.pacing, characters: scene.characters, plot: scene.plot,
            location: scene.location, attire: scene.attire,
            description: scene.description, guidance: scene.guidance,
            references: scene.references.map(({label, path}) => path === undefined ? {pending: true, locator: label} : {path, purpose: label}),
            foreshadowing: executed,
            requiredElements: [...scene.plot, ...executed.map(foreshadowElement)],
            ending: scene.plot[scene.plot.length - 1]!,
            forbidden,
        };
    });
    const assigned = new Set(scenes.flatMap((scene) => scene.foreshadowing.map(({marker}) => marker)));
    for (const item of foreshadowing) {
        if (assigned.has(item.marker)) continue;
        issues.push({code: "UNASSIGNED_FORESHADOW", severity: "hint",
            message: `章节大纲的伏笔标记「${item.text}」（${FORESHADOW_ACTION[item.action]}）没有分给任何场景，写手只会看到原文`,
            location: {entryId: context.chapter.entryId}});
    }
    const text = context.chapter.writingGuidance?.trim() ?? "";
    const chapterGuidance = text === "" ? [] : [{entryId: context.chapter.entryId, title: context.chapter.title, text}];
    return {ok: true, issues, materials: {detailEntryId: detail.entryId, overview: structure.overview, chapterGuidance,
        foreshadowing, forbidden, targetWords: structure.overview.targetWords, scenes}};
}
