import {createWorkspaceContentFrontmatterDefaults} from "nbook/server/workspace-files/content-node-schema";
import {
    MATERIAL_FEATURE_TYPE_FIELD, MATERIAL_FEATURE_TYPES, MATERIAL_TEMPLATES, MaterialExtractionSourceSchema,
    type MaterialExtractionSource, type MaterialParagraphReference, type MaterialTemplateKind,
} from "nbook/shared/dto/inspiration-material.dto";

/** 素材提取新增模板（写作手法、素材特点、角色经历、角色人际关系）的校验、P 引用还原与落盘形态。 */

export interface MaterialParagraph {
    id: string;
    text: string;
}

export interface MaterialValidationContext {
    /** 来源的段落列表；提供时 P 编号必须存在于其中。 */
    paragraphs?: readonly Pick<MaterialParagraph, "id">[];
    /** 本分块的 P 编号范围；提供时引用必须落在范围内。 */
    range?: MaterialParagraphReference;
}

export interface MaterialValidationResult {
    /** 空数组表示通过；消息可直接拼入修复重试提示词。 */
    errors: string[];
    /** 去掉空值并按模板字段顺序排列后的字段。 */
    fields: Record<string, string>;
    references: MaterialParagraphReference[];
}

export interface RestoredFragment {
    /** `P12` 或 `P12-P15`。 */
    label: string;
    text: string;
}

const REFERENCE_TOKEN = /^P([1-9]\d*)(?:-P([1-9]\d*))?$/u;
const REFERENCE_SEPARATOR = /[\s,，、;；]+/u;

function paragraphNumber(id: string): number {
    return Number(id.slice(1));
}

function referenceLabel(reference: MaterialParagraphReference): string {
    return reference.firstParagraphId === reference.lastParagraphId
        ? reference.firstParagraphId
        : `${reference.firstParagraphId}-${reference.lastParagraphId}`;
}

/** 解析“参考片段”字段：以空白、逗号或顿号分隔的 `P12` 或 `P12-P15`；格式错误逐项报告。 */
export function parseParagraphReferences(text: string): {references: MaterialParagraphReference[]; errors: string[]} {
    const references: MaterialParagraphReference[] = [];
    const errors: string[] = [];
    for (const token of text.split(REFERENCE_SEPARATOR).filter(Boolean)) {
        const match = REFERENCE_TOKEN.exec(token);
        if (!match) {
            errors.push(`参考片段“${token}”不是有效的 P 编号引用，应写作 P12 或 P12-P15`);
            continue;
        }
        const first = Number(match[1]);
        const last = match[2] === undefined ? first : Number(match[2]);
        if (last < first) {
            errors.push(`参考片段“${token}”的结束编号小于起始编号`);
            continue;
        }
        references.push({firstParagraphId: `P${first}`, lastParagraphId: `P${last}`});
    }
    return {references, errors};
}

/**
 * 按模板校验一次产出：字段归属、素材特点类型取值、P 编号格式、存在性与分块范围。
 * 字段均非必填，但整条记录至少要有一个非空字段。
 */
export function validateMaterialTemplateFields(kind: MaterialTemplateKind, rawFields: Readonly<Record<string, unknown>>, context: MaterialValidationContext = {}): MaterialValidationResult {
    const template = MATERIAL_TEMPLATES[kind];
    const allowed: readonly string[] = template.fields;
    const errors: string[] = [];
    const given = new Map<string, string>();
    for (const [label, value] of Object.entries(rawFields)) {
        if (!allowed.includes(label)) {
            const owner = MATERIAL_TEMPLATES_BY_FIELD.get(label);
            errors.push(owner
                ? `字段“${label}”属于模板“${owner}”，不属于“${template.label}”；“${template.label}”的字段为：${allowed.join("、")}`
                : `字段“${label}”不属于模板“${template.label}”，该模板的字段为：${allowed.join("、")}`);
            continue;
        }
        if (typeof value !== "string") {
            errors.push(`字段“${label}”的值必须是文本`);
            continue;
        }
        if (value.trim()) given.set(label, value.trim());
    }
    const fields = Object.fromEntries(allowed.filter(label => given.has(label)).map(label => [label, given.get(label)!]));
    if (!errors.length && !given.size) errors.push(`模板“${template.label}”没有任何非空字段，请至少填写一个字段`);

    if (kind === "material-feature") {
        const type = fields[MATERIAL_FEATURE_TYPE_FIELD];
        if (type !== undefined && !(MATERIAL_FEATURE_TYPES as readonly string[]).includes(type)) {
            errors.push(`字段“${MATERIAL_FEATURE_TYPE_FIELD}”只能填写：${MATERIAL_FEATURE_TYPES.join("、")}`);
        }
    }

    const references: MaterialParagraphReference[] = [];
    const referenceText = fields[template.referenceField];
    if (referenceText !== undefined) {
        const parsed = parseParagraphReferences(referenceText);
        errors.push(...parsed.errors);
        const known = context.paragraphs && new Set(context.paragraphs.map(paragraph => paragraph.id));
        for (const reference of parsed.references) {
            const label = referenceLabel(reference);
            if (known && !(known.has(reference.firstParagraphId) && known.has(reference.lastParagraphId))) {
                errors.push(`参考片段“${label}”引用了来源中不存在的 P 编号`);
            } else if (context.range && (paragraphNumber(reference.firstParagraphId) < paragraphNumber(context.range.firstParagraphId)
                || paragraphNumber(reference.lastParagraphId) > paragraphNumber(context.range.lastParagraphId))) {
                errors.push(`参考片段“${label}”超出本块范围 ${referenceLabel(context.range)}`);
            } else {
                references.push(reference);
            }
        }
    }
    return {errors, fields, references};
}

