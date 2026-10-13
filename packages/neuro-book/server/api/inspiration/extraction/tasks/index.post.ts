import {defineEventHandler, readBody, setResponseStatus} from "h3";
import {ExtractionStartRequestSchema} from "nbook/shared/dto/inspiration-extraction-api.dto";
import type {ExtractionTask} from "nbook/shared/dto/inspiration-extraction-task.dto";
import {parseExtractionRequest, withExtractionServices} from "nbook/server/inspiration/extraction/http";
import {startExtractionTask} from "nbook/server/inspiration/extraction/task-service";

/**
 * 启动大纲或素材提取。任务运行绑定项目生命周期而不是本请求：返回 202 与刚创建的任务记录，
 * 进度用任务读取路由查询。同一来源同一种类已有运行中任务 409；来源哈希与磁盘不一致 409。
 */
export default defineEventHandler(async (event): Promise<{task: ExtractionTask}> => {
    const request = parseExtractionRequest(ExtractionStartRequestSchema, await readBody(event), "提取任务启动请求");
    const task = await withExtractionServices(request.projectRoot, services => startExtractionTask(services, request));
    setResponseStatus(event, 202);
    return {task};
});
