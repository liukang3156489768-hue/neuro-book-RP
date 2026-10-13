import {createError, defineEventHandler, getQuery} from "h3";
import {InspirationMaterialListRequestSchema} from "nbook/shared/dto/inspiration.dto";
import {listInspirationMaterials} from "nbook/server/inspiration/materials";
import {runtimePathsFromEnv} from "nbook/server/runtime/paths/runtime-paths";
import {resolveWorkspaceFileTarget} from "nbook/server/workspace-files/novel-workspace";
import {withProjectTargetOperation} from "nbook/server/workspace-files/project-open-guard";

export default defineEventHandler(async event => {
    const parsed = InspirationMaterialListRequestSchema.safeParse(getQuery(event));
    if (!parsed.success) throw createError({statusCode: 400, message: "请先打开项目，参考素材列表参数无效"});
    const target = await resolveWorkspaceFileTarget(runtimePathsFromEnv(), parsed.data);
    return withProjectTargetOperation(target, () => listInspirationMaterials(target.root, {
        category: parsed.data.category, query: parsed.data.query, offset: parsed.data.offset, limit: parsed.data.limit,
    }));
});
