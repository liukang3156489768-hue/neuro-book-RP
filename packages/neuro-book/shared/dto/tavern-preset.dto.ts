import {z} from "zod";

/** Zod record drops __proto__; ST dictionaries must preserve own keys without invoking prototype setters. */
export function tavernDictionary<S extends z.ZodType>(schema: S) {
    return z.unknown().transform((value, context): Record<string, z.output<S>> => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            context.addIssue({code: "custom", message: "酒馆字典必须是对象"});
            return z.NEVER;
        }
        const result: Record<string, z.output<S>> = {};
        for (const [key, item] of Object.entries(value)) {
            const parsed = schema.safeParse(item);
            if (!parsed.success) {context.addIssue({code: "custom", path: [key], message: parsed.error.message}); continue;}
            Object.defineProperty(result, key, {value: parsed.data, configurable: true, enumerable: true, writable: true});
        }
        return result;
    });
}
export const TavernVariablesSchema = tavernDictionary(z.string());

export const TavernMessageSchema = z.object({
    role: z.enum(["system", "user", "assistant"]), content: z.string(), name: z.string().optional(),
}).strict();
export type TavernMessage = z.infer<typeof TavernMessageSchema>;

export const TavernMacroEngineSchema = z.enum(["legacy", "native"]);
export const TavernPostProcessingSchema = z.enum(["", "none", "claude", "merge", "merge_tools", "semi", "semi_tools", "strict", "strict_tools", "single"]);
export const TavernNativeContextSchema = z.object({
    input: z.string().optional(), model: z.string().optional(), original: z.string().optional(),
    chatId: z.string().optional(), pickRerollSeed: z.number().int().optional(),
    // A compilation captures one clock and RNG seed; frozen messages do not re-run macros on retries.
    now: z.string().datetime({offset: true}).optional(), randomSeed: z.string().optional(),
    locale: z.string().optional(), utcOffsetMinutes: z.number().int().min(-840).max(840).optional(),
    maxContext: z.number().int().nonnegative().optional(), maxResponse: z.number().int().nonnegative().optional(),
    lastGenerationType: z.string().optional(), firstIncludedMessageId: z.number().int().nonnegative().optional(),
    firstDisplayedMessageId: z.number().int().nonnegative().optional(),
    names: z.object({group: z.string().optional(), groupNotMuted: z.string().optional(), notChar: z.string().optional()}).strict().optional(),
    character: z.object({
        charPrompt: z.string().optional(), charInstruction: z.string().optional(), description: z.string().optional(),
        personality: z.string().optional(), scenario: z.string().optional(), persona: z.string().optional(), mesExamplesRaw: z.string().optional(),
        charDepthPrompt: z.string().optional(), creatorNotes: z.string().optional(), version: z.string().optional(),
        firstMessage: z.string().optional(), alternateGreetings: z.array(z.string()).optional(),
    }).strict().optional(),
}).strict();
export type TavernNativeContext = z.infer<typeof TavernNativeContextSchema>;
export const TavernContextBudgetSchema = z.object({
    tokenizer: z.enum(["claude", "cl100k_base", "o200k_base"]), contextTokens: z.number().int().positive(), pinExamples: z.boolean().optional(),
}).strict();
export const TavernBudgetReportSchema = z.object({
    tokenizer: z.enum(["claude", "cl100k_base", "o200k_base"]), contextTokens: z.number().int().positive(), responseTokens: z.number().int().nonnegative(),
    usedTokens: z.number().int(), droppedHistory: z.number().int().nonnegative(), droppedExamples: z.number().int().nonnegative(),
}).strict();
export type TavernBudgetReport = z.infer<typeof TavernBudgetReportSchema>;

export const TavernBindingsSchema = z.object({
    user: z.string().min(1), char: z.string().min(1),
    // Marker inputs are explicit; the assistant supplying a task does not determine its API role or macro identity.
    slots: tavernDictionary(z.array(TavernMessageSchema)),
    localVariables: TavernVariablesSchema.optional(),
    globalVariables: TavernVariablesSchema.optional(),
    requestPostProcessing: TavernPostProcessingSchema.optional(),
    nativeContext: TavernNativeContextSchema.optional(),
    contextBudget: TavernContextBudgetSchema.optional(),
    generationType: z.enum(["normal", "continue"]).optional(),
    variablePersistence: z.enum(["isolated", "writing-session"]).optional(),
}).strict();
export type TavernBindings = z.infer<typeof TavernBindingsSchema>;

