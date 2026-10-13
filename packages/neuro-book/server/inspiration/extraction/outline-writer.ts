import type {OutlineComparisonItem} from "nbook/shared/dto/inspiration-outline-extraction.dto";
import type {JsonRecord} from "nbook/shared/dto/inspiration-extraction-task.dto";
import {stableId, type OutlineEntry, type OutlineId, type OutlineReference} from "nbook/server/outline/format";
import {detailsOfChapter, entryOf, hasBody, readPlanLayout, type OutlinePlanningPort} from "./outline-planning";

/**
 * 把提取产出写入大纲库。所有写入经 `OutlinePlanningPort`（大纲领域操作），写入的条目直接是正式条目。
 * 每个函数都对“同一单元重复执行”幂等：取消或中断后单元会被整体重做，不能产生重复条目。
 */

/** 章节大纲依据的原文引用在 `references` 里的用途标注。 */
export const EXTRACTION_REFERENCE_PURPOSE = "提取依据";

export type StoredCandidate = Readonly<{title: string; body: string; locator: string}>;

export const DETAIL_SEPARATOR = "\n\n---\n\n";

export function candidateOf(value: unknown): StoredCandidate | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const {title, body, locator} = value as Record<string, unknown>;
    return typeof title === "string" && typeof body === "string" && typeof locator === "string" ? {title, body, locator} : null;
}

export function candidateRecord(candidate: StoredCandidate): JsonRecord {
    return {title: candidate.title, body: candidate.body, locator: candidate.locator};
}

export type OutlineWriter = Readonly<{port: OutlinePlanningPort; planId: string}>;

/** 本章是否已有细纲（任何来源）。有则细纲单元不再生成，补充模式也不改动它。 */
export async function chapterDetails(port: OutlinePlanningPort, planId: string, chapterId: OutlineId): Promise<readonly OutlineEntry[]> {
    const layout = readPlanLayout(await port.snapshot(), planId);
    if (!layout) throw new Error("提取方案已不存在");
    return detailsOfChapter(layout, chapterId);
}

export async function createChapterDetail(writer: OutlineWriter, input: Readonly<{chapterId: OutlineId; title: string; body: string; sourcePath: string; locator: string}>): Promise<OutlineId> {
    const existing = await chapterDetails(writer.port, writer.planId, input.chapterId);
    const reused = existing.find(detail => detail.body === input.body);
    if (reused) return reused.id;
    return writer.port.createDetail({
        planId: writer.planId, chapterId: input.chapterId, title: input.title, body: input.body,
        // 同一路径只能登记一条引用，多段范围合并进同一个定位串。
        sources: [{path: input.sourcePath, locator: input.locator}],
    });
}

function mergedReferences(existing: readonly OutlineReference[] | undefined, reference: OutlineReference): OutlineReference[] {
    return [...(existing ?? []).filter(item => item.path !== reference.path), reference];
}

/**
 * 把正文写入条目并正式采用。领域上编辑会把条目退回草稿，采用是第二步，所以两步之间的中断会留下
 * “有正文的草稿”；单元重做时条目已有正文就只补上采用这一步，不再调用模型也不改正文。
 * 调用方只对提取开始时为空的条目调用本函数，因此已有的正文必然是本流水线上次写下的。
 */
export async function fillEntryBody(writer: OutlineWriter, input: Readonly<{
    entryId: OutlineId;
    body: string;
    reference?: Readonly<{path: string; locator: string}>;
}>): Promise<void> {
    const source = entryOf(await writer.port.snapshot(), input.entryId);
    if (!source) throw new Error("条目已不存在");
    if (!hasBody(source.value)) {
        await replaceBody(writer, source.value, source.contentHash, input.body, input.reference);
        return;
    }
    if (source.value.status === "adopted") return;
    await writer.port.apply({kind: "adopt-entry", planId: writer.planId, entryId: input.entryId, expectedVersion: source.value.version, expectedContentHash: source.contentHash});
}

