import {defineEventHandler} from "h3";
import {InspirationCancelSchema} from "nbook/shared/dto/inspiration.dto";
import {validateBody} from "nbook/server/utils/novel-chapter";
import {cancelInspiration} from "nbook/server/inspiration/runtime";

export default defineEventHandler(async event => {
    const input = await validateBody(event, InspirationCancelSchema);
    return cancelInspiration(input.projectRoot, input.requestId);
});
