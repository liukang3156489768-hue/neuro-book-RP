import {defineEventHandler, getQuery} from "h3";
import {ExtractionProjectQuerySchema} from "nbook/shared/dto/inspiration-extraction-api.dto";
import {USER_CONFIRMER} from "nbook/server/inspiration/extraction/host";
import {parseExtractionRequest, withExtractionServices} from "nbook/server/inspiration/extraction/http";
import {requireTaskId} from "nbook/server/inspiration/extraction/route-params";

/** 已选条目与项目内同名条目的新旧对比；确认者固定为界面用户，决定哪些冲突可由其处理。 */
export default defineEventHandler(async (event) => {
    const query = parseExtractionRequest(ExtractionProjectQuerySchema, getQuery(event), "任务查询");
    const taskId = requireTaskId(event);
    return withExtractionServices(query.projectRoot, ({review}) => review.conflicts(taskId, USER_CONFIRMER));
});
