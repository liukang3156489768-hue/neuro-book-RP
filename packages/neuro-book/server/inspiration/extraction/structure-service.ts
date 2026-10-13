import type {AbsoluteFsPath} from "nbook/server/runtime/paths/file-path";
import type {
    ExtractionStructureConfirmRequestDto,
    ExtractionStructureConfirmResponseDto,
    ExtractionStructurePreviewRequestDto,
    ExtractionStructurePreviewResponseDto,
} from "nbook/shared/dto/inspiration-extraction-api.dto";
import type {ExtractionSourceRef} from "nbook/shared/dto/inspiration-extraction-task.dto";
import type {
    ChapterCorrectionDto, ChapterRecognitionDto, ExtractionChapterDto, ExtractionStructureDto, VolumeDivisionDto,
} from "nbook/shared/dto/inspiration-outline-structure.dto";
import {
    applyChapterCorrections, buildExtractionStructure, planChunkChapters, recognizeChapters, suggestVolumeRanges,
} from "../outline-structure";
import {prepareInspirationSource} from "../source";

/**
 * 来源章节识别、修正与划卷的服务端入口（t03 纯函数的 HTTP 侧薄封装）。
 * 每次调用都从磁盘重读来源并重新识别：服务端不保存修正列表，来源哈希随结果返回，
 * 后续启动任务时再以磁盘为准复核，所以客户端手里的旧结构不可能悄悄用于变化后的文件。
 */

/** Agent 自动划卷时字数模式每卷的切分块数；用户在界面里按自己的意愿划卷。 */
export const DEFAULT_CHUNKS_PER_VOLUME = 5;

type RecognizedSource = Readonly<{
    source: ExtractionSourceRef;
    paragraphs: ReadonlyArray<Readonly<{id: string; text: string}>>;
    recognition: ChapterRecognitionDto;
    mode: ExtractionStructureDto["mode"];
}>;

async function recognizeSource(root: AbsoluteFsPath, path: string, corrections: readonly ChapterCorrectionDto[]): Promise<RecognizedSource> {
    const prepared = await prepareInspirationSource(root, path);
    const paragraphs = prepared.paragraphs.map(({id, text}) => ({id, text}));
    const recognition = applyChapterCorrections(paragraphs, recognizeChapters(paragraphs), corrections);
    return {
        source: {path: prepared.source.path, sha256: prepared.source.sha256},
        paragraphs,
        recognition,
        // 与 `buildExtractionStructure` 同一判据：没有可识别章节才进入字数模式。
        mode: recognition.chapters.length > 0 ? "chapters" : "chunks",
    };
}

function chaptersOf(recognized: RecognizedSource, targetCharacters: number | undefined): ExtractionChapterDto[] {
    if (recognized.mode === "chunks") return planChunkChapters(recognized.paragraphs, targetCharacters);
    return recognized.recognition.chapters.map(({index, title, firstParagraphId, lastParagraphId, characterCount}) => ({
        index, title, firstParagraphId, lastParagraphId, characterCount,
    }));
}

export async function previewExtractionStructure(
    root: AbsoluteFsPath,
    request: Pick<ExtractionStructurePreviewRequestDto, "path" | "corrections" | "mode" | "targetCharacters">,
): Promise<ExtractionStructurePreviewResponseDto> {
    const recognized = await recognizeSource(root, request.path, request.corrections);
    const mode = request.mode ?? recognized.mode;
    const chapters = mode === "chunks"
        ? planChunkChapters(recognized.paragraphs, request.targetCharacters, recognized.recognition)
        : recognized.recognition.chapters.map(({index, title, firstParagraphId, lastParagraphId, characterCount}) => ({index, title, firstParagraphId, lastParagraphId, characterCount}));
    return {
        source: recognized.source,
        mode,
        recognition: recognized.recognition,
        chapters,
        suggestedVolumes: mode === "chapters" ? suggestVolumeRanges(recognized.recognition) : [],
    };
}

function structureOf(recognized: RecognizedSource, division: VolumeDivisionDto, mode: ExtractionStructureDto["mode"] | undefined, targetCharacters: number | undefined): ExtractionStructureConfirmResponseDto {
    const structure = buildExtractionStructure({
        sourceSha256: recognized.source.sha256,
        paragraphs: recognized.paragraphs,
        recognition: recognized.recognition,
        division,
        mode,
        ...(targetCharacters === undefined ? {} : {targetCharacters}),
    });
    return {source: recognized.source, structure};
}

/** 校验用户的划卷（章节范围或字数模式 N）并返回可交给任务启动的提取结构；非法划卷抛 `OutlineStructureError`。 */
export async function confirmExtractionStructure(
    root: AbsoluteFsPath,
    request: Pick<ExtractionStructureConfirmRequestDto, "path" | "corrections" | "mode" | "targetCharacters" | "division">,
): Promise<ExtractionStructureConfirmResponseDto> {
    return structureOf(await recognizeSource(root, request.path, request.corrections), request.division, request.mode, request.targetCharacters);
}

/** Agent 下发大纲提取用：不修正章节，按建议划卷（字数模式用固定的每卷块数）。 */
export async function defaultExtractionStructure(root: AbsoluteFsPath, path: string): Promise<ExtractionStructureConfirmResponseDto> {
    const recognized = await recognizeSource(root, path, []);
    const division: VolumeDivisionDto = recognized.mode === "chapters"
        ? {mode: "chapters", volumes: suggestVolumeRanges(recognized.recognition)}
        : {mode: "chunks", chunksPerVolume: DEFAULT_CHUNKS_PER_VOLUME};
    return structureOf(recognized, division, undefined, undefined);
}
