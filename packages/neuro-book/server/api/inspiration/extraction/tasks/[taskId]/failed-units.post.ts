import {defineEventHandler, readBody} from "h3";
import {ExtractionFailedUnitsRequestSchema} from "nbook/shared/dto/inspiration-extraction-api.dto";
import type {ExtractionTask} from "nbook/shared/dto/inspiration-extraction-task.dto";
import {parseExtractionRequest, withExtractionServices} from "nbook/server/inspiration/extraction/http";
import {requireTaskId} from "nbook/server/inspiration/extraction/route-params";
import {taskControl} from "nbook/server/inspiration/extraction/task-service";

export default defineEventHandler(async (event): Promise<{task: ExtractionTask}> => {
    const request = parseExtractionRequest(ExtractionFailedUnitsRequestSchema, await readBody(event), "批量失败项操作请求");
    const taskId = requireTaskId(event);
    return {task: await withExtractionServices(request.projectRoot, services =>
        taskControl.changeFailedUnits(services, taskId, request.action, request.unitIds))};
});
