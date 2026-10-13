import {defineEventHandler, getQuery} from "h3";
import {ExtractionProjectQuerySchema} from "nbook/shared/dto/inspiration-extraction-api.dto";
import {parseExtractionRequest, withExtractionServices} from "nbook/server/inspiration/extraction/http";
import {readOutlineExtractionOutcome} from "nbook/server/inspiration/extraction/outline-pipeline";
import {requireTaskId} from "nbook/server/inspiration/extraction/route-params";
import {requireTaskKind} from "nbook/server/inspiration/extraction/task-service";

/** 大纲任务的覆盖新旧对比、已确认项、覆盖失败项与卷纲/总纲过期状态。 */
export default defineEventHandler(async (event) => {
    const query = parseExtractionRequest(ExtractionProjectQuerySchema, getQuery(event), "任务查询");
    const taskId = requireTaskId(event);
    return withExtractionServices(query.projectRoot, async ({manager}) => readOutlineExtractionOutcome(requireTaskKind(await manager.get(taskId), "outline")));
});
