import path from "node:path";
import type {z} from "zod";
import type {ExtractionTask, ExtractionUnit} from "nbook/shared/dto/inspiration-extraction-task.dto";
import type {MaterialParagraphReference} from "nbook/shared/dto/inspiration-material.dto";
import {ExtractionTaskError} from "./errors";
import {
    CHARACTER_SUBNODE_ROLES, ClassificationInputSchema, DocumentDraftSchema, EntityFragmentSchema, EntryFragmentSchema,
    IntegratedFileSchema, MATERIAL_CATEGORY_SPECS, mergeCitations, nameKey, paragraphNumber, readClassifiedGroups, readEntityIndex,
    recordTemplateOfCategory, referenceCovered, referenceLabel, materialCategorySpec, validateExtractedRecord, WritingTechniqueIndexSchema,
    type ClassificationGroup, type EntityIndexEntry, type EntityPreview, type MaterialCategorySpec, type MaterialDraftItem, type MaterialEntry, type MaterialNode,
} from "./material-data";
import {documentRule, documentDraftPath, entityFragmentPath, subnodeFragmentPath} from "./material-extract";
import type {MaterialIntermediate} from "./material-intermediate";
import {NOTE_INDEX_CATEGORIES, executeMaterialNoteIndex} from "./material-note-index";
import {
    MATERIAL_SYSTEM_PROMPT, documentIntegrationGoal, entityIntegrationGoal, parseJsonObject, renderIntegrationPrefix,
} from "./material-prompts";
import type {ExtractionTaskPatch, ExtractionUnitContext, NewExtractionUnit, ValidationResult} from "./types";

/**
 * 全部分块完成后的归类与整合：列出实体文件夹与疑似同一实体的候选，接受人工归类，
 * 再把整合工作拆成单元追加到任务里。整合单元的输入只含对应文件夹（或文档类别）自己的片段。
 */

// ---------------------------------------------------------------------------
// 归类
// ---------------------------------------------------------------------------

export type ClassificationFolder = Readonly<{key: string; name: string; aliases: readonly string[]; blocks: readonly number[]; preview?: EntityPreview}>;
export type ClassificationCategory = Readonly<{category: string; label: string; folders: readonly ClassificationFolder[]}>;
export type SuspectedCandidate = Readonly<{category: string; folders: readonly string[]; reason: string}>;
export type ClassificationView = Readonly<{categories: readonly ClassificationCategory[]; candidates: readonly SuspectedCandidate[]}>;

/**
 * 归类暂停点展示的内容：各类别的实体文件夹，以及按名称／别称重合标出的疑似同一实体。
 * 只做标记，不自动合并——同名异人、通用称呼都会造成误合并，由用户决定。
 */
export function listClassification(task: ExtractionTask): ClassificationView {
    const index = readEntityIndex(task.state);
    const categories: ClassificationCategory[] = [];
    const candidates: SuspectedCandidate[] = [];
    for (const spec of MATERIAL_CATEGORY_SPECS) {
        const entries = Object.entries(index[spec.key] ?? {});
        if (!entries.length) continue;
        categories.push({category: spec.key, label: spec.label, folders: entries.map(([key, entry]) => ({key, name: entry.name, aliases: entry.aliases, blocks: entry.blocks}))});
        candidates.push(...suspectedCandidates(spec.key, entries));
    }
    return {categories, candidates};
}

