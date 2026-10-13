import {Type} from "typebox";
import {normalizeToolResultDetails} from "nbook/server/agent/messages/message-utils";
import type {JsonValue} from "nbook/server/agent/messages/types";
import {defineAgentTool, type NeuroToolResult, type ToolExecutionContext} from "nbook/server/agent/tools/types";
import type {ExtractionServices} from "nbook/server/inspiration/extraction/host";
import type {ExtractionTask} from "nbook/shared/dto/inspiration-extraction-task.dto";

/**
 * 作品提取的 Agent 工具：只下发任务、查进度、确认新条目写入、读失败报告，不做内容编排。
 * 覆盖确认、章节修正、归类、审阅编辑与冲突决定都留给界面里的用户。
 * 服务（含两条流水线的注册）经 `useProjectExtractionServices` 取得，与 HTTP 路由共用同一实例。
 */

// 提取 host 经项目数据面与历史记账依赖 project-history，而工具注册表在其加载链上，静态导入会成环（同 writing-tools）。
const loadHost = () => import("nbook/server/inspiration/extraction/host");
const loadTaskService = () => import("nbook/server/inspiration/extraction/task-service");
const loadHttp = () => import("nbook/server/inspiration/extraction/http");

const TaskId = Type.String({pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", description: "提取任务 ID（start_inspiration_extraction 返回，或 get_inspiration_extraction_progress 列出）"});

const STATUS_LABEL: Record<ExtractionTask["status"], string> = {
    running: "运行中",
    "awaiting-input": "等待人工输入",
    completed: "已完成",
    "partial-failed": "部分失败",
    cancelled: "已取消",
    interrupted: "已中断",
};

function textResult(text: string, details: unknown): NeuroToolResult {
    return {content: [{type: "text", text}], details: normalizeToolResultDetails(details as JsonValue)};
}

function requireProjectRoot(context: ToolExecutionContext): string {
    if (!context.currentProject) throw new Error("提取工具必须绑定当前已打开的 Project");
    return context.currentProject.workspace.ref.projectRoot;
}

/** 工具内的领域错误也要给 Agent 一条可读的原因，而不是内部错误类名。 */
async function withServices<T>(context: ToolExecutionContext, run: (services: ExtractionServices) => Promise<T>): Promise<T> {
    const projectRoot = requireProjectRoot(context);
    const {useProjectExtractionServices} = await loadHost();
    const {createExtractionHttpError} = await loadHttp();
    try {
        return await run(await useProjectExtractionServices(projectRoot));
    } catch (error) {
        const domain = createExtractionHttpError(error);
        throw domain ? new Error(domain.message) : error;
    }
}

function describeTask(task: ExtractionTask): string {
    const failed = task.units.filter(unit => unit.status === "failed").length;
    const done = task.units.filter(unit => unit.status === "done").length;
    const awaiting = task.awaitingInput === null ? "" : `（等待：${task.awaitingInput}）`;
    return `${task.id}：${task.kind === "outline" ? "大纲" : "素材"}提取 ${task.source.path}，${STATUS_LABEL[task.status]}${awaiting}，完成 ${done}/${task.units.length}，失败 ${failed}`;
}

export function createExtractionTools() {
    const startExtraction = defineAgentTool({
        key: "start_inspiration_extraction",
        description: "对灵感区里的一份作品来源发起大纲提取或素材提取，任务在后台运行，立即返回任务 ID。"
            + "大纲提取不修正章节、按建议划卷并写入新方案，不会覆盖已有内容；需要修正章节或覆盖已有方案时请让用户在界面里启动。"
            + "素材提取跑完会停在人工归类与审阅，之后由用户在界面处理。同一来源同一种类已有运行中的任务会被拒绝。",
        parameters: Type.Object({
            kind: Type.Union([Type.Literal("outline"), Type.Literal("material")], {description: "outline 大纲提取；material 素材提取"}),
            path: Type.String({minLength: 1, description: "灵感来源路径（sources 列表里的 path）"}),
            workTitle: Type.Optional(Type.String({description: "仅大纲提取：作品名，缺省取来源文件名"})),
            categories: Type.Optional(Type.Array(Type.String(), {description: "仅素材提取：要提取的素材类别，缺省全部"})),
            blocks: Type.Optional(Type.Array(Type.Integer({minimum: 1}), {description: "仅素材提取：要提取的分块编号，缺省全部"})),
        }),
        mutatesWorkspace: true,
        async executeWithContext(context, _toolCallId, params): Promise<NeuroToolResult> {
            const input = params as {kind: "outline" | "material"; path: string; workTitle?: string; categories?: string[]; blocks?: number[]};
            const {startExtractionFromAgent} = await loadTaskService();
            const task = await withServices(context, services => startExtractionFromAgent(services, input));
            return textResult([
                `${input.kind === "outline" ? "大纲" : "素材"}提取任务 ${task.id} 已在后台启动（${task.source.path}）。`,
                "任务运行期间可用 get_inspiration_extraction_progress 查询。现在向用户简述并结束本回合，不要轮询。",
            ].join("\n"), {taskId: task.id, kind: task.kind, status: task.status, source: task.source});
        },
    });

    const getProgress = defineAgentTool({
        key: "get_inspiration_extraction_progress",
        description: "查询提取进度。不传 taskId：列出最近的提取任务（可按 path 过滤）；传入：该任务的整体与分组进度、等待原因和停止原因。",
        parameters: Type.Object({
            taskId: Type.Optional(TaskId),
            path: Type.Optional(Type.String({description: "只列出该来源路径的任务"})),
        }),
        async executeWithContext(context, _toolCallId, params): Promise<NeuroToolResult> {
            const {taskId, path} = params as {taskId?: string; path?: string};
            return withServices(context, async ({manager}) => {
                if (taskId === undefined) {
                    const tasks = (await manager.list(path === undefined ? {} : {sourcePath: path})).slice(0, 20);
                    return textResult(tasks.length === 0 ? "没有提取任务。" : tasks.map(describeTask).join("\n"),
                        {tasks: tasks.map(({id, kind, status, awaitingInput}) => ({id, kind, status, awaitingInput}))});
                }
                const task = await manager.get(taskId);
                const progress = await manager.progress(taskId);
                const lines = [describeTask(task)];
                if (task.stopReason) lines.push(`停止原因：${task.stopReason.message}`);
                for (const {group, counts} of progress.groups) lines.push(`- ${group}：完成 ${counts.done}/${counts.total}，失败 ${counts.failed}`);
                return textResult(lines.join("\n"), {taskId, status: progress.status, awaitingInput: progress.awaitingInput, overall: progress.overall, stopReason: progress.stopReason});
            });
        },
    });

    const confirmMaterialWrite = defineAgentTool({
        key: "confirm_inspiration_material_write",
        description: "确认把素材审阅清单里已勾选且尚未写入的条目写入资料库。只写新条目；与已有条目同名的冲突不会被覆盖，"
            + "会原样列出交给用户在界面里决定。本工具不勾选、不编辑条目，审阅内容以用户在界面里留下的为准。",
        parameters: Type.Object({taskId: TaskId}),
        mutatesWorkspace: true,
        async executeWithContext(context, _toolCallId, params): Promise<NeuroToolResult> {
            const {taskId} = params as {taskId: string};
            const {agentConfirmer} = await loadHost();
            // 确认者来自会话上下文，不来自模型给出的参数；无 decisions，因此只写入没有冲突的新条目。
            const report = await withServices(context, ({review, withSignal}) => withSignal(signal => review.confirmWrite(taskId, {confirmer: agentConfirmer(String(context.sessionId)), signal})));
            const count = (status: string) => report.outcomes.filter(outcome => outcome.status === status).length;
            const failed = report.outcomes.filter(outcome => outcome.status === "failed");
            const lines = [`写入 ${count("written")} 条，失败 ${failed.length} 条，待用户决定的同名冲突 ${report.conflicts.length} 条。`,
                ...failed.map(outcome => `- 失败：${outcome.title}：${outcome.error ?? "未知原因"}`),
                ...report.conflicts.map(conflict => `- 冲突：${conflict.title}（${conflict.path}）`)];
            return textResult(lines.join("\n"), {
                written: count("written"), failed: failed.length, conflicts: report.conflicts.map(({itemId, title, path}) => ({itemId, title, path})),
            });
        },
    });

    const getFailures = defineAgentTool({
        key: "get_inspiration_extraction_failures",
        description: "读取提取任务的失败报告：停止原因、失败与被跳过的单元及错误摘要。重试或跳过单元由用户在界面里处理。",
        parameters: Type.Object({taskId: TaskId}),
        async executeWithContext(context, _toolCallId, params): Promise<NeuroToolResult> {
            const {taskId} = params as {taskId: string};
            const {summarizeFailures} = await loadTaskService();
            const report = await withServices(context, async ({manager}) => summarizeFailures(await manager.get(taskId)));
            const lines = [`${STATUS_LABEL[report.status]}；失败单元 ${report.failedUnits.length}，已跳过 ${report.skippedUnits.length}。`,
                ...(report.stopReason ? [`停止原因：${report.stopReason.message}`] : []),
                ...report.failedUnits.map(unit => `- ${unit.label}（${unit.id}，已尝试 ${unit.attempts} 次）：${unit.error ?? "未记录原因"}`)];
            return textResult(lines.join("\n"), report);
        },
    });

    return {startExtraction, getProgress, confirmMaterialWrite, getFailures} as const;
}
