import {z} from "zod";
import {ProjectRootDtoSchema} from "nbook/shared/dto/project.dto";
import {InspirationSourcePathSchema} from "nbook/shared/dto/inspiration-source.dto";
import {MATERIAL_CATEGORIES, MaterialParagraphReferenceSchema} from "nbook/shared/dto/inspiration-material.dto";
import {
    ExtractionProgressSchema,
    ExtractionSourceRefSchema,
    ExtractionStopReasonSchema,
    ExtractionTaskKindSchema,
    ExtractionTaskSchema,
    ExtractionTaskStatusSchema,
    ExtractionUnitCountsSchema,
} from "nbook/shared/dto/inspiration-extraction-task.dto";
import {
    ChapterCorrectionSchema,
    ChapterRecognitionSchema,
    ExtractionChapterSchema,
    ExtractionStructureSchema,
    VolumeDivisionSchema,
    VolumeRangeSchema,
} from "nbook/shared/dto/inspiration-outline-structure.dto";
import {OutlineDestinationSchema, OutlineOverwriteConfirmationSchema} from "nbook/shared/dto/inspiration-outline-extraction.dto";

/**
 * `/api/inspiration/extraction/**` 的请求与响应合同（t08 阶段 A）。
 *
 * 只描述 HTTP 边界：任务记录、进度、提取结构等沿用 t03 到 t07 的 DTO，不在这里改变它们的语义。
 * 请求体一律 strict，因此客户端无法夹带服务端自行决定的字段——尤其是“确认者身份”：
 * 界面请求的确认者永远是用户，由路由按调用来源填入，请求体里没有也不接受 `confirmer`。
 */

const ProjectRequestShape = {projectRoot: ProjectRootDtoSchema};
const TaskIdSchema = z.string().uuid();
const UnitIdSchema = z.string().min(1).max(200);
const MAX_CORRECTIONS = 2000;

/** 只带项目定位的请求体（取消、继续、重新汇总等）。 */
export const ExtractionProjectRequestSchema = z.object(ProjectRequestShape).strict();
export const ExtractionProjectQuerySchema = ExtractionProjectRequestSchema;
export const ExtractionTaskIdParamSchema = TaskIdSchema;

// ---------------------------------------------------------------------------
// 来源与结构（t03）
// ---------------------------------------------------------------------------

/** 切分目标字数只用于字数模式（没有可识别章节时）的块划分，缺省沿用来源切分目标。 */
const TargetCharactersSchema = z.number().int().positive().max(1_000_000);
const StructureModeSchema = z.enum(["chapters", "chunks"]);

export const ExtractionStructurePreviewRequestSchema = z.object({
    ...ProjectRequestShape,
    path: InspirationSourcePathSchema,
    /** 按顺序重放；服务端不保存修正，每次预览都从来源重新识别。 */
    corrections: z.array(ChapterCorrectionSchema).max(MAX_CORRECTIONS).default([]),
    /** 未提供时按识别结果自动选择；提供时允许用户在已识别章节的来源上切换到字数分块。 */
    mode: StructureModeSchema.optional(),
    targetCharacters: TargetCharactersSchema.optional(),
}).strict();

export const ExtractionStructurePreviewResponseSchema = z.object({
    source: ExtractionSourceRefSchema,
    mode: z.enum(["chapters", "chunks"]),
    /** 应用修正后的章节识别结果。字数模式下 `chapters` 为空。 */
    recognition: ChapterRecognitionSchema,
    /** 章节模式下为识别出的章节，字数模式下为按目标字数切分的块（每块视作一章）。 */
    chapters: z.array(ExtractionChapterSchema),
    /** 章节模式的默认划卷建议；字数模式为空。 */
    suggestedVolumes: z.array(VolumeRangeSchema),
}).strict();

export const ExtractionStructureConfirmRequestSchema = ExtractionStructurePreviewRequestSchema.extend({
    division: VolumeDivisionSchema,
}).strict();

export const ExtractionStructureConfirmResponseSchema = z.object({
    source: ExtractionSourceRefSchema,
    structure: ExtractionStructureSchema,
}).strict();

