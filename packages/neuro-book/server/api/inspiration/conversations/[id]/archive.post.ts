import {createError, defineEventHandler, getRouterParam} from "h3";
import {InspirationConversationArchiveSchema} from "nbook/shared/dto/inspiration.dto";
import {archiveInspirationConversation} from "nbook/server/inspiration/runtime";
import {validateBody} from "nbook/server/utils/novel-chapter";

export default defineEventHandler(async event => {
    const body = await validateBody(event, InspirationConversationArchiveSchema.omit({id: true}));
    const parsed = InspirationConversationArchiveSchema.safeParse({...body, id: getRouterParam(event, "id")});
    if (!parsed.success) throw createError({statusCode: 400, message: "聊天记录标识无效"});
    return archiveInspirationConversation(parsed.data.projectRoot, parsed.data.id);
});
