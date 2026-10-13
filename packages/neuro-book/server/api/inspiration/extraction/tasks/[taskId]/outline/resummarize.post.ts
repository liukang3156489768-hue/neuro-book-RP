import {defineEventHandler, readBody} from "h3";
import {ExtractionProjectRequestSchema} from "nbook/shared/dto/inspiration-extraction-api.dto";
import {parseExtractionRequest, withExtractionServices} from "nbook/server/inspiration/extraction/http";
import {requireTaskId} from "nbook/server/inspiration/extraction/route-params";

/**
 * 重新汇总过期的卷纲与总纲。会在请求内调用模型，所以与同一任务的取消、继续等操作串行（见 `ExtractionServices.serialize`）；
 * 任务仍在运行或等待输入、没有过期汇总时由领域层拒绝。
 */
export default defineEventHandler(async (event) => {
    const request = parseExtractionRequest(ExtractionProjectRequestSchema, await readBody(event), "任务操作请求");
    const taskId = requireTaskId(event);
    return withExtractionServices(request.projectRoot, services => services.resummarize(taskId));
});
