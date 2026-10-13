import type {ModelLibraryEntryDto} from "nbook/shared/dto/app-settings.dto";

/**
 * SDK 目录之外的模型资料快照（2026-10-10，models.dev/api.json）。
 * 只补 SDK 缺失的精确 ID；来源、能力取舍与验证边界见
 * docs/research/provider-model-library-2026-10.md（主应用包内）。
 * off:null 保守地省略关闭思考参数，其余档位使用 SDK 协议适配器，不推断新档位。
 */
export const MODEL_LIBRARY_SUPPLEMENT: readonly ModelLibraryEntryDto[] = [
    {
        id: "claude-opus-5",
        name: "Claude Opus 5",
        source: "anthropic",
        reasoning: true,
        thinkingLevelMap: {off: null},
        input: ["text", "image"],
        contextWindowTokens: 1_000_000,
        maxTokens: 128_000,
    },
    {
        id: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        source: "anthropic",
        reasoning: true,
        thinkingLevelMap: {off: null},
        input: ["text", "image"],
        contextWindowTokens: 1_000_000,
        maxTokens: 128_000,
    },
    {
        id: "gpt-6.1-sol",
        name: "GPT-6.1 Sol",
        source: "openai",
        reasoning: true,
        thinkingLevelMap: {off: null},
        input: ["text", "image"],
        contextWindowTokens: 1_050_000,
        maxTokens: 128_000,
    },
    {
        id: "gpt-6-astra",
        name: "GPT-6 Astra",
        source: "openai",
        reasoning: true,
        thinkingLevelMap: {off: null},
        input: ["text", "image"],
        contextWindowTokens: 1_050_000,
        maxTokens: 128_000,
    },
    {
        id: "gemini-3.7-flash",
        name: "Gemini 3.7 Flash",
        source: "google",
        reasoning: true,
        thinkingLevelMap: {off: null},
        input: ["text", "image"],
        contextWindowTokens: 1_048_576,
        maxTokens: 65_536,
    },
    {
        id: "gemini-3.8-flash",
        name: "Gemini 3.8 Flash",
        source: "google",
        reasoning: true,
        thinkingLevelMap: {off: null},
        input: ["text", "image"],
        contextWindowTokens: 1_048_576,
        maxTokens: 65_536,
    },
];
