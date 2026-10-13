import {
    OutlineExtractionParamsSchema, type OutlineDestinationDto, type OutlineExtractionParamsDto,
    type OutlineOverwriteItemKind,
} from "nbook/shared/dto/inspiration-outline-extraction.dto";
import type {ExtractionChapterDto, ExtractionVolumeDto} from "nbook/shared/dto/inspiration-outline-structure.dto";
import type {ExtractionSourceRef, ExtractionTask, ExtractionUnit, JsonRecord} from "nbook/shared/dto/inspiration-extraction-task.dto";
import type {OutlineId} from "nbook/server/outline/format";
import {stableId} from "nbook/server/outline/format";
import {ExtractionTaskError} from "./errors";

/**
 * 大纲提取流水线的任务参数、单元 ID 与流水线状态约定。这些键写入任务记录的 `state`，
 * 由 `readOutlineState` 集中读取，其他模块不直接按字符串键取值。
 */

export type OutlineStepKind = "detail" | "outline" | "volume" | "total" | "compare" | "apply-detail" | "apply-outline";

export const OUTLINE_STEP = {
    detail: "detail",
    outline: "outline",
    volume: "volume",
    total: "total",
    compare: "compare",
    applyDetail: "apply-detail",
    applyOutline: "apply-outline",
} as const satisfies Record<string, OutlineStepKind>;

export const OUTLINE_TOTAL_UNIT_ID = "total";
export const OUTLINE_COMPARE_UNIT_ID = "compare";

export const chapterDetailUnitId = (chapter: number) => `chapter-${chapter}:detail`;
export const chapterOutlineUnitId = (chapter: number) => `chapter-${chapter}:outline`;
export const volumeUnitId = (volume: number) => `volume-${volume}:summary`;
export const applyUnitId = (chapter: number, kind: OutlineOverwriteItemKind) => `chapter-${chapter}:apply-${kind}`;
/** 进度分组键：一卷的章节单元与该卷的卷纲单元同组，界面据此显示每卷进度。 */
export const volumeGroup = (volume: number) => `volume-${volume}`;
export const candidateKey = (chapter: number, kind: OutlineOverwriteItemKind) => `cand:${chapter}:${kind}`;
export const staleVolumeKey = (volume: number) => `stale:volume:${volume}`;
export const STALE_TOTAL_KEY = "stale:total";

export function unitChapter(unit: ExtractionUnit): number {
    const value = unit.data.chapter;
    if (typeof value !== "number") throw new Error(`单元 ${unit.id} 缺少章节序号`);
    return value;
}

export function unitVolume(unit: ExtractionUnit): number {
    const value = unit.data.volume;
    if (typeof value !== "number") throw new Error(`单元 ${unit.id} 缺少卷序号`);
    return value;
}

/** 解析并校验启动参数；结构问题在 `prepare` 之前暴露，避免先创建方案再失败。 */
export function parseOutlineParams(params: JsonRecord, source: ExtractionSourceRef): OutlineExtractionParamsDto {
    const parsed = OutlineExtractionParamsSchema.safeParse(params);
    if (!parsed.success) {
        throw new ExtractionTaskError("INVALID_INPUT", `大纲提取参数无效：${parsed.error.issues.map(issue => `${issue.path.join(".") || "参数"} ${issue.message}`).join("；")}`);
    }
    const {structure} = parsed.data;
    if (structure.sourceSha256 !== source.sha256) {
        throw new ExtractionTaskError("SOURCE_CHANGED", "提取结构基于旧版本的作品文件，请重新识别章节后再开始。");
    }
    if (structure.chapters.length === 0) throw new ExtractionTaskError("INVALID_INPUT", "提取结构没有任何章节。");
    structure.chapters.forEach((chapter, position) => {
        if (chapter.index !== position + 1) throw new ExtractionTaskError("INVALID_INPUT", `提取结构的章节序号必须从 1 连续递增，第 ${position + 1} 项是 ${chapter.index}。`);
    });
    if (structure.volumes.length === 0) throw new ExtractionTaskError("INVALID_INPUT", "提取结构没有划卷结果。");
    let expectedFirst = 1;
    structure.volumes.forEach((volume, position) => {
        if (volume.index !== position + 1 || volume.firstChapterIndex !== expectedFirst || volume.lastChapterIndex < volume.firstChapterIndex) {
            throw new ExtractionTaskError("INVALID_INPUT", `第 ${position + 1} 卷的章节范围与前一卷不连续。`);
        }
        expectedFirst = volume.lastChapterIndex + 1;
    });
    if (expectedFirst !== structure.chapters.length + 1) throw new ExtractionTaskError("INVALID_INPUT", "划卷结果没有覆盖全部章节。");
    return parsed.data;
}

export function chapterVolumeIndex(volumes: readonly ExtractionVolumeDto[], chapterIndex: number): number {
    const volume = volumes.find(item => item.firstChapterIndex <= chapterIndex && chapterIndex <= item.lastChapterIndex);
    if (!volume) throw new Error(`第 ${chapterIndex} 章不属于任何卷`);
    return volume.index;
}

export function chapterDisplayTitle(chapter: ExtractionChapterDto): string {
    return chapter.title.trim() || `第${chapter.index}章`;
}

export function volumeDisplayTitle(volume: ExtractionVolumeDto): string {
    return volume.title?.trim() || `第${volume.index}卷`;
}

/** 方案内每个结构条目对应的大纲库条目；下标 0 对应第 1 章／第 1 卷。 */
export type OutlineState = Readonly<{
    destination: OutlineDestinationDto["kind"];
    planId: string;
    planTitle: string;
    totalId: OutlineId;
    volumeIds: readonly OutlineId[];
    chapterIds: readonly OutlineId[];
    /** 启动时卷纲已有正文的卷序号；补充与覆盖据此判断章节大纲写入后卷纲是否过期。 */
    volumesWithBody: readonly number[];
    totalHadBody: boolean;
    /** 覆盖模式下，结构里没有对应章节的章序号（方案章节数较少）；这些章不提取。 */
    unmappedChapters: readonly number[];
}>;

function idList(value: unknown, path: string): OutlineId[] {
    return Array.isArray(value) ? value.map((item, position) => stableId(item, `${path}[${position}]`)) : [];
}

function numberList(value: unknown): number[] {
    return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : [];
}

export function stateOfPlan(plan: OutlineState): JsonRecord {
    return {
        destination: plan.destination, planId: plan.planId, planTitle: plan.planTitle, totalId: plan.totalId,
        volumeIds: [...plan.volumeIds], chapterIds: [...plan.chapterIds], volumesWithBody: [...plan.volumesWithBody],
        totalHadBody: plan.totalHadBody, unmappedChapters: [...plan.unmappedChapters],
    };
}

export function readOutlineState(task: Pick<ExtractionTask, "state">): OutlineState {
    const {state} = task;
    const planId = state.planId;
    if (typeof planId !== "string" || typeof state.totalId !== "string") {
        throw new Error("任务记录缺少提取方案信息（planId），不是有效的大纲提取任务");
    }
    const destination = state.destination;
    return {
        destination: destination === "supplement" || destination === "overwrite" ? destination : "new",
        planId,
        planTitle: typeof state.planTitle === "string" ? state.planTitle : "",
        totalId: stableId(state.totalId, "state.totalId"),
        volumeIds: idList(state.volumeIds, "state.volumeIds"),
        chapterIds: idList(state.chapterIds, "state.chapterIds"),
        volumesWithBody: numberList(state.volumesWithBody),
        totalHadBody: state.totalHadBody === true,
        unmappedChapters: numberList(state.unmappedChapters),
    };
}
