import {defineEventHandler, readBody} from "h3";
import {MaterialConfirmWriteRequestSchema} from "nbook/shared/dto/inspiration-extraction-api.dto";
import {USER_CONFIRMER} from "nbook/server/inspiration/extraction/host";
import {parseExtractionRequest, withExtractionServices} from "nbook/server/inspiration/extraction/http";
import {requireTaskId} from "nbook/server/inspiration/extraction/route-params";

/**
 * 确认写入已选条目。确认者由路由固定为界面用户；请求体 strict 校验，带 `confirmer` 会得到 400，
 * 因此调用方无法自报身份。冲突条目必须在 `decisions` 里逐项给出覆盖、另存或跳过。
 */
export default defineEventHandler(async (event) => {
    const request = parseExtractionRequest(MaterialConfirmWriteRequestSchema, await readBody(event), "写入确认请求");
    const taskId = requireTaskId(event);
    return withExtractionServices(request.projectRoot, ({review, withSignal}) => withSignal(signal => review.confirmWrite(taskId, {
        confirmer: USER_CONFIRMER,
        signal,
        ...(request.decisions === undefined ? {} : {decisions: request.decisions}),
    })));
});
