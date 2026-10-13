import type {ExtractionStopReason} from "nbook/shared/dto/inspiration-extraction-task.dto";

export type ExtractionTaskErrorCode =
    /** 同一来源同一种类已有运行中任务。 */
    | "CONFLICT"
    | "NOT_FOUND"
    /** 当前任务或单元状态不允许该操作。 */
    | "INVALID_STATE"
    /** 流水线拒绝了人工输入。 */
    | "INVALID_INPUT"
    /** 来源哈希变化、被移动或不可读，任务不可继续。 */
    | "SOURCE_CHANGED"
    | "PIPELINE_UNREGISTERED";

/** 任务控制接口（start/cancel/resume/...）的领域错误；路由层按 `code` 映射 HTTP 状态。 */
export class ExtractionTaskError extends Error {
    constructor(readonly code: ExtractionTaskErrorCode, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ExtractionTaskError";
    }
}

/**
 * 运行中遇到的、重试其他单元也不会好转的错误（模型未配置、来源变化）。
 * 抛出后整个任务停止为“已中断”，当前单元回到等待，而不是把所有单元逐个标记失败。
 */
export class ExtractionFatalError extends Error {
    constructor(readonly reason: ExtractionStopReason["code"], message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ExtractionFatalError";
    }
}

/** 模型返回了非完整结束原因；保留 stop reason 供上层选择一次压缩重试。 */
export class ExtractionModelError extends Error {
    constructor(readonly stopReason: string, message = `模型未完整返回（${stopReason}），请重试该单元`, options?: ErrorOptions) {
        super(message, options);
        this.name = "ExtractionModelError";
    }
}

/** 同一次模型调用连续两次未通过流水线校验；`errors` 按尝试顺序保存每次的校验错误。 */
export class ExtractionValidationFailure extends Error {
    constructor(readonly errors: readonly string[]) {
        super(`模型产出连续 ${errors.length} 次未通过校验：${errors.map((error, index) => `（${index + 1}）${error}`).join("；")}`);
        this.name = "ExtractionValidationFailure";
    }
}
