import {createError, defineEventHandler, getQuery} from "h3";
import {InspirationConversationListRequestSchema} from "nbook/shared/dto/inspiration.dto";
import {listInspirationConversations} from "nbook/server/inspiration/runtime";

export default defineEventHandler(async event => {
    const parsed = InspirationConversationListRequestSchema.safeParse(getQuery(event));
    if (!parsed.success) throw createError({statusCode: 400, message: "聊天记录查询参数无效"});
    return listInspirationConversations(parsed.data.projectRoot, parsed.data.includeArchived === "true");
});
