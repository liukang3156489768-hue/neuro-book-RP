import {describe, expect, it} from "vitest";
import {resolvePiModelMetadata} from "nbook/server/agent/harness/pi-model-metadata";
import type {ConfiguredModelConfig, ConfiguredProviderConfig} from "nbook/server/config/types";

describe("Pi model metadata contract", () => {
    it("只从完整 Provider Config 生成自包含 Pi Model", () => {
        const resolved = resolvePiModelMetadata("mimo", createProvider(), createModel({
            id: "mimo-v2.5-pro",
            name: "MiMo V2.5 Pro",
            compat: {maxTokensField: "max_tokens"},
        }));

        expect(resolved).toMatchObject({
            provider: "mimo",
            providerConfigId: "mimo",
            baseUrl: "http://127.0.0.1:11434/v1",
            contextWindow: 1_048_576,
            maxTokens: 131_072,
            compat: {maxTokensField: "max_tokens"},
        });
    });

    it.each([
        ["Pi API", createProvider(), createModel({api: null})],
        ["Provider Base URL", createProvider({baseURL: ""}), createModel()],
        ["reasoning 能力", createProvider(), createModel({reasoning: null})],
        ["输入能力", createProvider(), createModel({input: null})],
        ["contextWindowTokens", createProvider(), createModel({contextWindowTokens: null})],
        ["maxTokens", createProvider(), createModel({maxTokens: null})],
    ])("完整配置缺少 %s 时明确失败", (_field, provider, model) => {
        expect(() => resolvePiModelMetadata("custom", provider, model)).toThrow();
    });

    it("拒绝 maxTokens 大于 contextWindowTokens", () => {
        expect(() => resolvePiModelMetadata("custom", createProvider(), createModel({
            contextWindowTokens: 4096,
            maxTokens: 8192,
        }))).toThrow("maxTokens 不能大于 contextWindowTokens");
    });

    it("为近期 Anthropic Claude 模型补齐 adaptive thinking 能力", () => {
        const resolved = resolvePiModelMetadata("kitool", createProvider({baseURL: "https://kitool.ai"}), createModel({
            id: "claude-opus-5-5",
            api: "anthropic-messages",
            reasoning: true,
        }));

        expect(resolved.compat).toMatchObject({forceAdaptiveThinking: true});
        expect(resolved.thinkingLevelMap).toMatchObject({off: null});
    });

    it("不为旧版或非 Anthropic 模型猜测 adaptive thinking", () => {
        const resolved = resolvePiModelMetadata("custom", createProvider(), createModel({
            id: "claude-opus-4-5",
            api: "anthropic-messages",
            reasoning: true,
        }));

        expect(resolved.compat).toBeUndefined();
        expect(resolved.thinkingLevelMap).toBeUndefined();
    });
});

function createProvider(overrides: {baseURL?: string} = {}): ConfiguredProviderConfig {
    return {
        name: "Custom",
        enabled: true,
        modelApi: null,
        options: {
            apiKey: "",
            baseURL: overrides.baseURL ?? "http://127.0.0.1:11434/v1",
            proxy: "",
            timeoutMs: null,
            requestOptions: {},
        },
        models: {},
    };
}

function createModel(overrides: Partial<ConfiguredModelConfig> = {}): ConfiguredModelConfig {
    return {
        name: "Custom Model",
        id: "custom-model",
        group: null,
        enabled: true,
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        maxTokens: 131_072,
        cost: null,
        compat: null,
        headers: null,
        thinkingLevelMap: null,
        contextWindowTokens: 1_048_576,
        ...overrides,
    };
}
