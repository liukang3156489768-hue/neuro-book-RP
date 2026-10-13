import {createError, defineEventHandler, getQuery} from "h3";
import {ProjectRootDtoSchema} from "nbook/shared/dto/project.dto";
import {readCharacterWorkspace} from "nbook/server/character/character-files";
import {runtimePathsFromEnv} from "nbook/server/runtime/paths/runtime-paths";
import {resolveWorkspaceFileTarget} from "nbook/server/workspace-files/novel-workspace";
import {withProjectTargetOperation} from "nbook/server/workspace-files/project-open-guard";

export default defineEventHandler(async event => {
    const parsed = ProjectRootDtoSchema.safeParse(getQuery(event).projectRoot);
    if (!parsed.success) throw createError({statusCode: 400, message: "projectRoot 不能为空或格式无效"});
    const target = await resolveWorkspaceFileTarget(runtimePathsFromEnv(), {projectRoot: parsed.data});
    return withProjectTargetOperation(target, () => readCharacterWorkspace(target.root));
});