/** 详情直接读成功片段，包含全部分块，也适用于没有预览状态的历史任务。 */
export async function listClassificationWithDetails(task: ExtractionTask, store: MaterialIntermediate): Promise<ClassificationView> {
    const classification = listClassification(task);
    const categories: ClassificationCategory[] = [];
    for (const category of classification.categories) {
        const folders: ClassificationFolder[] = [];
        for (const folder of category.folders) {
            const fragments: EntityPreview["fragments"][number][] = [];
            for (const block of folder.blocks) {
                const main = await store.readJson(entityFragmentPath(category.category, folder.key, block), EntityFragmentSchema);
                if (main) fragments.push({block, role: "main", fields: main.fields, citations: main.citations});
                if (category.category !== "character") continue;
                for (const role of CHARACTER_SUBNODE_ROLES) {
                    const subnode = await store.readJson(subnodeFragmentPath(folder.key, role, block), EntryFragmentSchema);
                    for (const entry of subnode?.entries ?? []) fragments.push({block, role, fields: entry.fields, citations: entry.citations});
                }
            }
            folders.push({...folder, preview: {fragments}});
        }
        categories.push({...category, folders});
    }
    return {...classification, categories};
}

function suspectedCandidates(category: string, entries: ReadonlyArray<readonly [string, EntityIndexEntry]>): SuspectedCandidate[] {
    // 并查集：共用任意一个名称键的文件夹归为一簇。
    const parent = new Map(entries.map(([key]) => [key, key]));
    const find = (key: string): string => {
        let root = key;
        while (parent.get(root) !== root) root = parent.get(root)!;
        return root;
    };
    const owners = new Map<string, {display: string; folders: string[]}>();
    for (const [folderKey, entry] of entries) {
        for (const label of [entry.name, ...entry.aliases]) {
            const key = nameKey(label);
            if (!key) continue;
            const owner = owners.get(key) ?? {display: label, folders: []};
            if (!owner.folders.includes(folderKey)) owner.folders.push(folderKey);
            owners.set(key, owner);
        }
    }
    const reasons = new Map<string, string[]>();
    for (const owner of owners.values()) {
        if (owner.folders.length < 2) continue;
        for (const folder of owner.folders.slice(1)) parent.set(find(folder), find(owner.folders[0]!));
    }
    for (const owner of owners.values()) {
        if (owner.folders.length < 2) continue;
        const root = find(owner.folders[0]!);
        reasons.set(root, [...(reasons.get(root) ?? []), owner.display]);
    }
    const clusters = new Map<string, string[]>();
    for (const [key] of entries) clusters.set(find(key), [...(clusters.get(find(key)) ?? []), key]);
    return [...clusters.entries()].filter(([, folders]) => folders.length > 1).map(([root, folders]) => ({
        category, folders, reason: `名称或别称重合：${(reasons.get(root) ?? []).join("、")}`,
    }));
}

/** 校验并折算归类输入；非法输入抛 `INVALID_INPUT`，任务保持暂停。 */
export function acceptClassification(task: ExtractionTask, input: unknown): {state: {classified: true; groups: ClassificationGroup[]}} {
    const parsed = ClassificationInputSchema.safeParse(input);
    if (!parsed.success) throw new ExtractionTaskError("INVALID_INPUT", `归类输入格式无效：${parsed.error.issues.map(issue => issue.message).join("；")}`);
    const groups = parsed.data.skip ? [] : parsed.data.groups ?? [];
    const index = readEntityIndex(task.state);
    const used = new Set<string>();
    for (const group of groups) {
        for (const folder of group.folders) {
            const token = `${group.category}/${folder}`;
            if (!index[group.category]?.[folder]) throw new ExtractionTaskError("INVALID_INPUT", `归类引用了不存在的文件夹：${token}`);
            if (used.has(token)) throw new ExtractionTaskError("INVALID_INPUT", `文件夹只能属于一个分组：${token}`);
            used.add(token);
        }
    }
    return {state: {classified: true, groups}};
}

// ---------------------------------------------------------------------------
// 整合单元规划
// ---------------------------------------------------------------------------

export const INTEGRATE_STEP = "integrate";
export const INDEX_STEP = "index";
const INTEGRATE_GROUP = "整合";
const INDEX_GROUP = "整理";

type EntityUnitData = {category: string; folders: string[]};

