import {defineEventHandler, getQuery} from "h3";
import {ExtractionProjectQuerySchema} from "nbook/shared/dto/inspiration-extraction-api.dto";
import {parseExtractionRequest, withExtractionServices} from "nbook/server/inspiration/extraction/http";
import {requireTaskId} from "nbook/server/inspiration/extraction/route-params";

/** 素材审阅清单：条目、勾选状态与节点内容。任务未到审阅阶段、已写入后的锁定由审阅服务判定。 */
export default defineEventHandler(async (event) => {
    const query = parseExtractionRequest(ExtractionProjectQuerySchema, getQuery(event), "任务查询");
    const taskId = requireTaskId(event);
    return withExtractionServices(query.projectRoot, ({review}) => review.get(taskId));
});
