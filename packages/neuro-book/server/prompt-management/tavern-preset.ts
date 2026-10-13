import {createHash} from "node:crypto";
import {z} from "zod";
import {TavernBindingsSchema, TavernPostProcessingSchema, type TavernBindings, type TavernGenerationParameters, type TavernMessage, type TavernWriterPreset} from "nbook/shared/dto/tavern-preset.dto";
import {postProcessTavernMessages, squashTavernSystemMessages} from "./tavern-message-conversion";
import {createTavernBudget, type TavernCompilationBudget} from "./tavern-budget";
import {createTavernMacroEvaluator, resolveTavernNativeContext, supportedTavernMacroNames, type MacroEnvironment, type TavernMacroEvaluator, type TavernState} from "./tavern-macros";
import type {TavernWriterInjection} from "nbook/shared/prompt-management/tavern-writer-mapping";
export {expandTavernMacros, TAVERN_ENV_MACROS, type TavernState} from "./tavern-macros";

export const SILLYTAVERN_REVISION = "06bde939fb1e9c4c8d8641d810f0a916b5bce127";
const PromptSchema = z.object({
    identifier: z.string().min(1), name: z.string().optional(), role: z.enum(["system", "user", "assistant"]).optional(),
    content: z.string().optional(), marker: z.boolean().optional(),
    spreset_condition_script: z.string().optional(),
    injection_position: z.number().int().optional(), injection_depth: z.number().int().min(0).optional(), injection_order: z.number().int().optional(),
    injection_trigger: z.union([z.array(z.string()), z.string()]).optional(),
}).passthrough();
const RegexSchema = z.object({
    id: z.string().optional(), scriptName: z.string(), disabled: z.boolean().optional(),
    findRegex: z.string(), replaceString: z.string(), trimStrings: z.array(z.string()).optional(),
    placement: z.array(z.number().int()), promptOnly: z.boolean().optional(), markdownOnly: z.boolean().optional(),
    minDepth: z.number().nullable().optional(), maxDepth: z.number().nullable().optional(), substituteRegex: z.number().optional(),
}).passthrough();
const SourceSchema = z.object({
    prompts: z.array(PromptSchema).max(1024),
    prompt_order: z.array(z.object({character_id: z.number(), order: z.array(z.object({identifier: z.string(), enabled: z.boolean()}))})),
    squash_system_messages: z.boolean().optional(),
    new_chat_prompt: z.string().optional(), new_example_chat_prompt: z.string().optional(), send_if_empty: z.string().optional(),
    scenario_format: z.string().optional(), personality_format: z.string().optional(), wi_format: z.string().optional(),
    names_behavior: z.number().optional(),
    custom_prompt_post_processing: z.string().optional(), continue_prefill: z.boolean().optional(), continue_nudge_prompt: z.string().optional(), assistant_prefill: z.string().optional(),
    extensions: z.object({
        regex_scripts: z.array(RegexSchema).optional(),
        tavern_helper: z.object({scripts: z.array(z.object({name: z.string(), enabled: z.boolean().optional()}).passthrough()).optional()}).passthrough().optional(),
    }).passthrough().optional(),
}).passthrough();
export type TavernSource = z.infer<typeof SourceSchema>;
const MARKERS = new Set(["worldInfoBefore", "worldInfoAfter", "charDescription", "charPersonality", "scenario", "personaDescription",
    "dialogueExamples", "chatHistory", "agentTask", "agentSystemPrompt", "agentResults"]);
const RUNTIME_ORDER = ["worldInfoBefore", "worldInfoAfter", "charDescription", "charPersonality", "scenario", "personaDescription",
    "agentTask", "agentSystemPrompt", "agentResults"];
