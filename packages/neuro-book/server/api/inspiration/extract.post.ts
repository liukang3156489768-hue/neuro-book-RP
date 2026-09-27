import {defineEventHandler} from "h3";
import {InspirationExtractSchema} from "nbook/shared/dto/inspiration.dto";
import {extractInspiration} from "nbook/server/inspiration/runtime";
import {validateBody} from "nbook/server/utils/novel-chapter";

export default defineEventHandler(async event => {
    const input = await validateBody(event, InspirationExtractSchema, {maxBytes: 256 * 1024});
    const controller = new AbortController();
    const disconnected = () => { if (!event.node.res.writableEnded) controller.abort(); };
    event.node.res.on("close", disconnected);
    try {
        return await extractInspiration(input, controller.signal);
    } finally {
        event.node.res.off("close", disconnected);
    }
});
