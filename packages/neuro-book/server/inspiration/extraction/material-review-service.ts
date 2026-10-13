import type {ExtractionTask} from "nbook/shared/dto/inspiration-extraction-task.dto";
import type {WorkspaceFileTarget} from "nbook/server/workspace-files/workspace-file-target";
import {ExtractionTaskError} from "./errors";
import {
    IntegratedFileSchema, materialCategorySpec, mergeCitations, recordTemplateOfCategory, referenceCovered, referenceLabel, validateExtractedRecord,
    type MaterialDraftItem,
} from "./material-data";
import {INTEGRATE_STEP, boundingRange, integratedPath} from "./material-consolidate";
import {createMaterialIntermediate, type MaterialIntermediate} from "./material-intermediate";
import {MaterialNoteIndexSchema, NOTE_INDEX_CATEGORIES, generateMaterialNoteIndex, isNoteIndexCategory, materialNoteIndexPath, noteIndexKey, readNoteDrafts, type MaterialNoteIndex} from "./material-note-index";
import {createSourceVerifier} from "./source-guard";
import {MATERIAL_SYSTEM_PROMPT, mergeItemsGoal, mergeItemsPrefix, parseJsonObject} from "./material-prompts";
import {
    MaterialReviewError, MaterialReviewSchema, appendReviewItems, applyMerge, deleteReviewItem, editReviewItem, emptyReview, selectItemsToMerge,
    setItemsSelected, splitReviewItem,
    type MaterialReview, type ReviewItem, type ReviewItemPatch, type SplitInput,
} from "./material-review";
import {writeReviewItems, previewConflicts, type ConflictComparison, type ConflictDecision, type Confirmer, type WriteReport} from "./material-write";
import {callWithRepair} from "./repair";
import type {ExtractionModelPort, ValidationResult} from "./types";

/**
 * 待写入清单的服务：把已完成的整合结果同步成清单，持久化在任务目录的 `review.json`，
 * 并承接界面的编辑、拆分、合并、确认写入。
 *
 * 清单不属于任务状态机（状态集合里没有“审阅中”）：任务整合完成即结束，审阅与写入是任务之后的独立阶段。
 * 同一任务的所有操作串行执行，避免界面连点时交错读写 `review.json`。
 */

const REVIEW_FILE = "review.json";

export interface ReviewTaskSource {
    get(taskId: string): Promise<ExtractionTask>;
}

export type MaterialReviewServiceOptions = Readonly<{
    target: WorkspaceFileTarget;
    tasks: ReviewTaskSource;
    /** 手动合并调用的模型；与提取任务共用同一个端口（思考关闭由适配器固定）。 */
    model: ExtractionModelPort;
}>;

async function readReview(store: MaterialIntermediate, taskId: string): Promise<MaterialReview> {
    // 落盘前已由 schema 与各操作校验；类别键在 schema 里已确认属于素材类别。
    return (await store.readJson(REVIEW_FILE, MaterialReviewSchema) as MaterialReview | null) ?? emptyReview(taskId);
}

/** 整合完成的单元 -> 清单草稿。素材特点不整合：每个提取出的条目就是一个待写入条目。 */
async function collectDrafts(store: MaterialIntermediate, task: ExtractionTask, consumed: ReadonlySet<string>): Promise<Array<{unitId: string; drafts: MaterialDraftItem[]}>> {
    const collected: Array<{unitId: string; drafts: MaterialDraftItem[]}> = [];
    const hasLegacyTechnique = consumed.has("integrate:writing-technique") || task.units.some(unit => unit.id === "integrate:writing-technique" && unit.status === "done");
    for (const unit of task.units) {
        if (unit.status !== "done" || consumed.has(unit.id)) continue;
        if (unit.step === INTEGRATE_STEP) {
            const category = String(unit.data.category);
            const folders = Array.isArray(unit.data.folders) ? unit.data.folders : [];
            const name = materialCategorySpec(category).mode === "entity" ? String(folders[0]) : "document";
            const file = await store.readJson(integratedPath(category, name), IntegratedFileSchema);
            // 产出缺失说明整合单元被重试时中间产物被清理，不能当作“没有条目”而消耗掉这个单元。
            if (file) collected.push({unitId: unit.id, drafts: file.items as MaterialDraftItem[]});
        } else if (unit.step === "extract" && isNoteIndexCategory(String(unit.data.category))) {
            // 已经形成旧整合清单的任务保持其审阅结果，不能再同步分块草稿制造重复条目。
            if (unit.data.category === "writing-technique" && hasLegacyTechnique) continue;
            const drafts = await readNoteDrafts(store, unit);
            if (drafts) collected.push({unitId: unit.id, drafts});
        }
    }
    return collected;
}