const MATERIAL_TEMPLATES_BY_FIELD: ReadonlyMap<string, string> = new Map(
    Object.values(MATERIAL_TEMPLATES).flatMap(template => template.fields.map(field => [field, template.label] as const)),
);

/**
 * 把 P 引用还原为来源中的原文片段。引用必须已通过 `validateMaterialTemplateFields`；
 * 段落文本自带空白，拼接后只裁去首尾空白。引用不存在或顺序颠倒时抛错，不返回残缺片段。
 */
export function restoreParagraphReferences(references: readonly MaterialParagraphReference[], paragraphs: readonly MaterialParagraph[]): RestoredFragment[] {
    const indexById = new Map(paragraphs.map((paragraph, index) => [paragraph.id, index]));
    return references.map(reference => {
        const first = indexById.get(reference.firstParagraphId);
        const last = indexById.get(reference.lastParagraphId);
        if (first === undefined || last === undefined || last < first) {
            throw new RangeError(`无法还原参考片段 ${referenceLabel(reference)}：来源中缺少对应段落`);
        }
        return {label: referenceLabel(reference), text: paragraphs.slice(first, last + 1).map(paragraph => paragraph.text).join("").trim()};
    });
}

/**
 * 渲染内容节点正文。单条模板的字段为二级标题；多条模板（经历、人际关系）每条一个二级标题，
 * 保持传入顺序，不去重合并。提供 `paragraphs` 时“参考片段”展开为原文引用，否则保留 P 编号。
 */
export function renderMaterialBody(kind: MaterialTemplateKind, entries: ReadonlyArray<Readonly<Record<string, string>>>, paragraphs?: readonly MaterialParagraph[]): string {
    const template = MATERIAL_TEMPLATES[kind];
    if (!entries.length || (!template.multiEntry && entries.length !== 1)) {
        throw new RangeError(`模板“${template.label}”${template.multiEntry ? "至少需要一条记录" : "每个节点只容纳一条记录"}`);
    }
    const fieldLevel = template.multiEntry ? "###" : "##";
    return entries.map((entry, index) => {
        const blocks = template.fields.filter(label => entry[label]?.trim()).map(label => {
            let value = entry[label]!.trim();
            if (label === template.referenceField && paragraphs) {
                const {references} = parseParagraphReferences(value);
                value = restoreParagraphReferences(references, paragraphs)
                    .map(fragment => `> ${fragment.label}\n${fragment.text.split(/\r?\n/u).map(line => `> ${line}`).join("\n")}`).join("\n\n");
            }
            return `${fieldLevel} ${label}\n\n${value}`;
        });
        if (!template.multiEntry) return blocks.join("\n\n");
        return [`## ${entry[template.titleField]?.trim() || `第 ${index + 1} 条`}`, ...blocks].join("\n\n");
    }).join("\n\n");
}

/** 提取素材的 frontmatter：沿用标准默认值，另带 `origin: extract` 与来源信息；来源信息格式非法时抛错。 */
export function buildExtractedMaterialFrontmatter(input: {title: string; type: string; subtype?: string; source: MaterialExtractionSource}): Record<string, unknown> {
    const frontmatter = createWorkspaceContentFrontmatterDefaults({title: input.title, type: input.type, status: "active"});
    if (input.subtype) frontmatter.subtype = input.subtype;
    // 只有经用户审阅后才会写入 lorebook，与原创设计的保存口径一致。
    frontmatter.governance = {source: "generated", review: "reviewed"};
    frontmatter.origin = "extract";
    frontmatter.extraction = MaterialExtractionSourceSchema.parse(input.source);
    return frontmatter;
}
