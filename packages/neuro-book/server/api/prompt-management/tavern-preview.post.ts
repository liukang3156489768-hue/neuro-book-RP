import {useAgentHarness} from "nbook/server/agent/http";
import {usePromptManagement} from "nbook/server/prompt-management/service";
import {validateBody} from "nbook/server/utils/novel-chapter";
import {TavernPreviewRequestSchema} from "nbook/shared/dto/tavern-preset.dto";

export default defineEventHandler(async event => usePromptManagement(useAgentHarness().runtimePaths)
    .preview(await validateBody(event, TavernPreviewRequestSchema)));
