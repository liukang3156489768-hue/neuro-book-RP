import {describe, expect, it} from "vitest";
import {modelLibrary, modelKnowledge} from "nbook/server/models/model-library";

describe("Model Library", () => {
    it("按精确 model ID 生成唯一稳定条目，不暴露 Provider 价格和传输配置", () => {
        const library = modelLibrary();
        const ids = library.models.map((model) => model.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toEqual([...ids].sort((left, right) => left.localeCompare(right)));

        const mimo = modelKnowledge("mimo-v2.5-pro");
        expect(mimo).toMatchObject({source: "xiaomi", contextWindowTokens: 1_048_576, maxTokens: 131_072});
        expect(mimo).not.toHaveProperty("cost");
        expect(mimo).not.toHaveProperty("defaultApi");
        expect(mimo).not.toHaveProperty("compatByApi");
    });

    it("只允许精确 ID 命中", () => {
        expect(modelKnowledge("mimo-v2.5")).not.toBeNull();
        expect(modelKnowledge("mimo-v2.5 ")).not.toBeNull();
        expect(modelKnowledge("mimo")).toBeNull();
    });

    it.each([
        ["claude-opus-5", "anthropic", 1_000_000, 128_000],
        ["claude-opus-5-5", "anthropic", 1_000_000, 128_000],
        ["gpt-6.1-sol", "openai", 1_050_000, 128_000],
        ["gpt-6-astra", "openai", 1_050_000, 128_000],
        ["gemini-3.7-flash", "google", 1_048_576, 65_536],
        ["gemini-3.8-flash", "google", 1_048_576, 65_536],
    ])("为 %s 提供可用于导入的完整通用能力", (id, source, contextWindowTokens, maxTokens) => {
        expect(modelKnowledge(id)).toMatchObject({
            id, source, contextWindowTokens, maxTokens,
            reasoning: true, input: ["text", "image"],
        });
    });
});
