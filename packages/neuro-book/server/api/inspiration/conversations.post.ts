import {defineEventHandler} from "h3";
import {InspirationConversationCreateSchema} from "nbook/shared/dto/inspiration.dto";
import {createInspirationConversation} from "nbook/server/inspiration/runtime";
import {validateBody} from "nbook/server/utils/novel-chapter";

export default defineEventHandler(async event => {
    const input = await validateBody(event, InspirationConversationCreateSchema);
    return createInspirationConversation(input.projectRoot, input.title);
});
