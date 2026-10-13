import {randomUUID} from "node:crypto";
import {z} from "zod";
import type {MaterialParagraphReference} from "nbook/shared/dto/inspiration-material.dto";
import {
    CHARACTER_SUBNODE_ROLES, MaterialDraftItemSchema, MaterialNodeSchema, materialCategorySpec, mergeCitations, nameKey, toFolderName,
    recordTemplateOfCategory, recordTemplateOfSubnode, validateExtractedRecord,
    type MaterialCategorySpec, type MaterialDraftItem, type MaterialEntry, type MaterialNode, type MaterialNodeRole,
} from "./material-data";
import {fillIdentityFields} from "./material-consolidate";
import {documentRule} from "./material-extract";

/**
 * 待写入清单：整合完成后给界面（切片 8）审阅的纯数据，以及对它的编辑／删除／拆分／合并操作。
 * 这里只有纯函数，不读写磁盘也不调用模型；持久化与手动合并的模型调用在 `material-review-service.ts`。
 * 清单不属于任务状态机：任务以完成或部分失败结束，是否已写入记在清单的逐条 `write` 里。
 */

export class MaterialReviewError extends Error {
    constructor(readonly code: "NOT_FOUND" | "INVALID" | "LOCKED", message: string) {
        super(message);
        this.name = "MaterialReviewError";
    }
}

export const REVIEW_WRITE_STATUSES = ["pending", "written", "skipped", "failed"] as const;
export const ReviewWriteSchema = z.object({
    status: z.enum(REVIEW_WRITE_STATUSES),
    error: z.string().nullable(),
    /** 已经写成功的节点，部分失败后再次确认时不会重复写。 */
    writtenRoles: z.array(z.enum(["main", ...CHARACTER_SUBNODE_ROLES, "state"])),
    /** “另存为”之后使用的新名称。 */
    savedAs: z.string().nullable(),
}).strict();
export type ReviewWrite = z.infer<typeof ReviewWriteSchema>;

export const ReviewItemSchema = MaterialDraftItemSchema.extend({
    id: z.string().min(1),
    /** 产生该条目的单元；手动拆分与合并的条目沿用来源条目的单元。 */
    unitId: z.string().min(1),
    selected: z.boolean(),
    /** 写入 `lorebook/<目录>/<directoryName>/`；角色使用 stableId，其余类别由标题得出并在同目录内去重。 */
    directoryName: z.string().min(1),
    write: ReviewWriteSchema,
}).strict();
export type ReviewItem = Omit<z.infer<typeof ReviewItemSchema>, "category"> & {category: MaterialCategorySpec["key"]};

export const MaterialReviewSchema = z.object({
    version: z.literal(1),
    taskId: z.string().uuid(),
    nextId: z.number().int().positive(),
    /** 已转成清单条目的单元；条目被删除后不会因同步而重新出现。 */
    consumedUnitIds: z.array(z.string()),
    items: z.array(ReviewItemSchema),
}).strict();
export type MaterialReview = Omit<z.infer<typeof MaterialReviewSchema>, "items"> & {items: ReviewItem[]};

export function emptyReview(taskId: string): MaterialReview {
    return {version: 1, taskId, nextId: 1, consumedUnitIds: [], items: []};
}

const PENDING_WRITE: ReviewWrite = {status: "pending", error: null, writtenRoles: [], savedAs: null};

function specOf(item: Pick<ReviewItem, "category">): MaterialCategorySpec {
    return materialCategorySpec(item.category);
}

/** 目录名：标题净化后在同一 `lorebook/` 目录的清单条目内去重（不区分大小写，Windows 文件系统不区分）。 */
export function assignDirectoryName(items: readonly ReviewItem[], spec: MaterialCategorySpec, title: string, selfId?: string, stableId?: string): string {
    const source = items.find(item => item.id === selfId);
    if (spec.key === "character" && (source?.stableId || stableId)) return source?.stableId ?? stableId!;
    const base = toFolderName(title) ?? `${spec.key}-素材`;
    const taken = new Set(items.filter(item => item.id !== selfId && specOf(item).directory === spec.directory).map(item => item.directoryName.toLowerCase()));
    let candidate = base;
    for (let suffix = 2; taken.has(candidate.toLowerCase()); suffix += 1) candidate = `${base}-${suffix}`;
    return candidate;
}

