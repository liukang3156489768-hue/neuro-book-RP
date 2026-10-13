import {defineEventHandler, readBody} from "h3";
import {ExtractionInputRequestSchema} from "nbook/shared/dto/inspiration-extraction-api.dto";
import type {ExtractionTask} from "nbook/shared/dto/inspiration-extraction-task.dto";
import {parseExtractionRequest, withExtractionServices} from "nbook/server/inspiration/extraction/http";
import {requireTaskId} from "nbook/server/inspiration/extraction/route-params";
import {provideExtractionInput} from "nbook/server/inspiration/extraction/task-service";

/** 为等待人工输入的任务提供输入并继续：素材任务的归类，或大纲覆盖任务的逐项覆盖确认。 */
export default defineEventHandler(async (event): Promise<{task: ExtractionTask}> => {
    const request = parseExtractionRequest(ExtractionInputRequestSchema, await readBody(event), "人工输入请求");
    const taskId = requireTaskId(event);
    return {task: await withExtractionServices(request.projectRoot, services => provideExtractionInput(services, taskId, request.input))};
});
