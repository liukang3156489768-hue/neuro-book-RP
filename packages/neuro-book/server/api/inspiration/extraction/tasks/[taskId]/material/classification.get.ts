import {defineEventHandler, getQuery} from "h3";
import {ExtractionProjectQuerySchema} from "nbook/shared/dto/inspiration-extraction-api.dto";
import {parseExtractionRequest, withExtractionServices} from "nbook/server/inspiration/extraction/http";
import {requireTaskId} from "nbook/server/inspiration/extraction/route-params";
import {requireTaskKind} from "nbook/server/inspiration/extraction/task-service";

/** 素材任务等待归类时的候选类别、文件夹与疑似同名项，供人工归类使用。 */
export default defineEventHandler(async (event) => {
    const query = parseExtractionRequest(ExtractionProjectQuerySchema, getQuery(event), "任务查询");
    const taskId = requireTaskId(event);
    return withExtractionServices(query.projectRoot, async services => {
        requireTaskKind(await services.manager.get(taskId), "material");
        return services.classification(taskId);
    });
});
