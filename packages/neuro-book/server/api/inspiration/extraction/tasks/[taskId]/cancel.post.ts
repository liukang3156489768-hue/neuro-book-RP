import {defineEventHandler, readBody} from "h3";
import {ExtractionProjectRequestSchema} from "nbook/shared/dto/inspiration-extraction-api.dto";
import type {ExtractionTask} from "nbook/shared/dto/inspiration-extraction-task.dto";
import {parseExtractionRequest, withExtractionServices} from "nbook/server/inspiration/extraction/http";
import {requireTaskId} from "nbook/server/inspiration/extraction/route-params";
import {taskControl} from "nbook/server/inspiration/extraction/task-service";

/** 取消：停止调度并中止进行中的调用，已写入成果保留；已取消的任务幂等，已结束的任务 409。 */
export default defineEventHandler(async (event): Promise<{task: ExtractionTask}> => {
    const request = parseExtractionRequest(ExtractionProjectRequestSchema, await readBody(event), "任务操作请求");
    const taskId = requireTaskId(event);
    return {task: await withExtractionServices(request.projectRoot, services => taskControl.cancel(services, taskId))};
});
