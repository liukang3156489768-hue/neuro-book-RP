import {promises as fs} from "node:fs";
import {join, relative} from "node:path";

interface LorebookEntry {
    path: string;
    title: string;
    type: string;
}

interface LorebookTree {
    [type: string]: LorebookEntry[];
}

export default defineEventHandler(async (event): Promise<{tree: LorebookTree}> => {
    const query = getQuery(event);
    const projectRoot = String(query.projectRoot ?? "");

    if (!projectRoot) {
        throw createError({
            statusCode: 400,
            message: "projectRoot is required",
        });
    }

    const lorebookDir = join(projectRoot, "lorebook");

    // 检查 lorebook 目录是否存在
    try {
        await fs.access(lorebookDir);
    } catch {
        // lorebook 目录不存在，返回空树
        return {tree: {}};
    }

    const tree: LorebookTree = {};

    try {
        const types = await fs.readdir(lorebookDir, {withFileTypes: true});

        for (const typeEntry of types) {
            if (!typeEntry.isDirectory()) {
                continue;
            }

            const typeName = typeEntry.name;
            const typeDir = join(lorebookDir, typeName);

            try {
                const files = await fs.readdir(typeDir);
                const entries: LorebookEntry[] = [];

                for (const file of files) {
                    if (!file.endsWith(".md")) {
                        continue;
                    }

                    const filePath = join(typeDir, file);
                    const relativePath = relative(projectRoot, filePath).replace(/\\/g, "/");

                    try {
                        const content = await fs.readFile(filePath, "utf-8");
                        const title = extractTitle(content, file);

                        entries.push({
                            path: relativePath,
                            title,
                            type: typeName,
                        });
                    } catch (error) {
                        // 跳过无法读取的文件
                        console.warn(`Failed to read lorebook file: ${relativePath}`, error);
                    }
                }

                if (entries.length > 0) {
                    tree[typeName] = entries.sort((a, b) => a.title.localeCompare(b.title));
                }
            } catch (error) {
                // 跳过无法读取的目录
                console.warn(`Failed to read lorebook type directory: ${typeName}`, error);
            }
        }
    } catch (error) {
        console.error("Failed to scan lorebook directory:", error);
        throw createError({
            statusCode: 500,
            message: "Failed to scan lorebook directory",
        });
    }

    return {tree};
});

/**
 * 从 Markdown 内容中提取标题。
 * 优先从 frontmatter 的 title 字段提取，其次使用第一个一级标题，最后使用文件名。
 */
function extractTitle(content: string, filename: string): string {
    // 尝试从 frontmatter 提取 title
    const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    if (frontmatterMatch) {
        const frontmatter = frontmatterMatch[1];
        const titleMatch = /^title:\s*(.+)$/m.exec(frontmatter ?? "");
        if (titleMatch) {
            return titleMatch[1]!.trim().replace(/^["']|["']$/g, "");
        }
    }

    // 尝试提取第一个一级标题
    const headingMatch = /^#\s+(.+)$/m.exec(content);
    if (headingMatch) {
        return headingMatch[1]!.trim();
    }

    // 使用文件名（去除 .md 扩展名）
    return filename.replace(/\.md$/, "");
}
