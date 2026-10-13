import type {
    WritingChapterDto, WritingChapterIssuesDto, WritingChapterStatus, WritingIssuesDto, WritingOverviewDto, WritingRunSummaryDto,
    WritingUnlinkedReason,
} from "nbook/shared/dto/writing.dto";

/**
 * 大纲视图的纯投影：把服务端给出的章节目录、问题与运行摘要整理成界面需要的形状。
 * 章节是否可写、状态是什么只取服务端结果，这里不按版本、哈希或条目状态自行判定。
 */

export type WritingTone = "neutral" | "success" | "warning" | "danger" | "muted";

export type WritingVolumeGroup = Readonly<{
    /** 树节点的稳定键：卷纲 id，未分卷固定为 `unvolumed`。 */
    key: string;
    entryId: string | null;
    title: string;
    chapters: readonly WritingChapterDto[];
}>;

export const UNVOLUMED_KEY = "unvolumed";

const STATUS_LABELS: Record<WritingChapterStatus, string> = {
    "outline-not-adopted": "大纲未采用",
    "detail-not-reviewed": "细纲未审阅",
    "ownership-conflict": "归属冲突",
    unwritten: "未写",
    written: "已写",
    "source-stale": "依据已过期",
};

const STATUS_TONES: Record<WritingChapterStatus, WritingTone> = {
    "outline-not-adopted": "muted",
    "detail-not-reviewed": "muted",
    "ownership-conflict": "danger",
    unwritten: "neutral",
    written: "success",
    "source-stale": "warning",
};

const BLOCK_LABELS = {OUTLINE_NOT_ADOPTED: "大纲未采用", DETAIL_NOT_REVIEWED: "细纲未审阅"} as const;

const UNLINKED_LABELS: Record<WritingUnlinkedReason, string> = {
    "no-link": "未关联章节",
    "invalid-link": "关联信息有误",
    "not-in-plan": "所属章节不在当前写作方案中",
    "plan-unavailable": "写作方案不可用",
};

/** 按章节在方案中的顺序分组；卷的顺序取它第一章出现的位置，没有上级卷纲的章节并入“未分卷”。 */
export function groupChaptersByVolume(chapters: readonly WritingChapterDto[]): WritingVolumeGroup[] {
    const groups = new Map<string, {key: string; entryId: string | null; title: string; chapters: WritingChapterDto[]}>();
    for (const chapter of chapters) {
        const key = chapter.volume?.entryId ?? UNVOLUMED_KEY;
        let group = groups.get(key);
        if (!group) {
            group = {key, entryId: chapter.volume?.entryId ?? null, title: chapter.volume?.title ?? "未分卷", chapters: []};
            groups.set(key, group);
        }
        group.chapters.push(chapter);
    }
    return [...groups.values()];
}

export function chapterStatusLabel(status: WritingChapterStatus): string {
    return STATUS_LABELS[status];
}

export function chapterStatusTone(status: WritingChapterStatus): WritingTone {
    return STATUS_TONES[status];
}

/** 不可写的原因；归属冲突同时有规划阻断时两条都列出。可写章节为空。 */
export function chapterBlockReasons(chapter: WritingChapterDto): string[] {
    if (chapter.writable) return [];
    const reasons = chapter.status === "ownership-conflict" ? [STATUS_LABELS["ownership-conflict"]] : [];
    if (chapter.block) reasons.push(BLOCK_LABELS[chapter.block.code]);
    if (reasons.length === 0) reasons.push(STATUS_LABELS[chapter.status]);
    return reasons;
}

export function unlinkedReasonLabel(reason: WritingUnlinkedReason): string {
    return UNLINKED_LABELS[reason];
}

export function issuesByChapter(issues: WritingIssuesDto | null): Map<string, WritingChapterIssuesDto> {
    return new Map((issues?.chapters ?? []).map((chapter) => [chapter.chapterEntryId, chapter]));
}

/** 徽标只看未处理与待复核的计数；两者都为 0 时不显示。 */
export function issueBadge(issues: WritingChapterIssuesDto | undefined): Readonly<{severity: "blocking" | "hint"; count: number}> | null {
    if (!issues) return null;
    if (issues.blocking > 0) return {severity: "blocking", count: issues.blocking + issues.hint};
    if (issues.hint > 0) return {severity: "hint", count: issues.hint};
    return null;
}

/** 选中的条目或正文所属的章节；卷纲不属于任何一章。 */
export function chapterOfSelection(overview: WritingOverviewDto | null, selection: WritingSelection | null): WritingChapterDto | null {
    if (!overview || !selection) return null;
    if (selection.kind === "prose") return overview.chapters.find((chapter) => chapter.prose.some(({path}) => path === selection.path)) ?? null;
    if (selection.kind === "empty-prose") return overview.chapters.find((chapter) => chapter.entryId === selection.chapterEntryId) ?? null;
    if (selection.kind === "unlinked") return null;
    return overview.chapters.find((chapter) => chapter.entryId === selection.entryId
        || chapter.details.some((detail) => detail.entryId === selection.entryId)) ?? null;
}

export function chapterOfProsePath(overview: WritingOverviewDto | null, path: string): WritingChapterDto | null {
    return overview?.chapters.find((chapter) => chapter.prose.some((prose) => prose.path === path)) ?? null;
}

/**
 * 左栏的选中项。条目与正文分开：正文在项目编辑器里打开，条目在中间只读显示。
 * - `entry`：卷纲、章节大纲或细纲；
 * - `prose`：已有正文文件（含未关联正文）；
 * - `empty-prose`：章节还没有正文；
 * - `unlinked`：未关联正文分组里的文件，打开方式同正文。
 */
export type WritingSelection =
    | Readonly<{kind: "entry"; entryId: string}>
    | Readonly<{kind: "prose"; path: string}>
    | Readonly<{kind: "empty-prose"; chapterEntryId: string}>
    | Readonly<{kind: "unlinked"; path: string}>;

export function selectionKey(selection: WritingSelection | null): string | null {
    if (!selection) return null;
    if (selection.kind === "entry") return `entry:${selection.entryId}`;
    if (selection.kind === "empty-prose") return `empty:${selection.chapterEntryId}`;
    return `${selection.kind}:${selection.path}`;
}

/**
 * 正文编辑器需要只读的章节：运行在服务进程中执行，或正等待确认。
 * 记录为运行中但进程已退出的运行（interrupted）不会再写正文，不锁定。
 */
export function lockedChapterIds(runs: readonly WritingRunSummaryDto[]): Set<string> {
    return new Set(runs.filter((run) => run.status === "waiting" || (run.status === "running" && !run.interrupted))
        .map((run) => run.chapterEntryId));
}

/** 预填到写作会话输入框的改写请求；修改要求留给用户补写。 */
export function rewriteRequestText(selectedText: string): string {
    const quoted = selectedText.trim().split(/\r?\n/u).map((line) => (line.trim() === "" ? ">" : `> ${line}`)).join("\n");
    return `改写选中内容：\n${quoted}\n\n修改要求：`;
}
