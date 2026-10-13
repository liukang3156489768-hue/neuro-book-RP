import {z} from "zod";
import {
    MATERIAL_CATEGORIES, MATERIAL_TEMPLATES, MaterialParagraphReferenceSchema,
    type MaterialCategoryKey, type MaterialParagraphReference, type MaterialProcessingMode, type MaterialTemplateKind,
} from "nbook/shared/dto/inspiration-material.dto";
import {INSPIRATION_TEMPLATE_FIELDS, type InspirationCategory} from "nbook/shared/dto/inspiration.dto";
import {parseParagraphReferences, validateMaterialTemplateFields} from "../material-template";

/**
 * 素材提取流水线的共用数据：类别规格、中间产物与审阅清单的落盘形态、命名规则、引用工具。
 * 其他素材模块都只依赖这里，不互相依赖落盘形态。
 */

// ---------------------------------------------------------------------------
// 类别规格
// ---------------------------------------------------------------------------

export type MaterialCategorySpec = Readonly<{
    key: MaterialCategoryKey;
    label: string;
    mode: MaterialProcessingMode;
    directory: string;
    allowsPlotDevelopment: boolean;
    /** 本类条目的模板字段，顺序即渲染顺序。 */
    fields: readonly string[];
    /** t06 新增模板的种类；沿用原创设计模板的类别为 null。 */
    templateKind: MaterialTemplateKind | null;
    /** 取值为 P 编号引用的字段；模板没有该字段时为 null。 */
    referenceField: string | null;
}>;

function buildSpec(category: typeof MATERIAL_CATEGORIES[number]): MaterialCategorySpec {
    const templateKind: MaterialTemplateKind | null = category.key === "writing-technique" || category.key === "material-feature" ? category.key : null;
    const fields: readonly string[] = templateKind
        ? MATERIAL_TEMPLATES[templateKind].fields
        : INSPIRATION_TEMPLATE_FIELDS[category.key as InspirationCategory];
    const referenceField = templateKind ? MATERIAL_TEMPLATES[templateKind].referenceField : fields.includes("参考片段") ? "参考片段" : null;
    return {...category, fields, templateKind, referenceField};
}

export const MATERIAL_CATEGORY_SPECS: readonly MaterialCategorySpec[] = MATERIAL_CATEGORIES.map(buildSpec);
const SPEC_BY_KEY = new Map(MATERIAL_CATEGORY_SPECS.map(spec => [spec.key, spec]));

export function materialCategorySpec(key: string): MaterialCategorySpec {
    const spec = SPEC_BY_KEY.get(key as MaterialCategoryKey);
    if (!spec) throw new Error(`未知的素材类别：${key}`);
    return spec;
}

export function isMaterialCategoryKey(key: string): key is MaterialCategoryKey {
    return SPEC_BY_KEY.has(key as MaterialCategoryKey);
}

/** 角色在主文件之外另有两个子节点；两者的模板由 t06 定义。 */
export const CHARACTER_SUBNODE_ROLES = ["experience", "relationship"] as const;
export type MaterialNodeRole = "main" | typeof CHARACTER_SUBNODE_ROLES[number];
export const SUBNODE_TEMPLATE_KIND = {
    experience: "character-experience",
    relationship: "character-relationship",
} as const satisfies Record<typeof CHARACTER_SUBNODE_ROLES[number], MaterialTemplateKind>;

// ---------------------------------------------------------------------------
// 命名
// ---------------------------------------------------------------------------

/** 实体文件夹与 `lorebook/` 目录共用的名称长度上限。 */
export const MATERIAL_NAME_MAX_CHARACTERS = 60;
const FORBIDDEN_NAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f\u007f]/gu;
const RESERVED_WINDOWS_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

/**
 * 把实体名或标题转成可作文件夹名的形式；无法得到合法名称时返回 null。
 * 名称要同时作为中间产物文件夹与 `lorebook/` 目录名，所以按 Windows 的限制取并集。
 */
