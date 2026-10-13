import type {Api, Model, StreamOptions} from "@earendil-works/pi-ai";
import {describe, expect, it} from "vitest";
import {applyTavernGeneration, resolveTavernCustomReasoningEffort} from "./tavern-provider-generation";

const model: Model<"openai-completions"> = {id: "claude-opus-4-6", name: "Opus", api: "openai-completions", provider: "fixture",
    baseUrl: "https://example.invalid/v1", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 64000,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};

describe("酒馆生成参数的Provider边界", () => {
    it("固定CUSTOM努力映射不会将max猜测成none，koboldcpp单独映射", () => {
        expect(resolveTavernCustomReasoningEffort("max", model.id)).toBe("high");
        expect(resolveTavernCustomReasoningEffort("min", model.id)).toBe("low");
        expect(resolveTavernCustomReasoningEffort("none", model.id)).toBe("none");
        expect(resolveTavernCustomReasoningEffort("max", "koboldcpp/example")).toBe("xhigh");
        expect(resolveTavernCustomReasoningEffort("auto", model.id)).toBeUndefined();
    });
    it("在先前hook之后写入完整参数，零值不丢失且不同时发送两种token上限字段", async () => {
        const orderedMessages = [{role: "user", content: "task"}];
        const previous: StreamOptions = {temperature: 0.2, onPayload: () => ({model: model.id, messages: orderedMessages, max_completion_tokens: 1000, stream: true})};
        const options = applyTavernGeneration(model, previous, {temperature: 1, maxTokens: 50000, topP: 0, presencePenalty: 0, frequencyPenalty: 0,
            reasoningEffort: "none", seed: 0, stop: ["END"]});
        expect(options.temperature).toBe(1);
        expect(options.maxTokens).toBe(50000);
        expect(await options.onPayload?.({}, model)).toEqual({model: model.id, messages: orderedMessages, stream: true, temperature: 1, max_tokens: 50000,
            top_p: 0, presence_penalty: 0, frequency_penalty: 0, reasoning_effort: "none", seed: 0, stop: ["END"]});
        expect(previous.temperature).toBe(0.2);
    });
    it("前置hook只原地修改时沿用payload；接口无法保持参数时明确拒绝", async () => {
        const options = applyTavernGeneration(model, {onPayload: (payload: unknown) => {
            if (!payload || typeof payload !== "object") throw new Error("fixture expects an object payload");
            Reflect.set(payload, "stream", true);
        }}, {topP: 0});
        expect(await options.onPayload?.({model: model.id}, model)).toEqual({model: model.id, stream: true, top_p: 0});
        const responses: Model<Api> = {...model, api: "openai-responses"};
        expect(() => applyTavernGeneration(responses, {}, {topP: 0})).toThrow("仅支持");
        expect(() => resolveTavernCustomReasoningEffort("unrecognized", model.id)).toThrow("不支持");
    });
});

describe.skipIf(!process.env.NBOOK_TAVERN_UPSTREAM_DIR)("固定上游CUSTOM推理等级对照", () => {
    it("全部原生effort选项对普通模型与koboldcpp保持同一映射", async () => {
        const {createOracle} = await import("nbook/scripts/smoke/tavern-upstream-oracle.mjs");
        const oracle = createOracle({prompts: [], prompt_order: [{character_id: 100001, order: []}]});
        for (const id of [model.id, "koboldcpp/example"]) for (const effort of ["auto", "min", "low", "medium", "high", "max"]) {
            expect(resolveTavernCustomReasoningEffort(effort, id)).toBe(oracle.customReasoningEffort(effort, id));
        }
    });
});
