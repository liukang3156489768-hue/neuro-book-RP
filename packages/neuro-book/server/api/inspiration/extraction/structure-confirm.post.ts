import {defineEventHandler, readBody} from "h3";
import {ExtractionStructureConfirmRequestSchema, type ExtractionStructureConfirmResponseDto} from "nbook/shared/dto/inspiration-extraction-api.dto";
import {parseExtractionRequest, withExtractionHttpError} from "nbook/server/inspiration/extraction/http";
import {confirmExtractionStructure} from "nbook/server/inspiration/extraction/structure-service";
import {runtimePathsFromEnv} from "nbook/server/runtime/paths/runtime-paths";
import {resolveWorkspaceFileTarget} from "nbook/server/workspace-files/novel-workspace";
import {withProjectTargetOperation} from "nbook/server/workspace-files/project-open-guard";

/** 校验划卷（章节范围或字数模式每卷块数 N），返回可交给任务启动的提取结构；非法划卷 422。 */
export default defineEventHandler(async (event): Promise<ExtractionStructureConfirmResponseDto> => {
    const request = parseExtractionRequest(ExtractionStructureConfirmRequestSchema, await readBody(event), "划卷确认请求");
    const target = await resolveWorkspaceFileTarget(runtimePathsFromEnv(), {projectRoot: request.projectRoot});
    return withProjectTargetOperation(target, () => withExtractionHttpError(() => confirmExtractionStructure(target.root, request)));
});
