import {randomUUID} from "node:crypto";
import {z} from "zod";
import {contentHash, pendingReferenceWarnings, serializeEntryMarkdown, type DetailAnalysis, type OutlineId, type PendingReferenceWarning} from "./format";
import type {PlanningSnapshot} from "./index";
import {OutlineGenerationError} from "./direction";
import {OutlineLibraryError, type LibraryChange, prepareDetailAdoption} from "./library";

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
    if (detail.value.body.length > 16000 || chapter.value.body.length > 16000) {
        throw new OutlineLibraryError("细纲或章节正文过长，无法完整分析，请先拆分内容");
    }
    // 报告只依赖本方案的关系和规范条目；全局 revision 仍单独用于提交 CAS，不能让无关方案撤回报告。
    const refs = new Map(snapshot.manifest.entries.map((ref) => [ref.id, ref]));
    const contextHash = contentHash(JSON.stringify({plan, entries: plan.placements.map(({entryId}) => refs.get(entryId))}));
    const entries = new Map(snapshot.entries.map((entry) => [entry.value.id, entry.value]));
    const planEntries = plan.placements.map((place) => ({parentId: place.parentId,
        entry: entries.get(place.entryId)}));
    if (planEntries.some(({entry}) => !entry || entry.body.length > 16_000)
        || planEntries.reduce((size, {entry}) => size + (entry?.body.length ?? 0), 0) > 60_000) {
        throw new OutlineLibraryError("方案上下文过长，无法完整分析，请先拆分内容");
    }
    const prompt = JSON.stringify({plan: {title: plan.title, entries: planEntries}, chapter: chapter.value, detail: detail.value});
    return {prompt, contextHash};
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
    return detail ? pendingReferenceWarnings(detail.value.id, detail.path, detail.value.references) : [];
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