/** 用新正文替换已有正文并正式采用（重新汇总卷纲与总纲）。 */
export async function replaceEntryBody(writer: OutlineWriter, entryId: OutlineId, body: string): Promise<void> {
    const source = entryOf(await writer.port.snapshot(), entryId);
    if (!source) throw new Error("条目已不存在");
    if (source.value.status === "adopted" && source.value.body.trim() === body.trim()) return;
    await replaceBody(writer, source.value, source.contentHash, body, undefined);
}

async function replaceBody(writer: OutlineWriter, entry: OutlineEntry, contentHash: string, body: string, reference: Readonly<{path: string; locator: string}> | undefined): Promise<void> {
    const edited = await writer.port.apply({
        kind: "edit-entry", planId: writer.planId, entryId: entry.id, expectedVersion: entry.version, expectedContentHash: contentHash,
        title: entry.title, body,
        ...(reference ? {references: mergedReferences(entry.references, {path: reference.path, locator: reference.locator, purpose: EXTRACTION_REFERENCE_PURPOSE})} : {}),
    });
    const next = entryOf(await writer.port.snapshot(), edited.entryId ?? entry.id);
    if (!next) throw new Error("条目写入后读取失败");
    await writer.port.apply({kind: "adopt-entry", planId: writer.planId, entryId: next.value.id, expectedVersion: next.value.version, expectedContentHash: next.contentHash});
}

/** 覆盖前读取章节现有内容，生成对比条目（不写入）。 */
export async function readChapterOldState(port: OutlinePlanningPort, planId: string, chapterId: OutlineId): Promise<Readonly<{
    detail: Pick<OutlineComparisonItem, "oldText" | "oldEntries">;
    outline: Pick<OutlineComparisonItem, "oldText" | "oldEntries">;
}>> {
    const snapshot = await port.snapshot();
    const layout = readPlanLayout(snapshot, planId);
    const chapter = entryOf(snapshot, chapterId);
    if (!layout || !chapter) throw new Error("章节条目已不存在，无法对比");
    const details = layout.childrenOf(chapterId).filter(({value}) => value.kind === "detail");
    return {
        detail: {
            oldText: details.length === 0 ? null : details.map(({value}) => value.body).join(DETAIL_SEPARATOR),
            oldEntries: details.map(({value, contentHash}) => ({id: value.id, version: value.version, contentHash})),
        },
        outline: {
            oldText: hasBody(chapter.value) ? chapter.value.body : null,
            oldEntries: [{id: chapter.value.id, version: chapter.value.version, contentHash: chapter.contentHash}],
        },
    };
}

/** 覆盖失败的统一说明：点名失败项；`reason` 自己说明原内容是否保留。 */
export class OverwriteItemError extends Error {
    constructor(label: string, reason: string, options?: ErrorOptions) {
        super(`${label}覆盖失败：${reason}`, options);
        this.name = "OverwriteItemError";
    }
}

/**
 * 覆盖章节大纲：只在条目仍是对比时的版本时写入；已经等于新正文且为正式条目则视为上次已完成。
 */
export async function overwriteChapterOutline(writer: OutlineWriter, input: Readonly<{
    label: string; item: OutlineComparisonItem; candidate: StoredCandidate; sourcePath: string;
}>): Promise<void> {
    const recorded = input.item.oldEntries[0];
    if (!recorded) throw new OverwriteItemError(input.label, "对比记录缺少原条目，原内容已保留");
    const source = entryOf(await writer.port.snapshot(), stableId(recorded.id, "oldEntries"));
    if (!source) throw new OverwriteItemError(input.label, "原条目已不存在，无法覆盖");
    if (source.value.status === "adopted" && source.value.body === input.candidate.body) return;
    // 以对比时记录的正文为准而不是内容哈希：写入失败后“恢复原内容”会让版本号前进，哈希随之变化，
    // 但正文没变，重试仍应允许；用户在对比之后改过正文才拒绝。
    if (source.value.body.trim() !== (input.item.oldText ?? "").trim()) throw new OverwriteItemError(input.label, "原条目在对比之后被修改，原内容已保留；请重新提取后再确认");
    try {
        await replaceBody(writer, source.value, source.contentHash, input.candidate.body, {path: input.sourcePath, locator: input.candidate.locator});
    } catch (error) {
        const restored = await restoreOutline(writer, source.value).then(() => true, () => false);
        throw new OverwriteItemError(input.label, `${error instanceof Error ? error.message : String(error)}（${restored ? "原内容已保留" : "恢复原内容也失败，条目可能停留在草稿，请在大纲库检查"}）`, {cause: error});
    }
}

