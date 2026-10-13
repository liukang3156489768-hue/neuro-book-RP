import type {ManagedPromptMessages, PromptEntry, PromptPurposeDefinition, PromptSnapshot} from "nbook/shared/dto/prompt-management.dto";
import {compileTavernPreset, parseTavernPreset, tavernPromptsForGeneration} from "./tavern-preset";
import type {TavernBindings, TavernWriterPreset} from "nbook/shared/dto/tavern-preset.dto";
import {extractTavernGeneration} from "./tavern-generation";
import type {TavernCompilationBudget} from "./tavern-budget";
import {supportedTavernMacroNames} from "./tavern-macros";
import {materializeWriterMappings, writerMappingSections} from "nbook/shared/prompt-management/tavern-writer-mapping";

/** Save, preview and writing share mapping materialization and the initialization boundary. */
export function compileWriterTavern(purposeId: string, tavern: TavernWriterPreset, variables: Readonly<Record<string, string>>,
    required: readonly string[], budget?: TavernCompilationBudget, initial?: {local: Record<string, string>; global: Record<string, string>},
) {
    const bindings = renderTavernBindings(tavern.bindings, variables);
    if (initial) {bindings.localVariables = initial.local; bindings.globalVariables = initial.global;}
    const writerInjection = tavern.writerMappings === undefined ? undefined : materializeWriterMappings(purposeId, tavern.sourceJson, bindings,
        tavern.writerMappings, text => renderPromptText(text, variables));
    const compiled = compileTavernPreset(tavern.sourceJson, bindings, {macroEngine: tavern.macroEngine, budget, writerInjection,
        generation: {...extractTavernGeneration(tavern.sourceJson), ...tavern.generationOverride}});
    if (tavern.writerMappings !== undefined) {
        const content = compiled.promptMessages.map(message => message.content).join("\n");
        const directTemplates = writerInjection && Object.keys(writerInjection.prompts).length
            ? new Map(parseTavernPreset(tavern.sourceJson).prompts.map(prompt => [prompt.identifier, prompt.content ?? ""])) : new Map<string, string>();
        for (const section of writerMappingSections(purposeId)) {
            const names = [...promptVariableNames([section])].filter(name => required.includes(name));
            if (!names.length) continue;
            const target = tavern.writerMappings[section.id];
            const template = target?.kind === "prompt" ? directTemplates.get(target.name) ?? "" : section.content;
            const provided = promptVariableNames([{...section, content: template}]);
            if (!target || names.some(name => !provided.has(name)) || !content.includes(renderPromptText(template, variables))) {
                throw new Error(`必需写作条目未进入最终提示词：${section.name}（${names.join("、")}）；请检查映射、变量读取、正则和上下文预算`);
            }
        }
    } else if (budget) validateTavernRetainedFacts(tavern.bindings, compiled.retainedHistoryIndices, required, tavern.sourceJson);
    return compiled;
}

export function renderTavernBindings(binding: TavernBindings, variables: Readonly<Record<string, string>>): TavernBindings {
    const macroNames = new Set([...supportedTavernMacroNames("legacy"), ...supportedTavernMacroNames("native")]);
    return {...binding, user: renderPromptText(binding.user, variables), char: renderPromptText(binding.char, variables),
        slots: Object.fromEntries(Object.entries(binding.slots).map(([id, messages]) => [id,
            messages.map(message => ({...message, content: message.content.replace(/\{\{\s*([a-zA-Z][\w.-]*)\s*\}\}/gu, (raw, key: string) => {
                if (Object.hasOwn(variables, key)) return variables[key]!;
                if (macroNames.has(key.toLowerCase())) return raw;
                throw new Error(`提示词缺少动态变量：${key}`);
            })}))]))};
}

/** Template expansion is one pass: inserted novel text cannot introduce new template variables. */
export function renderPromptText(template: string, variables: Readonly<Record<string, string>>): string {
    return template.replace(/\{\{\s*([a-zA-Z][\w.-]*)\s*\}\}/gu, (_match, key: string) => {
        if (!Object.hasOwn(variables, key)) throw new Error(`提示词缺少动态变量：${key}`);
        return variables[key]!;
    });
}

export function promptVariableNames(entries: readonly PromptEntry[]): Set<string> {
    return new Set(entries.flatMap(entry => [...entry.content.matchAll(/\{\{\s*([a-zA-Z][\w.-]*)\s*\}\}/gu)].map(match => match[1]!)));
}

