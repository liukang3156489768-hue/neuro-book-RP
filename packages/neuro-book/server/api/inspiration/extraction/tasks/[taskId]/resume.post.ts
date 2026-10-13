import {defineEventHandler, readBody} from "h3";
import {ExtractionProjectRequestSchema} from "nbook/shared/dto/inspiration-extraction-api.dto";
import type {ExtractionTask} from "nbook/shared/dto/inspiration-extraction-task.dto";
import {parseExtractionRequest, withExtractionServices} from "nbook/server/inspiration/extraction/http";
import {requireTaskId} from "nbook/server/inspiration/extraction/route-params";
import {taskControl} from "nbook/server/inspiration/extraction/task-service";

/** 从未完成单元继续已取消、已中断或部分失败的任务；继续前复核来源哈希，已变化则 409。 */
export default defineEventHandler(async (event): Promise<{task: ExtractionTask}> => {
    const request = parseExtractionRequest(ExtractionProjectRequestSchema, await readBody(event), "任务操作请求");
    const taskId = requireTaskId(event);
    return {task: await withExtractionServices(request.projectRoot, services => taskControl.resume(services, taskId))};
});
