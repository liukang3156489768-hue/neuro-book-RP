import type {ExtractionStartRequestDto, ExtractionTaskSummaryDto} from "nbook/shared/dto/inspiration-extraction-api.dto";
import {ExtractionClassificationInputSchema, ExtractionMaterialStartRequestSchema, ExtractionOverwriteInputSchema} from "nbook/shared/dto/inspiration-extraction-api.dto";
import {
    JsonRecordSchema,
    type ExtractionTask,
    type JsonRecord,
} from "nbook/shared/dto/inspiration-extraction-task.dto";
import {ExtractionTaskError} from "./errors";
import type {ExtractionServices} from "./host";
import {summarizeExtractionProgress} from "./progress";
import {prepareInspirationSource} from "../source";
import {defaultExtractionStructure} from "./structure-service";

/** 任务启动、列表投影与人工输入的服务端规则，路由与 Agent 工具共用。 */

export type StartOutlineInput = Extract<ExtractionStartRequestDto, {kind: "outline"}>;
export type StartMaterialInput = Extract<ExtractionStartRequestDto, {kind: "material"}>;

/** 两种启动输入的公共外形；`source` 与 `structure` 的哈希一致性由大纲流水线的参数校验复核。 */
export type StartExtractionRequest = StartOutlineInput | StartMaterialInput;

/**
 * 启动任务。`params` 先经 `JsonRecordSchema` 解析：任务记录只能保存可序列化的 JSON，
 * 解析失败说明请求里带了非 JSON 值，而不是用类型断言把它塞进去。
 * 来源哈希是否仍与磁盘一致、同一来源是否已有运行中任务，都由管理器的 `start` 判定。
 */
export async function startExtractionTask(services: ExtractionServices, request: StartExtractionRequest): Promise<ExtractionTask> {
    const modelKey = request.modelKey === undefined ? {} : {modelKey: request.modelKey};
    if (request.kind === "outline") {
        const params = JsonRecordSchema.parse({
            workTitle: request.workTitle,
            structure: request.structure,
            corrections: request.corrections,
            destination: request.destination,
        });
        return services.manager.start({kind: "outline", source: request.source, params, ...modelKey});
    }
    const params: JsonRecord = {
        ...(request.categories === undefined ? {} : {categories: request.categories}),
        ...(request.blocks === undefined ? {} : {blocks: request.blocks}),
    };
    return services.manager.start({kind: "material", source: request.source, params, ...modelKey});
}

export function summarizeTask(task: ExtractionTask): ExtractionTaskSummaryDto {
    return {
        id: task.id,
        kind: task.kind,
        source: task.source,
        status: task.status,
        awaitingInput: task.awaitingInput,
        stopReason: task.stopReason,
        overall: summarizeExtractionProgress(task).overall,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
    };
}

/**
 * 提供人工输入。输入的形状取决于任务种类：大纲任务只会等待“覆盖确认”，素材任务只会等待“归类”。
 * 这里按种类做形状校验，使错种类的输入得到 422 而不是进入流水线；语义校验（条目是否存在、
 * 文件夹是否属于同一类别）仍由流水线的 `acceptInput` 负责。
 */
export function provideExtractionInput(services: ExtractionServices, taskId: string, input: unknown): Promise<ExtractionTask> {
    return services.serialize(taskId, async () => {
        const task = await services.manager.get(taskId);
        const schema = task.kind === "outline" ? ExtractionOverwriteInputSchema : ExtractionClassificationInputSchema;
        const parsed = schema.safeParse(input);
        if (!parsed.success) {
            throw new ExtractionTaskError("INVALID_INPUT", `${task.kind === "outline" ? "覆盖确认" : "归类结果"}的格式无效：${parsed.error.issues.map(issue => `${issue.path.join(".") || "输入"} ${issue.message}`).join("；")}`);
        }
        return services.manager.provideInput(taskId, parsed.data);
    });
}

