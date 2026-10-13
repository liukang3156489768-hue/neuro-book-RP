import {resolvePiModelFromConfig} from "nbook/server/agent/harness/model-resolver";
import {resolvePiModelsFromConfig} from "nbook/server/agent/harness/pi-runtime-resolver";
import {mergePiRequestHeaders, parsePiSimpleRequestOptions, piRequestAuthOptions} from "nbook/server/agent/harness/pi-request-options";
import {tracedCompleteSimple} from "nbook/server/agent/observability/traced-provider";
import {loadEffectiveConfigFromTarget} from "nbook/server/config/config-service";
import {resolveStateWorkspaceRoot} from "nbook/server/runtime/installation-paths";
import {absoluteFsPath} from "nbook/server/runtime/paths/file-path";
import type {ReadyProjectSessionRef} from "nbook/server/workspace-files/project-session-types";
import {OutlineGenerationError} from "./direction";
import {usePromptManagement} from "nbook/server/prompt-management/service";
import {renderManagedPrompt} from "nbook/server/prompt-management/render";
import {managedProviderMessages} from "nbook/server/prompt-management/provider-messages";
import {prepareOrderedProviderRequest} from "nbook/server/prompt-management/ordered-provider-request";

/** 一次性、不带工具的模型请求；Project 配置与 ready generation 相同，关闭会话时透传取消信号。 */
export async function completeDirectionWithModel(ready: ReadyProjectSessionRef, prompt: string, signal: AbortSignal,
    purposeId: "outline.direction" | "outline.line-analysis" | "outline.detail-analysis" = "outline.direction",
): Promise<string> {
    const snapshot = await usePromptManagement().capture();
    const managed = renderManagedPrompt(snapshot, purposeId, {context: prompt});
    const config = await loadEffectiveConfigFromTarget({scope: "project", workspaceRoot: absoluteFsPath(resolveStateWorkspaceRoot()), project: ready});
    let model: ReturnType<typeof resolvePiModelFromConfig>;
    try {
        model = resolvePiModelFromConfig(config, "outline");
    } catch (error) {
        throw new OutlineGenerationError("尚无可用的大纲生成模型，请先配置模型", "MODEL_UNAVAILABLE", error);
    }
    const provider = config.models.providers[model.provider]!;
    const request = parsePiSimpleRequestOptions(provider.options.requestOptions);
    signal.throwIfAborted();
    const context = {
        systemPrompt: managed.systemPrompt,
        messages: managedProviderMessages(managed.messages),
        tools: [],
    };
    const options = {
        ...request,
        ...piRequestAuthOptions({api: model.api, apiKey: provider.options.apiKey.trim() || undefined, env: request.env}),
        headers: mergePiRequestHeaders(model.headers, request.headers),
        timeoutMs: Math.min(provider.options.timeoutMs ?? 30_000, 30_000),
        maxTokens: Math.min(model.maxTokens, 4096),
        reasoning: undefined,
        signal,
    };
    const ordered = prepareOrderedProviderRequest(model, context, options, managed.orderedMessages, context.messages.length);
    const response = await tracedCompleteSimple(resolvePiModelsFromConfig(config, model), model, ordered.context, ordered.options);
    signal.throwIfAborted();
    if (response.stopReason !== "stop") throw new OutlineGenerationError("模型未完整返回草案，请重试", "MODEL_FAILED");
    return response.content.filter((block) => block.type === "text").map((block) => block.text).join("").trim();
}