/** 实体文件夹逐个整合；归类里的分组合并为一个整合单元。素材特点不整合。 */
export function planIntegrationUnits(task: ExtractionTask): NewExtractionUnit[] {
    const index = readEntityIndex(task.state);
    const groups = readClassifiedGroups(task.state);
    const units: NewExtractionUnit[] = [];
    for (const spec of MATERIAL_CATEGORY_SPECS) {
        if (spec.mode === "entity") {
            const folders = Object.keys(index[spec.key] ?? {});
            const grouped = new Set<string>();
            const clusters: string[][] = [];
            for (const group of groups.filter(item => item.category === spec.key)) {
                clusters.push(group.folders);
                for (const folder of group.folders) grouped.add(folder);
            }
            for (const folder of folders) if (!grouped.has(folder)) clusters.push([folder]);
            // 用首个文件夹在索引中的先后顺序排序，使单元顺序稳定。
            clusters.sort((left, right) => folders.indexOf(left[0]!) - folders.indexOf(right[0]!));
            for (const cluster of clusters) {
                const first = index[spec.key]![cluster[0]!]!;
                units.push({
                    id: `${INTEGRATE_STEP}:${spec.key}:${cluster[0]}`, step: INTEGRATE_STEP,
                    label: `整合${spec.label}：${first.name}${cluster.length > 1 ? `等 ${cluster.length} 个` : ""}`,
                    group: INTEGRATE_GROUP, data: {category: spec.key, folders: cluster},
                });
            }
        } else if (spec.mode === "document" && spec.key !== "writing-technique") {
            const hasOutput = task.units.some(unit => unit.step === "extract" && unit.status === "done" && unit.data.category === spec.key);
            if (hasOutput) units.push({id: `${INTEGRATE_STEP}:${spec.key}`, step: INTEGRATE_STEP, label: `整合${spec.label}`, group: INTEGRATE_GROUP, data: {category: spec.key}});
        }
    }
    return units;
}

/** 索引只为独立条目提供检索注释，正文不做跨块整合。 */
export function planIndexUnits(task: ExtractionTask): NewExtractionUnit[] {
    return NOTE_INDEX_CATEGORIES.filter(category => task.units.some(unit => unit.step === "extract" && unit.status === "done" && unit.data.category === category)).map(category => ({
        id: `${INDEX_STEP}:${category}`, step: INDEX_STEP,
        label: `建立${category === "writing-technique" ? "写作手法" : "写作素材"}总索引`, group: INDEX_GROUP, data: {category},
    }));
}

// ---------------------------------------------------------------------------
// 整合执行
// ---------------------------------------------------------------------------

/** 整合产出落盘路径：实体用首个文件夹键，文档类用类别键。 */
export function integratedPath(category: string, name: string): string {
    return `integrated/${category}/${name}.json`;
}

export function writingTechniqueIndexPath(): string {
    return integratedPath("writing-technique", "index");
}

function readUnitData(unit: ExtractionUnit): {category: MaterialCategorySpec; folders: string[]} {
    const category = unit.data.category;
    if (typeof category !== "string") throw new Error(`整合单元 ${unit.id} 缺少类别`);
    const folders = unit.data.folders;
    return {category: materialCategorySpec(category), folders: Array.isArray(folders) ? folders.filter((item): item is string => typeof item === "string") : []};
}

/** 外层范围：一组引用的最小外包范围，作为整合产出校验的上限（再由 `referenceCovered` 收紧到草稿原有范围）。 */
export function boundingRange(references: readonly MaterialParagraphReference[]): MaterialParagraphReference | null {
    if (!references.length) return null;
    const first = Math.min(...references.map(reference => paragraphNumber(reference.firstParagraphId)));
    const last = Math.max(...references.map(reference => paragraphNumber(reference.lastParagraphId)));
    return {firstParagraphId: `P${first}`, lastParagraphId: `P${last}`};
}