/** 把一个单元的整合结果追加进清单；同一单元只转换一次。 */
export function appendReviewItems(review: MaterialReview, unitId: string, drafts: readonly MaterialDraftItem[]): MaterialReview {
    if (review.consumedUnitIds.includes(unitId)) return review;
    const next: MaterialReview = {...review, consumedUnitIds: [...review.consumedUnitIds, unitId], items: [...review.items]};
    for (const draft of drafts) {
        const spec = materialCategorySpec(draft.category);
        next.items.push({
            ...draft, id: `item-${next.nextId}`, unitId, selected: true,
            directoryName: assignDirectoryName(next.items, spec, draft.title, undefined, draft.stableId), write: {...PENDING_WRITE},
        });
        next.nextId += 1;
    }
    return next;
}

function locate(review: MaterialReview, itemId: string): ReviewItem {
    const item = review.items.find(candidate => candidate.id === itemId);
    if (!item) throw new MaterialReviewError("NOT_FOUND", `待写入清单中没有条目 ${itemId}`);
    return item;
}

function requireEditable(item: ReviewItem): void {
    if (item.write.status === "written") throw new MaterialReviewError("LOCKED", `“${item.title}”已经写入 lorebook，不能再在清单里修改`);
}

function replaceItem(review: MaterialReview, itemId: string, replacement: ReviewItem): MaterialReview {
    return {...review, items: review.items.map(item => item.id === itemId ? replacement : item)};
}

export function setItemsSelected(review: MaterialReview, itemIds: readonly string[], selected: boolean): MaterialReview {
    const targets = new Set(itemIds.map(id => locate(review, id).id));
    return {...review, items: review.items.map(item => targets.has(item.id) && item.write.status !== "written" ? {...item, selected} : item)};
}

export function deleteReviewItem(review: MaterialReview, itemId: string): MaterialReview {
    requireEditable(locate(review, itemId));
    return {...review, items: review.items.filter(item => item.id !== itemId)};
}

// ---------------------------------------------------------------------------
// 编辑
// ---------------------------------------------------------------------------

/** 编辑时无法知道来源的段落总数，范围上限放宽；段落是否存在由写入时还原原文再校验。 */
const WIDE_RANGE: MaterialParagraphReference = {firstParagraphId: "P1", lastParagraphId: "P999999999"};

function templateOfRole(spec: MaterialCategorySpec, role: MaterialNodeRole) {
    return role === "main" ? recordTemplateOfCategory(spec) : recordTemplateOfSubnode(role);
}

/**
 * 校验并规范化用户编辑后的节点：字段归属与取值按模板校验；有“参考片段”字段的模板，节点引用由字段重新得出，
 * 其他模板保持原节点引用。一个条目至少要有一个 P 引用，否则无法写出来源标记。
 */
export function normalizeNodes(spec: MaterialCategorySpec, nodes: readonly MaterialNode[]): MaterialNode[] {
    const parsed = z.array(MaterialNodeSchema).safeParse(nodes);
    if (!parsed.success) throw new MaterialReviewError("INVALID", `节点格式无效：${parsed.error.issues.map(issue => issue.message).join("；")}`);
    const roles = parsed.data.map(node => node.role);
    if (new Set(roles).size !== roles.length) throw new MaterialReviewError("INVALID", "同一角色的同一类节点只能有一个");
    if (!roles.includes("main")) throw new MaterialReviewError("INVALID", "条目必须保留主文件节点");
    if (spec.key !== "character" && roles.some(role => role !== "main")) throw new MaterialReviewError("INVALID", `${spec.label}没有经历或人际关系节点`);
    const hasSubnodes = roles.some(role => role !== "main");
    const normalized = parsed.data.map((node): MaterialNode => {
        if (node.role === "main" && node.entries.length !== 1) throw new MaterialReviewError("INVALID", "主文件节点只容纳一条记录");
        const template = templateOfRole(spec, node.role);
        const citations: MaterialParagraphReference[] = [];
        const entries = node.entries.map((entry): MaterialEntry => {
            const result = validateExtractedRecord(template, entry.fields, {
                range: WIDE_RANGE, citationsOptional: true, allowEmptyFields: node.role === "main" && hasSubnodes,
            });
            if (!result.record) throw new MaterialReviewError("INVALID", `${node.role === "main" ? spec.label : template.label}：${result.errors.join("；")}`);
            citations.push(...result.record.citations);
            return {fields: result.record.fields, block: entry.block};
        });
        return {role: node.role, entries, citations: template.referenceField ? mergeCitations(citations) : node.citations};
    });
    if (!mergeCitations(normalized.flatMap(node => node.citations)).length) {
        throw new MaterialReviewError("INVALID", "条目缺少 P 引用：请在“参考片段”字段中保留信息来源的 P 编号");
    }
    return normalized;
}

