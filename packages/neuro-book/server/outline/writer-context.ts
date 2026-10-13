import {
    allEntryReferences, contentHash, pendingReferenceWarnings, serializeEntryMarkdown,
    type ForeshadowAction, type OutlineEntry, type OutlineId, type OutlineReference, type PendingReferenceWarning,
} from "./format";
import {detailAnalysisContext} from "./detail-analysis";
import type {PlanningSnapshot} from "./index";
import {OutlineLineError} from "./line-planning";

type SnapshotEntry = PlanningSnapshot["entries"][number];

export type WriterOutlineEntry = Readonly<{
    entryId: OutlineId;
    kind: OutlineEntry["kind"];
    title: string;
    body: string;
    path: string;
    version: number;
    contentHash: string;
    materialRefs: readonly string[];
    /** 章节大纲取 frontmatter；细纲取正文各场景的参考资料，没有链接的项是待补资料。 */
    references: readonly OutlineReference[];
    writingGuidance?: string;
    targetWords?: number;
}>;

/** “待补”资料不阻止交接，但正文 Agent 必须看到缺口，不能自行补写相关知识。 */
export type WriterOutlineWarning = PendingReferenceWarning;

/** 正文只需本章标记处要呈现的文本；伏笔定义正文含背后关联和回收计划，交给正文会提前泄露后续剧情。 */
export type WriterForeshadowingSource = Readonly<{
    id: OutlineId;
    title: string;
    path: string;
    version: number;
    contentHash: string;
    entryPath: string;
    marker: string;
    action: ForeshadowAction;
    content: string;
    startOffset: number;
}>;

function projectEntry(entry: SnapshotEntry): WriterOutlineEntry {
    const {value} = entry;
    return {entryId: value.id, kind: value.kind, title: value.title, body: value.body,
        path: entry.path, version: value.version, contentHash: entry.contentHash,
        materialRefs: value.materialRefs ?? [], references: allEntryReferences(value),
        ...(value.writingGuidance === undefined ? {} : {writingGuidance: value.writingGuidance}),
        ...(value.targetWords === undefined ? {} : {targetWords: value.targetWords})};
}

/** 细纲正式报告绑定原草稿及方案快照；无法证明仍有效时，拒绝整份正文上下文。 */
function assertDetailReviewed(snapshot: PlanningSnapshot, detail: SnapshotEntry, planId: string): void {
    const {value, contentHash: currentHash} = detail;
    // 来源提取细纲的依据是 basis 中的原文引用（格式层已保证它是带引用的正式细纲），免分析报告。
    if (value.basis) return;
    const report = value.analysis;
    if (!report || report.planId !== planId || value.version < 1) {
        throw new OutlineLineError("正式细纲缺少有效分析报告，不能用于正文");
    }
    const draft: OutlineEntry = {...value, version: value.version - 1, status: "draft", analysis: undefined};
    const draftHash = contentHash(serializeEntryMarkdown(draft));
    if (report.sourceHash !== draftHash || contentHash(serializeEntryMarkdown(value)) !== currentHash) {
        throw new OutlineLineError("正式细纲的来源已变化，不能用于正文");
    }
    const original: PlanningSnapshot = {...snapshot,
        entries: snapshot.entries.map((entry) => entry === detail ? {...entry, value: draft, contentHash: draftHash} : entry),
        manifest: {...snapshot.manifest, entries: snapshot.manifest.entries.map((ref) => ref.id === value.id
            ? {...ref, version: draft.version, contentHash: draftHash} : ref)}};
    try {
        const {contextHash} = detailAnalysisContext(original, {planId, entryId: value.id,
            expectedRevision: original.manifest.revision, expectedVersion: draft.version, expectedContentHash: draftHash});
        if (contextHash !== report.contextHash) throw new OutlineLineError("细纲审阅上下文已过期，不能用于正文");
    } catch (error) {
        if (error instanceof OutlineLineError) throw error;
        throw new OutlineLineError("细纲审阅上下文无效，不能用于正文");
    }
}

/** 章节不可写的原因；message 指出具体条目，供作者定位。 */
export type WriterChapterBlock = Readonly<{code: "OUTLINE_NOT_ADOPTED" | "DETAIL_NOT_REVIEWED"; message: string}>;

export type WriterVolumeRef = Readonly<{entryId: OutlineId; title: string}>;

