import fs from "node:fs/promises";
import path from "node:path";
import {parseMarkdownDocument} from "nbook/server/workspace-files/workspace-files";
import {assertRealPathContained, resolveContainedFilePath, type AbsoluteFsPath} from "nbook/server/runtime/paths/file-path";
import type {InspirationCategory} from "nbook/shared/dto/inspiration.dto";

const CATEGORIES = new Set<InspirationCategory>(["character", "faction", "instruction", "item", "location", "note", "system", "world"]);

export class LorebookPathError extends Error {
    constructor(public readonly code: "INVALID" | "NOT_FOUND" | "AMBIGUOUS", message: string, public readonly candidates: readonly string[] = []) {
        super(message);
        this.name = "LorebookPathError";
    }
}

export type ResolvedLorebookFile = Readonly<{
    requestedPath: string;
    canonicalPath: string;
    category: InspirationCategory;
    absolutePath: AbsoluteFsPath;
    stat: Awaited<ReturnType<typeof fs.lstat>>;
}>;

export function normalizeLorebookPath(input: string): string {
    const normalized = input.trim().replace(/\\/gu, "/").replace(/\/+$/u, "");
    const segments = normalized.split("/");
    if (!normalized || normalized.startsWith("/") || segments.some(segment => !segment || segment === "." || segment === ".." || segment.includes(":"))) {
        throw new LorebookPathError("INVALID", "素材路径无效");
    }
    const [root, category] = segments;
    if (root !== "lorebook" || !CATEGORIES.has(category as InspirationCategory) || segments.length < 3) {
        throw new LorebookPathError("INVALID", "素材路径必须位于当前项目 lorebook 分类下");
    }
    return normalized;
}

/** 将目录、稳定 ID 或标题引用解析为同一份 lorebook/index.md。 */
export async function resolveLorebookFile(root: AbsoluteFsPath, requested: string): Promise<ResolvedLorebookFile> {
    const normalized = normalizeLorebookPath(requested);
    const category = normalized.split("/")[1] as InspirationCategory;
    const direct = await resolveDirect(root, normalized);
    if (direct) return {...direct, requestedPath: requested};

    const identifier = normalized.split("/").slice(2).join("/").replace(/\/index\.md$/u, "").replace(/\.md$/u, "");
    const matches = await findMetadataMatches(root, category, identifier);
    if (matches.length === 0) throw new LorebookPathError("NOT_FOUND", `参考素材不存在：${requested}`);
    if (matches.length > 1) throw new LorebookPathError("AMBIGUOUS", `参考素材名称对应多个素材，请使用稳定 ID 路径：${requested}`, matches.map(item => item.canonicalPath));
    return {...matches[0]!, requestedPath: requested};
}

async function resolveDirect(root: AbsoluteFsPath, normalized: string): Promise<Omit<ResolvedLorebookFile, "requestedPath"> | null> {
    const absolute = resolveContainedFilePath(root, normalized);
    const stat = await safeLstat(root, absolute);
    if (!stat) return null;
    if (stat.isDirectory()) {
        const index = `${normalized}/index.md`;
        const indexed = resolveContainedFilePath(root, index);
        const indexStat = await safeLstat(root, indexed);
        if (!indexStat) return null;
        if (!indexStat.isFile() || !indexStat.nlink || indexStat.nlink !== 1) throw new LorebookPathError("INVALID", `参考素材不是普通文件：${index}`);
        return {canonicalPath: index, category: normalized.split("/")[1] as InspirationCategory, absolutePath: indexed, stat: indexStat};
    }
    if (!stat.isFile()) throw new LorebookPathError("INVALID", `参考素材不是文件：${normalized}`);
    if (!normalized.endsWith(".md")) throw new LorebookPathError("INVALID", `参考素材必须是 Markdown 文件：${normalized}`);
    if (stat.nlink !== 1) throw new LorebookPathError("INVALID", `参考素材不能是硬链接：${normalized}`);
    await assertRealPathContained(root, absolute);
    return {canonicalPath: normalized, category: normalized.split("/")[1] as InspirationCategory, absolutePath: absolute, stat};
}

async function safeLstat(root: AbsoluteFsPath, target: AbsoluteFsPath) {
    const relative = path.relative(root, target);
    let cursor = root;
    for (const segment of relative.split(path.sep)) {
        if (!segment) continue;
        cursor = resolveContainedFilePath(cursor, segment);
        const ancestor = await fs.lstat(cursor).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
        });
        if (ancestor?.isSymbolicLink()) throw new LorebookPathError("INVALID", "素材路径不能经过符号链接");
    }
    await assertRealPathContained(root, target);
    const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
    });
    if (stat?.isSymbolicLink()) throw new LorebookPathError("INVALID", "素材路径不能经过符号链接");
    return stat;
}

async function findMetadataMatches(root: AbsoluteFsPath, category: InspirationCategory, identifier: string): Promise<ResolvedLorebookFile[]> {
    const base = `lorebook/${category}`;
    const matches: ResolvedLorebookFile[] = [];
    const visit = async (relative: string): Promise<void> => {
        const absolute = resolveContainedFilePath(root, relative);
        const entries = await fs.readdir(absolute, {withFileTypes: true}).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return [];
            throw error;
        });
        for (const entry of entries) {
            if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
            const child = `${relative}/${entry.name}`;
            if (entry.isDirectory()) {
                const index = `${child}/index.md`;
                const indexStat = await safeLstat(root, resolveContainedFilePath(root, index));
                if (indexStat?.isFile() && indexStat.nlink === 1 && await metadataMatches(root, index, identifier, child)) {
                    matches.push({requestedPath: index, canonicalPath: index, category, absolutePath: resolveContainedFilePath(root, index), stat: indexStat});
                }
                await visit(child);
            }
        }
    };
    await visit(base);
    return matches;
}

async function metadataMatches(root: AbsoluteFsPath, indexPath: string, identifier: string, directoryPath: string): Promise<boolean> {
    const directoryIdentifier = directoryPath.split("/").slice(2).join("/");
    if (identifier === directoryIdentifier) return true;
    const content = await fs.readFile(resolveContainedFilePath(root, indexPath), "utf8");
    const document = parseMarkdownDocument(content);
    if (document.error) return false;
    const frontmatter = document.frontmatter as Record<string, unknown>;
    const id = typeof frontmatter.id === "string" ? frontmatter.id.trim() : "";
    const title = typeof frontmatter.title === "string" ? frontmatter.title.trim() : "";
    const aliases = Array.isArray(frontmatter.aliases) ? frontmatter.aliases.filter((value): value is string => typeof value === "string") : [];
    const ext = frontmatter.ext as Record<string, unknown> | undefined;
    const inspiration = ext?.inspiration as Record<string, unknown> | undefined;
    const artifactId = typeof inspiration?.artifactId === "string" ? inspiration.artifactId : "";
    return [id, title, ...aliases, artifactId].some(value => value === identifier);
}
