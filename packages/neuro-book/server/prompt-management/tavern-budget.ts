import {Tokenizer} from "@agnai/web-tokenizers";
import {getEncoding} from "js-tiktoken";
import type {TavernMessage, TavernWriterPreset, TavernBudgetReport} from "nbook/shared/dto/tavern-preset.dto";
import claudeModel from "./tokenizers/claude.json";

export type TavernCompilationBudget = {
    tokenizer: "claude" | "cl100k_base" | "o200k_base";
    contextTokens: number;
    responseTokens: number;
    pinExamples: boolean;
    count(message: TavernMessage): number;
};

const counters = new Map<TavernCompilationBudget["tokenizer"], Promise<TavernCompilationBudget["count"]>>();

/** Counts the fixed upstream CUSTOM interface, including its per-message full=false adjustment. */
async function tokenizerCounter(kind: TavernCompilationBudget["tokenizer"]): Promise<TavernCompilationBudget["count"]> {
    const existing = counters.get(kind);
    if (existing) return existing;
    const pending = (async () => {
        if (kind === "claude") {
            const tokenizer = await Tokenizer.fromJSON(new TextEncoder().encode(JSON.stringify(claudeModel)).buffer);
            return (message: TavernMessage) => {
                const fields = [message.role, message.content, ...(message.name !== undefined ? [message.name] : [])];
                return tokenizer.encode(fields.join("\n\n")).length - 2;
            };
        }
        const tokenizer = getEncoding(kind);
        return (message: TavernMessage) => 4 + tokenizer.encode(message.role).length + tokenizer.encode(message.content).length
            + (message.name !== undefined ? tokenizer.encode(message.name).length + 1 : 0);
    })();
    counters.set(kind, pending);
    try {return await pending;} catch (error) {counters.delete(kind); throw error;}
}

/** Explicit budgets keep preview and generation identical; the harness separately enforces the selected model window. */
export async function prepareTavernBudget(tavern: TavernWriterPreset): Promise<TavernCompilationBudget | undefined> {
    const settings = tavern.bindings.contextBudget;
    if (!settings) return undefined;
    const source: unknown = JSON.parse(tavern.sourceJson);
    const sourceResponse = source && typeof source === "object" && "openai_max_tokens" in source ? source.openai_max_tokens : undefined;
    const responseTokens = tavern.generationOverride?.maxTokens ?? (typeof sourceResponse === "number" ? sourceResponse : undefined);
    if (responseTokens === undefined) throw new Error("启用酒馆预算必须在预设或生成覆盖中指定输出额度");
    if (!Number.isInteger(responseTokens) || responseTokens <= 0 || responseTokens >= settings.contextTokens) {
        throw new Error("酒馆输出额度必须小于上下文预算，请调整生成参数覆盖或预算");
    }
    return {...settings, responseTokens, pinExamples: settings.pinExamples ?? false, count: await tokenizerCounter(settings.tokenizer)};
}

/** ST reserves mandatory prompts, then fills optional history/examples until the first unaffordable item. */
export function createTavernBudget(input: TavernCompilationBudget) {
    let usedTokens = 3;
    const cost = (messages: readonly TavernMessage[]) => messages.reduce((total, message) => total + (message.content ? input.count(message) : 0), 0);
    const available = input.contextTokens - input.responseTokens;
    return {
        pinExamples: input.pinExamples,
        reserve(messages: readonly TavernMessage[]): void {
            const tokens = cost(messages);
            if (usedTokens + tokens > available) throw new Error("酒馆必需提示词超过上下文预算；请提高预算或停用条目");
            usedTokens += tokens;
        },
        take(messages: readonly TavernMessage[]): boolean {
            const tokens = cost(messages);
            if (usedTokens + tokens > available) return false;
            usedTokens += tokens;
            return true;
        },
        report(droppedHistory = 0, droppedExamples = 0): TavernBudgetReport {
            return {tokenizer: input.tokenizer, contextTokens: input.contextTokens, responseTokens: input.responseTokens,
                usedTokens, droppedHistory, droppedExamples};
        },
    };
}
