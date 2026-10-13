import {z} from "zod";

/**
 * Chapter recognition, user corrections, volume division and the persisted "extraction structure"
 * of the outline-extraction pipeline. Paragraph IDs follow `inspiration-source.dto.ts` (P1 onward).
 */

const ParagraphIdSchema = z.string().regex(/^P[1-9]\d*$/u);
const IndexSchema = z.number().int().positive();
const TitleSchema = z.string().trim().min(1).max(200);

export const OUTLINE_STRUCTURE_ERROR_CODES = [
    "PARAGRAPH_NOT_FOUND",
    "CHAPTER_NOT_FOUND",
    "CHAPTER_TITLE_EMPTY",
    "CORRECTION_VOLUME_LINE",
    "CORRECTION_NOT_HEADING",
    "CORRECTION_ALREADY_HEADING",
    "CORRECTION_NO_CHAPTER",
    "CORRECTION_EMPTY_CHAPTER",
    "CORRECTION_NO_NEXT_CHAPTER",
    "VOLUME_MODE_MISMATCH",
    "VOLUME_NO_CHAPTERS",
    "VOLUME_NO_VOLUMES",
    "VOLUME_EMPTY",
    "VOLUME_OVERLAP",
    "VOLUME_GAP",
    "VOLUME_OUT_OF_RANGE",
    "VOLUME_CHUNKS_PER_VOLUME_INVALID",
    "SOURCE_HASH_INVALID",
    "TARGET_CHARACTERS_INVALID",
] as const;
export type OutlineStructureErrorCode = (typeof OUTLINE_STRUCTURE_ERROR_CODES)[number];

/** One recognized chapter. `headingParagraphId` is null for the leading "章前文字" chapter. */
export const RecognizedChapterSchema = z.object({
    index: IndexSchema,
    title: z.string(),
    headingParagraphId: ParagraphIdSchema.nullable(),
    firstParagraphId: ParagraphIdSchema,
    lastParagraphId: ParagraphIdSchema,
    characterCount: z.number().int().nonnegative(),
});

export const VolumeHeadingSchema = z.object({
    paragraphId: ParagraphIdSchema,
    title: z.string(),
});

export const ChapterRecognitionSchema = z.object({
    chapters: z.array(RecognizedChapterSchema),
    volumeHeadings: z.array(VolumeHeadingSchema),
});

/** Corrections are replayed in order; `chapterIndex` refers to the list after earlier corrections. */
export const ChapterCorrectionSchema = z.discriminatedUnion("kind", [
    z.object({kind: z.literal("set-heading"), paragraphId: ParagraphIdSchema, title: TitleSchema.optional()}).strict(),
    z.object({kind: z.literal("unset-heading"), paragraphId: ParagraphIdSchema}).strict(),
    z.object({kind: z.literal("merge"), chapterIndex: IndexSchema}).strict(),
    z.object({kind: z.literal("split"), paragraphId: ParagraphIdSchema, title: TitleSchema.optional()}).strict(),
]);

export const VolumeRangeSchema = z.object({
    title: TitleSchema.nullable(),
    firstChapterIndex: IndexSchema,
    lastChapterIndex: IndexSchema,
}).strict();

/** `chapters` divides recognized chapters into ranges; `chunks` groups every N split chunks (word-count mode). */
export const VolumeDivisionSchema = z.discriminatedUnion("mode", [
    z.object({mode: z.literal("chapters"), volumes: z.array(VolumeRangeSchema)}).strict(),
    z.object({mode: z.literal("chunks"), chunksPerVolume: IndexSchema}).strict(),
]);

export const ExtractionChapterSchema = z.object({
    index: IndexSchema,
    title: z.string(),
    firstParagraphId: ParagraphIdSchema,
    lastParagraphId: ParagraphIdSchema,
    characterCount: z.number().int().nonnegative(),
});

export const ExtractionVolumeSchema = z.object({
    index: IndexSchema,
    title: z.string().nullable(),
    firstChapterIndex: IndexSchema,
    lastChapterIndex: IndexSchema,
});

export const ExtractionStructureSchema = z.object({
    sourceSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    mode: z.enum(["chapters", "chunks"]),
    chapters: z.array(ExtractionChapterSchema),
    volumes: z.array(ExtractionVolumeSchema),
});

export type RecognizedChapterDto = z.infer<typeof RecognizedChapterSchema>;
export type VolumeHeadingDto = z.infer<typeof VolumeHeadingSchema>;
export type ChapterRecognitionDto = z.infer<typeof ChapterRecognitionSchema>;
export type ChapterCorrectionDto = z.infer<typeof ChapterCorrectionSchema>;
export type VolumeRangeDto = z.infer<typeof VolumeRangeSchema>;
export type VolumeDivisionDto = z.infer<typeof VolumeDivisionSchema>;
export type ExtractionChapterDto = z.infer<typeof ExtractionChapterSchema>;
export type ExtractionVolumeDto = z.infer<typeof ExtractionVolumeSchema>;
export type ExtractionStructureDto = z.infer<typeof ExtractionStructureSchema>;