function validateMergedFields(items: readonly ReviewItem[], output: string): ValidationResult<Record<string, string>> {
    const spec = materialCategorySpec(items[0]!.category);
    const parsed = parseJsonObject(output);
    if (!parsed.ok) return parsed;
    const known = mergeCitations(items.flatMap(item => item.nodes.flatMap(node => node.citations)));
    const range = boundingRange(known);
    if (!range) return {ok: false, error: "待合并条目没有 P 引用"};
    const result = validateExtractedRecord(recordTemplateOfCategory(spec), parsed.value.fields ?? {}, {range, citationsOptional: spec.referenceField === null});
    if (!result.record) return {ok: false, error: result.errors.join("\n")};
    const outside = result.record.citations.filter(reference => !referenceCovered(reference, known));
    if (outside.length) return {ok: false, error: `参考片段“${outside.map(referenceLabel).join("、")}”不在待合并条目给出的范围内，合并不能新增引用`};
    return {ok: true, value: result.record.fields};
}

export class MaterialReviewService {
    private readonly queues = new Map<string, Promise<unknown>>();

    constructor(private readonly options: MaterialReviewServiceOptions) {}

    /** 同一任务的操作排队执行；前一个失败不影响后一个。 */
    private serialize<T>(taskId: string, action: () => Promise<T>): Promise<T> {
        const previous = this.queues.get(taskId) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(action);
        this.queues.set(taskId, next);
        void next.finally(() => { if (this.queues.get(taskId) === next) this.queues.delete(taskId); }).catch(() => undefined);
        return next;
    }

    private async loadTask(taskId: string): Promise<ExtractionTask> {
        const task = await this.options.tasks.get(taskId);
        if (task.kind !== "material") throw new ExtractionTaskError("INVALID_STATE", "只有素材提取任务有待写入清单");
        return task;
    }

    /** 读取清单并补入新完成的单元；有变化时落盘。 */
    private async synced(taskId: string, store: MaterialIntermediate): Promise<{review: MaterialReview; task: ExtractionTask}> {
        const task = await this.loadTask(taskId);
        const original = await readReview(store, taskId);
        let review = original;
        for (const {unitId, drafts} of await collectDrafts(store, task, new Set(original.consumedUnitIds))) {
            review = appendReviewItems(review, unitId, drafts);
        }
        if (review !== original) await store.commit({write: [{path: REVIEW_FILE, data: review}]});
        return {review, task};
    }

    private async mutate(taskId: string, change: (review: MaterialReview, task: ExtractionTask) => Promise<MaterialReview> | MaterialReview): Promise<MaterialReview> {
        return this.serialize(taskId, async () => {
            const store = createMaterialIntermediate(this.options.target, taskId);
            const {review, task} = await this.synced(taskId, store);
            const next = await change(review, task);
            if (next !== review) await store.commit({write: [{path: REVIEW_FILE, data: MaterialReviewSchema.parse(next)}]});
            return next;
        });
    }

    get(taskId: string): Promise<MaterialReview> {
        return this.serialize(taskId, async () => (await this.synced(taskId, createMaterialIntermediate(this.options.target, taskId))).review);
    }

    setSelected(taskId: string, itemIds: readonly string[], selected: boolean): Promise<MaterialReview> {
        return this.mutate(taskId, review => setItemsSelected(review, itemIds, selected));
    }

    update(taskId: string, itemId: string, patch: ReviewItemPatch): Promise<MaterialReview> {
        return this.mutate(taskId, review => editReviewItem(review, itemId, patch));
    }

    remove(taskId: string, itemId: string): Promise<MaterialReview> {
        return this.mutate(taskId, review => deleteReviewItem(review, itemId));
    }

