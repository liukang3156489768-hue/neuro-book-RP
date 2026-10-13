import {describe, expect, it} from "vitest";
import {candidateFromLibrary, completeModelCandidate} from "nbook/app/components/novel-ide/settings/sections/providers/provider-model-draft-factory";
import type {DiscoveredProviderModelDto, ModelLibraryEntryDto} from "nbook/shared/dto/app-settings.dto";
import {modelKnowledge} from "nbook/server/models/model-library";

describe("Model Candidate Completion", () => {
    it("完整远程字段保持优先", () => {
        const result = completeModelCandidate(discovered({
            reasoning: false,
            input: ["text"],
            contextWindowTokens: 32_000,
            maxTokens: 4_000,
        }), knowledge());

        expect(result).toMatchObject({
            status: "complete",
            model: {enabled: true, contextWindowTokens: 32_000, maxTokens: 4_000, reasoning: false},
            provenance: {contextWindowTokens: "remote", maxTokens: "remote"},
        });
    });

    it("Model Library 只补远端缺失字段", () => {
        const result = completeModelCandidate(discovered({contextWindowTokens: 64_000}), knowledge());
        expect(result).toMatchObject({
            status: "complete",
            model: {contextWindowTokens: 64_000, maxTokens: 8_000, reasoning: true, input: ["text"]},
            provenance: {contextWindowTokens: "remote", maxTokens: "model-library", reasoning: "model-library"},
        });
    });

    it("OpenAI 发现无法判断接口时使用 Provider Config 的 Responses 格式", () => {
        const result = completeModelCandidate(discovered({api: null}), knowledge(), "openai-responses");
        expect(result).toMatchObject({
            status: "complete",
            model: {api: "openai-responses"},
            provenance: {api: "provider-config"},
        });
    });

    it("未补全候选不产生可持久化 model", () => {
        const result = completeModelCandidate(discovered({api: null}), null);
        expect(result).toMatchObject({status: "incomplete"});
        expect(result).not.toHaveProperty("model");
        if (result.status === "incomplete") {
            expect(result.missingFields).toEqual(expect.arrayContaining(["api", "reasoning", "input", "contextWindowTokens", "maxTokens"]));
        }
    });

    it.each([
        "claude-opus-5", "claude-opus-5-5", "gpt-6.1-sol", "gpt-6-astra",
        "gemini-3.7-flash", "gemini-3.8-flash",
    ])("%s 可从模型库导入，也可补齐仅返回 ID 的网关候选", (id) => {
        const entry = modelKnowledge(id);
        expect(entry).not.toBeNull();
        if (!entry) throw new Error(`模型库缺少 ${id}`);

        for (const api of ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const) {
            expect(candidateFromLibrary(entry, api)).toMatchObject({
                status: "complete", model: {id, api, enabled: true},
            });
        }
        expect(completeModelCandidate(discovered({
            id, api: null, contextWindowTokens: 128_000, maxTokens: 8_192,
        }), entry, "anthropic-messages")).toMatchObject({
            status: "complete",
            model: {id, api: "anthropic-messages", contextWindowTokens: 128_000, maxTokens: 8_192},
            provenance: {contextWindowTokens: "remote", maxTokens: "remote", reasoning: "model-library"},
        });
    });
});

function discovered(overrides: Partial<DiscoveredProviderModelDto> = {}): DiscoveredProviderModelDto {
    return {
        id: "model",
        name: "Remote Model",
        group: null,
        api: "openai-completions",
        reasoning: null,
        input: null,
        contextWindowTokens: null,
        maxTokens: null,
        cost: null,
        compat: null,
        headers: null,
        thinkingLevelMap: null,
        ...overrides,
    };
}

function knowledge(): ModelLibraryEntryDto {
    return {
        id: "model",
        name: "Library Model",
        source: "vendor",
        reasoning: true,
        thinkingLevelMap: null,
        input: ["text"],
        contextWindowTokens: 128_000,
        maxTokens: 8_000,
    };
}
