import {useAgentHarness} from "nbook/server/agent/http";
import {usePromptManagement} from "nbook/server/prompt-management/service";
import {validateBody} from "nbook/server/utils/novel-chapter";
import {PromptMutationDtoSchema} from "nbook/shared/dto/prompt-management.dto";

export default defineEventHandler(async event => usePromptManagement(useAgentHarness().runtimePaths).mutate(await validateBody(event, PromptMutationDtoSchema)));
