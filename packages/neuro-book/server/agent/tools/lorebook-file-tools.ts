import {stat} from "node:fs/promises";
import {relativeRealPathInside} from "nbook/server/runtime/paths/file-path";
import {authorizeFileOperation} from "nbook/server/workspace-files/authorized-file-operation";
import {createFileTools} from "nbook/server/agent/tools/file-tools";
import {assertPlanningWriteGrant} from "nbook/server/agent/tools/planning-delegation";
import type {NeuroAgentTool, ToolExecutionContext} from "nbook/server/agent/tools/types";

/**
 * 规划专家的 lorebook/ 写入口。复用通用 write/edit 的写入、历史记录与 diff 行为，只在前面加两道门：
 * 必须处于规划助手的写入委派期间，且真实目标必须落在当前 Project 的 lorebook/ 内。
 * 通用文件工具不带路径范围，直接开放会让专家绕过规划领域校验去改 outline/ 规范文件或正文。
 */
export function createLorebookFileTools(): NeuroAgentTool[] {
    const base = new Map(createFileTools().map((tool) => [tool.key, tool]));
    return [
        scoped(base.get("write"), "write_lorebook", "写入 lorebook 文件", "write"),
        scoped(base.get("edit"), "edit_lorebook", "编辑 lorebook 文件", "edit"),
    ];
}

function scoped(tool: NeuroAgentTool | undefined, key: string, label: string, operation: "write" | "edit"): NeuroAgentTool {
    if (!tool?.executeWithContext) throw new Error(`缺少通用文件工具：${operation}`);
    const execute = tool.executeWithContext;
    return {
        ...tool,
        key,
        name: key,
        label,
        description: `${tool.description}\n\nScoped variant for planning specialists: the path must be inside the current Project's lorebook/ directory, and it only works during a delegate_planning_task call.`,
        async executeWithContext(context, toolCallId, params, userInput, signal, onUpdate) {
            assertPlanningWriteGrant(context.sessionId);
            await assertLorebookTarget(context, (params as {path?: unknown}).path, operation);
            return execute(context, toolCallId, params, userInput, signal, onUpdate);
        },
    };
}

async function assertLorebookTarget(context: ToolExecutionContext, inputPath: unknown, operation: "write" | "edit"): Promise<void> {
    const project = context.currentProject;
    if (!project) throw new Error("规划专家必须绑定当前 ready Project");
    if (typeof inputPath !== "string") throw new Error("path 必须是字符串");
    const {target} = await authorizeFileOperation(context, inputPath, operation);
    if (target.project !== project) throw new Error("规划专家只能写入当前 Project 的 lorebook/");
    const relative = await relativeRealPathInside(project.workspace.root, target.absolutePath);
    const normalized = process.platform === "win32" ? relative?.toLowerCase() : relative;
    if (!normalized || !normalized.startsWith("lorebook/") || !/\.md$/u.test(normalized)) {
        throw new Error("规划专家只能写入当前 Project lorebook/ 下的 Markdown 文件");
    }
    // 硬链接不改变真实路径，却能让 lorebook 条目指向规划规范文件的同一 inode。
    const metadata = await stat(target.absolutePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
    });
    if (metadata?.isFile() && metadata.nlink > 1) throw new Error("规划专家不能写入多重硬链接文件");
}
