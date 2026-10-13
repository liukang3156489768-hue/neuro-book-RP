import {describe, expect, it} from "vitest";
import {extractTavernGeneration} from "./tavern-generation";

describe("酒馆生成参数", () => {
    it("保留零top-p、显式惩罚和原始reasoning等级，忽略明确关闭的参数", () => {
        expect(extractTavernGeneration(JSON.stringify({temperature: 1, top_p: 0, top_k: 0, openai_max_tokens: 50000,
            presence_penalty: 0, frequency_penalty: -0.2, reasoning_effort: "max", seed: -1,
            min_p: 0, top_a: 0, repetition_penalty: 1, n: 1, verbosity: "auto"}))).toEqual({
            temperature: 1, topP: 0, topK: undefined, maxTokens: 50000, presencePenalty: 0, frequencyPenalty: -0.2,
            reasoningEffort: "max", seed: undefined, stop: undefined,
        });
        expect(extractTavernGeneration(JSON.stringify({top_k: 20, seed: 0, stop: ["END"]}))).toMatchObject({topK: 20, seed: 0, stop: ["END"]});
    });
    it("有效但未支持的采样机制必须明确失败", () => {
        for (const value of [{min_p: 0.1}, {top_a: 0.5}, {repetition_penalty: 1.2}, {n: 2}, {verbosity: "high"}, {enable_web_search: true}]) {
            expect(() => extractTavernGeneration(JSON.stringify(value))).toThrow("尚未支持");
        }
    });
    it("拒绝非法数值，不通过隐式强制转换改变预设", () => {
        for (const value of [{top_p: "0"}, {top_p: -0.1}, {openai_max_tokens: 0}, {temperature: 3}, {seed: -2}, {stop: [""]}]) {
            expect(() => extractTavernGeneration(JSON.stringify(value))).toThrow();
        }
    });
});