export function toFolderName(name: string): string | null {
    let result = name.normalize("NFC").replace(FORBIDDEN_NAME_CHARACTERS, "_").replace(/\s+/gu, " ").trim();
    result = Array.from(result).slice(0, MATERIAL_NAME_MAX_CHARACTERS).join("").replace(/[. ]+$/u, "");
    if (!result || /^\.+$/u.test(result) || RESERVED_WINDOWS_NAMES.test(result)) return null;
    return result;
}

/** 名称比较的归一化：忽略大小写、全半角与首尾空白。 */
export function nameKey(name: string): string {
    return name.normalize("NFKC").trim().toLowerCase();
}

export function blockFileName(block: number): string {
    return `block-${String(block).padStart(3, "0")}.json`;
}

// ---------------------------------------------------------------------------
// P 引用工具
// ---------------------------------------------------------------------------

export function paragraphNumber(id: string): number {
    return Number(id.slice(1));
}

export function referenceLabel(reference: MaterialParagraphReference): string {
    return reference.firstParagraphId === reference.lastParagraphId ? reference.firstParagraphId : `${reference.firstParagraphId}-${reference.lastParagraphId}`;
}

/** frontmatter `citations` 的条数上限（见 `MaterialExtractionSourceSchema`）。 */
const CITATIONS_MAX = 500;

/**
 * 合并引用：排序后合并重叠或相邻的范围（覆盖的段落不变），超过 frontmatter 上限时保留靠前的部分。
 * 上限几乎只会被极大的实体触发，截断只丢来源标记的末端，不影响正文。
 */
export function mergeCitations(references: readonly MaterialParagraphReference[]): MaterialParagraphReference[] {
    const sorted = references
        .map(reference => [paragraphNumber(reference.firstParagraphId), paragraphNumber(reference.lastParagraphId)] as const)
        .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    const merged: Array<[number, number]> = [];
    for (const [first, last] of sorted) {
        const tail = merged[merged.length - 1];
        if (tail && first <= tail[1] + 1) tail[1] = Math.max(tail[1], last);
        else merged.push([first, last]);
    }
    return merged.slice(0, CITATIONS_MAX).map(([first, last]) => ({firstParagraphId: `P${first}`, lastParagraphId: `P${last}`}));
}

export function referenceWithin(reference: MaterialParagraphReference, range: MaterialParagraphReference): boolean {
    return paragraphNumber(reference.firstParagraphId) >= paragraphNumber(range.firstParagraphId)
        && paragraphNumber(reference.lastParagraphId) <= paragraphNumber(range.lastParagraphId);
}

/** 引用是否被任一已知范围完整覆盖；用于整合产出只能引用输入片段已有的范围。 */
export function referenceCovered(reference: MaterialParagraphReference, known: readonly MaterialParagraphReference[]): boolean {
    return known.some(range => referenceWithin(reference, range));
}

// ---------------------------------------------------------------------------
// 记录校验
// ---------------------------------------------------------------------------

export type ValidatedRecord = Readonly<{fields: Record<string, string>; citations: MaterialParagraphReference[]}>;

/** 条目字段的模板描述：t06 的新模板或原创设计模板。 */
export type RecordTemplate = Readonly<
    | {kind: MaterialTemplateKind; label: string; fields: readonly string[]; referenceField: string}
    | {kind: null; label: string; fields: readonly string[]; referenceField: string | null}
>;

export function recordTemplateOfCategory(spec: MaterialCategorySpec): RecordTemplate {
    return spec.templateKind
        ? {kind: spec.templateKind, label: spec.label, fields: spec.fields, referenceField: MATERIAL_TEMPLATES[spec.templateKind].referenceField}
        : {kind: null, label: spec.label, fields: spec.fields, referenceField: spec.referenceField};
}

export function recordTemplateOfSubnode(role: typeof CHARACTER_SUBNODE_ROLES[number]): RecordTemplate {
    const kind = SUBNODE_TEMPLATE_KIND[role];
    const template = MATERIAL_TEMPLATES[kind];
    return {kind, label: template.label, fields: template.fields, referenceField: template.referenceField};
}

