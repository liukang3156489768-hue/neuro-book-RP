import {z} from "zod";
import {InspirationSourcePathSchema} from "nbook/shared/dto/inspiration-source.dto";

/**
 * 作品素材提取的数据合同（Spec：inspiration.material-extraction）。
 * 与 `inspiration.dto.ts` 的原创设计八类互不影响：原创设计的类别、模板与保存行为不在此处定义。
 */

/** `lorebook/` 内容节点的来源标记；frontmatter 缺失 `origin` 时按 `design` 处理，旧素材不迁移。 */
export const MATERIAL_ORIGINS = ["design", "extract"] as const;
export const MaterialOriginSchema = z.enum(MATERIAL_ORIGINS);
export type MaterialOrigin = z.infer<typeof MaterialOriginSchema>;

/** 与来源分块的段落编号保持同一格式（`P` 加正整数，见 `inspiration-source.dto.ts`）。 */
export const MaterialParagraphIdSchema = z.string().regex(/^P[1-9]\d*$/u);
export const MaterialParagraphReferenceSchema = z.object({
    firstParagraphId: MaterialParagraphIdSchema,
    lastParagraphId: MaterialParagraphIdSchema,
}).strict();
export type MaterialParagraphReference = z.infer<typeof MaterialParagraphReferenceSchema>;

/** 提取素材写入 frontmatter 的来源信息：来源文件、内容哈希与 P 段落引用。 */
export const MaterialExtractionSourceSchema = z.object({
    sourcePath: InspirationSourcePathSchema,
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    citations: z.array(MaterialParagraphReferenceSchema).min(1).max(500),
}).strict();
export type MaterialExtractionSource = z.infer<typeof MaterialExtractionSourceSchema>;

export type MaterialProcessingMode = "entity" | "document" | "itemized";

/**
 * 素材九类。`allowsPlotDevelopment` 是 Spec 对“素材模板不涉及剧情发展”规则的例外开关：
 * 只有写作手法与素材特点可以涉及剧情发展，其余类别保持该规则。
 * 角色类别的该规则约束主文件（基本人设）；经历与人际关系两个子节点是角色在作品中的经历记录，
 * 由各自模板定义内容，不参与类别级判断。
 */
export const MATERIAL_CATEGORIES = [
    {key: "character", label: "角色", mode: "entity", directory: "lorebook/character/", allowsPlotDevelopment: false},
    {key: "faction", label: "势力", mode: "entity", directory: "lorebook/faction/", allowsPlotDevelopment: false},
    {key: "item", label: "物品", mode: "entity", directory: "lorebook/item/", allowsPlotDevelopment: false},
    {key: "location", label: "地点", mode: "entity", directory: "lorebook/location/", allowsPlotDevelopment: false},
    {key: "system", label: "特殊规则", mode: "entity", directory: "lorebook/system/", allowsPlotDevelopment: false},
    {key: "instruction", label: "文风", mode: "document", directory: "lorebook/instruction/", allowsPlotDevelopment: false},
    {key: "world", label: "世界观", mode: "document", directory: "lorebook/world/", allowsPlotDevelopment: false},
    {key: "writing-technique", label: "写作手法", mode: "document", directory: "lorebook/note/写作手法/", allowsPlotDevelopment: true},
    {key: "material-feature", label: "素材特点", mode: "itemized", directory: "lorebook/note/写作素材/", allowsPlotDevelopment: true},
] as const satisfies ReadonlyArray<{key: string; label: string; mode: MaterialProcessingMode; directory: string; allowsPlotDevelopment: boolean}>;
export type MaterialCategoryKey = typeof MATERIAL_CATEGORIES[number]["key"];

/** 本 Task 新增的四个模板；其余类别沿用 `INSPIRATION_TEMPLATE_FIELDS` 中的模板。 */
export const MATERIAL_TEMPLATE_KINDS = ["writing-technique", "material-feature", "character-experience", "character-relationship"] as const;
export type MaterialTemplateKind = typeof MATERIAL_TEMPLATE_KINDS[number];

export interface MaterialTemplateDefinition {
    label: string;
    /** Spec“模板”表中的字段，均非必填，无对应信息留空。 */
    fields: readonly string[];
    /** 取值为 P 编号引用的字段，由程序还原为原文片段。 */
    referenceField: string;
    /** 用作节点标题的字段。 */
    titleField: string;
    /** 一个节点是否容纳多条记录（角色经历与人际关系按时间线整理，不去重合并）。 */
    multiEntry: boolean;
    /** 内容节点元数据：`type` 为 lorebook 类型，`subtype` 区分同目录下的不同模板。 */
    node: {type: "note" | "character"; subtype: string};
}

/** 素材特点的“类型”字段只接受 Spec 模板表列出的两个取值。字段名沿用 Spec 原文，与原创八类模板的“字段（说明）”写法一致。 */
export const MATERIAL_FEATURE_LOCATION_FIELD = "所在位置（分块与章节）";
export const MATERIAL_FEATURE_TYPE_FIELD = "类型（剧情安排 / 表现形式）";
export const MATERIAL_FEATURE_TYPES = ["剧情安排", "表现形式"] as const;

export const MATERIAL_TEMPLATES = {
    "writing-technique": {
        label: "写作手法",
        fields: ["手法名称", "类型（叙事 / 描写 / 对话 / 结构 / 节奏等）", "手法说明", "适用场景", "实现要点", "效果", "参考片段"],
        referenceField: "参考片段", titleField: "手法名称", multiEntry: false,
        node: {type: "note", subtype: "writing-technique"},
    },
    "material-feature": {
        label: "素材特点",
        fields: ["名称", MATERIAL_FEATURE_LOCATION_FIELD, MATERIAL_FEATURE_TYPE_FIELD, "安排描述", "效果", "参考片段"],
        referenceField: "参考片段", titleField: "名称", multiEntry: false,
        node: {type: "note", subtype: "material-feature"},
    },
    "character-experience": {
        label: "角色经历",
        fields: ["时间顺序（分块与章节）", "阶段名称", "经历描述", "对角色的影响", "参考片段"],
        referenceField: "参考片段", titleField: "阶段名称", multiEntry: true,
        node: {type: "character", subtype: "experience"},
    },
    "character-relationship": {
        label: "角色人际关系",
        fields: ["关联角色", "关系类型", "关系描述", "变化节点（分块与章节及变化内容）", "参考片段"],
        referenceField: "参考片段", titleField: "关联角色", multiEntry: true,
        node: {type: "character", subtype: "relationship"},
    },
} as const satisfies Record<MaterialTemplateKind, MaterialTemplateDefinition>;


/** 角色目录下存放经历与人际关系的子文件夹；其他实体类别没有此子文件夹。 */
export const MATERIAL_CHARACTER_SUBFOLDERS = {
    "character-experience": "experience",
    "character-relationship": "relationship",
} as const;
