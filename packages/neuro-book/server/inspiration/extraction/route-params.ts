import {getRouterParam, type H3Event} from "h3";
import {ExtractionTaskIdParamSchema} from "nbook/shared/dto/inspiration-extraction-api.dto";
import {parseExtractionRequest} from "./http";

/** 路径里的任务 ID；非 UUID 直接 400，不会进入存储层拼路径。 */
export function requireTaskId(event: H3Event): string {
    return parseExtractionRequest(ExtractionTaskIdParamSchema, getRouterParam(event, "taskId"), "任务 ID");
}
