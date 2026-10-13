import {defineEventHandler, readBody} from "h3";
import {ExtractionProjectRequestSchema} from "nbook/shared/dto/inspiration-extraction-api.dto";
import {parseExtractionRequest, withExtractionServices} from "nbook/server/inspiration/extraction/http";
import {requireTaskId} from "nbook/server/inspiration/extraction/route-params";

/** 删除任务记录与任务目录下的中间产物；已经写入 lorebook 的正式条目不受影响。 */
export default defineEventHandler(async event => {
    const request = parseExtractionRequest(ExtractionProjectRequestSchema, await readBody(event), "任务删除请求");
    const taskId = requireTaskId(event);
    await withExtractionServices(request.projectRoot, services => services.serialize(taskId, () => services.manager.remove(taskId)));
    return {deleted: true, taskId};
});
