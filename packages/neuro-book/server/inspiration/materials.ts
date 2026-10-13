import {createHash} from "node:crypto";
import {constants, type Stats} from "node:fs";
import {createError} from "h3";
import {lstat, open, readdir} from "node:fs/promises";
import path from "node:path";
import {parseMarkdownDocument} from "nbook/server/workspace-files/workspace-files";
import {INSPIRATION_CATEGORIES, InspirationMaterialListRequestSchema, InspirationMaterialPathSchema, InspirationMaterialSourceSchema, type InspirationMaterialListRequestDto, type InspirationCategory, type InspirationMaterialListDto, type InspirationMaterialSourceDto} from "nbook/shared/dto/inspiration.dto";
import {absoluteFsPath, assertRealPathContained, resolveContainedFilePath, type AbsoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {resolveLorebookFile} from "./lorebook-path";

const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_SOURCES = 12;
const MAX_TOTAL_CONTENT = 160_000;

/**
 * 列表阶段只读取目录信息，包含角色子文件和分类笔记，但不把未选素材正文放入上下文。
 */
async function listMaterials(
    projectRootAbs: string,
    input: Pick<InspirationMaterialListRequestDto, "category" | "query" | "offset" | "limit">,
): Promise<InspirationMaterialListDto> {
    const root = absoluteFsPath(projectRootAbs);
    const parsed = InspirationMaterialListRequestSchema.omit({projectRoot: true}).safeParse(input);
    if (!parsed.success) throw new Error("素材列表参数无效");
    const query = parsed.data.query?.trim().toLocaleLowerCase("zh-CN");
    const categories = parsed.data.category ? [parsed.data.category] : INSPIRATION_CATEGORIES;
    const items: InspirationMaterialListDto["items"] = [];
    for (const category of categories) {
        const pending = [`lorebook/${category}`];
        while (pending.length) {
            const categoryPath = pending.pop()!;
            const entries = await readDirectory(root, categoryPath);
            for (const entry of entries) {
                if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
                const relativePath = `${categoryPath}/${entry.name}`;
                if (entry.isDirectory()) { pending.push(relativePath); continue; }
                if (!entry.isFile() || !InspirationMaterialPathSchema.safeParse(relativePath).success) continue;
                if (!(await isRegularFile(root, relativePath))) continue;
                const title = entry.name === "index.md" ? path.posix.basename(categoryPath) : entry.name.slice(0, -3);
                if (query && !`${category} ${title} ${relativePath}`.toLocaleLowerCase("zh-CN").includes(query)) continue;
                items.push({path: relativePath, category, title});
            }
        }
    }
    items.sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
    const {offset, limit} = parsed.data;
    const selected = items.slice(offset, offset + limit);
    return {items: selected, total: items.length, nextOffset: offset + selected.length < items.length ? offset + selected.length : null};
}

/** 按用户明确选择的相对路径读取完整素材；每个文件和整个请求都有硬上限，不做截断。 */
async function readMaterials(
    projectRootAbs: string, paths: readonly string[], signal: AbortSignal,
): Promise<InspirationMaterialSourceDto[]> {
    if (paths.length === 0 || paths.length > MAX_SOURCES || new Set(paths.map(value => value.toLowerCase())).size !== paths.length) {
        throw new Error("参考素材最多选择 12 份且不能重复");
    }
    const root = absoluteFsPath(projectRootAbs);
    const results: InspirationMaterialSourceDto[] = [];
    let total = 0;
    for (const relativePath of paths) {
        throwIfAborted(signal);
        const resolved = await resolveMaterialFile(root, relativePath);
        const {category, absolutePath, stat, canonicalPath} = resolved;
        const bytes = await readStableFile(absolutePath, signal, root, canonicalPath, stat);
        if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error(`参考素材超过 5 MiB：${relativePath}`);
        const decoded = decodeUtf8(bytes, relativePath);
        const document = parseMarkdownDocument(decoded);
        if (document.error) throw new Error(`参考素材 frontmatter 无法解析：${relativePath}`);
        if (!document.body.trim()) throw new Error(`参考素材正文为空：${relativePath}`);
        if (document.body.length > 60_000) throw new Error(`参考素材正文超过 60,000 字符：${relativePath}`);
        total += document.body.length;
        if (total > MAX_TOTAL_CONTENT) throw new Error("参考素材正文总量超过 160,000 字符，请减少选择");
        const title = typeof document.frontmatter.title === "string" && document.frontmatter.title.trim()
            ? document.frontmatter.title.trim()
            : path.posix.basename(relativePath, ".md") === "index"
                ? path.posix.basename(path.posix.dirname(relativePath))
                : path.posix.basename(relativePath, ".md");
        const source = InspirationMaterialSourceSchema.parse({
            path: canonicalPath, category, title,
            sha256: createHash("sha256").update(bytes).digest("hex"), content: document.body,
        });
        results.push(source);
    }
    return results;
}

async function resolveMaterialFile(root: AbsoluteFsPath, relativePath: string): Promise<{category: InspirationCategory; absolutePath: AbsoluteFsPath; stat: Stats; canonicalPath: string}> {
    if (!InspirationMaterialPathSchema.safeParse(relativePath).success) throw new Error("参考素材路径必须位于当前项目 lorebook 分类下");
    try {
        return await resolveLorebookFile(root, relativePath) as {category: InspirationCategory; absolutePath: AbsoluteFsPath; stat: Stats; canonicalPath: string};
    } catch (error) {
        if (error instanceof Error && "code" in error && (error as {code?: string}).code === "NOT_FOUND") throw createError({statusCode: 404, message: `参考素材不存在：${relativePath}`});
        throw error;
    }
}

function sameFile(a: Stats, b: Stats): boolean {
    return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

async function readStableFile(filePath: AbsoluteFsPath, signal: AbortSignal, root: AbsoluteFsPath, relativePath: string, initial: Stats): Promise<Buffer> {
    throwIfAborted(signal);
    if (!initial.isFile() || initial.nlink !== 1) throw new Error("参考素材文件身份无效");
    if (initial.size > MAX_SOURCE_BYTES) throw new Error("参考素材文件超过 5 MiB");
    const file = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const opened = await file.stat();
        if (!opened.isFile() || !sameFile(initial, opened) || opened.nlink !== 1) throw new Error("参考素材在读取前发生变化");
        const buffer = Buffer.allocUnsafe(opened.size);
        let offset = 0;
        while (offset < buffer.length) {
            throwIfAborted(signal);
            const read = await file.read(buffer, offset, buffer.length - offset, offset);
            if (read.bytesRead === 0) throw new Error("参考素材在读取时被截断");
            offset += read.bytesRead;
        }
        const after = await file.stat();
        const current = await resolveMaterialFile(root, relativePath);
        if (!sameFile(opened, after) || !sameFile(opened, await lstat(current.absolutePath)) || after.nlink !== 1) {
            throw new Error("参考素材在读取时发生变化");
        }
        return buffer;
    } finally {
        await file.close();
    }
}

async function readDirectory(root: AbsoluteFsPath, relativePath: string) {
    const target = resolveContainedFilePath(root, relativePath);
    let cursor = root;
    for (const segment of relativePath.split("/")) {
        cursor = resolveContainedFilePath(cursor, segment);
        let ancestor;
        try { ancestor = await lstat(cursor); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
        if (ancestor.isSymbolicLink() || !ancestor.isDirectory()) throw new Error(`素材目录不能经过链接或无效目录：${relativePath}`);
    }
    await assertRealPathContained(root, target);
    const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
    });
    if (!stat) return [];
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`素材分类目录无效：${relativePath}`);
    return readdir(target, {withFileTypes: true});
}