    split(taskId: string, itemId: string, input: SplitInput): Promise<MaterialReview> {
        return this.mutate(taskId, review => splitReviewItem(review, itemId, input));
    }

    /** 手动合并：基本设定由一次模型调用合并，经历与关系由代码按块顺序拼接。 */
    merge(taskId: string, itemIds: readonly string[], signal: AbortSignal): Promise<MaterialReview> {
        return this.mutate(taskId, async (review, task) => {
            const items = selectItemsToMerge(review, itemIds);
            const spec = materialCategorySpec(items[0]!.category);
            const fields = await callWithRepair({
                purposeId: `extraction.merge.${spec.key}`, promptSnapshotId: task.promptSnapshotId,
                model: this.options.model, signal, system: MATERIAL_SYSTEM_PROMPT, modelKey: task.modelKey ?? undefined,
                prompt: {prefix: mergeItemsPrefix(spec, items), goal: mergeItemsGoal(spec)},
                validate: output => validateMergedFields(items, output),
            });
            return applyMerge(review, items, fields);
        });
    }

    /** 勾选条目里与现有内容冲突的节点及对照数据；不写入。 */
    conflicts(taskId: string, confirmer: Confirmer): Promise<ConflictComparison[]> {
        return this.serialize(taskId, async () => {
            const {review, task} = await this.synced(taskId, createMaterialIntermediate(this.options.target, taskId));
            return previewConflicts({target: this.options.target, review, source: task.source, confirmer});
        });
    }

    /** 确认写入。台账在批量写入结束后一次落盘；中途中断时已写文件因内容相同在下次确认被识别，不会重复写。 */
    confirmWrite(taskId: string, input: Readonly<{confirmer: Confirmer; decisions?: readonly ConflictDecision[]; signal?: AbortSignal}>): Promise<WriteReport> {
        return this.serialize(taskId, async () => {
            const store = createMaterialIntermediate(this.options.target, taskId);
            const {review, task} = await this.synced(taskId, store);
            // 旧任务也可直接确认写入；编辑后的正文需要新摘要，选择与目录改名只改变最终投影。
            const indexes: MaterialNoteIndex[] = [];
            const timeout = AbortSignal.timeout(10 * 60 * 1000);
            const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
            const verifySource = createSourceVerifier(this.options.target.root);
            for (const category of NOTE_INDEX_CATEGORIES) {
                const items = review.items.filter(item => item.category === category && (item.selected || item.write.status === "written"));
                if (!items.length) continue;
                const cached = await store.readJson(materialNoteIndexPath(category), MaterialNoteIndexSchema);
                const index = await generateMaterialNoteIndex({category, items, cached, signal, generate: request => callWithRepair({
                    ...request, model: this.options.model, signal, modelKey: task.modelKey ?? undefined,
                    promptSnapshotId: task.promptSnapshotId,
                    beforeCall: () => verifySource(task.source),
                })});
                await store.commit({write: [{path: materialNoteIndexPath(category), data: index}]});
                indexes.push(index);
            }
            const report = await writeReviewItems({target: this.options.target, review, source: task.source, confirmer: input.confirmer, decisions: input.decisions, indexes});
            if (report.review !== review) await store.commit({write: [{path: REVIEW_FILE, data: MaterialReviewSchema.parse(report.review)}]});
            // 另存为仅改名称；给同一正文的新身份沿用注释，避免下次确认重新调用模型。
            const originals = new Map(review.items.map(item => [item.id, item]));
            for (const index of indexes) {
                const annotations = new Map(index.entries.map(entry => [entry.key, entry]));
                let renamed = false;
                for (const item of report.review.items) {
                    if (item.category !== index.category || item.write.status !== "written") continue;
                    const original = originals.get(item.id);
                    const key = noteIndexKey(item);
                    const annotation = original ? annotations.get(noteIndexKey(original)) : undefined;
                    if (annotation && !annotations.has(key)) { annotations.set(key, {...annotation, key}); renamed = true; }
                }
                if (renamed) await store.commit({write: [{path: materialNoteIndexPath(index.category), data: {...index, entries: [...annotations.values()]}}]});
            }
            return report;
        });
    }
}

export {MaterialReviewError};
