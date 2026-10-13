import {z} from "zod";
import {TavernWriterPresetSchema, type TavernWriterPreset, type TavernGenerationParameters, type TavernBudgetReport} from "./tavern-preset.dto";

export const PromptEntrySchema = z.object({
    id: z.string().min(1).max(120),
    name: z.string().trim().min(1).max(120),
    role: z.enum(["system", "user", "assistant"]),
    content: z.string().min(1).max(200_000),
    // Missing means enabled; injecting a default would invalidate hashes of historical snapshots.
    enabled: z.boolean().optional(),
}).strict();
export type PromptEntry = z.infer<typeof PromptEntrySchema>;

export const PromptPurposeDefinitionSchema = z.object({
    purposeId: z.string().regex(/^[a-z][a-z0-9.-]+$/u),
    module: z.enum(["design", "outline", "writing"]),
    label: z.string().min(1),
    description: z.string(),
    variables: z.array(z.string()),
    requiredVariables: z.array(z.string()).optional(),
    entries: z.array(PromptEntrySchema).max(128),
}).strict();
export type PromptPurposeDefinition = z.infer<typeof PromptPurposeDefinitionSchema>;

export const PromptPresetSchema = z.object({
    id: z.string().min(1),
    name: z.string().trim().min(1).max(120),
    builtin: z.boolean(),
    revision: z.number().int().positive(),
    entries: z.array(PromptEntrySchema).max(128),
    tavern: TavernWriterPresetSchema.optional(),
}).strict();
export type PromptPreset = z.infer<typeof PromptPresetSchema>;
export const PromptPurposeDtoSchema = PromptPurposeDefinitionSchema.extend({
    presets: z.array(PromptPresetSchema),
    selectedPresetId: z.string().min(1),
});
export type PromptPurposeDto = z.infer<typeof PromptPurposeDtoSchema>;
export const PromptCatalogDtoSchema = z.object({revision: z.number().int().nonnegative(), purposes: z.array(PromptPurposeDtoSchema)}).strict();
export type PromptCatalogDto = z.infer<typeof PromptCatalogDtoSchema>;

const mutationBase = {purposeId: z.string().min(1), expectedRevision: z.number().int().nonnegative()};
export const PromptMutationDtoSchema = z.discriminatedUnion("action", [
    z.object({...mutationBase, action: z.literal("import-tavern"), presetId: z.string().min(1).optional(), name: z.string().trim().min(1).max(120), tavern: TavernWriterPresetSchema}).strict(),
    z.object({...mutationBase, action: z.literal("save"), presetId: z.string().min(1).optional(), name: z.string().trim().min(1).max(120), entries: z.array(PromptEntrySchema).max(128)}).strict(),
    z.object({...mutationBase, action: z.literal("select"), presetId: z.string().min(1)}).strict(),
    z.object({...mutationBase, action: z.literal("delete"), presetId: z.string().min(1)}).strict(),
    z.object({...mutationBase, action: z.literal("toggle"), presetId: z.string().min(1), entryId: z.string().min(1), enabled: z.boolean()}).strict(),
]);
export type PromptMutationDto = z.infer<typeof PromptMutationDtoSchema>;

export const PromptSnapshotSchema = z.object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-f0-9]{64}$/u),
    purposes: z.record(z.string(), z.object({presetId: z.string(), presetRevision: z.number().int().positive(), entries: z.array(PromptEntrySchema), messageOrder: z.literal("configured").optional(), tavern: TavernWriterPresetSchema.optional(), requiredVariables: z.array(z.string()).optional()}).strict()),
}).strict();
export type PromptSnapshot = z.infer<typeof PromptSnapshotSchema>;
export type PromptMessage = {role: PromptEntry["role"]; content: string; name?: string};
export type ManagedPromptMessages = {systemPrompt: string; messages: Array<{role: "user" | "assistant"; content: string}>; orderedMessages?: PromptMessage[];
    tavernState?: {local: Record<string, string>; global: Record<string, string>}; tavern?: TavernWriterPreset; generation?: TavernGenerationParameters;
    budgetReport?: TavernBudgetReport};
