import {z} from "zod";
import {InspirationSourcePathSchema} from "nbook/shared/dto/inspiration-source.dto";

/**
 * 作品提取后台任务（大纲提取与素材提取共用）的持久化记录与进度投影。
 * 记录保存在 `.nbook/inspiration/extractions/<任务 ID>/task.json`；流水线私有数据只能放在
 * 可序列化的 `params` / `state` / 单元 `data` 中，由各流水线自己校验。
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | {[key: string]: JsonValue};
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
    z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema),
]));
export const JsonRecordSchema = z.record(z.string(), JsonValueSchema);
export type JsonRecord = z.infer<typeof JsonRecordSchema>;

export const EXTRACTION_TASK_KINDS = ["outline", "material"] as const;
export const ExtractionTaskKindSchema = z.enum(EXTRACTION_TASK_KINDS);
export type ExtractionTaskKind = z.infer<typeof ExtractionTaskKindSchema>;

/** `skipped` 是用户对失败单元的明确放弃，视为已处理但不算成果。 */
export const EXTRACTION_UNIT_STATUSES = ["pending", "running", "done", "failed", "skipped"] as const;
export const ExtractionUnitStatusSchema = z.enum(EXTRACTION_UNIT_STATUSES);
export type ExtractionUnitStatus = z.infer<typeof ExtractionUnitStatusSchema>;

/**
 * `awaiting-input` 是流水线声明的“暂停等待人工输入”终止态（素材提取的归类、审阅）；
 * `interrupted` 既可能是已持久化的，也可能是读取时由“运行中但无活动执行者”推导出的。
 */
export const EXTRACTION_TASK_STATUSES = ["running", "awaiting-input", "completed", "partial-failed", "cancelled", "interrupted"] as const;
export const ExtractionTaskStatusSchema = z.enum(EXTRACTION_TASK_STATUSES);
export type ExtractionTaskStatus = z.infer<typeof ExtractionTaskStatusSchema>;

export const EXTRACTION_STOP_REASON_CODES = ["source-changed", "model-unavailable", "unexpected"] as const;
export const ExtractionStopReasonSchema = z.object({
    code: z.enum(EXTRACTION_STOP_REASON_CODES),
    message: z.string().max(1000),
}).strict();
export type ExtractionStopReason = z.infer<typeof ExtractionStopReasonSchema>;

export const ExtractionSourceRefSchema = z.object({
    path: InspirationSourcePathSchema,
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();
export type ExtractionSourceRef = z.infer<typeof ExtractionSourceRefSchema>;

export const ExtractionUnitSchema = z.object({
    /** 流水线分配的稳定 ID（如 `chapter-3:outline`），任务内唯一。 */
    id: z.string().min(1).max(200),
    /** 流水线内的单元类型，`execute` 据此分派。 */
    step: z.string().min(1).max(100),
    label: z.string().max(200),
    /** 进度分组键（如卷序号）；null 表示不属于任何分组。 */
    group: z.string().max(200).nullable(),
    status: ExtractionUnitStatusSchema,
    /** 最近一次执行内已发起的模型调用次数；单元重试时清零。 */
    attempts: z.number().int().nonnegative(),
    /** 失败时的错误摘要。 */
    error: z.string().max(1000).nullable(),
    data: JsonRecordSchema,
}).strict();
export type ExtractionUnit = z.infer<typeof ExtractionUnitSchema>;

export const ExtractionTaskSchema = z.object({
    version: z.literal(1),
    id: z.string().uuid(),
    kind: ExtractionTaskKindSchema,
    source: ExtractionSourceRefSchema,
    /** 指定的提取模型；缺省走默认模型。继续任务沿用同一模型。 */
    modelKey: z.string().min(1).nullable(),
    /** 新任务固定全局提示词快照；历史任务缺省沿用内置提示词。 */
    promptSnapshotId: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    /** 启动参数，创建后不变。 */
    params: JsonRecordSchema,
    /** 流水线运行中产生的小型状态（如归类结果）。 */
    state: JsonRecordSchema,
    status: ExtractionTaskStatusSchema,
    /** `awaiting-input` 时流水线给出的等待原因；其余状态为 null。 */
    awaitingInput: z.string().max(100).nullable(),
    stopReason: ExtractionStopReasonSchema.nullable(),
    units: z.array(ExtractionUnitSchema),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
}).strict().superRefine((task, context) => {
    const seen = new Set<string>();
    for (const [index, unit] of task.units.entries()) {
        if (seen.has(unit.id)) context.addIssue({code: "custom", path: ["units", index, "id"], message: `单元 ID 重复：${unit.id}`});
        seen.add(unit.id);
    }
});
export type ExtractionTask = z.infer<typeof ExtractionTaskSchema>;

export const ExtractionUnitCountsSchema = z.object({
    total: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
}).strict();
export type ExtractionUnitCounts = z.infer<typeof ExtractionUnitCountsSchema>;

/** 整体、按分组、逐单元三层进度，供后续 API 与界面直接使用。 */
export const ExtractionProgressSchema = z.object({
    taskId: z.string().uuid(),
    kind: ExtractionTaskKindSchema,
    status: ExtractionTaskStatusSchema,
    awaitingInput: z.string().nullable(),
    stopReason: ExtractionStopReasonSchema.nullable(),
    overall: ExtractionUnitCountsSchema,
    /** 按首次出现顺序排列；无分组的单元不出现在此。 */
    groups: z.array(z.object({group: z.string(), counts: ExtractionUnitCountsSchema}).strict()),
    units: z.array(ExtractionUnitSchema.pick({id: true, step: true, label: true, group: true, status: true, attempts: true, error: true}).strict()),
}).strict();
export type ExtractionProgress = z.infer<typeof ExtractionProgressSchema>;