/** 取消、继续、单元重试与跳过都与同一任务的重新汇总串行。 */
export const taskControl = {
    cancel: (services: ExtractionServices, taskId: string) => services.serialize(taskId, () => services.manager.cancel(taskId)),
    resume: (services: ExtractionServices, taskId: string) => services.serialize(taskId, () => services.manager.resume(taskId)),
    retryUnit: (services: ExtractionServices, taskId: string, unitId: string) => services.serialize(taskId, () => services.manager.retryUnit(taskId, unitId)),
    skipUnit: (services: ExtractionServices, taskId: string, unitId: string) => services.serialize(taskId, () => services.manager.skipUnit(taskId, unitId)),
    changeFailedUnits: (services: ExtractionServices, taskId: string, action: "retry" | "skip", unitIds: readonly string[]) => services.serialize(taskId, () => services.manager.changeFailedUnits(taskId, action, unitIds)),
} as const;

/** 种类专属读取（大纲成果、素材归类）遇到另一种类的任务时拒绝，而不是在任务状态里找不存在的字段。 */
export function requireTaskKind(task: ExtractionTask, kind: ExtractionTask["kind"]): ExtractionTask {
    if (task.kind !== kind) {
        throw new ExtractionTaskError("INVALID_STATE", `该操作只适用于${kind === "outline" ? "大纲" : "素材"}提取任务。`);
    }
    return task;
}

/** Agent 下发提取的输入：不带结构、修正与数据去向，这些决定留给界面里的用户。 */
export type AgentStartInput = Readonly<{kind: "outline" | "material"; path: string; workTitle?: string; categories?: readonly string[]; blocks?: readonly number[]}>;

function defaultWorkTitle(path: string): string {
    const name = path.split("/").at(-1) ?? "";
    const title = name.replace(/\.[^.]*$/u, "").trim();
    return title === "" ? "未命名作品" : title;
}

/**
 * Agent 工具下发任务：来源哈希取自磁盘；大纲提取不修正章节、按建议划卷并写入新方案（不会覆盖任何已有方案），
 * 因此不存在需要用户逐项确认覆盖的前提。想修正章节、选择覆盖或追加去向，必须由用户在界面里启动。
 */
export async function startExtractionFromAgent(services: ExtractionServices, input: AgentStartInput): Promise<ExtractionTask> {
    const categories = ExtractionMaterialStartRequestSchema.shape.categories.safeParse(input.categories);
    if (!categories.success) throw new ExtractionTaskError("INVALID_INPUT", `素材类别无效：${categories.error.issues.map(issue => issue.message).join("；")}`);
    if (input.kind === "material") {
        const prepared = await prepareInspirationSource(services.root, input.path);
        const source = {path: prepared.source.path, sha256: prepared.source.sha256};
        return services.manager.start({kind: "material", source, params: {
            ...(categories.data === undefined ? {} : {categories: categories.data}),
            ...(input.blocks === undefined ? {} : {blocks: [...input.blocks]}),
        }});
    }
    const {source, structure} = await defaultExtractionStructure(services.root, input.path);
    const params = JsonRecordSchema.parse({
        workTitle: input.workTitle?.trim() || defaultWorkTitle(source.path),
        structure,
        corrections: [],
        destination: {kind: "new"},
    });
    return services.manager.start({kind: "outline", source, params});
}

/** 失败与被跳过的单元及停止原因，供 Agent 汇报；不含单元内部数据。 */
export function summarizeFailures(task: ExtractionTask) {
    return {
        taskId: task.id,
        kind: task.kind,
        status: task.status,
        stopReason: task.stopReason,
        failedUnits: task.units.filter(unit => unit.status === "failed").map(({id, step, label, group, attempts, error}) => ({id, step, label, group, attempts, error})),
        skippedUnits: task.units.filter(unit => unit.status === "skipped").map(({id, label}) => ({id, label})),
    };
}
