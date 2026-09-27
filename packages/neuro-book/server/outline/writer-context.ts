import {
    contentHash, parseGuidanceAnnotations, pendingReferenceWarnings, serializeEntryMarkdown,
    type OutlineEntry, type OutlineId, type OutlineReference, type PendingReferenceWarning,
} from "./format";
import {detailAnalysisContext} from "./detail-analysis";
import {deriveForeshadowingStates, type ForeshadowingSource} from "./foreshadowing";
import type {PlanningSnapshot} from "./index";
import {type LineAnalysisRequest, readValidFixedLineNodes} from "./line-analysis";
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
    references: readonly OutlineReference[];
    writingGuidance?: string;
    /** 细纲正文中按场景锚定的写作指导；words 是该场景篇幅预算，不要求与 targetWords 求和一致。 */
    guidance: readonly Readonly<{marker: string; scene: string; words?: number; text: string}>[];
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
    action: ForeshadowingSource["action"];
    content: string;
    startOffset: number;
}>;

export type WriterOutlineNode = WriterOutlineEntry & Readonly<{
    nodeId: OutlineId;
    /** 方案图中的格号；同方案不同线路的节点可按它比较先后。 */
    column: number;
    details: readonly WriterOutlineEntry[];
    foreshadowing: readonly WriterForeshadowingSource[];
}>;

function projectEntry(entry: SnapshotEntry): WriterOutlineEntry {
    const {value} = entry;
    return {entryId: value.id, kind: value.kind, title: value.title, body: value.body,
        path: entry.path, version: value.version, contentHash: entry.contentHash,
        materialRefs: value.materialRefs ?? [], references: value.references ?? [],
        ...(value.writingGuidance === undefined ? {} : {writingGuidance: value.writingGuidance}),
        guidance: parseGuidanceAnnotations(value.body, entry.path).map(({marker, scene, words, text}) => ({
            marker, scene, ...(words === undefined ? {} : {words}), text})),
        ...(value.targetWords === undefined ? {} : {targetWords: value.targetWords})};
}

/** 细纲正式报告绑定原草稿及方案快照；无法证明仍有效时，拒绝整份正文上下文。 */
function assertDetailReviewed(snapshot: PlanningSnapshot, detail: SnapshotEntry, planId: string): void {
    const {value, contentHash: currentHash} = detail;
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

/** 只投影经当前规范快照验证的固定节点；正文侧不接收草稿或模型审查报告。 */
export function readWriterOutlineContext(snapshot: PlanningSnapshot, request: LineAnalysisRequest): Readonly<{
    lineId: OutlineId;
    planId: string;
    revision: number;
    version: number;
    contentHash: string;
    nodes: readonly WriterOutlineNode[];
    warnings: readonly WriterOutlineWarning[];
}> {
    const source = snapshot.lines.find(({value}) => value.id === request.lineId);
    if (!source) throw new OutlineLineError("线路不存在");
    if (snapshot.manifest.revision !== request.expectedRevision || source.value.version !== request.expectedVersion
        || source.contentHash !== request.expectedContentHash) {
        throw new OutlineLineError("规划版本已变化，请重新读取", "CAS_CONFLICT");
    }
    const nodes = readValidFixedLineNodes(snapshot, request.lineId);
    const lineNodeIds = new Set(nodes.map(({nodeId}) => nodeId));
    const plan = snapshot.manifest.plans.find(({id}) => id === source.value.planId);
    if (!plan) throw new OutlineLineError("线路所属方案不存在");
    const entries = new Map(snapshot.entries.map((entry) => [entry.value.id, entry]));
    const definitions = new Map(snapshot.foreshadowing.filter(({value}) => value.status === "adopted")
        .map((definition) => [definition.value.id, definition]));
    const foreshadowingByNode = new Map<OutlineId, WriterForeshadowingSource[]>();
    // 伏笔先后按方案格号跨线路判定；正文只接收落在本线路节点上的已生效标记。
    for (const view of deriveForeshadowingStates(snapshot)) {
        const definition = definitions.get(view.id);
        if (!definition) continue;
        for (const source of view.sources) {
            if (!lineNodeIds.has(source.nodeId) || !source.valid) continue;
            const projected: WriterForeshadowingSource = {id: definition.value.id, title: definition.value.title,
                path: definition.path, version: definition.value.version,
                contentHash: definition.contentHash, entryPath: source.entryPath, marker: source.marker,
                action: source.action, content: source.content, startOffset: source.startOffset};
            const current = foreshadowingByNode.get(source.nodeId);
            if (current) current.push(projected);
            else foreshadowingByNode.set(source.nodeId, [projected]);
        }
    }
    for (const sources of foreshadowingByNode.values()) sources.sort((a, b) => a.startOffset - b.startOffset);
    const detailsByChapter = new Map<OutlineId, SnapshotEntry[]>();
    for (const placement of plan.placements) {
        const detail = entries.get(placement.entryId);
        if (!detail || detail.value.kind !== "detail" || detail.value.status !== "adopted") continue;
        const chapterId = detail.value.chapterId;
        if (chapterId === null || chapterId !== placement.parentId) throw new OutlineLineError("细纲章节归属无效");
        const current = detailsByChapter.get(chapterId);
        if (current) current.push(detail);
        else detailsByChapter.set(chapterId, [detail]);
    }
    const projectedNodes = nodes.map((node): WriterOutlineNode => {
        const entry = node.entryId === null ? undefined : entries.get(node.entryId);
        if (!entry || entry.value.status !== "adopted") throw new OutlineLineError("正式大纲条目已失效");
        const details = detailsByChapter.get(entry.value.id) ?? [];
        for (const detail of details) assertDetailReviewed(snapshot, detail, plan.id);
        return {...projectEntry(entry), nodeId: node.nodeId, column: node.column,
            details: details.map(projectEntry), foreshadowing: foreshadowingByNode.get(node.nodeId) ?? []};
    });
    return {lineId: source.value.id, planId: source.value.planId, revision: snapshot.manifest.revision,
        version: source.value.version, contentHash: source.contentHash, nodes: projectedNodes,
        warnings: projectedNodes.flatMap((node) => [node, ...node.details]).flatMap((entry) => pendingReferenceWarnings(entry.entryId, entry.path, entry.references))};
}