/** 把名称与别称补进模板的名称字段；模型已填的字段保持不动。 */
export function fillIdentityFields(spec: MaterialCategorySpec, fields: Record<string, string>, name: string, aliases: readonly string[]): Record<string, string> {
    const result = {...fields};
    const nameField = spec.fields.find(label => label === "角色名称" || label === "名称" || label === "势力名称与别称" || label === "名称与别称");
    const merged = [name, ...aliases].join("、");
    if (nameField && !result[nameField]) result[nameField] = nameField.endsWith("与别称") ? merged : name;
    if (spec.fields.includes("别称") && aliases.length && !result["别称"]) result["别称"] = aliases.join("、");
    return Object.fromEntries(spec.fields.filter(label => result[label]).map(label => [label, result[label]!]));
}

function sortedByBlock<T extends {block: number}>(items: T[]): T[] {
    return items.map((item, position) => ({item, position})).sort((left, right) => left.item.block - right.item.block || left.position - right.position).map(({item}) => item);
}

async function integrateEntity(store: MaterialIntermediate, unit: ExtractionUnit, context: ExtractionUnitContext): Promise<void> {
    const {category: spec, folders} = readUnitData(unit);
    const index = readEntityIndex(context.task.state)[spec.key] ?? {};
    if (!folders.length || folders.some(folder => !index[folder])) throw new Error(`整合单元 ${unit.id} 引用了索引中不存在的文件夹`);

    // 输入只取这些文件夹自己的片段，且按块顺序，不混入其他实体。
    const personas: Array<z.infer<typeof EntityFragmentSchema>> = [];
    const subnodes: Record<typeof CHARACTER_SUBNODE_ROLES[number], Array<{block: number; fields: Record<string, string>; citations: MaterialParagraphReference[]}>> = {experience: [], relationship: []};
    for (const folder of folders) {
        for (const block of index[folder]!.blocks) {
            const fragment = await store.readJson(entityFragmentPath(spec.key, folder, block), EntityFragmentSchema);
            if (fragment) personas.push(fragment);
            if (spec.key !== "character") continue;
            for (const role of CHARACTER_SUBNODE_ROLES) {
                const entries = await store.readJson(subnodeFragmentPath(folder, role, block), EntryFragmentSchema);
                for (const entry of entries?.entries ?? []) subnodes[role].push({block, ...entry});
            }
        }
    }
    const first = index[folders[0]!]!;
    const aliases = [...new Set([...folders.flatMap(folder => [index[folder]!.name, ...index[folder]!.aliases, ...personas.filter(item => nameKey(item.name) === nameKey(index[folder]!.name)).flatMap(item => item.aliases)])].filter(alias => nameKey(alias) !== nameKey(first.name)))];

    const filled = sortedByBlock(personas).filter(fragment => Object.keys(fragment.fields).length > 0);
    let fields: Record<string, string> = {};
    if (filled.length === 1) {
        fields = filled[0]!.fields;
    } else if (filled.length > 1) {
        const range = boundingRange(filled.flatMap(fragment => fragment.citations));
        fields = await context.generate({
            purposeId: `extraction.integrate.${spec.key}`,
            system: MATERIAL_SYSTEM_PROMPT,
            prompt: {
                prefix: renderIntegrationPrefix(`${spec.label}：${first.name}`, filled.map(fragment => ({block: fragment.block, fields: fragment.fields}))),
                goal: entityIntegrationGoal(spec),
            },
            validate: output => validatePersonaOutput(spec, range, output),
        });
    }
    fields = fillIdentityFields(spec, fields, first.name, aliases);

    const personaCitations = mergeCitations(filled.flatMap(fragment => fragment.citations));
    const nodes: MaterialNode[] = [];
    const subnodeCitations = mergeCitations(CHARACTER_SUBNODE_ROLES.flatMap(role => subnodes[role].flatMap(entry => entry.citations)));
    nodes.push({role: "main", entries: [{fields, block: null}], citations: personaCitations.length ? personaCitations : subnodeCitations});
    // 经历与人际关系按块顺序排列，不去重、不合并：同一人物的重复出现各自保留，P 引用随条目保存。
    for (const role of CHARACTER_SUBNODE_ROLES) {
        const entries = sortedByBlock(subnodes[role]);
        if (!entries.length) continue;
        nodes.push({
            role, entries: entries.map((entry): MaterialEntry => ({fields: entry.fields, block: entry.block})),
            citations: mergeCitations(entries.flatMap(entry => entry.citations)),
        });
    }
    const item: MaterialDraftItem = {category: spec.key, title: first.name, aliases, ...(spec.key === "character" ? {stableId: first.stableId} : {}), nodes};
    context.signal.throwIfAborted();
    await store.commit({write: [{path: integratedPath(spec.key, folders[0]!), data: IntegratedFileSchema.parse({items: [item]})}]});
}

