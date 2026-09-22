import {createHash} from "node:crypto";
import {constants, type Stats} from "node:fs";
import {lstat, open, readdir} from "node:fs/promises";
import path from "node:path";
import {createError} from "h3";
import {
    assertRealPathContained,
    resolveContainedFilePath,
    type AbsoluteFsPath,
} from "nbook/server/runtime/paths/file-path";
import {
    INSPIRATION_SOURCE_EXTENSIONS,
    INSPIRATION_SOURCE_MAX_BYTES,
    INSPIRATION_SOURCE_TARGET_CHARACTERS,
    InspirationSourcePathSchema,
    type InspirationSourceFileDto,
    type InspirationSourceListResponseDto,
    type InspirationSourcePrepareResponseDto,
} from "nbook/shared/dto/inspiration-source.dto";
import {splitInspirationSource} from "./source-split";

function sourceError(statusCode: number, code: string, message: string, cause?: unknown): Error {
    return createError({statusCode, message, data: {code}, cause});
}

function isMissing(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isSourceError(error: unknown): boolean {
    return typeof error === "object" && error !== null && "statusCode" in error;
}

/** Reject links even when they point back inside reference, keeping the displayed path unambiguous. */
async function inspectSourcePath(root: AbsoluteFsPath, relativePath: string): Promise<{absolutePath: AbsoluteFsPath; stat: Stats}> {
    let absolutePath = root;
    let stat: Stats | undefined;
    const segments = relativePath.split("/");
    for (let index = 0; index < segments.length; index += 1) {
        absolutePath = resolveContainedFilePath(absolutePath, segments[index]!);
        stat = await lstat(absolutePath);
        if (stat.isSymbolicLink()) {
            throw sourceError(400, "INSPIRATION_SOURCE_LINK", "作品来源不能使用符号链接或目录联接，请将实际文件放入 reference 目录。");
        }
        if (index < segments.length - 1 && !stat.isDirectory()) {
            throw sourceError(400, "INSPIRATION_SOURCE_PATH", "作品来源路径中的目录不可用，请重新选择文件。");
        }
    }
    await assertRealPathContained(root, absolutePath);
    if (!stat) throw sourceError(400, "INSPIRATION_SOURCE_PATH", "作品来源路径不能为空。");
    return {absolutePath, stat};
}

function sourceFile(relativePath: string, stat: Stats): InspirationSourceFileDto {
    return {path: relativePath, name: path.posix.basename(relativePath), bytes: stat.size, mtimeMs: stat.mtimeMs};
}

/** Lists supported regular files without reading their bodies; encoding is validated when preparing. */
export async function listInspirationSources(root: AbsoluteFsPath): Promise<InspirationSourceListResponseDto> {
    const sources: InspirationSourceFileDto[] = [];
    try {
        const reference = await inspectSourcePath(root, "reference");
        if (!reference.stat.isDirectory()) {
            throw sourceError(400, "INSPIRATION_SOURCE_PATH", "当前项目的 reference 不是目录，请修复后重试。");
        }
        const pending = ["reference"];
        while (pending.length > 0) {
            const directory = pending.pop()!;
            const inspected = await inspectSourcePath(root, directory);
            const entries = await readdir(inspected.absolutePath, {withFileTypes: true});
            for (const entry of entries) {
                if (entry.isSymbolicLink()) continue;
                const relativePath = `${directory}/${entry.name}`;
                if (entry.isDirectory()) {
                    pending.push(relativePath);
                } else if (entry.isFile() && InspirationSourcePathSchema.safeParse(relativePath).success) {
                    const file = await inspectSourcePath(root, relativePath);
                    if (file.stat.isFile()) sources.push(sourceFile(relativePath, file.stat));
                }
            }
        }
    } catch (error) {
        // An absent reference directory is a valid new-project state; disappearing selected files are errors.
        if (!isMissing(error)) {
            if (isSourceError(error)) throw error;
            throw sourceError(400, "INSPIRATION_SOURCE_UNREADABLE", "无法读取作品来源目录，请检查访问权限后重试。", error);
        }
        const reference = resolveContainedFilePath(root, "reference");
        try {
            await lstat(reference);
        } catch (referenceError) {
            if (isMissing(referenceError)) return sourceListResponse([]);
            throw sourceError(400, "INSPIRATION_SOURCE_UNREADABLE", "无法读取作品来源目录，请检查访问权限后重试。", referenceError);
        }
        throw sourceError(409, "INSPIRATION_SOURCE_CHANGED", "作品来源目录在扫描时发生变化，请刷新列表后重试。", error);
    }
    return sourceListResponse(sources.sort((left, right) => left.path.localeCompare(right.path, "zh-CN")));
}

function sourceListResponse(sources: InspirationSourceFileDto[]): InspirationSourceListResponseDto {
    return {
        sources,
        maxBytes: INSPIRATION_SOURCE_MAX_BYTES,
        targetCharacters: INSPIRATION_SOURCE_TARGET_CHARACTERS,
        supportedExtensions: [...INSPIRATION_SOURCE_EXTENSIONS],
    };
}

function sameFile(left: Stats, right: Stats): boolean {
    return left.dev === right.dev && left.ino === right.ino
        && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

/** Read-only snapshot: a bounded descriptor read, strict UTF-8 decode, and exact source-to-paragraph map. */
export async function prepareInspirationSource(root: AbsoluteFsPath, sourcePath: string): Promise<InspirationSourcePrepareResponseDto> {
    const parsedPath = InspirationSourcePathSchema.safeParse(sourcePath);
    if (!parsedPath.success) {
        throw sourceError(400, "INSPIRATION_SOURCE_PATH", "请选择当前项目 reference 目录内的 .txt 或 .md 文件。");
    }
    try {
        const inspected = await inspectSourcePath(root, parsedPath.data);
        if (!inspected.stat.isFile()) {
            throw sourceError(400, "INSPIRATION_SOURCE_PATH", "请选择实际的作品文本文件。");
        }
        if (inspected.stat.size > INSPIRATION_SOURCE_MAX_BYTES) {
            throw sourceError(413, "INSPIRATION_SOURCE_TOO_LARGE", "作品文件超过 5 MiB，请先按完整章节拆成较小的 UTF-8 文件后重试。");
        }
        const file = await open(inspected.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let buffer: Buffer;
        try {
            const openedStat = await file.stat();
            if (!openedStat.isFile() || !sameFile(inspected.stat, openedStat)) {
                throw sourceError(409, "INSPIRATION_SOURCE_CHANGED", "作品文件在读取前发生变化，请重新选择文件。");
            }
            // The extra byte detects growth without letting concurrent writes allocate beyond the cap.
            const bounded = Buffer.allocUnsafe(inspected.stat.size + 1);
            let bytesRead = 0;
            while (bytesRead < bounded.length) {
                const read = await file.read(bounded, bytesRead, bounded.length - bytesRead, bytesRead);
                if (read.bytesRead === 0) break;
                bytesRead += read.bytesRead;
            }
            const afterRead = await file.stat();
            const current = await inspectSourcePath(root, parsedPath.data);
            if (bytesRead !== inspected.stat.size || !sameFile(openedStat, afterRead) || !sameFile(openedStat, current.stat)) {
                throw sourceError(409, "INSPIRATION_SOURCE_CHANGED", "作品文件在读取时发生变化，请稍后重试。");
            }
            buffer = bounded.subarray(0, bytesRead);
        } finally {
            await file.close();
        }
        let text: string;
        try {
            // Preserve the BOM as source text so reconstruction remains byte-for-byte faithful.
            text = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(buffer);
        } catch (error) {
            throw sourceError(415, "INSPIRATION_SOURCE_ENCODING", "作品文件不是有效的 UTF-8 文本，请转换为 UTF-8 后重试。", error);
        }
        if (text.includes("\0")) {
            throw sourceError(415, "INSPIRATION_SOURCE_ENCODING", "作品文件包含二进制内容，请选择 UTF-8 文本文件。");
        }
        if (!text.trim()) {
            throw sourceError(400, "INSPIRATION_SOURCE_EMPTY", "作品文件没有可切分的正文，请选择包含内容的文件。");
        }
        return {
            source: {...sourceFile(parsedPath.data, inspected.stat), sha256: createHash("sha256").update(buffer).digest("hex")},
            targetCharacters: INSPIRATION_SOURCE_TARGET_CHARACTERS,
            ...splitInspirationSource(text),
        };
    } catch (error) {
        if (isSourceError(error)) throw error;
        if (isMissing(error)) {
            throw sourceError(404, "INSPIRATION_SOURCE_NOT_FOUND", "作品文件已不存在，请刷新列表后重新选择。", error);
        }
        throw sourceError(400, "INSPIRATION_SOURCE_UNREADABLE", "无法安全读取作品文件，请检查路径和访问权限后重试。", error);
    }
}
