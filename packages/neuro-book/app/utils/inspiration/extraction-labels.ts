import type {ExtractionStopReason, ExtractionTaskStatus, ExtractionUnitStatus} from "nbook/shared/dto/inspiration-extraction-task.dto";
import {resolveApiErrorCode, resolveApiErrorMessage} from "nbook/app/utils/api-error";

/** 作品提取界面的状态文案与服务端错误的友好说明；所有面向用户的中文措辞集中在这里，组件不自行拼接。 */

export type ToneName = "neutral" | "accent" | "success" | "warning" | "danger";

export const TASK_STATUS_LABELS: Readonly<Record<ExtractionTaskStatus, string>> = {
    running: "提取中",
    "awaiting-input": "等待你确认",
    completed: "已完成",
    "partial-failed": "部分失败",
    cancelled: "已取消",
    interrupted: "已中断",
};

export const TASK_STATUS_TONES: Readonly<Record<ExtractionTaskStatus, ToneName>> = {
    running: "accent",
    "awaiting-input": "warning",
    completed: "success",
    "partial-failed": "danger",
    cancelled: "neutral",
    interrupted: "warning",
};

export const UNIT_STATUS_LABELS: Readonly<Record<ExtractionUnitStatus, string>> = {
    pending: "等待中",
    running: "进行中",
    done: "已完成",
    failed: "失败",
    skipped: "已跳过",
};

export const UNIT_STATUS_TONES: Readonly<Record<ExtractionUnitStatus, ToneName>> = {
    pending: "neutral",
    running: "accent",
    done: "success",
    failed: "danger",
    skipped: "neutral",
};

export const STOP_REASON_LABELS: Readonly<Record<ExtractionStopReason["code"], string>> = {
    "source-changed": "来源文件在提取期间发生了变化",
    "model-unavailable": "提取模型暂时不可用",
    unexpected: "出现了意料之外的错误",
};

export const WRITE_STATUS_LABELS = {pending: "待写入", written: "已写入", skipped: "已跳过", failed: "写入失败", conflict: "存在同名冲突"} as const;
export const WRITE_STATUS_TONES: Readonly<Record<keyof typeof WRITE_STATUS_LABELS, ToneName>> = {
    pending: "neutral", written: "success", skipped: "neutral", failed: "danger", conflict: "warning",
};

export const NODE_ROLE_LABELS = {main: "基本设定", experience: "经历", relationship: "人际关系"} as const;
export const ITEM_KIND_LABELS = {detail: "细纲", outline: "章节大纲"} as const;

/** 服务端稳定业务码对应的兜底说明；服务端带了具体中文消息时优先使用消息。 */
const ERROR_CODE_FALLBACKS: Readonly<Record<string, string>> = {
    NOT_FOUND: "找不到对应的来源或任务，可能已被删除。",
    CONFLICT: "同一来源已有正在运行的同类任务，请等待它结束或先取消。",
    INVALID_STATE: "当前状态下不能执行这个操作，请刷新后再试。",
    SOURCE_CHANGED: "来源文件已变化，请重新选择来源后再开始。",
    REVIEW_LOCKED: "待写入清单正在被另一个操作占用，请稍后再试。",
    INVALID_INPUT: "提交的内容不符合要求，请检查后重试。",
    REVIEW_INVALID: "修改后的条目不符合模板要求，请检查字段后重试。",
    MODEL_OUTPUT_INVALID: "模型返回的内容无法使用，可以重试。",
    PIPELINE_UNREGISTERED: "提取功能尚未就绪，请稍后再试。",
    MODEL_UNAVAILABLE: "提取模型暂时不可用，请在设置中检查模型后重试。",
    INVALID_REQUEST: "请求不完整，请刷新后重试。",
};

export type DescribedError = Readonly<{code: string | null; message: string}>;

export function describeExtractionError(error: unknown): DescribedError {
    const code = resolveApiErrorCode(error);
    const message = resolveApiErrorMessage(error, "");
    // 服务端 4xx 的消息是写给用户的中文说明；只有缺失时才回落到按业务码的通用文案。
    return {code, message: message || (code && ERROR_CODE_FALLBACKS[code]) || "操作失败，请稍后重试。"};
}

/** 把章节 P 范围写成“P3–P8”。 */
export function paragraphRange(first: string, last: string): string {
    return first === last ? first : `${first}–${last}`;
}
