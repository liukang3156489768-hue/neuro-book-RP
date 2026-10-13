import {randomUUID} from "node:crypto";
import {z} from "zod";
import {allEntryReferences, contentHash, pendingReferenceWarnings, serializeEntryMarkdown, type DetailAnalysis, type OutlineId, type OutlineManifest, type PendingReferenceWarning} from "./format";
import type {PlanningSnapshot} from "./index";
import {OutlineGenerationError} from "./direction";
import {OutlineLibraryError, type LibraryChange, prepareDetailAdoption} from "./library";
import {analyzeDetailStructure, blockingDetailProblems} from "nbook/shared/outline-detail-structure";

const ModelReport = z.object({
    summary: z.string().trim().min(1).max(2000),
    deviations: z.array(z.string().trim().min(1).max(1200)).max(30),
    conflicts: z.array(z.string().trim().min(1).max(1200)).max(30),
}).strict();

export type DetailAnalysisRequest = Readonly<{planId: string; entryId: OutlineId; expectedRevision: number;
    expectedVersion: number; expectedContentHash: string}>;
export type DetailResolution = Readonly<{index: number; decision: "resolved" | "ignored"; reason: string}>;
/** warnings 由程序从细纲参考文件派生，不进入模型报告，也不随正式采用持久化。 */
export type IssuedDetailReport = Readonly<{entryId: OutlineId; expectedRevision: number; expectedVersion: number; report: DetailAnalysis;
    warnings: readonly PendingReferenceWarning[]}>;

/**
 * 细纲审阅只依赖上游链：细纲在方案中的挂载、所属章节大纲、卷纲与总纲。
 * 同章其他细纲、其他章节、方案标题与排序不进入审阅，因此它们变化时已审阅细纲保持有效；
 * 若审阅提示改为读取链外条目，这里必须同步扩大，否则报告会在依据变化后仍被当作有效。
 * 返回自细纲起向上的条目 id；挂载链断裂或方案不存在时返回 undefined。
 */
export function detailReviewScope(manifest: OutlineManifest, planId: string, detailId: OutlineId):
    Readonly<{chain: readonly OutlineId[]; hash: string}> | undefined {
    const plan = manifest.plans.find(({id}) => id === planId);
    if (!plan) return undefined;
    const placements = new Map(plan.placements.map((place) => [place.entryId, place]));
    const refs = new Map(manifest.entries.map((ref) => [ref.id, ref]));
    const links: {entryId: OutlineId; parentId: OutlineId | null}[] = [];
    let current = placements.get(detailId);
    while (current && links.length <= plan.placements.length) {
        links.push({entryId: current.entryId, parentId: current.parentId});
        current = current.parentId === null ? undefined : placements.get(current.parentId);
    }
    if (links.length === 0 || links.at(-1)!.parentId !== null) return undefined;
    // 细纲自身内容由报告的 sourceHash 绑定，这里只记录它的挂载位置。
    const ancestors = links.slice(1).map(({entryId}) => refs.get(entryId));
    if (ancestors.some((ref) => ref === undefined)) return undefined;
    return {chain: links.map(({entryId}) => entryId), hash: contentHash(JSON.stringify({planId, links,
        ancestors: ancestors.map((ref) => ({id: ref!.id, version: ref!.version, contentHash: ref!.contentHash}))}))};
}