export type WriterDetailRef = Readonly<{entryId: OutlineId; title: string; status: OutlineEntry["status"];
    version: number; contentHash: string}>;

export type WriterChapterSummary = Readonly<{
    entryId: OutlineId;
    title: string;
    status: OutlineEntry["status"];
    version: number;
    contentHash: string;
    volume: WriterVolumeRef | null;
    details: readonly WriterDetailRef[];
    writable: boolean;
    block?: WriterChapterBlock;
}>;

/** 正文写作依据的版本；调用方保存它，下次读取时用于判断规划是否已变化。 */
export type WriterChapterBasis = Readonly<{
    chapterVersion: number;
    chapterContentHash: string;
    details: readonly Readonly<{entryId: OutlineId; version: number; contentHash: string}>[];
}>;

export type WriterChapterContextRequest = Readonly<{planId: string; chapterEntryId: OutlineId; expectedBasis?: WriterChapterBasis}>;

export type WriterChapterContext = Readonly<{
    planId: string;
    revision: number;
    basis: WriterChapterBasis;
    /** 仅在请求附带 expectedBasis 时出现；为 true 时调用方不得静默沿用旧依据。 */
    basisChanged?: boolean;
    volume: WriterVolumeRef | null;
    chapter: WriterOutlineEntry;
    details: readonly WriterOutlineEntry[];
    foreshadowing: readonly WriterForeshadowingSource[];
    warnings: readonly WriterOutlineWarning[];
}>;

type Plan = PlanningSnapshot["manifest"]["plans"][number];
type PlanChapter = Readonly<{chapter: SnapshotEntry; volume: SnapshotEntry | null; details: readonly SnapshotEntry[]}>;

function requirePlan(snapshot: PlanningSnapshot, planId: string): Plan {
    const plan = snapshot.manifest.plans.find(({id}) => id === planId);
    if (!plan) throw new OutlineLineError("写作方案不存在");
    return plan;
}

/**
 * 章节顺序只取大纲库层级：卷纲按方案顺序、卷内章节按方案顺序，直属总纲的章节排在最后。
 * 线路图的格号不参与排序，线路规划只供作者梳理剧情。
 */
function collectPlanChapters(snapshot: PlanningSnapshot, plan: Plan): readonly PlanChapter[] {
    const entries = new Map(snapshot.entries.map((entry) => [entry.value.id, entry]));
    const children = new Map<OutlineId, SnapshotEntry[]>();
    for (const placement of [...plan.placements].sort((a, b) => a.position - b.position)) {
        if (placement.parentId === null) continue;
        const entry = entries.get(placement.entryId);
        // 严格快照已保证方案引用的条目存在；缺失说明读取了损坏快照，不能静默跳过章节。
        if (!entry) throw new OutlineLineError(`方案引用的条目不存在：${placement.entryId}`);
        const siblings = children.get(placement.parentId) ?? [];
        siblings.push(entry);
        children.set(placement.parentId, siblings);
    }
    const chapterOf = (chapter: SnapshotEntry, volume: SnapshotEntry | null): PlanChapter => ({chapter, volume,
        details: (children.get(chapter.value.id) ?? []).filter(({value}) => value.kind === "detail")});
    const volumed: PlanChapter[] = [];
    const unvolumed: PlanChapter[] = [];
    for (const child of children.get(plan.totalId) ?? []) {
        if (child.value.kind === "chapter") unvolumed.push(chapterOf(child, null));
        if (child.value.kind !== "volume") continue;
        for (const chapter of children.get(child.value.id) ?? []) {
            if (chapter.value.kind === "chapter") volumed.push(chapterOf(chapter, child));
        }
    }
    return [...volumed, ...unvolumed];
}

function chapterBlock(snapshot: PlanningSnapshot, plan: Plan, {chapter, details}: PlanChapter): WriterChapterBlock | undefined {
    if (chapter.value.status !== "adopted") return {code: "OUTLINE_NOT_ADOPTED", message: "章节大纲未采用"};
    if (details.length === 0) return {code: "DETAIL_NOT_REVIEWED", message: "本章还没有细纲"};
    for (const detail of details) {
        const label = `细纲「${detail.value.title}」`;
        if (detail.value.status !== "adopted") return {code: "DETAIL_NOT_REVIEWED", message: `${label}未审阅`};
        if (detail.value.chapterId !== chapter.value.id) return {code: "DETAIL_NOT_REVIEWED", message: `${label}章节归属无效`};
        try {
            assertDetailReviewed(snapshot, detail, plan.id);
        } catch (error) {
            if (!(error instanceof OutlineLineError)) throw error;
            return {code: "DETAIL_NOT_REVIEWED", message: `${label}：${error.message}`};
        }
    }
    return undefined;
}

