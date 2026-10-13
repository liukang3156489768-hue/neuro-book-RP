import {defineEventHandler, readBody} from "h3";
import {MaterialReviewActionRequestSchema} from "nbook/shared/dto/inspiration-extraction-api.dto";
import {parseExtractionRequest, withExtractionServices} from "nbook/server/inspiration/extraction/http";
import {requireTaskId} from "nbook/server/inspiration/extraction/route-params";
import {applyMaterialReviewAction} from "nbook/server/inspiration/extraction/review-actions";

/** 审阅操作：勾选、编辑、删除、拆分、合并；返回操作后的完整审阅清单。 */
export default defineEventHandler(async (event) => {
    const request = parseExtractionRequest(MaterialReviewActionRequestSchema, await readBody(event), "审阅操作请求");
    const taskId = requireTaskId(event);
    return withExtractionServices(request.projectRoot, services => applyMaterialReviewAction(services, taskId, request.action));
});