function validatePersonaOutput(spec: MaterialCategorySpec, range: MaterialParagraphReference | null, output: string): ValidationResult<Record<string, string>> {
    const parsed = parseJsonObject(output);
    if (!parsed.ok) return parsed;
    const result = validateExtractedRecord(recordTemplateOfCategory(spec), parsed.value.fields ?? {}, {
        range: range ?? {firstParagraphId: "P1", lastParagraphId: "P1"}, citationsOptional: true,
    });
    return result.record ? {ok: true, value: result.record.fields} : {ok: false, error: result.errors.join("\n")};
}

/** 文档类整合允许的最大条数：文风与世界观各一份，写作手法按对象拆分。 */
function integrationLimit(spec: MaterialCategorySpec): number {
    return spec.key === "writing-technique" ? 40 : 1;
}

/** 文风与世界观没有标题字段：用类别加来源文件名命名，多部作品的同类素材不会重名。 */
export function defaultDocumentTitle(spec: MaterialCategorySpec, sourcePath: string): string {
    return `${spec.label}（${path.basename(sourcePath, path.extname(sourcePath))}）`;
}

async function integrateDocument(store: MaterialIntermediate, unit: ExtractionUnit, context: ExtractionUnitContext): Promise<void> {
    const {category: spec} = readUnitData(unit);
    const rule = documentRule(spec);
    const drafts = [];
    for (const name of await store.list(`documents/${spec.key}`)) {
        const block = Number(/^block-(\d+)\.json$/u.exec(name)?.[1]);
        if (!Number.isInteger(block)) continue;
        const draft = await store.readJson(documentDraftPath(spec.key, block), DocumentDraftSchema);
        if (draft) drafts.push(draft);
    }
    const ordered = sortedByBlock(drafts);
    const entries = ordered.flatMap(draft => draft.entries.map(entry => ({block: draft.block, ...entry})));
    const known = mergeCitations(entries.flatMap(entry => entry.citations));
    const target = integratedPath(spec.key, "document");
    if (!entries.length) {
        await store.commit({write: [{path: target, data: IntegratedFileSchema.parse({items: []})}]});
        return;
    }
    const range = boundingRange(known)!;
    // 单条草稿没有可整合的内容，直接沿用，省一次模型调用。
    const results = entries.length === 1
        ? [{title: entries[0]!.title, fields: entries[0]!.fields, citations: entries[0]!.citations}]
        : await context.generate({
            purposeId: `extraction.integrate.${spec.key}`,
            system: MATERIAL_SYSTEM_PROMPT,
            prompt: {
                prefix: renderIntegrationPrefix(spec.label, entries.map(entry => ({block: entry.block, fields: entry.fields}))),
                goal: documentIntegrationGoal(spec, {maxEntries: integrationLimit(spec), titleField: rule.titleField}),
            },
            validate: output => validateIntegratedEntries(spec, integrationLimit(spec), rule.titleField, range, known, output),
        });
    const items: MaterialDraftItem[] = results.map(result => ({
        category: spec.key,
        title: rule.titleField ? result.title : defaultDocumentTitle(spec, context.task.source.path),
        aliases: [],
        nodes: [{role: "main", entries: [{fields: result.fields, block: null}], citations: result.citations.length ? result.citations : known}],
    }));
    context.signal.throwIfAborted();
    await store.commit({write: [{path: target, data: IntegratedFileSchema.parse({items})}]});
}

