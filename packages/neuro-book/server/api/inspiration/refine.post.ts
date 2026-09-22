import {defineEventHandler} from "h3";
import {InspirationArtifactRefineSchema} from "nbook/shared/dto/inspiration.dto";
import {validateBody} from "nbook/server/utils/novel-chapter";
import {refineInspiration} from "nbook/server/inspiration/runtime";

export default defineEventHandler(async event => {
    const input = await validateBody(event, InspirationArtifactRefineSchema, {maxBytes: 256 * 1024});
    const controller = new AbortController();
    const disconnected = () => { if (!event.node.res.writableEnded) controller.abort(); };
    event.node.res.on("close", disconnected);
    try { return await refineInspiration(input, controller.signal); }
    finally { event.node.res.off("close", disconnected); }
});