const CHARACTER_SLOT_FIELDS: Readonly<Record<string, "description" | "personality" | "persona" | "scenario">> = {
    charDescription: "description", charPersonality: "personality", personaDescription: "persona", scenario: "scenario",
};
function unsupportedText(text: string, engine: TavernWriterPreset["macroEngine"]): string[] {
    const supported = supportedTavernMacroNames(engine);
    const unsupported = [...text.matchAll(/\{\{[\s!#]*\/?([a-zA-Z][a-zA-Z0-9_-]*)/gu)].map(match => match[1]!.toLowerCase()).filter(name => !supported.has(name));
    if (/<%|\[GENERATE:|\[RENDER:|@INJECT/u.test(text)) unsupported.push("template extension");
    return unsupported;
}

export function parseTavernPreset(sourceJson: string): TavernSource {
    const source = SourceSchema.parse(JSON.parse(sourceJson));
    if (new Set(source.prompts.map(prompt => prompt.identifier)).size !== source.prompts.length) throw new Error("酒馆预设的 identifier 重复");
    const global = source.prompt_order.filter(order => order.character_id === 100001);
    if (global.length !== 1) throw new Error("酒馆预设必须包含唯一的全局 prompt_order（100001）");
    const identifiers = global[0]!.order.map(entry => entry.identifier);
    if (new Set(identifiers).size !== identifiers.length) throw new Error("酒馆预设 prompt_order 的 identifier 重复");
    for (const id of identifiers) if (!source.prompts.some(prompt => prompt.identifier === id)) throw new Error(`酒馆预设缺少条目：${id}`);
    return source;
}

export function activeTavernPrompts(source: TavernSource) {
    const prompts = new Map(source.prompts.map(prompt => [prompt.identifier, prompt]));
    return source.prompt_order.find(order => order.character_id === 100001)!.order.filter(entry => entry.enabled).map(entry => prompts.get(entry.identifier)!);
}

/** Trigger filtering is shared with required-data validation so inactive markers cannot satisfy the writer contract. */
export function tavernPromptsForGeneration(source: TavernSource, generationType: "normal" | "continue" = "normal") {
    return activeTavernPrompts(source).filter(prompt => prompt.identifier !== "SPresetSettings" && (!Array.isArray(prompt.injection_trigger)
        || !prompt.injection_trigger.length || prompt.injection_trigger.includes(generationType)));
}

/** Report compilation support independently from extension and Provider equivalence. */
export function inspectTavernPreset(sourceJson: string, options: {macroEngine?: TavernWriterPreset["macroEngine"]; generationType?: TavernBindings["generationType"]} = {}) {
    const source = parseTavernPreset(sourceJson);
    const active = options.generationType ? tavernPromptsForGeneration(source, options.generationType) : activeTavernPrompts(source);
    const unsupported: string[] = [];
    const extensionDependencies = (source.extensions?.tavern_helper?.scripts ?? []).filter(script => script.enabled).map(script => script.name);
    // SPreset also stores runtime configuration outside the enabled order, so checking active entries alone is insufficient.
    if (source.prompts.some(prompt => prompt.identifier === "SPresetSettings" && prompt.content?.trim())) {
        extensionDependencies.push("SPresetSettings: extension runtime configuration");
    }
    for (const prompt of active) {
        if (prompt.identifier === "SPresetSettings") continue;
        if (prompt.injection_position !== undefined && ![0, 1].includes(prompt.injection_position)) unsupported.push(`${prompt.identifier}: unknown injection position`);
        if (prompt.marker && !MARKERS.has(prompt.identifier)) unsupported.push(`${prompt.identifier}: unknown marker`);
        if (prompt.spreset_condition_script?.trim()) extensionDependencies.push(`${prompt.identifier}: SPreset condition script`);
        for (const name of unsupportedText(prompt.content ?? "", options.macroEngine ?? "legacy")) unsupported.push(`${prompt.identifier}: ${name}`);
    }
    for (const key of ["new_chat_prompt", "new_example_chat_prompt", "scenario_format", "personality_format", "wi_format", "continue_nudge_prompt"] as const) {
        const text = key === "continue_nudge_prompt" ? (source[key] ?? "").replace(/\{\{lastChatMessage\}\}/giu, "") : source[key] ?? "";
        for (const name of unsupportedText(text, options.macroEngine ?? "legacy")) unsupported.push(`${key}: ${name}`);
    }
    const regexes = source.extensions?.regex_scripts ?? [];
    for (const regex of regexes.filter(regex => !regex.disabled)) {
        if (![0, 1, 2].includes(regex.substituteRegex ?? 0)) unsupported.push(`${regex.scriptName}: unknown regex substitution`);
        if (regex.substituteRegex) {
            for (const name of unsupportedText(regex.findRegex, options.macroEngine ?? "legacy")) unsupported.push(`${regex.scriptName}: ${name}`);
        }
        // A macro may produce regex syntax; validate the expanded expression at its execution stage.
        if (!regex.substituteRegex || !regex.findRegex.includes("{{")) {
            try {parseRegex(regex.findRegex);} catch {unsupported.push(`${regex.scriptName}: invalid regex`);}
        }
    }
    const knownExtensions = new Set(["regex_scripts", "tavern_helper"]);
    for (const key of Object.keys(source.extensions ?? {})) if (!knownExtensions.has(key)) extensionDependencies.push(`extension: ${key}`);
    if (!TavernPostProcessingSchema.safeParse(source.custom_prompt_post_processing ?? "none").success) unsupported.push("custom_prompt_post_processing");
    if (source.names_behavior !== undefined && ![-1, 0, 1, 2].includes(source.names_behavior)) unsupported.push("names_behavior");
    if (source.assistant_prefill) unsupported.push("assistant_prefill requires native Claude provider formatting");
    return {sourceSha256: createHash("sha256").update(sourceJson).digest("hex"), upstreamRevision: SILLYTAVERN_REVISION,
        prompts: source.prompts.length, active: active.length, regexes: regexes.length, unsupported: [...new Set(unsupported)],
        extensionDependencies: [...new Set(extensionDependencies)], promptSupported: unsupported.length === 0, fullEnvironmentEquivalent: false as const};
}

function parseRegex(value: string): RegExp {
    const match = value.match(/(\/?)(.+)\1([a-z]*)/i);
    if (!match || match[2] === undefined) throw new Error("酒馆正则表达式无效");
    if (match[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/u.test(match[3])) return new RegExp(value);
    return new RegExp(match[2], match[3]);
}

/** Escape macro results only: escaping the whole expression would destroy its literal regex syntax. */
function sanitizeRegexMacro(value: string): string {
    // Legacy inc/dec return numbers; upstream leaves non-string macro results to String.replace coercion.
    if (!value || typeof value !== "string") return value;
    const controls: Record<string, string> = {"\n": "\\n", "\r": "\\r", "\t": "\\t", "\v": "\\v", "\f": "\\f", "\0": "\\0"};
    return value.replace(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/gu, character => controls[character] ?? `\\${character}`);
}

/** Prompt, stored output and display are separate stages; display markup never enters future history. */
export function applyTavernRegex(source: TavernSource, text: string, placement: number, stage: "prompt" | "display" | "stored", depth?: number,
    bindings: Pick<TavernBindings, "user" | "char"> = {user: "", char: ""}, state: TavernState = {local: {}, global: {}},
    expand: TavernMacroEvaluator = createTavernMacroEvaluator({...bindings, slots: {}}, bindings, state),
): string {
    let result = text;
    for (const script of source.extensions?.regex_scripts ?? []) {
        if (script.disabled || !script.placement.includes(placement)) continue;
        const prompt = stage === "prompt", display = stage === "display";
        if (script.promptOnly || script.markdownOnly) {
            if (!(prompt && script.promptOnly) && !(display && script.markdownOnly)) continue;
        } else if (stage !== "stored") continue;
        if (typeof depth === "number") {
            if (script.minDepth != null && script.minDepth >= -1 && depth < script.minDepth) continue;
            if (script.maxDepth != null && script.maxDepth >= 0 && depth > script.maxDepth) continue;
        }
        const findRegex = script.substituteRegex ? expand(script.findRegex, script.substituteRegex === 2 ? sanitizeRegexMacro : undefined) : script.findRegex;
        result = result.replace(parseRegex(findRegex), (...args: unknown[]) => {
            const replacement = script.replaceString.replace(/\{\{match\}\}/giu, "$0").replace(/\$(\d+)|\$<([^>]+)>/gu, (_raw, index: string, name: string) => {
                const last = args.at(-1);
                const groups = last && typeof last === "object" ? last : {};
                const matched = index ? args[Number(index)] : Reflect.get(groups, name);
                if (typeof matched !== "string") return "";
                return (script.trimStrings ?? []).reduce((value, trim) => value.replaceAll(expand(trim), ""), matched);
            });
            return expand(replacement);
        });
    }
    return result;
}

/** Text Chat Completion input includes selected ST post-processing, before SDK conversion and token truncation. */
export function compileTavernPreset(sourceJson: string, input: TavernBindings, options: {macroEngine?: TavernWriterPreset["macroEngine"]; budget?: TavernCompilationBudget; generation?: TavernGenerationParameters; writerInjection?: TavernWriterInjection} = {}) {
    const source = parseTavernPreset(sourceJson);
    // Direct writer templates belong to the application renderer, not ST's macro validator or initializer.
    const inspectionJson = options.writerInjection ? JSON.stringify({...source, prompts: source.prompts.map(prompt =>
        Object.hasOwn(options.writerInjection!.prompts, prompt.identifier) ? {...prompt, content: ""} : prompt)}) : sourceJson;
    const report = {...inspectTavernPreset(inspectionJson, {...options, generationType: input.generationType ?? "normal"}),
        sourceSha256: createHash("sha256").update(sourceJson).digest("hex")};
    if (!report.promptSupported) throw new Error(`酒馆预设包含未支持的提示机制：${report.unsupported.join("；")}`);
    const bindings = TavernBindingsSchema.parse(input);
    if (bindings.contextBudget && !options.budget) throw new Error("酒馆上下文预算未准备");
    bindings.nativeContext = resolveTavernNativeContext(bindings);
    if (options.budget) {
        bindings.nativeContext.maxContext = options.budget.contextTokens;
        bindings.nativeContext.maxResponse = options.budget.responseTokens;
    }
    bindings.nativeContext.maxContext ??= typeof source.openai_max_context === "number" ? source.openai_max_context : 0;
    bindings.nativeContext.maxResponse ??= typeof source.openai_max_tokens === "number" ? source.openai_max_tokens : 0;
    if (!options.budget && options.generation?.maxTokens !== undefined) bindings.nativeContext.maxResponse = options.generation.maxTokens;
    const budget = options.budget ? createTavernBudget(options.budget) : undefined;
    let droppedHistory = 0, droppedExamples = 0;
    const retainedHistoryIndices = new Set<number>();
    for (const id of Object.keys(bindings.slots)) if (!MARKERS.has(id)) throw new Error(`未知的酒馆资料绑定：${id}`);
    const state: TavernState = {local: {...bindings.localVariables}, global: {...bindings.globalVariables}};
    const before = structuredClone(state);
    const prepared = new Map<string, TavernMessage[]>();
    const continuation: TavernMessage[] = [];
    const generationType = bindings.generationType ?? "normal";
    const active = tavernPromptsForGeneration(source, generationType);
    const absolute = active.filter(prompt => prompt.injection_position === 1);
    if (options.writerInjection) {
        const initialEnvironment: MacroEnvironment = {...bindings, persona: bindings.slots.personaDescription?.[0]?.content ?? "",
            scenario: bindings.slots.scenario?.[0]?.content ?? "", personality: bindings.slots.charPersonality?.[0]?.content ?? "", description: bindings.slots.charDescription?.[0]?.content ?? ""};
        const initialize = createTavernMacroEvaluator(bindings, initialEnvironment, state, options.macroEngine);
        // Mapping is a deliberate three-stage mode. Variable writes run once, before any writer facts are injected.
        for (const prompt of active) if (!prompt.marker && !Object.hasOwn(options.writerInjection.prompts, prompt.identifier)) initialize(prompt.content ?? "");
        for (const id of RUNTIME_ORDER) if (active.some(prompt => prompt.marker && prompt.identifier === id)) {
            for (const message of bindings.slots[id] ?? []) initialize(message.content);
        }
        if (initialEnvironment.scenario) initialize(source.scenario_format ?? "");
        if (initialEnvironment.personality) initialize(source.personality_format ?? "");
        if (active.some(prompt => prompt.marker && prompt.identifier.startsWith("worldInfo"))) initialize(source.wi_format ?? "");
        if (active.some(prompt => prompt.marker && prompt.identifier === "dialogueExamples") && bindings.slots.dialogueExamples?.length) {
            initialize(source.new_example_chat_prompt ?? "");
            for (const message of bindings.slots.dialogueExamples) initialize(message.content);
        }
        if (active.some(prompt => prompt.marker && prompt.identifier === "chatHistory")) initialize(source.new_chat_prompt ?? "");
        if (active.some(prompt => prompt.marker && prompt.identifier === "chatHistory")) {
            for (const message of [...(bindings.slots.chatHistory ?? [])].reverse()) initialize(message.content);
        }
        for (const kind of ["local", "global"] as const) for (const [name, value] of Object.entries(options.writerInjection[kind])) {
            Object.defineProperty(state[kind], name, {value, enumerable: true, configurable: true, writable: true});
        }
        for (const [id, additions] of Object.entries(options.writerInjection.slots)) {
            const existing = bindings.slots[id] ?? [];
            bindings.slots[id] = id === "chatHistory" ? [...existing, ...additions] : [{role: "system", content: [...existing, ...additions].map(message => message.content).join("\n\n")}];
            const characterField = CHARACTER_SLOT_FIELDS[id];
            if (characterField && bindings.nativeContext?.character) bindings.nativeContext.character[characterField] = bindings.slots[id]![0]!.content;
        }
    }
    if (absolute.length && !active.some(prompt => prompt.identifier === "chatHistory" && prompt.injection_position !== 1)) {
        throw new Error("酒馆深度注入必须启用相对位置的 chatHistory");
    }
    for (const prompt of active.filter(prompt => prompt.marker)) {
        const values = bindings.slots[prompt.identifier];
        if (!values) throw new Error(`酒馆资料槽位必须显式绑定（允许空数组）：${prompt.identifier}`);
        if (RUNTIME_ORDER.includes(prompt.identifier) && values.length > 1) throw new Error(`酒馆资料槽位只接受一条内容：${prompt.identifier}`);
        if (prompt.identifier.startsWith("agent") && values.length) throw new Error(`酒馆 Agent 扩展槽位尚未支持：${prompt.identifier}`);
    }
    const environment: MacroEnvironment = {...bindings, persona: bindings.slots.personaDescription?.[0]?.content ?? "",
        scenario: bindings.slots.scenario?.[0]?.content ?? "", personality: bindings.slots.charPersonality?.[0]?.content ?? "", description: bindings.slots.charDescription?.[0]?.content ?? ""};
    // The expansion stage reads initialized/mapped variables without repeating initialization side effects.
    const expand = createTavernMacroEvaluator(bindings, environment, state, options.macroEngine, Boolean(options.writerInjection));
    const scenario = environment.scenario && source.scenario_format ? expand(source.scenario_format) : environment.scenario;
    const personality = environment.personality && source.personality_format ? expand(source.personality_format) : environment.personality;
    for (const prompt of active) {
        if (prompt.marker) continue;
        if (!prompt.role) throw new Error(`酒馆提示词缺少 role：${prompt.identifier}`);
        const direct = options.writerInjection?.prompts;
        prepared.set(prompt.identifier, [{role: prompt.role, content: direct && Object.hasOwn(direct, prompt.identifier) ? direct[prompt.identifier]! : expand(prompt.content ?? "")}]);
    }
    // SillyTavern prepares runtime slots after ordinary prompts, independently of their final positions.
    for (const id of RUNTIME_ORDER) {
        if (!active.some(prompt => prompt.identifier === id && prompt.marker)) continue;
        const prompt = active.find(prompt => prompt.identifier === id)!;
        prepared.set(id, bindings.slots[id]!.map(message => {
            let raw = id === "scenario" ? scenario ?? "" : id === "charPersonality" ? personality ?? "" : message.content;
            if (id.startsWith("worldInfo") && raw) raw = (source.wi_format ?? "{0}").replace("{0}", raw);
            return {role: prompt.role ?? "system", content: expand(raw)};
        }));
    }
    if (active.some(prompt => prompt.identifier === "dialogueExamples")) {
        const examples = bindings.slots.dialogueExamples!;
        if (examples.some(message => message.role !== "system" || !["example_user", "example_assistant"].includes(message.name ?? ""))) {
            throw new Error("酒馆示例必须是带 example_user / example_assistant 名称的 system 消息");
        }
        prepared.set("dialogueExamples", examples.length ? [{role: "system", content: expand(source.new_example_chat_prompt ?? "[Example Chat]")}, ...examples] : []);
    }
    const takeExamples = () => {
        const examples = prepared.get("dialogueExamples") ?? [];
        if (budget && examples.length && !budget.take(examples)) {prepared.set("dialogueExamples", []); droppedExamples = 1;}
    };
    const reserveMandatory = (extra: TavernMessage[] = []) => budget?.reserve([
        ...active.filter(prompt => prompt.injection_position !== 1 && !["chatHistory", "dialogueExamples"].includes(prompt.identifier))
            .flatMap(prompt => prepared.get(prompt.identifier) ?? []), ...continuation, ...extra,
    ]);
    if (active.some(prompt => prompt.identifier === "chatHistory")) {
        const history = [...bindings.slots.chatHistory!];
        const start = {role: "system" as const, content: expand(source.new_chat_prompt ?? "[Start a new Chat]")};
        const rawHistory = history.map((message, index) => {
            const name = message.name ?? (message.role === "user" ? bindings.user : message.role === "assistant" ? bindings.char : undefined);
            let content = applyTavernRegex(source, message.content, message.role === "assistant" ? 2 : 1, "prompt", history.length - index - 1, environment, state, expand);
            // API system history represents ST narrator messages; CONTENT does not prefix their names.
            if (source.names_behavior === 2 && message.role !== "system") content = `${name}: ${content}`;
            const formatted: TavernMessage = {role: message.role, content: content.replace(/\r/gmu, "")};
            if (source.names_behavior === 1 && name) formatted.name = name.replace(/[^a-zA-Z0-9_]/g, "_").substring(0, 64);
            return formatted;
        });
        let continuedMessage: TavernMessage | undefined;
        if (generationType === "continue") {
            const latest = rawHistory.at(-1);
            if (!latest) throw new Error("酒馆续写需要至少一条历史消息");
            retainedHistoryIndices.add(history.length - 1);
            if (source.continue_prefill) {
                // Upstream uses Message.createAsync for prefill, so it does not evaluate prompt macros here.
                rawHistory.pop();
                continuation.push({...latest});
            } else {
                continuedMessage = latest;
                const rawNudge = (source.continue_nudge_prompt ?? "[Continue your last message without repeating its original content.]")
                    .replace(/\{\{lastChatMessage\}\}/giu, () => latest.content.trim());
                const nudge = expand(rawNudge);
                continuation.push({role: latest.role, content: expand(latest.content)},
                    {role: "system", content: expand(nudge)});
            }
        }
        // Upstream injects into newest-first raw history, groups priority descending and reverses the entire list.
        const injected: {identifier: string; message: TavernMessage; historyIndex?: number; segments?: {content: string; literal: boolean}[]}[] = rawHistory.reverse()
            .map((message, index) => ({identifier: "chatHistory", message, historyIndex: rawHistory.length - index - 1}));
        let inserted = 0;
        const depths = [...new Set(absolute.map(prompt => prompt.injection_depth ?? 4))].sort((a, b) => a - b);
        for (const depth of depths) {
            const atDepth = absolute.filter(prompt => (prompt.injection_depth ?? 4) === depth);
            const orders = [...new Set(atDepth.map(prompt => prompt.injection_order ?? 100))].sort((a, b) => b - a);
            const additions: typeof injected = [];
            for (const order of orders) for (const role of ["system", "user", "assistant"] as const) {
                const segments = atDepth.filter(prompt => (prompt.injection_order ?? 100) === order)
                    .flatMap(prompt => (prepared.get(prompt.identifier) ?? []).filter(message => message.role === role)
                        .map(message => ({content: message.content, literal: Boolean(options.writerInjection && Object.hasOwn(options.writerInjection.prompts, prompt.identifier))})))
                    .filter(segment => segment.content);
                const content = segments.map(segment => segment.content).join("\n").trim();
                if (content) additions.push({identifier: "chatHistory", message: {role, content}, ...(segments.some(segment => segment.literal) ? {segments} : {})});
            }
            injected.splice(depth + inserted, 0, ...additions);
            inserted += additions.length;
        }
        injected.reverse();
        // Nudge continuation removes the latest original message after depth injection; prefill removes it before.
        if (continuedMessage) {
            const index = injected.findIndex(entry => entry.message === continuedMessage);
            if (index >= 0) injected.splice(index, 1);
        }
        let sendIfEmpty: TavernMessage[] = injected.at(-1)?.message.role === "assistant" && source.send_if_empty ? [{role: "user", content: source.send_if_empty}] : [];
        reserveMandatory([start]);
        if (budget && !budget.take(sendIfEmpty)) sendIfEmpty = [];
        if (budget?.pinExamples) takeExamples();
        const rendered: TavernMessage[] = [];
        const newestFirst = [...injected].reverse();
        for (let index = 0; index < newestFirst.length; index++) {
            const entry = newestFirst[index]!;
            const message = entry.message;
            const candidate = {...message, content: entry.segments ? entry.segments.map(segment => segment.literal ? segment.content : expand(segment.content)).join("\n").trim() : expand(message.content)};
            // ST evaluates the first rejected candidate; older candidates never run their macros.
            if (budget && !budget.take([candidate])) {droppedHistory = newestFirst.length - index; break;}
            if (entry.historyIndex !== undefined) retainedHistoryIndices.add(entry.historyIndex);
            rendered.unshift(candidate);
        }
        if (!budget?.pinExamples) takeExamples();
        rendered.push(...sendIfEmpty);
        prepared.set("chatHistory", [start, ...rendered]);
    } else {reserveMandatory(); takeExamples();}
    if (bindings.generationType === "continue" && !active.some(prompt => prompt.identifier === "chatHistory")) throw new Error("续写对照必须启用 chatHistory");
    const emitted = active.filter(prompt => prompt.injection_position !== 1).flatMap(prompt => (prepared.get(prompt.identifier) ?? []).map((message, index) => ({identifier: index === 0
        ? prompt.identifier === "chatHistory" ? "newMainChat" : prompt.identifier === "dialogueExamples" ? "newChat" : prompt.identifier : prompt.identifier, message})))
        .concat(continuation.map(message => ({identifier: "continueNudge", message})))
        .filter(entry => entry.message.content.length > 0);
    const finalEntries = source.squash_system_messages ? squashTavernSystemMessages(emitted) : emitted;
    const promptMessages = finalEntries.map(entry => entry.message);
    const postProcessing = TavernPostProcessingSchema.parse(bindings.requestPostProcessing ?? source.custom_prompt_post_processing ?? "none");
    return {messages: postProcessTavernMessages(promptMessages, bindings, postProcessing),
        promptMessages, messageIdentifiers: finalEntries.map(entry => entry.identifier),
        variablesBefore: before, variablesAfter: structuredClone(state), report, resolvedBindings: bindings,
        retainedHistoryIndices: [...retainedHistoryIndices].sort((a, b) => a - b),
        budgetReport: budget?.report(droppedHistory, droppedExamples)};
}
