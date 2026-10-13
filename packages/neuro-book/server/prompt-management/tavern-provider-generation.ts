import type {Api, Model, StreamOptions} from "@earendil-works/pi-ai";
import {TavernGenerationSchema, type TavernGenerationParameters} from "nbook/shared/dto/tavern-preset.dto";

/** ST's CUSTOM Chat Completions effort mapping depends on the model, before backend request conversion. */
export function resolveTavernCustomReasoningEffort(effort: string | undefined, modelId: string): string | undefined {
    if (effort === undefined || effort === "auto") return undefined;
    if (!["none", "min", "minimal", "low", "medium", "high", "max", "xhigh"].includes(effort)) throw new Error(`不支持的酒馆推理等级：${effort}`);
    if (effort === "min") return modelId.startsWith("koboldcpp/") ? "minimal" : "low";
    if (effort === "max") return modelId.startsWith("koboldcpp/") ? "xhigh" : "high";
    return effort;
}

/** SDK payload hooks carry samplers absent from StreamOptions, after every earlier request hook has run. */
export function applyTavernGeneration<T extends StreamOptions>(model: Model<Api>, options: T, input: TavernGenerationParameters): T {
    const generation = TavernGenerationSchema.parse(input);
    if (!Object.values(generation).some(value => value !== undefined)) return options;
    if (model.api !== "openai-completions") throw new Error("酒馆预设生成参数目前仅支持 OpenAI Chat Completions 接口");
    const reasoning = resolveTavernCustomReasoningEffort(generation.reasoningEffort, model.id);
    const parameters: Record<string, number | string | string[]> = {};
    const mappings = [
        ["temperature", generation.temperature], ["top_p", generation.topP], ["top_k", generation.topK],
        ["max_tokens", generation.maxTokens], ["presence_penalty", generation.presencePenalty],
        ["frequency_penalty", generation.frequencyPenalty], ["seed", generation.seed], ["stop", generation.stop],
        ["reasoning_effort", reasoning],
    ] as const;
    for (const [key, value] of mappings) if (value !== undefined) parameters[key] = value;
    const before = options.onPayload;
    return {...options, temperature: generation.temperature ?? options.temperature, maxTokens: generation.maxTokens ?? options.maxTokens,
        onPayload: async (payload, resolvedModel) => {
            const previous = await before?.(payload, resolvedModel);
            const current = previous === undefined ? payload : previous;
            if (!current || typeof current !== "object" || Array.isArray(current)) throw new Error("酒馆生成参数需要对象形式的模型请求");
            const result = {...current, ...parameters};
            // ST CUSTOM emits max_tokens; sending both alternatives is rejected by several compatibility gateways.
            if (generation.maxTokens !== undefined) Reflect.deleteProperty(result, "max_completion_tokens");
            return result;
        }};
}
