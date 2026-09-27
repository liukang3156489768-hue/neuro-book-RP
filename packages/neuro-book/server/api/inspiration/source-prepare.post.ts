import {createError, defineEventHandler, readBody} from "h3";
import {InspirationSourcePrepareRequestSchema} from "nbook/shared/dto/inspiration-source.dto";
import {prepareInspirationSource} from "nbook/server/inspiration/source";
import {runtimePathsFromEnv} from "nbook/server/runtime/paths/runtime-paths";
import {resolveWorkspaceFileTarget} from "nbook/server/workspace-files/novel-workspace";
import {withProjectTargetOperation} from "nbook/server/workspace-files/project-open-guard";

export default defineEventHandler(async (event) => {
    const parsed = InspirationSourcePrepareRequestSchema.safeParse(await readBody(event));
    if (!parsed.success) {
        throw createError({statusCode: 400, message: "请选择当前项目 reference 目录内的 .txt 或 .md 作品文件。"});
    }
    const target = await resolveWorkspaceFileTarget(runtimePathsFromEnv(), {projectRoot: parsed.data.projectRoot});
    return withProjectTargetOperation(target, () => prepareInspirationSource(target.root, parsed.data.path));
});
