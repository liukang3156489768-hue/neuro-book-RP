import {open, stat} from "node:fs/promises";
import {resolveContainedFilePath, relativeRealPathInside, type AbsoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {isEditableTextPath} from "nbook/server/workspace-files/workspace-files";
import {contentHash, type OutlineId} from "./format";
import {OutlineLineError} from "./line-planning";
import type {WriterChapterContext} from "./writer-context";

type MaterialSource = Readonly<{entryId: OutlineId; entryVersion: number;
    entryContentHash: string; entryPath: string; field: "materialRefs" | "references"}>;

const MAX_MATERIALS = 8;
const MAX_MATERIAL_BYTES = 64 * 1024;

type PreparedMaterial = Readonly<{
    root: AbsoluteFsPath;
    path: string;
    target: AbsoluteFsPath;
    sources: readonly MaterialSource[];
}>;

/**
 * 素材引用使用 parser 已接受的 portable 相对路径；这里再次校验是为了不把
 * 未经 parser 的调用方输入当成另一条文件系统路径。
 */
function normalizeMaterialPath(value: string): string {
    if (typeof value !== "string" || value.length === 0 || value !== value.trim()
        || value.startsWith("/") || value.includes("\\")) {
        throw new OutlineLineError("素材路径必须是规范化的项目内相对路径");
    }
    const segments = value.split("/");
    if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".."
        || /[<>:"|?*\x00-\x1f]/u.test(segment))) {
        throw new OutlineLineError("素材路径必须是规范化的项目内相对路径");
    }
    return segments.join("/");
}

function samePortablePath(left: string, right: string): boolean {
    return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isPlanningControlPath(relativePath: string): boolean {
    const firstSegment = relativePath.split("/", 1)[0] ?? "";
    const normalized = process.platform === "win32" ? firstSegment.toLowerCase() : firstSegment;
    return normalized === "outline" || normalized === ".nbook";
}

function rejectIfTooLarge(size: number): void {
    if (size > MAX_MATERIAL_BYTES) throw new OutlineLineError("所选素材过大，请缩小素材文件");
}

async function validatePreparedMaterial(material: PreparedMaterial): Promise<void> {
    let canonical: string | null;
    try {
        canonical = await relativeRealPathInside(material.root, material.target);
    } catch {
        throw new OutlineLineError("所选素材不存在或无法验证真实路径");
    }
    if (!canonical || !samePortablePath(canonical, material.path) || isPlanningControlPath(canonical)) {
        throw new OutlineLineError("素材路径存在链接别名或指向规划控制文件");
    }
    let metadata;
    try {
        metadata = await stat(material.target);
    } catch {
        throw new OutlineLineError("所选素材不存在或无法读取");
    }
    if (!metadata.isFile() || metadata.nlink > 1) {
        throw new OutlineLineError("素材文件不是独立普通文件，拒绝链接读取");
    }
    if (!isEditableTextPath(material.target)) {
        throw new OutlineLineError("所选素材不是可读取的文本文件");
    }
    rejectIfTooLarge(metadata.size);
}

async function readPreparedMaterial(material: PreparedMaterial): Promise<string> {
    const handle = await open(material.target, "r");
    try {
        const before = await handle.stat();
        if (!before.isFile() || before.nlink > 1) {
            throw new OutlineLineError("素材文件不是独立普通文件，拒绝链接读取");
        }
        rejectIfTooLarge(before.size);

        let canonical: string | null;
        try {
            canonical = await relativeRealPathInside(material.root, material.target);
        } catch {
            throw new OutlineLineError("素材路径在读取期间失效，拒绝返回内容");
        }
        if (!canonical || !samePortablePath(canonical, material.path) || isPlanningControlPath(canonical)) {
            throw new OutlineLineError("素材路径在读取期间变成链接别名或规划控制文件");
        }

        // 只向内存读取上限加一个字节，避免文件在 stat 后增长时先分配无界内容。
        const buffer = Buffer.allocUnsafe(MAX_MATERIAL_BYTES + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
            const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
            if (result.bytesRead === 0) break;
            bytesRead += result.bytesRead;
        }
        const after = await handle.stat();
        rejectIfTooLarge(after.size);
        if (after.size !== before.size || bytesRead !== after.size) {
            throw new OutlineLineError("素材在读取期间发生变化，拒绝返回不完整内容");
        }

        try {
            const bytes = buffer.subarray(0, bytesRead);
            if (bytes.includes(0)) throw new OutlineLineError("所选素材不是可读取的文本文件");
            return new TextDecoder("utf-8", {fatal: true}).decode(bytes);
        } catch (error) {
            if (error instanceof OutlineLineError) throw error;
            throw new OutlineLineError("所选素材不是有效的 UTF-8 文本");
        }
    } finally {
        await handle.close();
    }
}

/** 素材索引是正式条目的选择清单，而非 writer 任意路径读取权限。 */
export async function readSelectedWriterMaterials(
    projectRoot: AbsoluteFsPath,
    context: WriterChapterContext,
    selectedPaths: readonly string[],
): Promise<readonly Readonly<{path: string; content: string; contentHash: string; sources: readonly MaterialSource[]}>[]> {
    if (selectedPaths.length === 0 || selectedPaths.length > MAX_MATERIALS
        || !selectedPaths.every((value) => typeof value === "string")) {
        throw new OutlineLineError("素材读取必须指定 1 至 8 个不重复的正式来源路径");
    }
    const normalizedSelections = selectedPaths.map((selected) => {
        const normalized = normalizeMaterialPath(selected);
        if (normalized !== selected) throw new OutlineLineError("素材路径必须使用规范化的项目相对路径");
        return normalized;
    });
    if (new Set(normalizedSelections).size !== normalizedSelections.length) {
        throw new OutlineLineError("素材读取必须指定 1 至 8 个不重复的正式来源路径");
    }
    const sourcesByPath = new Map<string, MaterialSource[]>();
    for (const entry of [context.chapter, ...context.details]) {
        // 待补参考文件没有可读来源，不能被当成正式素材读取。
        // 段落参考可以在多个段落复用同一资料，来源审计按条目去重。
        const referencePaths = [...new Set(entry.references.flatMap((reference) => reference.pending === true || reference.path === undefined ? [] : [reference.path]))];
        for (const [field, refs] of [["materialRefs", entry.materialRefs], ["references", referencePaths]] as const) {
            for (const ref of refs) {
                const normalized = normalizeMaterialPath(ref);
                const source: MaterialSource = {entryId: entry.entryId,
                    entryVersion: entry.version, entryContentHash: entry.contentHash, entryPath: entry.path, field};
                const current = sourcesByPath.get(normalized);
                if (current) current.push(source);
                else sourcesByPath.set(normalized, [source]);
            }
        }
    }
    const prepared: PreparedMaterial[] = [];
    for (const selected of normalizedSelections) {
        const sources = sourcesByPath.get(selected);
        if (!sources) throw new OutlineLineError("所选素材未被本章正式章节大纲或细纲引用");
        let target: AbsoluteFsPath;
        try {
            target = resolveContainedFilePath(projectRoot, selected);
        } catch {
            throw new OutlineLineError("素材路径越过当前 Project 根目录");
        }
        prepared.push({root: projectRoot, path: selected, target, sources});
    }
    // 先完整预检全部输入，再开始读取，避免一次请求先读出部分内容后才发现后续路径无效。
    for (const material of prepared) await validatePreparedMaterial(material);

    const results: {path: string; content: string; contentHash: string; sources: readonly MaterialSource[]}[] = [];
    for (const material of prepared) {
        const content = await readPreparedMaterial(material);
        results.push({path: material.path, content, contentHash: contentHash(content), sources: material.sources});
    }
    return results;
}