/** 原创设计模板的字段校验；规则与 t06 的新模板一致（字段归属、文本值、至少一个非空字段）。 */
function validateStandardFields(template: RecordTemplate, rawFields: Readonly<Record<string, unknown>>): {errors: string[]; fields: Record<string, string>} {
    const errors: string[] = [];
    const given = new Map<string, string>();
    for (const [label, value] of Object.entries(rawFields)) {
        if (!template.fields.includes(label)) {
            errors.push(`字段“${label}”不属于模板“${template.label}”，该模板的字段为：${template.fields.join("、")}`);
        } else if (typeof value !== "string") {
            errors.push(`字段“${label}”的值必须是文本`);
        } else if (value.trim()) {
            given.set(label, value.trim());
        }
    }
    return {errors, fields: Object.fromEntries(template.fields.filter(label => given.has(label)).map(label => [label, given.get(label)!]))};
}

export type RecordValidationOptions = Readonly<{
    /** 引用必须落在其中：提取时是本块范围，整合时是整份来源范围。 */
    range: MaterialParagraphReference;
    /** 顶层 `references` 的原始值，模板没有参考片段字段或该字段为空时用它作为引用来源。 */
    rawReferences?: unknown;
    /** 允许没有任何非空字段，此时不要求引用（角色主文件只在本块有经历或关系时可为空）。 */
    allowEmptyFields?: boolean;
    /** 整合产出不重新给出引用（由输入片段的引用并集代替）。 */
    citationsOptional?: boolean;
}>;

function checkRange(references: readonly MaterialParagraphReference[], range: MaterialParagraphReference): string[] {
    return references.filter(reference => !referenceWithin(reference, range))
        .map(reference => `参考片段“${referenceLabel(reference)}”超出本块范围 ${referenceLabel(range)}`);
}

/**
 * 校验一条模型产出的记录并得出 P 引用（用于来源标记）。
 * 字段校验委托 t06 的 `validateMaterialTemplateFields`（新模板）或同规则的原创设计模板校验；
 * 引用来源是模板的“参考片段”字段，缺失时回退到顶层 `references`；非空记录至少要有一个 P 引用，
 * 且全部落在范围内。
 */
export function validateExtractedRecord(template: RecordTemplate, rawFields: unknown, options: RecordValidationOptions): {errors: string[]; record: ValidatedRecord | null} {
    if (typeof rawFields !== "object" || rawFields === null || Array.isArray(rawFields)) {
        return {errors: [`“${template.label}”的 fields 必须是对象`], record: null};
    }
    const errors: string[] = [];
    let fields: Record<string, string>;
    let citations: MaterialParagraphReference[] = [];
    const record = rawFields as Record<string, unknown>;
    const emptyAllowed = options.allowEmptyFields && Object.values(record).every(value => typeof value === "string" && !value.trim());
    if (template.kind) {
        const result = validateMaterialTemplateFields(template.kind, record, {range: options.range});
        errors.push(...result.errors);
        fields = result.fields;
        citations = result.references;
    } else {
        const result = validateStandardFields(template, record);
        errors.push(...result.errors);
        fields = result.fields;
        if (!errors.length && !Object.keys(fields).length && !emptyAllowed) errors.push(`模板“${template.label}”没有任何非空字段，请至少填写一个字段`);
        const fieldText = template.referenceField ? fields[template.referenceField] : undefined;
        if (fieldText !== undefined) {
            const parsed = parseParagraphReferences(fieldText);
            errors.push(...parsed.errors, ...checkRange(parsed.references, options.range));
            citations = parsed.references.filter(reference => referenceWithin(reference, options.range));
        }
    }
    if (!citations.length && options.rawReferences !== undefined && options.rawReferences !== null && options.rawReferences !== "") {
        if (typeof options.rawReferences !== "string") {
            errors.push("references 必须是文本，例如 “P12 P15-P18”");
        } else {
            const parsed = parseParagraphReferences(options.rawReferences);
            errors.push(...parsed.errors, ...checkRange(parsed.references, options.range));
            citations = parsed.references.filter(reference => referenceWithin(reference, options.range));
        }
    }
    if (!errors.length && !options.citationsOptional && !citations.length && !emptyAllowed) {
        errors.push(`“${template.label}”缺少 P 引用：请在“${template.referenceField ?? "references"}”或 references 中给出信息来源的 P 编号，例如 P12 或 P12-P15`);
    }
    return {errors, record: errors.length ? null : {fields, citations: mergeCitations(citations)}};
}