export const TavernOutputPolicySchema = z.object({
    mode: z.enum(["full", "tag"]), tag: z.string().regex(/^[A-Za-z][\w-]*$/u).optional(), qualityCheck: z.boolean().optional(),
}).strict().refine(value => value.mode !== "tag" || Boolean(value.tag), "正文标签模式必须指定标签名");
export type TavernOutputPolicy = z.infer<typeof TavernOutputPolicySchema>;

export const TavernGenerationSchema = z.object({
    temperature: z.number().finite().min(0).max(2).optional(), topP: z.number().finite().min(0).max(1).optional(),
    topK: z.number().int().nonnegative().optional(), maxTokens: z.number().int().positive().optional(),
    presencePenalty: z.number().finite().min(-2).max(2).optional(), frequencyPenalty: z.number().finite().min(-2).max(2).optional(),
    reasoningEffort: z.enum(["auto", "none", "min", "minimal", "low", "medium", "high", "max", "xhigh"]).optional(),
    seed: z.number().int().nonnegative().optional(), stop: z.array(z.string().min(1)).optional(),
}).strict();
export type TavernGenerationParameters = z.infer<typeof TavernGenerationSchema>;

export const TavernWriterMappingTargetSchema = z.object({
    kind: z.enum(["slot", "local", "global", "prompt"]), name: z.string().min(1),
    previousMapping: z.object({kind: z.enum(["slot", "local", "global"]), name: z.string().min(1)}).strict().nullable().optional(),
}).strict();
export type TavernWriterMappingTarget = z.infer<typeof TavernWriterMappingTargetSchema>;
export const TavernWriterMappingsSchema = tavernDictionary(TavernWriterMappingTargetSchema.nullable());
export type TavernWriterMappings = z.infer<typeof TavernWriterMappingsSchema>;
export const TavernWriterDirectDraftSchema = TavernMessageSchema.extend({
    identifier: z.string().min(1), marker: z.literal(false).optional(),
    injection_position: z.number().int().optional(), injection_depth: z.number().int().nonnegative().optional(), injection_order: z.number().int().optional(),
    injection_trigger: z.union([z.array(z.string()), z.string()]).optional(),
}).passthrough();

export const TavernWriterPresetSchema = z.object({
    sourceJson: z.string().min(1).max(2_000_000),
    bindings: TavernBindingsSchema,
    macroEngine: TavernMacroEngineSchema,
    // Arbitrary extension scripts remain source data. Import never executes them.
    extensionPolicy: z.literal("prompt-only"),
    outputPolicy: TavernOutputPolicySchema.optional(),
    generationOverride: TavernGenerationSchema.optional(),
    // Absence preserves the original bindings and snapshot hash; enabling mapping is explicit.
    writerMappings: TavernWriterMappingsSchema.optional(),
    // Suspended direct templates retain edits across mode switches; they never enter compilation.
    writerDirectDrafts: tavernDictionary(TavernWriterDirectDraftSchema).optional(),
}).strict();
export type TavernWriterPreset = z.infer<typeof TavernWriterPresetSchema>;

export const FrozenWriterPromptSchema = z.object({
    snapshotId: z.string(), systemPrompt: z.string(), orderedMessages: z.array(TavernMessageSchema),
    tavernState: z.object({local: TavernVariablesSchema, global: TavernVariablesSchema}).optional(),
    tavern: TavernWriterPresetSchema.optional(),
    generation: TavernGenerationSchema.optional(),
    budgetReport: TavernBudgetReportSchema.optional(),
    variableScope: z.object({projectRoot: z.string(), ownerKey: z.string(), purposeId: z.string(), presetId: z.string(), attemptKey: z.string()}).strict().optional(),
}).strict();

export const TavernPreviewRequestSchema = z.object({
    purposeId: z.enum(["writing.writer.scene", "writing.writer.rewrite"]), tavern: TavernWriterPresetSchema,
    variables: z.record(z.string(), z.string()).optional(),
}).strict();
export type TavernPreviewRequest = z.infer<typeof TavernPreviewRequestSchema>;
export type TavernPreviewResult = {
    report: {sourceSha256: string; upstreamRevision: string; prompts: number; active: number; regexes: number;
        unsupported: string[]; extensionDependencies: string[]; promptSupported: boolean; fullEnvironmentEquivalent: false};
    messages: TavernMessage[]; promptMessages: TavernMessage[]; messageIdentifiers: string[];
    variablesBefore: {local: Record<string, string>; global: Record<string, string>};
    variablesAfter: {local: Record<string, string>; global: Record<string, string>};
    generation: TavernGenerationParameters;
    budgetReport?: z.infer<typeof TavernBudgetReportSchema>;
};