/** 编辑已提交但采用失败时，把条目恢复成覆盖前的正文与状态；条目没有被改动时什么都不做。 */
async function restoreOutline(writer: OutlineWriter, original: OutlineEntry): Promise<void> {
    const current = entryOf(await writer.port.snapshot(), original.id);
    if (!current || (current.value.body === original.body && current.value.status === original.status)) return;
    const edited = await writer.port.apply({
        kind: "edit-entry", planId: writer.planId, entryId: original.id, expectedVersion: current.value.version, expectedContentHash: current.contentHash,
        title: original.title, body: original.body, references: original.references === undefined ? null : [...original.references],
    });
    if (original.status !== "adopted") return;
    const next = entryOf(await writer.port.snapshot(), edited.entryId ?? original.id)!;
    await writer.port.apply({kind: "adopt-entry", planId: writer.planId, entryId: original.id, expectedVersion: next.value.version, expectedContentHash: next.contentHash});
}

/**
 * 覆盖细纲：先建新细纲，再删旧细纲，任何一步失败都不会让章节没有细纲。
 * 编辑细纲会清除来源依据，所以覆盖不原地改正文，而是新建一份来源提取细纲替换旧的。
 */
export async function overwriteChapterDetail(writer: OutlineWriter, input: Readonly<{
    label: string; item: OutlineComparisonItem; candidate: StoredCandidate; chapterId: OutlineId; sourcePath: string;
}>): Promise<void> {
    const current = await chapterDetails(writer.port, writer.planId, input.chapterId);
    const snapshot = await writer.port.snapshot();
    const recorded = new Map(input.item.oldEntries.map(entry => [entry.id, entry] as const));
    for (const detail of current) {
        const known = recorded.get(detail.id);
        if (known && entryOf(snapshot, detail.id)?.contentHash !== known.contentHash) {
            throw new OverwriteItemError(input.label, "原细纲在对比之后被修改，原内容已保留；请重新提取后再确认");
        }
    }
    const alreadyNew = current.find(detail => !recorded.has(detail.id) && detail.body === input.candidate.body);
    let newId: OutlineId;
    try {
        newId = alreadyNew?.id ?? await writer.port.createDetail({
            planId: writer.planId, chapterId: input.chapterId, title: input.candidate.title, body: input.candidate.body,
            sources: [{path: input.sourcePath, locator: input.candidate.locator}],
        });
    } catch (error) {
        throw new OverwriteItemError(input.label, `${error instanceof Error ? error.message : String(error)}（原细纲已保留）`, {cause: error});
    }
    let removed = 0;
    for (const old of current.filter(detail => recorded.has(detail.id))) {
        try {
            await writer.port.removeEntry(old.id);
            removed += 1;
        } catch (error) {
            // 一份旧细纲都没删成时撤销新建的，章节保持原样；已删掉一部分时只能保留新细纲并如实说明。
            if (removed === 0 && !alreadyNew) await writer.port.removeEntry(newId).catch(() => undefined);
            const state = removed === 0 && !alreadyNew ? "原细纲已保留" : "部分旧细纲已删除，新细纲已保留";
            throw new OverwriteItemError(input.label, `${error instanceof Error ? error.message : String(error)}（${state}）`, {cause: error});
        }
    }
}
