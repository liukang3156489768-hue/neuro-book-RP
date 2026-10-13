import type {WriterChapterContext} from "nbook/server/outline/writer-context";

const LOREBOOK_ROOT = "lorebook/";
/** 伏笔定义含后续剧情走向，助手读到后可能把尚未揭示的信息写进要素，写手就会提前泄露。 */
const FORESHADOWING_ROOT = "outline/foreshadowing/";

export function normalizeAssistantPath(path: string): string | null {
    const normalized = path.trim().replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
    const segments = normalized.split("/");
    if (normalized === "" || normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)
        || segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
    return normalized;
}

/** 本章交接中列出的参考路径；只有这些路径和 `lorebook/` 属于助手的可读范围。 */
export function chapterReferencePaths(context: WriterChapterContext): string[] {
    const paths = [context.chapter, ...context.details].flatMap((entry) => [
        ...entry.materialRefs,
        ...entry.references.flatMap(({path}) => path === undefined ? [] : [path]),
    ]);
    return [...new Set(paths.flatMap((path) => normalizeAssistantPath(path) ?? []))];
}

/**
 * 助手的可读范围：`lorebook/`（含 `lorebook/instruction/`）与本章交接列出的参考路径。
 * 伏笔定义即使被列为参考也拒绝。
 */
export function assistantCanRead(path: string, referencePaths: readonly string[]): boolean {
    const normalized = normalizeAssistantPath(path);
    if (normalized === null || normalized.startsWith(FORESHADOWING_ROOT)) return false;
    return normalized.startsWith(LOREBOOK_ROOT) || referencePaths.some(reference => normalizeAssistantPath(reference) === normalized);
}
