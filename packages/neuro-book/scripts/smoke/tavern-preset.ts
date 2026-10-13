import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {isDeepStrictEqual} from "node:util";
import {parseArgs} from "node:util";
import {TavernBindingsSchema} from "nbook/shared/dto/tavern-preset.dto";
import {compileTavernPreset, inspectTavernPreset, parseTavernPreset, applyTavernRegex} from "nbook/server/prompt-management/tavern-preset";
import {inspectTavernRequestReference} from "./tavern-request-reference";
import {prepareTavernBudget} from "nbook/server/prompt-management/tavern-budget";

/** Read-only compatibility CLI. Upstream is an explicit source cache; preset scripts never become executable modules. */
export async function runTavernPresetSmoke(args: string[]) {
    const {values} = parseArgs({args, options: {preset: {type: "string"}, bindings: {type: "string"}, upstream: {type: "string"}, reference: {type: "string"}}, strict: true});
    if (!values.preset) throw new Error("用法：smoke:tavern-preset --preset <原生JSON> [--bindings <绑定JSON>] [--upstream <固定源码目录>]");
    const raw = await readFile(resolve(values.preset), "utf8");
    const report = inspectTavernPreset(raw);
    if (!values.bindings) {
        if (values.reference || values.upstream) throw new Error("执行对照必须提供 --bindings");
        return {schema: "nbook.tavern-compatibility/v1", report, compilation: "not-run", upstreamComparison: "not-run"};
    }
    const bindings = TavernBindingsSchema.parse(JSON.parse(await readFile(resolve(values.bindings), "utf8")));
    const budget = await prepareTavernBudget({sourceJson: raw, bindings, macroEngine: "legacy", extensionPolicy: "prompt-only"});
    const compiled = compileTavernPreset(raw, bindings, {budget});
    let comparison: {messages: boolean; localVariables: boolean; globalVariables: boolean; regexStages: boolean} | undefined;
    if (values.upstream) {
        process.env.NBOOK_TAVERN_UPSTREAM_DIR = resolve(values.upstream);
        const {createOracle} = await import("./tavern-upstream-oracle.mjs");
        const source = parseTavernPreset(raw);
        const slot = (id: string) => bindings.slots[id]?.[0]?.content ?? "";
        const oracle = createOracle(JSON.parse(raw), {user: bindings.user, char: bindings.char, persona: slot("personaDescription"),
            charDescription: slot("charDescription"), charPersonality: slot("charPersonality"), scenario: slot("scenario"),
            worldInfoBefore: slot("worldInfoBefore"), worldInfoAfter: slot("worldInfoAfter"),
            localVariables: bindings.localVariables, globalVariables: bindings.globalVariables,
            generationType: bindings.generationType,
            budget,
            history: (bindings.slots.chatHistory ?? []).map((message, index, history) => ({...message,
                content: applyTavernRegex(source, message.content, message.role === "assistant" ? 2 : 1, "prompt", history.length - index - 1, bindings)})),
            examples: bindings.slots.dialogueExamples?.length ? [bindings.slots.dialogueExamples] : [],
        });
        const expected = await oracle.compile();
        const probe = "<content>正文</content><build>构建</build><锐评>评语</锐评><sonnet>诗句</sonnet><选项区>A：选择</选项区><time>time: 日一\nscene: 地一</time><math>记录</math>";
        const regexStages = ["prompt", "display", "stored"].every(stage => [0, 1, 2].every(depth => {
            const actual = applyTavernRegex(source, probe, 2, stage as "prompt" | "display" | "stored", depth, bindings);
            const reference = oracle.regex(probe, source.extensions?.regex_scripts, 2, {isPrompt: stage === "prompt", isMarkdown: stage === "display", depth});
            return actual === reference;
        }));
        const expectedMessages = oracle.postProcess(expected.messages, bindings.requestPostProcessing ?? source.custom_prompt_post_processing ?? "none");
        comparison = {messages: isDeepStrictEqual(compiled.messages, expectedMessages), localVariables: isDeepStrictEqual(compiled.variablesAfter.local, expected.localVariables),
            globalVariables: isDeepStrictEqual(compiled.variablesAfter.global, expected.globalVariables), regexStages};
        if (Object.values(comparison).some(equal => !equal)) process.exitCode = 1;
    }
    const source = parseTavernPreset(raw);
    const reference = values.reference ? inspectTavernRequestReference(await readFile(resolve(values.reference), "utf8"), source, compiled.promptMessages,
        compiled.messageIdentifiers.map(identifier => ({identifier, marker: identifier === "continueNudge" || (source.prompts.find(prompt => prompt.identifier === identifier)?.marker ?? false)})), compiled.messages) : undefined;
    return {schema: "nbook.tavern-compatibility/v1", report, compilation: {messages: compiled.messages.length,
        localVariables: Object.keys(compiled.variablesAfter.local).length, globalVariables: Object.keys(compiled.variablesAfter.global).length},
        upstreamComparison: comparison ?? "not-run", ...(reference ? {reference} : {}),
        ...(compiled.budgetReport ? {budget: compiled.budgetReport} : {}),
        unverified: [...(budget ? [] : ["real-token-budget"]), "provider-sampling-settings", "extension-runtime", "real-model-output"]};
}

if (import.meta.main) {
    try {console.log(JSON.stringify(await runTavernPresetSmoke(process.argv.slice(2)), null, 2));}
    catch (error) {console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;}
}
