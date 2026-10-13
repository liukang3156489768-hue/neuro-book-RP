import {readdir} from "node:fs/promises";
import path from "node:path";
import {ExtractionTaskSchema, type ExtractionTask} from "nbook/shared/dto/inspiration-extraction-task.dto";
import type {WorkspaceFileTarget} from "nbook/server/workspace-files/workspace-file-target";
import {withProjectTargetMutation} from "nbook/server/workspace-files/project-open-guard";
import {deleteWorkspacePath, readWorkspaceTextFile, workspacePathExists, writeWorkspaceTextFile} from "nbook/server/workspace-files/workspace-files";
import type {ExtractionTaskStore} from "./types";

const EXTRACTIONS_DIRECTORY = ".nbook/inspiration/extractions";
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isMissing(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function taskPath(taskId: string): string {
    // 路径由任务 ID 拼出，先限定为 UUID，避免调用方传入的 ID 越出任务目录。
    if (!TASK_ID_PATTERN.test(taskId)) throw new Error(`提取任务 ID 格式无效：${taskId}`);
    return `${EXTRACTIONS_DIRECTORY}/${taskId}/task.json`;
}

/**
 * 把任务记录保存到 `.nbook/inspiration/extractions/<任务 ID>/task.json`。
 *
 * 任务记录是项目内部状态而不是内容节点：与 Inspiration 对话更新一样使用 `writeWorkspaceTextFile`，
 * 每次状态变化都进工作区历史会淹没真正的创作记录；写入仍经项目 mutation gate，受项目生命周期保护。
 * 项目正在关闭时 gate 会拒绝写入，此时磁盘上保留的最后一条记录就是中断前的状态。
 * 素材中间产物后续也放在同一任务目录下，由素材流水线自己写入。
 */
export function createFileExtractionStore(target: WorkspaceFileTarget): ExtractionTaskStore {
    return {
        async read(taskId) {
            let text: string;
            try {
                text = await readWorkspaceTextFile(target.root, taskPath(taskId));
            } catch (error: unknown) {
                if (isMissing(error)) return null;
                throw error;
            }
            return ExtractionTaskSchema.parse(JSON.parse(text));
        },
        async list() {
            let entries: string[];
            try {
                entries = await readdir(path.join(target.root, ...EXTRACTIONS_DIRECTORY.split("/")));
            } catch (error: unknown) {
                if (isMissing(error)) return [];
                throw error;
            }
            const tasks: ExtractionTask[] = [];
            for (const entry of entries) {
                if (!TASK_ID_PATTERN.test(entry)) continue;
                try {
                    tasks.push(ExtractionTaskSchema.parse(JSON.parse(await readWorkspaceTextFile(target.root, taskPath(entry)))));
                } catch {
                    // 损坏或尚未写完的记录不应让整个任务列表不可用；单独 read 该 ID 会暴露具体错误。
                }
            }
            return tasks.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
        },
        async write(task) {
            const content = JSON.stringify(ExtractionTaskSchema.parse(task), null, 2);
            await withProjectTargetMutation(target, () => writeWorkspaceTextFile(target.root, taskPath(task.id), content));
        },
        async remove(taskId) {
            if (!TASK_ID_PATTERN.test(taskId)) throw new Error(`提取任务 ID 格式无效：${taskId}`);
            const relativePath = `${EXTRACTIONS_DIRECTORY}/${taskId}`;
            await withProjectTargetMutation(target, async () => {
                if (await workspacePathExists(target.root, relativePath)) await deleteWorkspacePath(target.root, relativePath, true);
            });
        },
    };
}
