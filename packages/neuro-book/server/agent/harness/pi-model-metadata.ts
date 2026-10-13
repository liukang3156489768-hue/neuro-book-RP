import type {Api, Model} from "@earendil-works/pi-ai";
import type {ConfiguredModelConfig, ConfiguredProviderConfig} from "nbook/server/config/types";
import type {JsonValue} from "nbook/server/agent/messages/types";
import {resolvePiRuntimeCost} from "nbook/server/utils/pi-model-cost";
import {SupportedPiApiSchema} from "nbook/shared/dto/app-settings.dto";
import {assertConfiguredModel} from "nbook/server/models/model-config-validation";

export type ResolvedPiModel = Model<Api> & {
    /** Session selection 使用的本地 Provider Config ID。 */
    providerConfigId: string;
};

/**
 * 将完整、自包含的用户 Provider Config 解析为 Pi Model。
 * Runtime 不读取 Provider Preset、Model Catalog 或远程发现结果，也不猜测任何必需能力。
 */
export function resolvePiModelMetadata(
    providerConfigId: string,
    provider: ConfiguredProviderConfig,
    model: ConfiguredModelConfig,
): ResolvedPiModel {
    assertConfiguredModel(providerConfigId, provider, model);
    const api = SupportedPiApiSchema.parse(model.api);
    const baseUrl = provider.options.baseURL.trim();
    const compat = resolveModelCompat(model, api);
    const thinkingLevelMap = resolveThinkingLevelMap(model, api, compat);

    return {
        id: model.id,
        name: model.name || model.id,
        api,
        provider: providerConfigId,
        providerConfigId,
        baseUrl,
        reasoning: model.reasoning,
        input: [...model.input],
        cost: resolvePiRuntimeCost(undefined, model.cost),
        contextWindow: model.contextWindowTokens,
        maxTokens: model.maxTokens,
        headers: Object.fromEntries(Object.entries(model.headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== null)),
        ...(compat ? {compat: compat as Model<Api>["compat"]} : {}),
        ...(thinkingLevelMap ? {thinkingLevelMap} : {}),
    };
}

/**
 * Anthropic 近期 Claude 模型要求 adaptive thinking；远端兼容网关返回的模型目录
 * 往往只有 ID，无法提供 Pi catalog 中的 compat 标记，因此按官方模型命名规则补齐。
 * 显式保存的 compat 始终优先，旧版或非 Claude 模型不会被改变。
 */
function resolveModelCompat(model: ConfiguredModelConfig, api: Api): Record<string, JsonValue> | null {
    const explicit = model.compat ? {...model.compat} : {};
    if (api === "anthropic-messages" && model.reasoning && isAdaptiveClaudeModel(model.id)) {
        explicit.forceAdaptiveThinking = true;
    }
    return Object.keys(explicit).length > 0 ? explicit : null;
}

/** `off: null` 让 Pi 在未请求思考时省略 thinking 字段，而不是发送 disabled。 */
function resolveThinkingLevelMap(model: ConfiguredModelConfig, api: Api, compat: Record<string, JsonValue> | null): Record<string, string | null> | null {
    const current = model.thinkingLevelMap ? {...model.thinkingLevelMap} : {};
    if (api === "anthropic-messages" && compat?.forceAdaptiveThinking === true) {
        current.off = null;
    }
    return Object.keys(current).length > 0 ? current : null;
}

function isAdaptiveClaudeModel(modelId: string): boolean {
    return /^claude-(?:opus|sonnet|haiku)-(?:5(?:[-.]|$)|4-(?:6|7|8)(?:[-.]|$))/u.test(modelId.trim().toLowerCase());
}
