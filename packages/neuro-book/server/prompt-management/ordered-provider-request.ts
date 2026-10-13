import type {Api, Context, Model, SimpleStreamOptions} from "@earendil-works/pi-ai";
import {z} from "zod";
import type {PromptMessage} from "nbook/shared/dto/prompt-management.dto";

const PayloadSchema = z.object({messages: z.array(z.unknown()).optional(), input: z.array(z.unknown()).optional()}).passthrough();

/** Pi's Context cannot represent system messages in history; its public payload hook preserves the native sequence. */
export function prepareOrderedProviderRequest(model: Model<Api>, context: Context, options: SimpleStreamOptions,
    entries: readonly PromptMessage[] | undefined, prefixCount: number,
): {context: Context; options: SimpleStreamOptions} {
    if (!entries) return {context, options};
    if (model.api === "openai-responses" && entries.some(entry => entry.name !== undefined)) {
        throw new Error("Responses 接口无法保持酒馆示例的 message name，请使用 Chat Completions 接口");
    }
    if (model.api !== "openai-completions" && model.api !== "openai-responses") {
        const systemIndices = entries.flatMap((entry, index) => entry.role === "system" ? [index] : []);
        if (systemIndices.length > 1 || (systemIndices.length === 1 && systemIndices[0] !== 0)) {
            throw new Error("当前模型接口无法保持多条或交错 system 提示词的结构，请使用 OpenAI Chat Completions / Responses 兼容接口，或仅保留一条位于最前面的 system 提示词");
        }
        return {context, options};
    }
    if (!Number.isInteger(prefixCount) || prefixCount < 0 || prefixCount > context.messages.length) throw new Error("提示词消息前缀计数无效");
    const previous = options.onPayload;
    const frozenEntries = entries.map(entry => ({...entry}));
    return {
        context: {...context, systemPrompt: undefined, messages: context.messages.slice(prefixCount)},
        options: {...options, onPayload: async (payload, requestModel) => {
            const supplied = previous ? await previous(payload, requestModel) : undefined;
            const native = PayloadSchema.parse(supplied ?? payload);
            if (model.api === "openai-completions") {
                if (!native.messages) throw new Error("模型请求缺少 messages，无法保持提示词顺序");
                return {...native, messages: [...frozenEntries, ...native.messages]};
            }
            if (!native.input) throw new Error("模型请求缺少 input，无法保持提示词顺序");
            return {...native, input: [...frozenEntries.map(entry => ({type: "message", role: entry.role, content: entry.content})), ...native.input]};
        }},
    };
}
