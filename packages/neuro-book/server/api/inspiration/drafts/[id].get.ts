import {createError, defineEventHandler, getQuery, getRouterParam} from "h3";
import {ProjectRootDtoSchema} from "nbook/shared/dto/project.dto";
import {readInspirationDraft} from "nbook/server/inspiration/runtime";

export default defineEventHandler(async event => {
    const id = getRouterParam(event, "id");
    const parsed = ProjectRootDtoSchema.safeParse(getQuery(event).projectRoot);
    if (!parsed.success) throw createError({statusCode: 400, message: "草稿查询参数无效"});
    if (!id) throw createError({statusCode: 400, message: "缺少草稿编号"});
    return readInspirationDraft(parsed.data, id);
});
