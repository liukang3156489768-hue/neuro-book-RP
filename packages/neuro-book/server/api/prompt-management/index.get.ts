import {useAgentHarness} from "nbook/server/agent/http";
import {usePromptManagement} from "nbook/server/prompt-management/service";

export default defineEventHandler(() => usePromptManagement(useAgentHarness().runtimePaths).catalog());