export type ReviewItemPatch = Readonly<{title?: string; aliases?: readonly string[]; nodes?: readonly MaterialNode[]}>;

export function editReviewItem(review: MaterialReview, itemId: string, patch: ReviewItemPatch): MaterialReview {
    const item = locate(review, itemId);
    requireEditable(item);
    const spec = specOf(item);
    const nodes = patch.nodes ? normalizeNodes(spec, patch.nodes) : item.nodes;
    // 写作手法、素材特点的标题来自模板里的标题字段；只改了字段时标题跟随，避免标题与正文不一致。
    const titleField = documentRule(spec).titleField;
    const fieldTitle = patch.title === undefined && patch.nodes && titleField
        ? nodes.find(node => node.role === "main")?.entries[0]?.fields[titleField]?.trim()
        : undefined;
    const title = patch.title === undefined ? fieldTitle || item.title : patch.title.trim();
    if (!title) throw new MaterialReviewError("INVALID", "标题不能为空");
    const aliases = patch.aliases ? [...new Set(patch.aliases.map(alias => alias.trim()).filter(alias => alias && nameKey(alias) !== nameKey(title)))] : item.aliases;
    return replaceItem(review, itemId, {
        ...item, title, aliases, nodes,
        directoryName: title === item.title || item.category === "character" ? item.directoryName : assignDirectoryName(review.items, spec, title, item.id),
    });
}

// ---------------------------------------------------------------------------
// 拆分
// ---------------------------------------------------------------------------

export type SplitInput = Readonly<{
    title: string;
    aliases?: readonly string[];
    /** 新条目主文件的字段；缺省时只含名称。 */
    mainFields?: Readonly<Record<string, string>>;
    /** 从原条目移走的经历／人际关系记录（按节点内的序号）。 */
    move: ReadonlyArray<Readonly<{role: typeof CHARACTER_SUBNODE_ROLES[number]; entryIndexes: readonly number[]}>>;
}>;

/**
 * 把一个条目里被错误合并的记录拆出去：只有经历与人际关系记录可以移动；原条目始终保留主文件节点。
 * 其余类别的条目只有一个主文件记录，没有可拆分的内容。
 */
export function splitReviewItem(review: MaterialReview, itemId: string, input: SplitInput): MaterialReview {
    const item = locate(review, itemId);
    requireEditable(item);
    const spec = specOf(item);
    const title = input.title.trim();
    if (!title) throw new MaterialReviewError("INVALID", "新条目的标题不能为空");
    if (spec.key !== "character") throw new MaterialReviewError("INVALID", `${spec.label}条目只有一份主文件记录，不能拆分`);

    const moved: MaterialNode[] = [];
    const remaining: MaterialNode[] = [];
    for (const node of item.nodes) {
        const request = node.role === "main" ? undefined : input.move.find(move => move.role === node.role);
        if (!request) { remaining.push(node); continue; }
        const indexes = new Set(request.entryIndexes);
        if ([...indexes].some(index => !Number.isInteger(index) || index < 0 || index >= node.entries.length)) {
            throw new MaterialReviewError("INVALID", `${node.role === "experience" ? "经历" : "人际关系"}的序号超出范围`);
        }
        const taken = node.entries.filter((_, index) => indexes.has(index));
        const kept = node.entries.filter((_, index) => !indexes.has(index));
        if (taken.length) moved.push({role: node.role, entries: taken, citations: referencesOfEntries(node, taken)});
        if (kept.length) remaining.push({...node, entries: kept, citations: referencesOfEntries(node, kept)});
    }
    if (!moved.length) throw new MaterialReviewError("INVALID", "没有选择要移到新条目的记录");

    const aliases = [...new Set((input.aliases ?? []).map(alias => alias.trim()).filter(alias => alias && nameKey(alias) !== nameKey(title)))];
    const mainFields = normalizeNodes(spec, [{
        role: "main", entries: [{fields: fillIdentityFields(spec, {...input.mainFields}, title, aliases), block: null}],
        citations: mergeCitations(moved.flatMap(node => node.citations)),
    }, ...moved])[0]!;
    const stableId = item.category === "character" ? randomUUID() : undefined;
    const created: ReviewItem = {
        category: item.category, title, aliases, ...(stableId ? {stableId} : {}), unitId: item.unitId, id: `item-${review.nextId}`, selected: true,
        directoryName: assignDirectoryName(review.items, spec, title, undefined, stableId),
        nodes: [mainFields, ...moved], write: {...PENDING_WRITE},
    };
    const updated: ReviewItem = {...item, nodes: remaining};
    return {...review, nextId: review.nextId + 1, items: review.items.flatMap(candidate => candidate.id === itemId ? [updated, created] : [candidate])};
}

