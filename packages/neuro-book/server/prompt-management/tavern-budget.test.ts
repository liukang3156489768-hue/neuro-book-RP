import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {join} from "node:path";
import {runInNewContext} from "node:vm";
import {Tokenizer} from "@agnai/web-tokenizers";
import {describe, expect, it} from "vitest";
import {createTavernBudget, prepareTavernBudget} from "./tavern-budget";
import type {TavernWriterPreset} from "nbook/shared/dto/tavern-preset.dto";
import claudeModel from "./tokenizers/claude.json";
import {compileTavernPreset} from "./tavern-preset";

function preset(tokenizer: "claude" | "cl100k_base" | "o200k_base", contextTokens = 1000): TavernWriterPreset {
    return {sourceJson: JSON.stringify({openai_max_tokens: 100}), bindings: {user: "作者", char: "写手", slots: {}, contextBudget: {tokenizer, contextTokens}},
        macroEngine: "legacy", extensionPolicy: "prompt-only"};
}

describe("酒馆原生预算", () => {
    it("保留必需提示并为输出和assistant priming预留额度，选填项按整体判断", () => {
        const budget = createTavernBudget({tokenizer: "claude", contextTokens: 30, responseTokens: 10, pinExamples: false, count: message => message.content.length});
        budget.reserve([{role: "system", content: "mandatory"}]);
        expect(budget.take([{role: "user", content: "recent"}])).toBe(true);
        expect(budget.take([{role: "user", content: "older"}])).toBe(false);
        expect(budget.report(1, 2)).toMatchObject({usedTokens: 18, responseTokens: 10, droppedHistory: 1, droppedExamples: 2});
        expect(() => budget.reserve([{role: "system", content: "never silently truncate"}])).toThrow("必需提示词");
    });
    it("未配置预算不加载分词器，输出覆盖优先原生额度，非法预算明确失败", async () => {
        expect(await prepareTavernBudget({...preset("claude"), bindings: {user: "作者", char: "写手", slots: {}}})).toBeUndefined();
        const prepared = await prepareTavernBudget({...preset("cl100k_base"), generationOverride: {maxTokens: 200}});
        expect(prepared?.responseTokens).toBe(200);
        await expect(prepareTavernBudget(preset("claude", 100))).rejects.toThrow("输出额度");
    });
    it("两个OpenAI词表实际计数，空消息不消耗预算", async () => {
        for (const tokenizer of ["cl100k_base", "o200k_base"] as const) {
            const prepared = (await prepareTavernBudget(preset(tokenizer)))!;
            expect(prepared.count({role: "user", content: "Hello world"})).toBe(7);
            const budget = createTavernBudget(prepared);
            budget.reserve([{role: "system", content: ""}]);
            expect(budget.report().usedTokens).toBe(3);
        }
    });
    it("Claude词表来源固定，并实际执行Unicode分词", async () => {
        const raw = await readFile(new URL("./tokenizers/claude.json", import.meta.url));
        expect(createHash("sha256").update(raw).digest("hex")).toBe("c241737df24b4e7f7c9af4fdcee29a0ca903dcb288a8b753bc346a3092911767");
        const prepared = (await prepareTavernBudget(preset("claude")))!;
        expect(prepared.count({role: "user", content: "中文写作，雨夜车站。"})).toBeGreaterThan(5);
    });
    it.skipIf(!process.env.NBOOK_TAVERN_UPSTREAM_DIR)("CUSTOM Claude计数与固定SHA上游原函数及前端减二规则一致", async () => {
        const source = await readFile(join(process.env.NBOOK_TAVERN_UPSTREAM_DIR!, "src__endpoints__tokenizers.js"), "utf8");
        expect(createHash("sha256").update(source).digest("hex")).toBe("6bc356ddf299ec86cc11082d185ca3c3150a4713b7e7c26494b60e0d85a2a3e2");
        const original = source.match(/export function countWebTokenizerTokens\(tokenizer, messages\) \{[\s\S]*?\n\}/u)?.[0];
        if (!original) throw new Error("缺少固定上游计数函数");
        const count = runInNewContext(`(${original.replace("export function", "function")})`) as
            (tokenizer: Tokenizer, messages: {role: string; content: string; name?: string}[]) => number;
        const tokenizer = await Tokenizer.fromJSON(new TextEncoder().encode(JSON.stringify(claudeModel)).buffer);
        const prepared = (await prepareTavernBudget(preset("claude")))!;
        for (const message of [{role: "user" as const, content: "中文写作，雨夜车站。"}, {role: "system" as const, content: "Hello world", name: "example_user"}]) {
            expect(prepared.count(message)).toBe(count(tokenizer, [message]) - 2);
        }
    });
    it.skipIf(!process.env.NBOOK_TAVERN_UPSTREAM_DIR)("真实分词预算下的历史、深度注入和示例选择等于固定上游", async () => {
        const {createOracle} = await import("nbook/scripts/smoke/tavern-upstream-oracle.mjs");
        const prompts = [{identifier: "main", role: "system", content: "Write a scene."},
            {identifier: "charDescription", marker: true}, {identifier: "dialogueExamples", marker: true}, {identifier: "chatHistory", marker: true},
            {identifier: "depth", role: "system", content: "nearby instruction", injection_position: 1, injection_depth: 1}];
        const sourceJson = JSON.stringify({prompts, prompt_order: [{character_id: 100001, order: prompts.map(prompt => ({identifier: prompt.identifier, enabled: true}))}],
            new_chat_prompt: "[Start]", new_example_chat_prompt: "[Example]", openai_max_tokens: 10});
        const history = [{role: "assistant" as const, content: "old words ".repeat(60)},
            {role: "user" as const, content: "middle task"}, {role: "assistant" as const, content: "latest prose"}];
        const examples = [{role: "system" as const, name: "example_user", content: "sample task"}, {role: "system" as const, name: "example_assistant", content: "sample prose"}];
        for (const tokenizer of ["claude", "cl100k_base", "o200k_base"] as const) {
            for (const contextTokens of [50, 80, 120, 1000]) for (const pinExamples of [false, true]) {
                const tavern = {...preset(tokenizer, contextTokens), sourceJson, bindings: {user: "Author", char: "Writer",
                    contextBudget: {tokenizer, contextTokens, pinExamples}, slots: {charDescription: [{role: "system" as const, content: "character"}], chatHistory: history, dialogueExamples: examples}}};
                const budget = (await prepareTavernBudget(tavern))!;
                const oracle = createOracle(JSON.parse(sourceJson), {user: "Author", char: "Writer", charDescription: "character", history, examples: [examples], budget});
                const expected = await oracle.compile();
                const compiled = compileTavernPreset(sourceJson, tavern.bindings, {budget});
                expect(compiled.messages, `${tokenizer}/${contextTokens}/pin=${pinExamples}`).toEqual(expected.messages);
                expect(compiled.variablesAfter).toEqual({local: expected.localVariables, global: expected.globalVariables});
                expect(compiled.budgetReport!.usedTokens + budget.responseTokens).toBeLessThanOrEqual(contextTokens);
            }
        }
    });
});
