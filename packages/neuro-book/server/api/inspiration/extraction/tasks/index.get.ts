import {defineEventHandler, getQuery} from "h3";
import {ExtractionTaskListQuerySchema, type ExtractionTaskListResponseDto} from "nbook/shared/dto/inspiration-extraction-api.dto";
import {parseExtractionRequest, withExtractionServices} from "nbook/server/inspiration/extraction/http";
import {summarizeTask} from "nbook/server/inspiration/extraction/task-service";

/** 任务列表（不含 params、state 与单元明细）；可按种类与来源路径过滤。 */
export default defineEventHandler(async (event): Promise<ExtractionTaskListResponseDto> => {
    const query = parseExtractionRequest(ExtractionTaskListQuerySchema, getQuery(event), "任务列表查询");
    return withExtractionServices(query.projectRoot, async ({manager}) => ({
        tasks: (await manager.list({kind: query.kind, sourcePath: query.path})).map(summarizeTask),
    }));
});