export function validatePromptEntries(definition: PromptPurposeDefinition, entries: readonly PromptEntry[]): void {
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error("提示词条目 ID 不能重复");
    const names = promptVariableNames(entries);
    const allowed = new Set(definition.variables);
    for (const name of names) if (!allowed.has(name)) throw new Error(`此用途不支持动态变量：${name}`);
    const activeNames = promptVariableNames(entries.filter(entry => entry.enabled !== false));
    for (const name of definition.requiredVariables ?? []) if (!activeNames.has(name)) throw new Error(`已启用的提示词中必须保留动态变量：${name}；请启用包含该变量的条目`);
    if (entries.some(entry => !entry.content.trim())) throw new Error("提示词正文不能为空");
}

/** Native selection may discard history, but the writer cannot proceed after losing reviewed source facts. */
export function validateTavernRetainedFacts(bindings: TavernBindings, retained: readonly number[], required: readonly string[], sourceJson: string): void {
    const included = new Set(retained);
    const missing = new Set<string>();
    const preserved = new Set<string>();
    const namesIn = (text: string) => [...text.matchAll(/\{\{\s*([a-zA-Z][\w.-]*)\s*\}\}/gu)].map(match => match[1]!);
    for (const prompt of tavernPromptsForGeneration(parseTavernPreset(sourceJson), bindings.generationType)) {
        if (!prompt.marker) continue;
        for (const [index, message] of (bindings.slots[prompt.identifier] ?? []).entries()) {
            if (prompt.identifier === "chatHistory" && !included.has(index)) continue;
            for (const name of namesIn(message.content)) preserved.add(name);
        }
    }
    (bindings.slots.chatHistory ?? []).forEach((message, index) => {
        if (included.has(index)) return;
        const names = new Set([...message.content.matchAll(/\{\{\s*([a-zA-Z][\w.-]*)\s*\}\}/gu)].map(match => match[1]!));
        for (const name of required) if (names.has(name) && !preserved.has(name)) missing.add(name);
    });
    if (missing.size) throw new Error(`酒馆预算会裁掉必需作品资料：${[...missing].join("、")}；请提高预算或调整资料绑定`);
}

/** Legacy projections remain available; new snapshots additionally preserve every role and message boundary. */
export function renderManagedPrompt(snapshot: PromptSnapshot, purposeId: string, variables: Readonly<Record<string, string>>,
    tavernInitial?: {local: Record<string, string>; global: Record<string, string>},
    budget?: TavernCompilationBudget,
): ManagedPromptMessages {
    const purpose = snapshot.purposes[purposeId];
    if (!purpose) throw new Error(`提示词版本中缺少调用用途：${purposeId}`);
    if (purpose.tavern) {
        if (purposeId !== "writing.writer.scene" && purposeId !== "writing.writer.rewrite") throw new Error("酒馆预设仅支持写手用途");
        const tavern: TavernWriterPreset = {...purpose.tavern};
        const generation = {...extractTavernGeneration(tavern.sourceJson), ...tavern.generationOverride};
        const compiled = compileWriterTavern(purposeId, tavern, variables, purpose.requiredVariables ?? [], budget, tavernInitial);
        if (compiled.resolvedBindings) tavern.bindings = compiled.resolvedBindings;
        const orderedMessages = compiled.messages;
        const messages: ManagedPromptMessages["messages"] = orderedMessages.flatMap(message => message.role === "system" ? [] : [{role: message.role, content: message.content}]);
        return {systemPrompt: orderedMessages.filter(message => message.role === "system").map(message => message.content).join("\n\n"),
            messages, orderedMessages, tavernState: compiled.variablesAfter, tavern,
            generation, budgetReport: compiled.budgetReport};
    }
    const system: string[] = [];
    const messages: ManagedPromptMessages["messages"] = [];
    const orderedMessages: NonNullable<ManagedPromptMessages["orderedMessages"]> = [];
    for (const entry of purpose.entries) {
        if (entry.enabled === false) continue;
        const content = renderPromptText(entry.content, variables);
        orderedMessages.push({role: entry.role, content});
        if (entry.role === "system") system.push(content);
        else messages.push({role: entry.role, content});
    }
    return {systemPrompt: system.join("\n\n"), messages, ...(purpose.messageOrder === "configured" ? {orderedMessages} : {})};
}