// ---------------------------------------------------------------------------
// 中间产物与审阅清单的落盘形态
// ---------------------------------------------------------------------------

const FieldsSchema = z.record(z.string(), z.string());
const CitationsSchema = z.array(MaterialParagraphReferenceSchema);

/** 实体文件夹内一个分块的提取片段：`entities/<类别>/<文件夹>/block-NNN.json`。 */
export const EntityFragmentSchema = z.object({
    block: z.number().int().positive(),
    name: z.string().min(1),
    aliases: z.array(z.string()),
    fields: FieldsSchema,
    citations: CitationsSchema,
}).strict();
export type EntityFragment = z.infer<typeof EntityFragmentSchema>;

/** 角色经历／人际关系一个分块的记录：`entities/character/<文件夹>/{experience,relationship}/block-NNN.json`。 */
export const EntryFragmentSchema = z.object({
    block: z.number().int().positive(),
    entries: z.array(z.object({fields: FieldsSchema, citations: CitationsSchema}).strict()),
}).strict();
export type EntryFragment = z.infer<typeof EntryFragmentSchema>;

/** 文档型一个分块的分析稿：`documents/<类别>/block-NNN.json`。 */
export const DocumentDraftSchema = z.object({
    block: z.number().int().positive(),
    entries: z.array(z.object({title: z.string().min(1), fields: FieldsSchema, citations: CitationsSchema}).strict()),
}).strict();
export type DocumentDraft = z.infer<typeof DocumentDraftSchema>;

/** 写作手法的确定性总索引：正文仍保存在各块草稿，索引只记录定位与来源。 */
export const WritingTechniqueIndexSchema = z.object({
    version: z.literal(1),
    category: z.literal("writing-technique"),
    blocks: z.array(z.object({
        block: z.number().int().positive(),
        path: z.string().min(1),
        entries: z.array(z.object({
            title: z.string().min(1),
            citations: CitationsSchema,
        }).strict()),
    }).strict()),
}).strict();
export type WritingTechniqueIndex = z.infer<typeof WritingTechniqueIndexSchema>;

/** 素材特点的一条：`features/block-NNN-<序号>.json`。 */
export const FeatureFileSchema = z.object({
    block: z.number().int().positive(),
    index: z.number().int().positive(),
    title: z.string().min(1),
    fields: FieldsSchema,
    citations: CitationsSchema,
}).strict();
export type FeatureFile = z.infer<typeof FeatureFileSchema>;

export const MaterialEntrySchema = z.object({fields: FieldsSchema, block: z.number().int().positive().nullable()}).strict();
export type MaterialEntry = z.infer<typeof MaterialEntrySchema>;

export const MaterialNodeSchema = z.object({
    role: z.enum(["main", ...CHARACTER_SUBNODE_ROLES]),
    entries: z.array(MaterialEntrySchema).min(1),
    citations: CitationsSchema,
}).strict();
export type MaterialNode = z.infer<typeof MaterialNodeSchema>;

/** 整合结果（也是审阅条目的内容部分）：一个待写入的 `lorebook/` 条目，可含多个节点。 */
export const MaterialDraftItemSchema = z.object({
    category: z.string().refine(isMaterialCategoryKey, "未知的素材类别"),
    title: z.string().min(1),
    aliases: z.array(z.string()),
    /** 角色目录的稳定身份；显示名或别名变化时保持不变。 */
    stableId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u).optional(),
    nodes: z.array(MaterialNodeSchema).min(1),
}).strict();
export type MaterialDraftItem = Omit<z.infer<typeof MaterialDraftItemSchema>, "category"> & {category: MaterialCategoryKey};

/** 整合单元的输出：`integrated/<类别>/<名称>.json`。 */
export const IntegratedFileSchema = z.object({items: z.array(MaterialDraftItemSchema)}).strict();

// ---------------------------------------------------------------------------
// 任务 state：实体索引与归类结果
// ---------------------------------------------------------------------------

/**
 * 实体索引是实体文件夹的真值：`settle` 是同步的、不能读磁盘，已知名单与归类候选都从它得出。
 * 磁盘上多出的文件夹（取消时遗留）不在索引里就不被使用。
 */
