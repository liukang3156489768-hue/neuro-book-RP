import {z} from "zod";
import {TavernGenerationSchema, type TavernGenerationParameters} from "nbook/shared/dto/tavern-preset.dto";

const GenerationSourceSchema = z.object({
    temperature: z.number().finite().min(0).max(2).optional(),
    top_p: z.number().finite().min(0).max(1).optional(),
    top_k: z.number().int().min(0).optional(),
    openai_max_tokens: z.number().int().positive().optional(),
    frequency_penalty: z.number().finite().min(-2).max(2).optional(),
    presence_penalty: z.number().finite().min(-2).max(2).optional(),
    reasoning_effort: z.enum(["auto", "none", "min", "minimal", "low", "medium", "high", "max", "xhigh"]).optional(),
    seed: z.number().int().min(-1).optional(),
    stop: z.array(z.string().min(1)).optional(),
    top_a: z.number().finite().optional(), min_p: z.number().finite().optional(), repetition_penalty: z.number().finite().optional(),
    n: z.number().int().positive().optional(),
    verbosity: z.enum(["auto", "low", "medium", "high"]).optional(),
    enable_web_search: z.boolean().optional(), request_images: z.boolean().optional(),
}).passthrough();

/** Preserve preset values before provider-specific adaptation. SDK options alone cannot carry all ST samplers. */
export function extractTavernGeneration(sourceJson: string): TavernGenerationParameters {
    const source = GenerationSourceSchema.parse(JSON.parse(sourceJson));
    const unsupported: string[] = [];
    if (source.top_a !== undefined && source.top_a !== 0) unsupported.push("top_a");
    if (source.min_p !== undefined && source.min_p !== 0) unsupported.push("min_p");
    if (source.repetition_penalty !== undefined && source.repetition_penalty !== 1) unsupported.push("repetition_penalty");
    if (source.n !== undefined && source.n !== 1) unsupported.push("n");
    if (source.verbosity && source.verbosity !== "auto") unsupported.push("verbosity");
    if (source.enable_web_search) unsupported.push("enable_web_search");
    if (source.request_images) unsupported.push("request_images");
    if (unsupported.length) throw new Error(`酒馆预设包含尚未支持的生成参数：${unsupported.join("、")}`);
    return TavernGenerationSchema.parse({
        temperature: source.temperature, topP: source.top_p,
        // ST treats zero top-k and -1 seed as disabled, rather than explicit provider parameters.
        topK: source.top_k ? source.top_k : undefined,
        maxTokens: source.openai_max_tokens, presencePenalty: source.presence_penalty, frequencyPenalty: source.frequency_penalty,
        reasoningEffort: source.reasoning_effort === "auto" ? undefined : source.reasoning_effort,
        seed: source.seed !== undefined && source.seed >= 0 ? source.seed : undefined,
        stop: source.stop?.length ? source.stop : undefined,
    });
}
