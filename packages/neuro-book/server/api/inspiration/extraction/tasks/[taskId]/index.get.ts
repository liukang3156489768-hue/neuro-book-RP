import {defineEventHandler, getQuery} from "h3";
import {ExtractionProjectQuerySchema, type ExtractionTaskDetailResponseDto} from "nbook/shared/dto/inspiration-extraction-api.dto";
import {parseExtractionRequest, withExtractionServices} from "nbook/server/inspiration/extraction/http";
import {requireTaskId} from "nbook/server/inspiration/extraction/route-params";

/** 任务记录与三层进度（整体、分组、逐单元）。运行中但无执行者的任务读成“已中断”。 */
export default defineEventHandler(async (event): Promise<ExtractionTaskDetailResponseDto> => {
    const query = parseExtractionRequest(ExtractionProjectQuerySchema, getQuery(event), "任务查询");
    const taskId = requireTaskId(event);
    return withExtractionServices(query.projectRoot, async ({manager}) => {
        const task = await manager.get(taskId);
        return {task, progress: await manager.progress(taskId)};
    });
});
