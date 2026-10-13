import type {
    ExtractionSourceRef,
    ExtractionTask,
    ExtractionUnit,
    JsonRecord,
} from "nbook/shared/dto/inspiration-extraction-task.dto";

/**
 * 提取任务框架的端口与流水线接口。框架只负责调度、持久化、校验重试与进度；
 * 大纲／素材提取的内容逻辑全部在 `ExtractionPipeline` 实现里。
 */

/** 一次模型补全请求。类型里刻意没有思考开关：提取流水线的模型调用一律关闭思考。 */
export type ExtractionModelRequest = Readonly<{
    system?: string;
    prompt: string;
    preMessages?: readonly Readonly<{role: "user" | "assistant"; content: string}>[];
    orderedMessages?: readonly Readonly<{role: "system" | "user" | "assistant"; content: string}>[];
    signal: AbortSignal;
    /** 覆盖默认提取模型（`provider/model`）。 */
    modelKey?: string;
    /** 用于素材提取日志关联；不包含原文或密钥。 */
    metadata?: Readonly<{
        taskId?: string;
        unitId?: string;
        purposeId?: string;
        block?: number;
        characterKeys?: readonly string[];
        tier?: string;
        prefixHash?: string;
    }>;
}>;

/** 无工具、一次性文本补全。 */
export interface ExtractionModelPort {
    complete(request: ExtractionModelRequest): Promise<string>;
}

/**
 * 任务记录存储。`write` 整体覆盖，调用方负责串行；`read` 对不存在返回 null；
 * `list` 跳过无法解析的记录而不是整体失败。
 */
export interface ExtractionTaskStore {
    read(taskId: string): Promise<ExtractionTask | null>;
    list(): Promise<ExtractionTask[]>;
    write(task: ExtractionTask): Promise<void>;
    /** 删除任务记录及其目录下的流水线中间产物；已不存在时幂等。 */
    remove(taskId: string): Promise<void>;
}

export type ValidationResult<T> = {ok: true; value: T} | {ok: false; error: string};

/** 提示词三段；预留位由 `buildExtractionPrompt` 在末尾管理，流水线不直接拼。 */
export type ExtractionPromptParts = Readonly<{
    /** 本单元原文。同一单元的不同任务必须传入逐字节相同的前缀。 */
    prefix: string;
    /** 追加材料（已知实体名单、已提取的细纲等），位于原文之后。 */
    supplements?: readonly string[];
    /** 任务目标，位于预留位之前。 */
    goal: string;
}>;

/** 流水线描述的新单元；状态固定为等待。 */
export type NewExtractionUnit = Readonly<{
    id: string;
    step: string;
    label: string;
    group?: string | null;
    data?: JsonRecord;
}>;

/** 对任务的增量变更：追加单元、浅合并流水线状态。 */
export type ExtractionTaskPatch = Readonly<{
    appendUnits?: readonly NewExtractionUnit[];
    state?: JsonRecord;
}>;

export type GenerateRequest<T> = Readonly<{
    purposeId?: string;
    variables?: Readonly<Record<string, string>>;
    metadata?: Readonly<{block?: number; characterKeys?: readonly string[]; tier?: string}>;
    system?: string;
    prompt: ExtractionPromptParts;
    /** 校验并解析模型产出；失败时的 `error` 会原样写入修复重试的预留位。 */
    validate: (output: string) => ValidationResult<T>;
}>;

export interface ExtractionUnitContext {
    /** 单元开始时任务的深拷贝快照。 */
    readonly task: ExtractionTask;
    /** 取消、项目关闭共同终止；`execute` 内的异步工作必须响应它。 */
    readonly signal: AbortSignal;
    /**
     * 构造提示词、调用模型并校验；校验失败带“本次产出与错误信息”重调一次，
     * 连续两次失败抛 `ExtractionValidationFailure`（单元随之标记失败）。
     * 每次模型调用前复核来源哈希。一个单元可以多次调用，各次独立计数。
     */
    generate<T>(request: GenerateRequest<T>): Promise<T>;
}

export type PipelineSettlement =
    /** 没有更多可执行单元，任务结束（有失败单元为部分失败，否则完成）。 */
    | {kind: "finished"}
    /** 暂停等待人工输入；输入经 `acceptInput` 提供后继续。 */
    | {kind: "awaiting-input"; reason: string}
    /** 发现新的工作（如分块全部完成后追加整合单元），必须追加至少一个单元。 */
    | {kind: "continue"; patch: ExtractionTaskPatch};

export type PreparedExtraction = Readonly<{
    units: readonly NewExtractionUnit[];
    state?: JsonRecord;
}>;

/**
 * 一种提取流水线。实例可按任务创建，也可共享；所有任务状态都在 `task` 里，实例不持有。
 * 单元执行必须幂等：取消、中断后同一单元会被整体重做。
 */
export interface ExtractionPipeline {
    /**
     * 任务创建前调用一次（已通过唯一性与来源复核），产出初始单元。
     * 创建提取方案之类的副作用放在这里，保证重复启动冲突时不会产生第二份。
     */
    prepare(input: Readonly<{params: JsonRecord; source: ExtractionSourceRef}>): Promise<PreparedExtraction>;
    /** 当前可执行的等待单元，按执行顺序；每次单元结束后重新询问，因此依赖关系在这里表达。 */
    readyUnits(task: ExtractionTask): readonly ExtractionUnit[];
    execute(unit: ExtractionUnit, context: ExtractionUnitContext): Promise<ExtractionTaskPatch | void>;
    /** 没有可执行单元时调用，决定任务去向。 */
    settle(task: ExtractionTask): PipelineSettlement;
    /** 处理 `awaiting-input` 时的人工输入；非法输入抛 `ExtractionTaskError("INVALID_INPUT")`。 */
    acceptInput?(task: ExtractionTask, input: unknown): ExtractionTaskPatch;
}
