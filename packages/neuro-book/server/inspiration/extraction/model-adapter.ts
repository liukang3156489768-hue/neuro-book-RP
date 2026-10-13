import {createUserMessage} from "nbook/server/agent/messages/message-utils";
import {managedProviderMessages} from "nbook/server/prompt-management/provider-messages";
import {prepareOrderedProviderRequest} from "nbook/server/prompt-management/ordered-provider-request";
import {resolvePiModelFromConfig} from "nbook/server/agent/harness/model-resolver";
import {resolvePiModelsFromConfig} from "nbook/server/agent/harness/pi-runtime-resolver";
import {mergePiRequestHeaders, parsePiSimpleRequestOptions, piRequestAuthOptions} from "nbook/server/agent/harness/pi-request-options";
import {tracedCompleteSimple} from "nbook/server/agent/observability/traced-provider";
import {loadEffectiveConfigFromTarget} from "nbook/server/config/config-service";
import {resolveStateWorkspaceRoot} from "nbook/server/runtime/installation-paths";
import {absoluteFsPath} from "nbook/server/runtime/paths/file-path";
import type {ReadyProjectSessionRef} from "nbook/server/workspace-files/project-session-types";
import {appLogger} from "nbook/server/app-logs/logger";
import {ExtractionFatalError, ExtractionModelError} from "./errors";
import type {ExtractionModelPort} from "./types";

/** 未指定 modelKey 时按 Inspiration Profile 的模型配置解析，与工作台设计 Agent 一致。 */
const EXTRACTION_PROFILE_KEY = "inspiration";
/**
 * 提取单元的原文约五万字，产出（含校验失败后的完整重写）远大于大纲方向草案，
 * 所以超时与输出上限都比 `outline/direction-model.ts` 宽松；超时取 Provider 配置与下限中较大者。
 */
export const EXTRACTION_MIN_TIMEOUT_MS = 10 * 60 * 1000;
/** 提取各阶段共享的输出预算；实际请求仍受所选模型自身上限约束。 */
export const EXTRACTION_MAX_OUTPUT_TOKENS = 64_000;

export {ExtractionModelError} from "./errors";

/**
 * 真实模型适配器：无工具、一次性补全，绑定 ready Project 的配置与调用方给出的取消信号。
 *
 * 思考能力固定关闭（`reasoning: undefined`，且排在 Provider requestOptions 展开之后，配置里的值不能覆盖）。
 * `ExtractionModelPort` 的请求类型没有思考开关，工作台的思考设置因此无法影响提取。
 * 解析方式沿用 `outline/direction-model.ts`，该文件不属于本能力，这里不复用其固定的 30 秒与 4096 上限。
 */
export function createProjectExtractionModel(ready: ReadyProjectSessionRef): ExtractionModelPort {
    return {
        async complete(request) {
            const config = await loadEffectiveConfigFromTarget({scope: "project", workspaceRoot: absoluteFsPath(resolveStateWorkspaceRoot()), project: ready});
            let model: ReturnType<typeof resolvePiModelFromConfig>;
            try {
                model = resolvePiModelFromConfig(config, EXTRACTION_PROFILE_KEY, request.modelKey ? {modelKey: request.modelKey} : undefined);
            } catch (error) {
                // 模型没配好时每个单元都会同样失败，按任务级错误停止，而不是把所有单元逐个标记失败。
                throw new ExtractionFatalError("model-unavailable", "尚无可用的提取模型，请先配置模型或检查所选模型", {cause: error});
            }
            const provider = config.models.providers[model.provider]!;
            const options = parsePiSimpleRequestOptions(provider.options.requestOptions);
            request.signal.throwIfAborted();
            const messages = request.orderedMessages
                ? request.orderedMessages.flatMap(message => message.role === "system" ? [] : [{role: message.role, content: message.content}])
                : request.preMessages ?? [];
            const context = {
                systemPrompt: request.system,
                messages: request.orderedMessages ? managedProviderMessages(messages)
                    : [...managedProviderMessages(messages), createUserMessage({text: request.prompt})],
                tools: [],
            };
            const requestOptions = {
                ...options,
                ...piRequestAuthOptions({api: model.api, apiKey: provider.options.apiKey.trim() || undefined, env: options.env}),
                headers: mergePiRequestHeaders(model.headers, options.headers),
                timeoutMs: Math.max(provider.options.timeoutMs ?? 0, EXTRACTION_MIN_TIMEOUT_MS),
                maxTokens: Math.min(model.maxTokens, EXTRACTION_MAX_OUTPUT_TOKENS),
                reasoning: undefined,
                signal: request.signal,
            };
            const ordered = prepareOrderedProviderRequest(model, context, requestOptions, request.orderedMessages, context.messages.length);
            let response: Awaited<ReturnType<typeof tracedCompleteSimple>>;
            try {
                response = await tracedCompleteSimple(resolvePiModelsFromConfig(config, model), model, ordered.context, ordered.options);
            } catch (error) {
                void appLogger.error("inspiration.extraction.modelError", {
                    ...request.metadata,
                    model: `${model.provider}/${model.id}`,
                    maxOutputCount: requestOptions.maxTokens,
                }, error);
                throw error;
            }
            request.signal.throwIfAborted();
            const usage = response.usage;
            void appLogger.info("inspiration.extraction.modelResponse", {
                ...request.metadata,
                model: `${model.provider}/${model.id}`,
                api: model.api,
                stopReason: response.stopReason,
                inputCount: usage?.input ?? null,
                outputCount: usage?.output ?? null,
                cacheReadCount: usage?.cacheRead ?? null,
                cacheWriteCount: usage?.cacheWrite ?? null,
                cacheWrite1hCount: usage?.cacheWrite1h ?? null,
                totalCount: usage?.totalTokens ?? null,
                maxOutputCount: requestOptions.maxTokens,
                outputCharacters: response.content.filter(block => block.type === "text")
                    .reduce((total, block) => total + block.text.length, 0),
            });
            // 被截断的产出不是完整成果，也不值得拿去做校验修复：按本单元失败处理。
            if (response.stopReason !== "stop") throw new ExtractionModelError(response.stopReason);
            return response.content.filter(block => block.type === "text").map(block => block.text).join("").trim();
        },
    };
}