/** 按块号扫描已成功的草稿，生成稳定索引；重复执行会覆盖同一路径。 */
export async function executeWritingTechniqueIndexUnit(store: MaterialIntermediate, unit: ExtractionUnit, context: ExtractionUnitContext): Promise<void> {
    if (unit.data.category !== "writing-technique") throw new Error(`索引单元 ${unit.id} 的类别无效`);
    const blocks: Array<{
        block: number;
        path: string;
        entries: Array<{title: string; citations: MaterialParagraphReference[]}>;
    }> = [];
    const names = await store.list("documents/writing-technique");
    const candidates = names
        .map(name => ({name, match: /^block-(\d+)\.json$/u.exec(name)}))
        .filter((entry): entry is {name: string; match: RegExpExecArray} => entry.match !== null)
        .sort((left, right) => Number(left.match[1]) - Number(right.match[1]));
    for (const {match} of candidates) {
        context.signal.throwIfAborted();
        const block = Number(match[1]);
        const draft = await store.readJson(documentDraftPath("writing-technique", block), DocumentDraftSchema);
        if (!draft) continue;
        blocks.push({
            block: draft.block,
            path: documentDraftPath("writing-technique", draft.block),
            entries: draft.entries.map(entry => ({title: entry.title, citations: entry.citations})),
        });
    }
    context.signal.throwIfAborted();
    await store.commit({write: [{path: writingTechniqueIndexPath(), data: WritingTechniqueIndexSchema.parse({version: 1, category: "writing-technique", blocks})}]});
    await executeMaterialNoteIndex(store, context.task, "writing-technique", context.generate, context.signal);
}

type IntegratedEntry = {title: string; fields: Record<string, string>; citations: MaterialParagraphReference[]};

function validateIntegratedEntries(spec: MaterialCategorySpec, limit: number, titleField: string | null, range: MaterialParagraphReference, known: readonly MaterialParagraphReference[], output: string): ValidationResult<IntegratedEntry[]> {
    const parsed = parseJsonObject(output);
    if (!parsed.ok) return parsed;
    const list = parsed.value.entries;
    if (!Array.isArray(list) || !list.length) return {ok: false, error: "产出必须包含非空数组字段 entries"};
    if (list.length > limit) return {ok: false, error: `entries 最多 ${limit} 条，实际 ${list.length} 条，请合并`};
    const errors: string[] = [];
    const entries: IntegratedEntry[] = [];
    for (const [position, item] of list.entries()) {
        const label = `第 ${position + 1} 条${spec.label}`;
        if (typeof item !== "object" || item === null || Array.isArray(item)) { errors.push(`${label}必须是对象`); continue; }
        const result = validateExtractedRecord(recordTemplateOfCategory(spec), (item as Record<string, unknown>).fields ?? {}, {range, citationsOptional: spec.referenceField === null});
        if (!result.record) { errors.push(...result.errors.map(error => `${label}：${error}`)); continue; }
        const outside = result.record.citations.filter(reference => !referenceCovered(reference, known));
        if (outside.length) { errors.push(`${label}：参考片段“${outside.map(referenceLabel).join("、")}”不在草稿给出的范围内，整合不能新增引用`); continue; }
        const title = titleField ? result.record.fields[titleField] : "";
        if (titleField && !title) { errors.push(`${label}：“${titleField}”必须填写`); continue; }
        entries.push({title: title ?? "", fields: result.record.fields, citations: result.record.citations});
    }
    return errors.length ? {ok: false, error: errors.join("\n")} : {ok: true, value: entries};
}

export async function executeIntegrateUnit(store: MaterialIntermediate, unit: ExtractionUnit, context: ExtractionUnitContext): Promise<ExtractionTaskPatch | void> {
    const {category} = readUnitData(unit);
    if (category.mode === "entity") await integrateEntity(store, unit, context);
    else await integrateDocument(store, unit, context);
}
