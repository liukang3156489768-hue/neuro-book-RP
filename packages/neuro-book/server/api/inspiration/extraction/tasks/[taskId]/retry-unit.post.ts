import {defineEventHandler, readBody} from "h3";
import {ExtractionUnitRequestSchema} from "nbook/shared/dto/inspiration-extraction-api.dto";
import type {ExtractionTask} from "nbook/shared/dto/inspiration-extraction-task.dto";
import {parseExtractionRequest, withExtractionServices} from "nbook/server/inspiration/extraction/http";
import {requireTaskId} from "nbook/server/inspiration/extraction/route-params";
import {taskControl} from "nbook/server/inspiration/extraction/task-service";

/** 只重做一个失败（或已跳过）的单元，不触碰已完成单元。 */
export default defineEventHandler(async (event): Promise<{task: ExtractionTask}> => {
    const request = parseExtractionRequest(ExtractionUnitRequestSchema, await readBody(event), "单元操作请求");
    const taskId = requireTaskId(event);
    return {task: await withExtractionServices(request.projectRoot, services => taskControl.retryUnit(services, taskId, request.unitId))};
});
