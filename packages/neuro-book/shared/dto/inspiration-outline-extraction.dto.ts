import {z} from "zod";
import {ChapterCorrectionSchema, ExtractionStructureSchema} from "./inspiration-outline-structure.dto";

/**
 * 大纲提取任务的启动参数与覆盖确认输入。启动参数写入任务记录的 `params`，创建后不变；
 * 来源路径与内容哈希由任务记录的 `source` 持有，这里不重复保存。
 */

/** 数据去向。补充与覆盖都要指向一个由同一来源提取出的已有方案。 */
export const OutlineDestinationSchema = z.discriminatedUnion("kind", [
    z.object({kind: z.literal("new")}).strict(),
    z.object({kind: z.literal("supplement"), planId: z.string().min(1)}).strict(),
    z.object({kind: z.literal("overwrite"), planId: z.string().min(1)}).strict(),
]);

export const OutlineExtractionParamsSchema = z.object({
    /** 用于命名“提取方案N·<作品名>”。 */
    workTitle: z.string().trim().min(1).max(200),
    /** t03 的提取结构（已含用户修正与划卷结果）；流水线按它切分章节原文，不重新识别。 */
    structure: ExtractionStructureSchema,
    /** 产生该结构的修正列表，仅作为任务记录保存，便于复核与重放。 */
    corrections: z.array(ChapterCorrectionSchema),
    destination: OutlineDestinationSchema,
}).strict();

/** 覆盖对比的条目种类：章节的来源提取细纲，或章节大纲。 */
export const OUTLINE_OVERWRITE_ITEM_KINDS = ["detail", "outline"] as const;
export const OutlineOverwriteItemKindSchema = z.enum(OUTLINE_OVERWRITE_ITEM_KINDS);

/** 覆盖任务在等待确认时收到的输入：逐项确认，只覆盖被确认的项，其余保持原样。 */
export const OutlineOverwriteConfirmationSchema = z.object({
    confirmedItems: z.array(z.object({
        chapterIndex: z.number().int().positive(),
        kind: OutlineOverwriteItemKindSchema,
    }).strict()),
}).strict();

/**
 * 覆盖前的新旧对比条目；纯数据，界面直接渲染，确认输入按 `chapterIndex + kind` 引用。
 * 这些条目随任务记录持久化在 `state.comparison`，所以由 schema 定义并在读取时重新校验。
 */
export const OutlineComparisonItemSchema = z.object({
    chapterIndex: z.number().int().positive(),
    chapterTitle: z.string(),
    kind: OutlineOverwriteItemKindSchema,
    /** 现有正文；该章尚无内容为 null。细纲有多份时按位置用分隔线连接。 */
    oldText: z.string().nullable(),
    newText: z.string(),
    /** 新旧正文相同则为 false，确认也不会产生写入。 */
    changed: z.boolean(),
    /** 新提取的原文引用，如 `P3-P8, P12`。 */
    locator: z.string(),
    /** 现有条目及其版本与内容哈希；覆盖时据此确认条目在对比之后没有被改动。 */
    oldEntries: z.array(z.object({id: z.string(), version: z.number().int().nonnegative(), contentHash: z.string()}).strict()),
}).strict();

export type OutlineDestinationDto = z.infer<typeof OutlineDestinationSchema>;
export type OutlineExtractionParamsDto = z.infer<typeof OutlineExtractionParamsSchema>;
export type OutlineOverwriteItemKind = z.infer<typeof OutlineOverwriteItemKindSchema>;
export type OutlineOverwriteConfirmationDto = z.infer<typeof OutlineOverwriteConfirmationSchema>;
export type OutlineComparisonItem = z.infer<typeof OutlineComparisonItemSchema>;