// ---------------------------------------------------------------------------
// 任务控制（t04）
// ---------------------------------------------------------------------------

const MaterialCategoryKeySchema = z.enum(MATERIAL_CATEGORIES.map(category => category.key) as [string, ...string[]]);
const ModelKeySchema = z.string().min(1).max(200);

export const ExtractionOutlineStartRequestSchema = z.object({
    ...ProjectRequestShape,
    kind: z.literal("outline"),
    /** 来源路径与内容哈希取自 source-prepare；启动时服务端仍会以磁盘为准复核哈希。 */
    source: ExtractionSourceRefSchema,
    workTitle: z.string().trim().min(1).max(200),
    structure: ExtractionStructureSchema,
    corrections: z.array(ChapterCorrectionSchema).max(MAX_CORRECTIONS).default([]),
    destination: OutlineDestinationSchema.default({kind: "new"}),
    modelKey: ModelKeySchema.optional(),
}).strict();

export const ExtractionMaterialStartRequestSchema = z.object({
    ...ProjectRequestShape,
    kind: z.literal("material"),
    source: ExtractionSourceRefSchema,
    /** 缺省为全部九类。 */
    categories: z.array(MaterialCategoryKeySchema).min(1).max(MATERIAL_CATEGORIES.length).optional(),
    /** 缺省为全部块；块号在流水线按来源哈希复核。 */
    blocks: z.array(z.number().int().positive()).min(1).max(10000).optional(),
    modelKey: ModelKeySchema.optional(),
}).strict();

export const ExtractionStartRequestSchema = z.discriminatedUnion("kind", [
    ExtractionOutlineStartRequestSchema,
    ExtractionMaterialStartRequestSchema,
]);

export const ExtractionTaskListQuerySchema = z.object({
    ...ProjectRequestShape,
    kind: ExtractionTaskKindSchema.optional(),
    path: InspirationSourcePathSchema.optional(),
}).strict();

/** 列表行：不含 `params` / `state` / 单元明细，需要时读取任务详情。 */
export const ExtractionTaskSummarySchema = z.object({
    id: TaskIdSchema,
    kind: ExtractionTaskKindSchema,
    source: ExtractionSourceRefSchema,
    status: ExtractionTaskStatusSchema,
    awaitingInput: z.string().nullable(),
    stopReason: ExtractionStopReasonSchema.nullable(),
    overall: ExtractionUnitCountsSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
}).strict();

export const ExtractionTaskListResponseSchema = z.object({tasks: z.array(ExtractionTaskSummarySchema)}).strict();

export const ExtractionTaskDetailResponseSchema = z.object({
    task: ExtractionTaskSchema,
    progress: ExtractionProgressSchema,
}).strict();

export const ExtractionUnitRequestSchema = z.object({...ProjectRequestShape, unitId: UnitIdSchema}).strict();

/** 一次提交点击时的失败项集合；服务端仍重新检查当前状态。 */
export const ExtractionFailedUnitsRequestSchema = z.object({
    ...ProjectRequestShape,
    action: z.enum(["retry", "skip"]),
    unitIds: z.array(UnitIdSchema).min(1).max(10000),
}).strict();

export const ExtractionClassificationInputSchema = z.object({
    skip: z.boolean().optional(),
    groups: z.array(z.object({category: MaterialCategoryKeySchema, folders: z.array(z.string().min(1)).min(2)}).strict()).optional(),
}).strict();
export const ExtractionOverwriteInputSchema = OutlineOverwriteConfirmationSchema;

/**
 * 通用“提供人工输入”：大纲任务等待覆盖确认，素材任务等待归类。输入的具体形状取决于任务种类，
 * 路由读取任务后再按种类校验（`{}` 对大纲任务无效，因为 `confirmedItems` 必填）。
 */
export const ExtractionInputRequestSchema = z.object({
    ...ProjectRequestShape,
    input: z.union([ExtractionOverwriteInputSchema, ExtractionClassificationInputSchema]),
}).strict();

// ---------------------------------------------------------------------------
// 大纲
// ---------------------------------------------------------------------------