export const EntityIndexEntrySchema = z.object({
    name: z.string().min(1),
    aliases: z.array(z.string()),
    blocks: z.array(z.number().int().positive()),
    stableId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u).optional(),
}).strict();
export type EntityIndexEntry = z.infer<typeof EntityIndexEntrySchema>;
/** 类别键 → 文件夹键 → 索引条目。 */
export const EntityIndexSchema = z.record(z.string(), z.record(z.string(), EntityIndexEntrySchema));
export type EntityIndex = z.infer<typeof EntityIndexSchema>;

/** 角色发现阶段的轻量候选；在逐角色提取成功前不会进入实体索引。 */
export const CharacterCandidateSchema = z.object({
    folderKey: z.string().min(1),
    name: z.string().min(1),
    aliases: z.array(z.string()),
    blocks: z.array(z.number().int().positive()),
    stableId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u).optional(),
}).strict();
export type CharacterCandidate = z.infer<typeof CharacterCandidateSchema>;
export const CharacterCandidateListSchema = z.array(CharacterCandidateSchema);

/** 角色提取只在任务编排阶段使用的频率等级，不写入角色最终文件。 */
export const CharacterExtractionTierSchema = z.enum(["primary", "secondary", "tertiary"]);
export type CharacterExtractionTier = z.infer<typeof CharacterExtractionTierSchema>;

export type EntityPreview = Readonly<{
    fragments: ReadonlyArray<{
        block: number;
        role: MaterialNodeRole;
        fields: Readonly<Record<string, string>>;
        citations: readonly MaterialParagraphReference[];
    }>;
}>;

export function readCharacterCandidates(state: Readonly<Record<string, unknown>>): CharacterCandidate[] {
    return CharacterCandidateListSchema.parse(state.characterCandidates ?? []);
}

export const ClassificationGroupSchema = z.object({
    category: z.string().refine(isMaterialCategoryKey, "未知的素材类别"),
    folders: z.array(z.string().min(1)).min(2),
}).strict();
export type ClassificationGroup = z.infer<typeof ClassificationGroupSchema>;

/** 归类暂停点的输入：跳过，或给出“这些文件夹是同一个实体”的分组。 */
export const ClassificationInputSchema = z.object({
    skip: z.boolean().optional(),
    groups: z.array(ClassificationGroupSchema).optional(),
}).strict();
export type ClassificationInput = z.infer<typeof ClassificationInputSchema>;

export const MaterialParamsSchema = z.object({
    categories: z.array(z.string().refine(isMaterialCategoryKey, "未知的素材类别")).min(1).optional(),
    blocks: z.array(z.number().int().positive()).min(1).max(10000).optional(),
}).strict();

/** 任务启用的类别，保持规范顺序（与单元顺序、界面顺序一致）。 */
export function selectedCategories(params: Readonly<Record<string, unknown>>): MaterialCategorySpec[] {
    const parsed = MaterialParamsSchema.parse(params);
    const wanted = new Set(parsed.categories ?? MATERIAL_CATEGORY_SPECS.map(spec => spec.key));
    return MATERIAL_CATEGORY_SPECS.filter(spec => wanted.has(spec.key));
}

export function selectedBlocks(params: Readonly<Record<string, unknown>>, available: ReadonlySet<number>): number[] {
    const parsed = MaterialParamsSchema.parse(params);
    const blocks = parsed.blocks ?? [...available].sort((left, right) => left - right);
    const unique = [...new Set(blocks)].sort((left, right) => left - right);
    if (unique.some(block => !available.has(block))) throw new Error("素材提取选择了不存在的分块");
    return unique;
}

export function readEntityIndex(state: Readonly<Record<string, unknown>>): EntityIndex {
    const parsed = EntityIndexSchema.safeParse(state.entities ?? {});
    if (!parsed.success) throw new Error(`素材提取任务的实体索引已损坏：${parsed.error.message}`);
    return parsed.data;
}

export function readClassifiedGroups(state: Readonly<Record<string, unknown>>): ClassificationGroup[] {
    return z.array(ClassificationGroupSchema).parse(state.groups ?? []);
}
