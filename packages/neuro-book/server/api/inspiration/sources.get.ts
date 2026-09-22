import {createError, defineEventHandler, getQuery} from "h3";
import {InspirationSourceListRequestSchema} from "nbook/shared/dto/inspiration-source.dto";
import {listInspirationSources} from "nbook/server/inspiration/source";
import {runtimePathsFromEnv} from "nbook/server/runtime/paths/runtime-paths";
import {resolveWorkspaceFileTarget} from "nbook/server/workspace-files/novel-workspace";
import {withProjectTargetOperation} from "nbook/server/workspace-files/project-open-guard";

export default defineEventHandler(async (event) => {
    const parsed = InspirationSourceListRequestSchema.safeParse(getQuery(event));
    if (!parsed.success) {
        throw createError({statusCode: 400, message: "请先打开项目，再选择作品来源。"});
    }
    const target = await resolveWorkspaceFileTarget(runtimePathsFromEnv(), parsed.data);
    return withProjectTargetOperation(target, () => listInspirationSources(target.root));
});