const volumeRef = (volume: SnapshotEntry | null): WriterVolumeRef | null =>
    volume === null ? null : {entryId: volume.value.id, title: volume.value.title};

/** 章节目录不因单章不可写而失败；每章自带资格，供写作界面置灰并说明原因。 */
export function readWriterChapterDirectory(snapshot: PlanningSnapshot, request: Readonly<{planId: string}>): Readonly<{
    planId: string;
    revision: number;
    chapters: readonly WriterChapterSummary[];
}> {
    const plan = requirePlan(snapshot, request.planId);
    const chapters = collectPlanChapters(snapshot, plan).map((item): WriterChapterSummary => {
        const block = chapterBlock(snapshot, plan, item);
        const {chapter} = item;
        return {entryId: chapter.value.id, title: chapter.value.title, status: chapter.value.status,
            version: chapter.value.version, contentHash: chapter.contentHash, volume: volumeRef(item.volume),
            details: item.details.map(({value, contentHash: hash}) => ({entryId: value.id, title: value.title,
                status: value.status, version: value.version, contentHash: hash})),
            writable: block === undefined, ...(block === undefined ? {} : {block})};
    });
    return {planId: plan.id, revision: snapshot.manifest.revision, chapters};
}

export function sameWriterChapterBasis(left: WriterChapterBasis, right: WriterChapterBasis): boolean {
    return left.chapterVersion === right.chapterVersion && left.chapterContentHash === right.chapterContentHash
        && left.details.length === right.details.length
        && left.details.every((detail, index) => {
            const other = right.details[index]!;
            return detail.entryId === other.entryId && detail.version === other.version && detail.contentHash === other.contentHash;
        });
}

/** 只返回可写章节的正式上下文；不可写时拒绝，不降级读取草稿。 */
export function readWriterChapterContext(snapshot: PlanningSnapshot, request: WriterChapterContextRequest): WriterChapterContext {
    const plan = requirePlan(snapshot, request.planId);
    const item = collectPlanChapters(snapshot, plan).find(({chapter}) => chapter.value.id === request.chapterEntryId);
    if (!item) throw new OutlineLineError("章节大纲不在该写作方案中");
    const block = chapterBlock(snapshot, plan, item);
    if (block) throw new OutlineLineError(`章节不可写：${block.message}`);
    const {chapter, details} = item;
    const definitions = new Map(snapshot.foreshadowing.filter(({value}) => value.status === "adopted")
        .map((definition) => [definition.value.id, definition]));
    // 标记取自章节大纲本身，只保留已确认伏笔；先埋后收不按线路判定，由作者在规划阶段负责。
    const foreshadowing = [...chapter.markers].sort((a, b) => a.startOffset - b.startOffset).flatMap((marker): WriterForeshadowingSource[] => {
        const definition = definitions.get(marker.foreshadowId);
        return definition ? [{id: definition.value.id, title: definition.value.title, path: definition.path,
            version: definition.value.version, contentHash: definition.contentHash, entryPath: chapter.path,
            marker: marker.marker, action: marker.action, content: marker.content, startOffset: marker.startOffset}] : [];
    });
    const basis: WriterChapterBasis = {chapterVersion: chapter.value.version, chapterContentHash: chapter.contentHash,
        details: details.map(({value, contentHash: hash}) => ({entryId: value.id, version: value.version, contentHash: hash}))};
    const projectedChapter = projectEntry(chapter);
    const projectedDetails = details.map(projectEntry);
    return {planId: plan.id, revision: snapshot.manifest.revision, basis,
        ...(request.expectedBasis === undefined ? {} : {basisChanged: !sameWriterChapterBasis(request.expectedBasis, basis)}),
        volume: volumeRef(item.volume), chapter: projectedChapter, details: projectedDetails, foreshadowing,
        warnings: [projectedChapter, ...projectedDetails].flatMap((entry) => pendingReferenceWarnings(entry.entryId, entry.path, entry.references))};
}
