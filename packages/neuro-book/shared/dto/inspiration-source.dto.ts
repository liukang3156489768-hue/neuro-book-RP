import {z} from "zod";
import {ProjectRootDtoSchema} from "nbook/shared/dto/project.dto";

export const INSPIRATION_SOURCE_MAX_BYTES = 5 * 1024 * 1024;
export const INSPIRATION_SOURCE_TARGET_CHARACTERS = 50_000;
export const INSPIRATION_SOURCE_EXTENSIONS = [".txt", ".md"] as const;

/** Only canonical project-relative reference paths cross the HTTP boundary. */
export const InspirationSourcePathSchema = z.string().min(1).max(2048).refine((value) => {
    const segments = value.split("/");
    return segments.length > 1
        && segments[0] === "reference"
        && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
        && !/[\\:\u0000-\u001f\u007f]/u.test(value)
        && /\.(?:txt|md)$/iu.test(value);
}, "请选择当前项目 reference 目录内的 .txt 或 .md 文件");

export const InspirationSourceListRequestSchema = z.object({
    projectRoot: ProjectRootDtoSchema,
}).strict();

export const InspirationSourcePrepareRequestSchema = InspirationSourceListRequestSchema.extend({
    path: InspirationSourcePathSchema,
}).strict();

export const InspirationSourceFileSchema = z.object({
    path: InspirationSourcePathSchema,
    name: z.string(),
    bytes: z.number().int().nonnegative(),
    mtimeMs: z.number().nonnegative(),
});

export const InspirationSourceListResponseSchema = z.object({
    sources: z.array(InspirationSourceFileSchema),
    maxBytes: z.literal(INSPIRATION_SOURCE_MAX_BYTES),
    targetCharacters: z.literal(INSPIRATION_SOURCE_TARGET_CHARACTERS),
    supportedExtensions: z.array(z.enum(INSPIRATION_SOURCE_EXTENSIONS)),
});

const ParagraphIdSchema = z.string().regex(/^P[1-9]\d*$/u);
const SourceRangeShape = {
    /** UTF-16 offsets allow consumers to use String.slice without renormalizing the source. */
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
};
const GroupRangeShape = {
    index: z.number().int().positive(),
    ...SourceRangeShape,
    firstParagraphId: ParagraphIdSchema,
    lastParagraphId: ParagraphIdSchema,
    characterCount: z.number().int().nonnegative(),
};

export const InspirationSourceParagraphSchema = z.object({
    id: ParagraphIdSchema,
    /** Original text, including attached whitespace; concatenation restores the complete UTF-8 source. */
    text: z.string(),
    ...SourceRangeShape,
    chapterIndex: z.number().int().positive().nullable(),
    chunkIndex: z.number().int().positive(),
});

export const InspirationSourceChapterSchema = z.object({
    ...GroupRangeShape,
    title: z.string(),
});

export const InspirationSourceChunkSchema = z.object({
    ...GroupRangeShape,
    chapterIndexes: z.array(z.number().int().positive()),
});

export const InspirationSourcePrepareResponseSchema = z.object({
    source: InspirationSourceFileSchema.extend({sha256: z.string().regex(/^[0-9a-f]{64}$/u)}),
    mode: z.enum(["chapters", "paragraphs"]),
    targetCharacters: z.literal(INSPIRATION_SOURCE_TARGET_CHARACTERS),
    characterCount: z.number().int().nonnegative(),
    paragraphs: z.array(InspirationSourceParagraphSchema),
    chapters: z.array(InspirationSourceChapterSchema),
    chunks: z.array(InspirationSourceChunkSchema),
    warnings: z.array(z.string()),
});

export type InspirationSourceFileDto = z.infer<typeof InspirationSourceFileSchema>;
export type InspirationSourceListResponseDto = z.infer<typeof InspirationSourceListResponseSchema>;
export type InspirationSourcePrepareRequestDto = z.infer<typeof InspirationSourcePrepareRequestSchema>;
export type InspirationSourcePrepareResponseDto = z.infer<typeof InspirationSourcePrepareResponseSchema>;
export type InspirationSourceParagraphDto = z.infer<typeof InspirationSourceParagraphSchema>;
export type InspirationSourceChapterDto = z.infer<typeof InspirationSourceChapterSchema>;
export type InspirationSourceChunkDto = z.infer<typeof InspirationSourceChunkSchema>;
