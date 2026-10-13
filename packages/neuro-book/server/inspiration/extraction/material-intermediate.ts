import {readdir} from "node:fs/promises";
import path from "node:path";
import type {z} from "zod";
import {withProjectTargetMutation} from "nbook/server/workspace-files/project-open-guard";
import {deleteWorkspacePath, readWorkspaceTextFile, workspacePathExists, writeWorkspaceTextFile} from "nbook/server/workspace-files/workspace-files";
import type {WorkspaceFileTarget} from "nbook/server/workspace-files/workspace-file-target";

/**
 * 素材提取任务目录 `.nbook/inspiration/extractions/<任务 ID>/` 下的中间产物读写。
 *
 * 中间产物是项目内部状态而不是内容节点，与任务记录一致使用不记账的 `writeWorkspaceTextFile`
 * （每个片段都进工作区历史会淹没真正的创作记录）；写入与删除经项目 mutation gate。
 * 单元的所有变更放进同一次 `commit`，取消发生在 `commit` 之前时磁盘不留半截产物。
 */

const EXTRACTIONS_DIRECTORY = ".nbook/inspiration/extractions";
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type IntermediateChange = Readonly<{
    /** 先删除；不存在的路径忽略。目录递归删除。 */
    remove?: readonly string[];
    write?: ReadonlyArray<Readonly<{path: string; data: unknown}>>;
}>;

export interface MaterialIntermediate {
    /** 不存在返回 null；内容不符合 schema 时抛错（中间产物损坏不应被静默当作空）。 */
    readJson<T>(relativePath: string, schema: z.ZodType<T>): Promise<T | null>;
    /** 目录下的条目名；目录不存在返回空数组。 */
    list(relativeDirectory: string): Promise<string[]>;
    commit(change: IntermediateChange): Promise<void>;
}

function isMissing(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function resolveRelative(taskId: string, relativePath: string): string {
    // 路径由任务 ID 与流水线自己拼出的段落拼成；仍限定任务 ID 并拒绝越界段，避免异常名称写出任务目录。
    if (!TASK_ID_PATTERN.test(taskId)) throw new Error(`提取任务 ID 格式无效：${taskId}`);
    const segments = relativePath.split("/").filter(Boolean);
    if (!segments.length || segments.some(segment => segment === "." || segment === ".." || segment.includes("\\"))) {
        throw new Error(`中间产物路径无效：${relativePath}`);
    }
    return `${EXTRACTIONS_DIRECTORY}/${taskId}/${segments.join("/")}`;
}

export function createMaterialIntermediate(target: WorkspaceFileTarget, taskId: string): MaterialIntermediate {
    return {
        async readJson(relativePath, schema) {
            let text: string;
            try {
                text = await readWorkspaceTextFile(target.root, resolveRelative(taskId, relativePath));
            } catch (error: unknown) {
                if (isMissing(error)) return null;
                throw error;
            }
            return schema.parse(JSON.parse(text));
        },
        async list(relativeDirectory) {
            try {
                return await readdir(path.join(target.root, ...resolveRelative(taskId, relativeDirectory).split("/")));
            } catch (error: unknown) {
                if (isMissing(error)) return [];
                throw error;
            }
        },
        async commit(change) {
            const removes = (change.remove ?? []).map(entry => resolveRelative(taskId, entry));
            const writes = (change.write ?? []).map(entry => ({path: resolveRelative(taskId, entry.path), content: JSON.stringify(entry.data, null, 2)}));
            if (!removes.length && !writes.length) return;
            await withProjectTargetMutation(target, async () => {
                for (const entry of removes) {
                    if (await workspacePathExists(target.root, entry)) await deleteWorkspacePath(target.root, entry, true);
                }
                for (const entry of writes) await writeWorkspaceTextFile(target.root, entry.path, entry.content);
            });
        },
    };
}
