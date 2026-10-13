import {createError, type H3Error} from "h3";
import type {ZodType, z} from "zod";
import {withProjectHandlesOperation} from "nbook/server/workspace-files/project-open-guard";
import {OutlineStructureError} from "../outline-structure";
import {ExtractionFatalError, ExtractionTaskError, ExtractionValidationFailure, type ExtractionTaskErrorCode} from "./errors";
import {useProjectExtractionServices, type ExtractionServices} from "./host";
import {MaterialReviewError} from "./material-review";
import {ExtractionModelError} from "./model-adapter";

/**
 * `/api/inspiration/extraction/**` 路由共用的边界：请求校验、领域错误到 HTTP 状态的映射、项目操作包装。
 * 项目错误（未打开、正在关闭等）由 `withProjectHandlesOperation` 映射，这里只处理提取领域错误。
 */

const TASK_ERROR_STATUS: Record<ExtractionTaskErrorCode, number> = {
    NOT_FOUND: 404,
    // 已有运行中的同来源同种类任务、状态不允许该操作、来源已变化：都是“请求与当前状态冲突”，重新读取状态后可以重试。
    CONFLICT: 409,
    INVALID_STATE: 409,
    SOURCE_CHANGED: 409,
    INVALID_INPUT: 422,
    PIPELINE_UNREGISTERED: 503,
};

const REVIEW_ERROR_STATUS = {NOT_FOUND: 404, INVALID: 422, LOCKED: 409} as const;

function domainError(statusCode: number, message: string, code: string): H3Error {
    return createError({statusCode, message, data: {code}});
}

/** 已知的提取领域错误转 H3 错误；未知错误返回 null，由调用方原样抛出以保留堆栈。 */
export function createExtractionHttpError(error: unknown): H3Error | null {
    if (error instanceof ExtractionTaskError) return domainError(TASK_ERROR_STATUS[error.code], error.message, error.code);
    if (error instanceof MaterialReviewError) return domainError(REVIEW_ERROR_STATUS[error.code], error.message, `REVIEW_${error.code}`);
    if (error instanceof OutlineStructureError) return domainError(422, error.message, error.code);
    // 以下来自手动合并与重新汇总这两条会在请求内调用模型的路径。
    if (error instanceof ExtractionValidationFailure) return domainError(422, error.message, "MODEL_OUTPUT_INVALID");
    if (error instanceof ExtractionFatalError) {
        return domainError(error.reason === "source-changed" ? 409 : 503, error.message, error.reason === "source-changed" ? "SOURCE_CHANGED" : "MODEL_UNAVAILABLE");
    }
    if (error instanceof ExtractionModelError) return domainError(503, error.message, "MODEL_UNAVAILABLE");
    return null;
}

export async function withExtractionHttpError<T>(handler: () => Promise<T> | T): Promise<T> {
    try {
        return await handler();
    } catch (error) {
        throw createExtractionHttpError(error) ?? error;
    }
}

/** 解析请求体或查询；失败抛 400。消息只列字段与原因，不回显请求内容。 */
export function parseExtractionRequest<S extends ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
        const detail = parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join(".") || "请求"} ${issue.message}`).join("；");
        throw createError({statusCode: 400, message: `${what}无效：${detail}`, data: {code: "INVALID_REQUEST"}});
    }
    return parsed.data;
}

/**
 * 在当前打开项目的操作内运行提取服务。项目未打开时 `withProjectHandlesOperation` 抛 409 项目错误，
 * 此时不会触碰任何任务数据。
 */
export function withExtractionServices<T>(projectRoot: string, handler: (services: ExtractionServices) => Promise<T>): Promise<T> {
    return withProjectHandlesOperation(projectRoot, () => withExtractionHttpError(async () => handler(await useProjectExtractionServices(projectRoot))));
}
