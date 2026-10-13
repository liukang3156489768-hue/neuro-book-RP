import {defineEventHandler, readBody} from "h3";
import {ExtractionStructurePreviewRequestSchema, type ExtractionStructurePreviewResponseDto} from "nbook/shared/dto/inspiration-extraction-api.dto";
import {parseExtractionRequest, withExtractionHttpError} from "nbook/server/inspiration/extraction/http";
import {previewExtractionStructure} from "nbook/server/inspiration/extraction/structure-service";
import {runtimePathsFromEnv} from "nbook/server/runtime/paths/runtime-paths";
import {resolveWorkspaceFileTarget} from "nbook/server/workspace-files/novel-workspace";
import {withProjectTargetOperation} from "nbook/server/workspace-files/project-open-guard";

/** 章节识别（应用修正后）、默认划卷建议或字数模式的切分块；每次从磁盘重新识别，不保存修正。 */
export default defineEventHandler(async (event): Promise<ExtractionStructurePreviewResponseDto> => {
    const request = parseExtractionRequest(ExtractionStructurePreviewRequestSchema, await readBody(event), "章节识别请求");
    const target = await resolveWorkspaceFileTarget(runtimePathsFromEnv(), {projectRoot: request.projectRoot});
    return withProjectTargetOperation(target, () => withExtractionHttpError(() => previewExtractionStructure(target.root, request)));
});