async function isRegularFile(root: AbsoluteFsPath, relativePath: string): Promise<boolean> {
    try {
        const resolved = await resolveMaterialFile(root, relativePath);
        return (await lstat(resolved.absolutePath)).isFile();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

function decodeUtf8(bytes: Buffer, relativePath: string): string {
    try {
        const text = new TextDecoder("utf-8", {fatal: true}).decode(bytes);
        if (text.includes("\0")) throw new Error("binary");
        return text;
    } catch (error) {
        throw new Error(`参考素材不是有效 UTF-8 文本：${relativePath}`, {cause: error});
    }
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("参考素材读取已取消");
}

function readingError(error: unknown): Error {
    if (error instanceof Error && "statusCode" in error) return error;
    return createError({statusCode: 400, message: error instanceof Error ? error.message : "无法读取参考素材", data: {code: "INSPIRATION_MATERIAL_INVALID"}, cause: error});
}

export async function listInspirationMaterials(projectRootAbs: string,
    input: Pick<InspirationMaterialListRequestDto, "category" | "query" | "offset" | "limit">): Promise<InspirationMaterialListDto> {
    try { return await listMaterials(projectRootAbs, input); } catch (error) { throw readingError(error); }
}

export async function readInspirationMaterials(projectRootAbs: string, paths: readonly string[], signal: AbortSignal): Promise<InspirationMaterialSourceDto[]> {
    try { return await readMaterials(projectRootAbs, paths, signal); }
    catch (error) { if (signal.aborted) throw error; throw readingError(error); }
}
