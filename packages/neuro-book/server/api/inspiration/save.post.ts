import {defineEventHandler} from "h3";
import {InspirationSaveSchema} from "nbook/shared/dto/inspiration.dto";
import {validateBody} from "nbook/server/utils/novel-chapter";
import {saveInspiration} from "nbook/server/inspiration/runtime";

export default defineEventHandler(async event => {
    const input = await validateBody(event, InspirationSaveSchema, {maxBytes: 12 * 1024 * 1024});
    return saveInspiration(input);
});
