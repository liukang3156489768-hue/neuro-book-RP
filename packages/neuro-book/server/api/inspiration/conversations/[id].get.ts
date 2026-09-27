import {createError, defineEventHandler, getQuery, getRouterParam} from "h3";
import {InspirationConversationGetRequestSchema} from "nbook/shared/dto/inspiration.dto";
import {readInspirationConversation} from "nbook/server/inspiration/runtime";

export default defineEventHandler(async event => {
    const query = getQuery(event);
    const parsed = InspirationConversationGetRequestSchema.safeParse({projectRoot: query.projectRoot, id: getRouterParam(event, "id")});
    if (!parsed.success) throw createError({statusCode: 400, message: "聊天记录标识无效"});
    return readInspirationConversation(parsed.data.projectRoot, parsed.data.id);
});
