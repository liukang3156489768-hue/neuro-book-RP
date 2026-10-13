import {defineEventHandler, readBody} from "h3";
import {ExtractionUnitRequestSchema} from "nbook/shared/dto/inspiration-extraction-api.dto";
import type {ExtractionTask} from "nbook/shared/dto/inspiration-extraction-task.dto";
import {parseExtractionRequest, withExtractionServices} from "nbook/server/inspiration/extraction/http";
import {requireTaskId} from "nbook/server/inspiration/extraction/route-params";
import {taskControl} from "nbook/server/inspiration/extraction/task-service";

/** 明确跳过失败单元，让依赖它的汇总按已完成部分继续。 */
export default defineEventHandler(async (event): Promise<{task: ExtractionTask}> => {
    const request = parseExtractionRequest(ExtractionUnitRequestSchema, await readBody(event), "单元操作请求");
    const taskId = requireTaskId(event);
    return {task: await withExtractionServices(request.projectRoot, services => taskControl.skipUnit(services, taskId, request.unitId))};
});