export function detailAnalysisContext(snapshot: PlanningSnapshot, input: DetailAnalysisRequest): {prompt: string; contextHash: string} {
    const plan = snapshot.manifest.plans.find(({id}) => id === input.planId);
    const detail = snapshot.entries.find(({value}) => value.id === input.entryId);
    const chapter = snapshot.entries.find(({value}) => value.id === detail?.value.chapterId);
    if (!plan || !detail || detail.value.kind !== "detail" || detail.value.status !== "draft" || !chapter
        || chapter.value.kind !== "chapter" || chapter.value.status !== "adopted"
        || detail.value.parentId !== chapter.value.id
        || !plan.placements.some(({entryId, parentId}) => entryId === detail.value.id && parentId === chapter.value.id)
        || snapshot.manifest.plans.filter(({placements}) => placements.some(({entryId}) => entryId === detail.value.id)).length !== 1) {
        throw new OutlineLibraryError("细纲必须在唯一方案中依附正式章节，请先处理共享引用或章节草稿");
    }
    if (snapshot.manifest.revision !== input.expectedRevision || detail.value.version !== input.expectedVersion
        || detail.contentHash !== input.expectedContentHash) {
        throw new OutlineLibraryError("细纲或方案上下文已变化，请重新分析", "CAS_CONFLICT");
    }
    // 正式采用会按当前 schema 重写文件，正文交接再以规范序列化反推草稿 hash；
    // 旧版或手工排版的草稿无法反推，必须先保存为规范格式，否则采用后才在正文侧失效。
    if (contentHash(serializeEntryMarkdown(detail.value)) !== detail.contentHash) {
        throw new OutlineLibraryError("细纲文件不是当前规范格式，请先保存一次再分析");
    }
    // 结构不完整的细纲采用后写作模块无法切分场景，所以分析和确认都在这里阻断，而不是等到写作时才报错。
    const blocking = blockingDetailProblems(analyzeDetailStructure(detail.value, {chapterMarkers: new Map(chapter.markers.map(({marker, action}) => [marker, action]))}));
    if (blocking.length > 0) {
        throw new OutlineLibraryError(`细纲结构不完整：${blocking.map(({message}) => message).join("；")}`);
    }
    const scope = detailReviewScope(snapshot.manifest, plan.id, detail.value.id);
    const entries = new Map(snapshot.entries.map((entry) => [entry.value.id, entry.value]));
    const upstream = scope?.chain.slice(1).map((id) => entries.get(id));
    if (!scope || !upstream || upstream.some((entry) => entry === undefined)) {
        throw new OutlineLibraryError("细纲的上游大纲链不完整，请先修复方案层级");
    }
    if (detail.value.body.length > 16_000 || upstream.some((entry) => entry!.body.length > 16_000)
        || upstream.reduce((size, entry) => size + entry!.body.length, detail.value.body.length) > 60_000) {
        throw new OutlineLibraryError("细纲或上游大纲过长，无法完整分析，请先拆分内容");
    }
    const volume = upstream.find((entry) => entry!.kind === "volume") ?? null;
    const total = upstream.find((entry) => entry!.kind === "total") ?? null;
    const prompt = JSON.stringify({total, volume, chapter: chapter.value, detail: detail.value});
    return {prompt, contextHash: scope.hash};
}

/** 模型只产生审阅报告；正式状态必须从另一个有版本门禁的请求进入。 */
export async function analyzeDetail(
    snapshot: PlanningSnapshot, input: DetailAnalysisRequest, complete: (prompt: string) => Promise<string>,
): Promise<IssuedDetailReport> {
    const {prompt, contextHash} = detailAnalysisContext(snapshot, input);
    let raw: string;
    try {
        raw = await complete(prompt);
    } catch (error) {
        if (error instanceof OutlineGenerationError) throw error;
        throw new OutlineGenerationError("细纲分析失败，请重试", "MODEL_FAILED", error);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new OutlineGenerationError("模型没有返回合法的细纲分析 JSON", "INVALID_RESULT", error);
    }
    const result = ModelReport.safeParse(parsed);
    if (!result.success) throw new OutlineGenerationError("模型报告格式无效，不能正式采用", "INVALID_RESULT", result.error);
    return {entryId: input.entryId, expectedRevision: input.expectedRevision, expectedVersion: input.expectedVersion, report: {
        reportId: randomUUID(), planId: input.planId, sourceHash: input.expectedContentHash, contextHash,
        ...result.data, resolutions: [],
    }, warnings: pendingDetailWarnings(snapshot, input.entryId)};
}

function pendingDetailWarnings(snapshot: PlanningSnapshot, entryId: OutlineId): PendingReferenceWarning[] {
    const detail = snapshot.entries.find(({value}) => value.id === entryId);
    return detail ? pendingReferenceWarnings(detail.value.id, detail.path, allEntryReferences(detail.value)) : [];
}

export function confirmDetail(
    snapshot: PlanningSnapshot, input: DetailAnalysisRequest, issued: IssuedDetailReport, reportId: string,
    confirmDeviations: boolean, resolutions: readonly DetailResolution[],
): LibraryChange {
    const {contextHash} = detailAnalysisContext(snapshot, input);
    if (issued.report.reportId !== reportId || issued.entryId !== input.entryId
        || issued.expectedRevision !== input.expectedRevision || issued.expectedVersion !== input.expectedVersion
        || issued.report.planId !== input.planId
        || issued.report.sourceHash !== input.expectedContentHash || issued.report.contextHash !== contextHash) {
        throw new OutlineLibraryError("细纲分析报告已过期或来源无效，请重新分析", "CAS_CONFLICT");
    }
    if (issued.report.deviations.length > 0 && !confirmDeviations) throw new OutlineLibraryError("请先审阅并确认偏差警告");
    if (resolutions.length !== issued.report.conflicts.length
        || new Set(resolutions.map(({index}) => index)).size !== resolutions.length
        || resolutions.some(({index, decision, reason}) => !Number.isInteger(index) || index < 0
            || index >= issued.report.conflicts.length || (decision !== "resolved" && decision !== "ignored") || !reason.trim())) {
        throw new OutlineLibraryError("存在未处理冲突，请逐项记录处理方式与理由");
    }
    return prepareDetailAdoption(snapshot, input.entryId, input.planId, {
        ...issued.report, resolutions: resolutions.map((resolution) => ({...resolution, reason: resolution.reason.trim()})),
    });
}