/** 带“参考片段”字段的节点由字段重新得出引用；否则保留原节点引用。 */
function referencesOfEntries(node: MaterialNode, entries: readonly MaterialEntry[]): MaterialParagraphReference[] {
    const template = templateOfRole(materialCategorySpec("character"), node.role);
    if (!template.referenceField) return node.citations;
    const result = entries.flatMap(entry => validateExtractedRecord(template, entry.fields, {range: WIDE_RANGE, citationsOptional: true}).record?.citations ?? []);
    return mergeCitations(result);
}

// ---------------------------------------------------------------------------
// 手动合并
// ---------------------------------------------------------------------------

/** 合并前的检查：同类别、未写入、至少两条；返回待合并条目（保持清单顺序）。 */
export function selectItemsToMerge(review: MaterialReview, itemIds: readonly string[]): ReviewItem[] {
    const ids = new Set(itemIds);
    if (ids.size < 2) throw new MaterialReviewError("INVALID", "合并至少需要选择两个条目");
    const items = [...ids].map(id => locate(review, id));
    for (const item of items) requireEditable(item);
    if (new Set(items.map(item => item.category)).size !== 1) throw new MaterialReviewError("INVALID", "只能合并同一类别的条目");
    return review.items.filter(item => ids.has(item.id));
}

/**
 * 把模型合并后的基本设定与被合并条目的其余节点装配成一个新条目，放在最靠前的被合并条目的位置。
 * 经历与人际关系按块顺序拼接，不去重；名称取最靠前的条目，其余名称并入别称。
 */
export function applyMerge(review: MaterialReview, items: readonly ReviewItem[], mergedFields: Readonly<Record<string, string>>): MaterialReview {
    const spec = specOf(items[0]!);
    const title = items[0]!.title;
    const aliases = [...new Set(items.flatMap(item => [item.title, ...item.aliases]).filter(alias => nameKey(alias) !== nameKey(title)))];
    const nodes: MaterialNode[] = [{
        role: "main", entries: [{fields: fillIdentityFields(spec, {...mergedFields}, title, aliases), block: null}],
        citations: mergeCitations(items.flatMap(item => item.nodes.flatMap(node => node.citations))),
    }];
    for (const role of CHARACTER_SUBNODE_ROLES) {
        const entries = items.flatMap(item => item.nodes.filter(node => node.role === role).flatMap(node => node.entries));
        if (!entries.length) continue;
        const ordered = entries.map((entry, position) => ({entry, position}))
            .sort((left, right) => (left.entry.block ?? 0) - (right.entry.block ?? 0) || left.position - right.position).map(({entry}) => entry);
        nodes.push({role, entries: ordered, citations: mergeCitations(items.flatMap(item => item.nodes.filter(node => node.role === role).flatMap(node => node.citations)))});
    }
    const normalized = normalizeNodes(spec, nodes);
    const mergedIds = new Set(items.map(item => item.id));
    const stableId = items[0]!.category === "character" ? (items[0]!.stableId ?? randomUUID()) : undefined;
    const created: ReviewItem = {
        category: items[0]!.category, title, aliases, ...(stableId ? {stableId} : {}), unitId: items[0]!.unitId, id: `item-${review.nextId}`, selected: true,
        directoryName: assignDirectoryName(review.items.filter(item => !mergedIds.has(item.id)), spec, title, undefined, stableId),
        nodes: normalized, write: {...PENDING_WRITE},
    };
    let placed = false;
    const result = review.items.flatMap(item => {
        if (!mergedIds.has(item.id)) return [item];
        if (placed) return [];
        placed = true;
        return [created];
    });
    return {...review, nextId: review.nextId + 1, items: result};
}
