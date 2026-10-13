import type {TavernMessage} from "nbook/shared/dto/tavern-preset.dto";
import type {TavernCompilationBudget} from "nbook/server/prompt-management/tavern-budget";

export const upstreamCommit: string;
export const sourceHashes: Record<string, string>;
export function createOracle(preset: unknown, bindings?: {
    user?: string; char?: string; persona?: string; scenario?: string; charDescription?: string; charPersonality?: string;
    worldInfoBefore?: string; worldInfoAfter?: string; history?: TavernMessage[]; examples?: TavernMessage[][];
    localVariables?: Record<string, string>; globalVariables?: Record<string, string>;
    generationType?: "normal" | "continue";
    budget?: TavernCompilationBudget;
}): {
    compile(): Promise<{messages: TavernMessage[]; localVariables: Record<string, string>; globalVariables: Record<string, string>}>;
    regex(raw: string, scripts: unknown, placement: number, parameters?: {isPrompt?: boolean; isMarkdown?: boolean; depth?: number}): string;
    macro(text: string): string;
    customReasoningEffort(effort: string, model: string): string | undefined;
    strict(messages: TavernMessage[]): TavernMessage[];
    postProcess(messages: TavernMessage[], type: string): TavernMessage[];
    squash(entries: {identifier: string; message: TavernMessage}[]): Promise<{identifier: string; message: TavernMessage}[]>;
};