export const OutlineDestinationQuerySchema = z.object({...ProjectRequestShape, path: InspirationSourcePathSchema}).strict();

// ---------------------------------------------------------------------------
// 素材
// ---------------------------------------------------------------------------

const ReviewFieldsSchema = z.record(z.string(), z.string());
/** 节点形状与服务端 `MaterialNodeSchema` 一致；字段归属、模板与引用等语义由审阅服务校验并以 422 拒绝。 */
const ReviewNodeSchema = z.object({
    role: z.enum(["main", "experience", "relationship"]),
    entries: z.array(z.object({fields: ReviewFieldsSchema, block: z.number().int().positive().nullable()}).strict()).min(1),
    citations: z.array(MaterialParagraphReferenceSchema),
}).strict();

const ReviewItemIdSchema = z.string().min(1).max(200);

export const MaterialReviewActionSchema = z.discriminatedUnion("kind", [
    z.object({kind: z.literal("select"), itemIds: z.array(ReviewItemIdSchema).min(1).max(5000), selected: z.boolean()}).strict(),
    z.object({
        kind: z.literal("update"), itemId: ReviewItemIdSchema,
        patch: z.object({
            title: z.string().optional(),
            aliases: z.array(z.string()).max(200).optional(),
            nodes: z.array(ReviewNodeSchema).min(1).max(3).optional(),
        }).strict(),
    }).strict(),
    z.object({kind: z.literal("remove"), itemId: ReviewItemIdSchema}).strict(),
    z.object({
        kind: z.literal("split"), itemId: ReviewItemIdSchema,
        input: z.object({
            title: z.string(),
            aliases: z.array(z.string()).max(200).optional(),
            mainFields: ReviewFieldsSchema.optional(),
            move: z.array(z.object({
                role: z.enum(["experience", "relationship"]),
                entryIndexes: z.array(z.number().int().nonnegative()).max(5000),
            }).strict()).max(2),
        }).strict(),
    }).strict(),
    z.object({kind: z.literal("merge"), itemIds: z.array(ReviewItemIdSchema).min(2).max(200)}).strict(),
]);

export const MaterialReviewActionRequestSchema = z.object({...ProjectRequestShape, action: MaterialReviewActionSchema}).strict();

export const MaterialConflictDecisionSchema = z.object({
    itemId: ReviewItemIdSchema,
    action: z.enum(["overwrite", "save-as", "skip"]),
    saveAsName: z.string().trim().min(1).max(200).optional(),
}).strict();

/** 没有 `confirmer` 字段：确认者由服务端按调用来源判定，strict 校验会拒绝任何自报身份。 */
export const MaterialConfirmWriteRequestSchema = z.object({
    ...ProjectRequestShape,
    decisions: z.array(MaterialConflictDecisionSchema).max(5000).optional(),
}).strict();

export type ExtractionStructurePreviewRequestDto = z.infer<typeof ExtractionStructurePreviewRequestSchema>;
export type ExtractionStructurePreviewResponseDto = z.infer<typeof ExtractionStructurePreviewResponseSchema>;
export type ExtractionStructureConfirmRequestDto = z.infer<typeof ExtractionStructureConfirmRequestSchema>;
export type ExtractionStructureConfirmResponseDto = z.infer<typeof ExtractionStructureConfirmResponseSchema>;
export type ExtractionStartRequestDto = z.infer<typeof ExtractionStartRequestSchema>;
export type ExtractionTaskSummaryDto = z.infer<typeof ExtractionTaskSummarySchema>;
export type ExtractionTaskListResponseDto = z.infer<typeof ExtractionTaskListResponseSchema>;
export type ExtractionTaskDetailResponseDto = z.infer<typeof ExtractionTaskDetailResponseSchema>;
export type MaterialReviewActionDto = z.infer<typeof MaterialReviewActionSchema>;
export type MaterialConflictDecisionDto = z.infer<typeof MaterialConflictDecisionSchema>;
export type MaterialConfirmWriteRequestDto = z.infer<typeof MaterialConfirmWriteRequestSchema>;
