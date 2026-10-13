import {z} from "zod";
import type {TavernBindings, TavernMessage, TavernWriterMappings, TavernWriterMappingTarget} from "nbook/shared/dto/tavern-preset.dto";
import {WRITER_SYSTEM_SECTIONS, SCENE_WRITER_SECTIONS, REWRITE_WRITER_SECTIONS} from "./writing-templates";

const SourceSchema = z.object({
    prompts: z.array(z.object({identifier: z.string(), marker: z.boolean().optional(), content: z.string().optional(), injection_trigger: z.union([z.array(z.string()), z.string()]).optional()})),
    prompt_order: z.array(z.object({character_id: z.number(), order: z.array(z.object({identifier: z.string(), enabled: z.boolean()}))})),
    extensions: z.object({regex_scripts: z.array(z.object({findRegex: z.string(), replaceString: z.string(), trimStrings: z.array(z.string()).optional(), disabled: z.boolean().optional(), promptOnly: z.boolean().optional(), placement: z.array(z.number()), substituteRegex: z.number().optional()})).optional()}).passthrough().optional(),
}).passthrough();
const slotNames = ["worldInfoBefore", "worldInfoAfter", "charDescription", "charPersonality", "scenario", "personaDescription", "dialogueExamples", "chatHistory"];
const slotAliases: Record<string, string> = {description: "charDescription", chardescription: "charDescription", personality: "charPersonality", scenario: "scenario", persona: "personaDescription"};
export const mappingTargetKey = (target: TavernWriterMappingTarget) => JSON.stringify([target.kind, target.name]);
export type WriterMappingField = TavernWriterMappingTarget & {active: boolean; read: boolean};

export function writerMappingSections(purposeId: string) {
    if (!["writing.writer.scene", "writing.writer.rewrite"].includes(purposeId)) throw new Error("酒馆映射仅支持写手用途");
    return [...WRITER_SYSTEM_SECTIONS, ...(purposeId.endsWith("scene") ? SCENE_WRITER_SECTIONS : REWRITE_WRITER_SECTIONS)]
        .filter(section => section.id !== "role" && section.id !== "output")
        .map(section => ({...section, category: section.id.startsWith("style-") ? "文风与样文"
            : ["previous-ending", "overview", "roster", "accepted-prose", "chapter-guidance", "chapter-foreshadowing", "before", "target", "after"].includes(section.id) ? "章节与上下文"
            : ["characters", "location", "attire", "techniques", "background", "supplements"].includes(section.id) ? "人物与创作资料" : "场景与写作要求"}));
}

/** Discovery never evaluates preset text. Dynamic names are reported rather than guessed. */
export function discoverWriterMappingFields(sourceJson: string, generationType: "normal" | "continue" = "normal") {
    const source = SourceSchema.parse(JSON.parse(sourceJson));
    const enabled = new Set(source.prompt_order.find(order => order.character_id === 100001)?.order.filter(entry => entry.enabled).map(entry => entry.identifier));
    const fields = new Map<string, WriterMappingField>();
    const dynamicNames = new Set<string>();
    const add = (kind: TavernWriterMappingTarget["kind"], name: string, active: boolean, read: boolean) => {
        const key = mappingTargetKey({kind, name}), previous = fields.get(key);
        fields.set(key, {kind, name, active: active || Boolean(previous?.active), read: read || Boolean(previous?.read)});
    };
    const scan = (text: string, active: boolean) => {
        for (const match of text.matchAll(/\{\{\s*[!?~>]*(get|set|add|inc|dec|has|delete)(global)?var(?:key|index)?(?:\s*::\s*([^{}:]+)|\s+("[^"{}]+"|'[^'{}]+'|[^\s{}:]+))/giu)) {
            const name = (match[3] ?? match[4] ?? "").trim().replace(/^(?:"(.*)"|'(.*)')$/u, "$1$2");
            if (!name) continue;
            add(match[2] ? "global" : "local", name, active, active && match[1]!.toLowerCase() === "get");
        }
        for (const match of text.matchAll(/\{\{\s*[!?~>]*([.$])\s*([a-zA-Z][\w-]*)\s*([^{}]*)/gu)) {
            const operator = match[3]!.trim();
            const writes = /^(?:=(?!=)|\+=|-=|\+\+|--|\|\|=|\?\?=)/u.test(operator);
            add(match[1] === "$" ? "global" : "local", match[2]!, active, active && !writes);
        }
        for (const match of text.matchAll(/\{\{\s*(?:get|set|add|inc|dec|has|delete)(?:global)?var(?:key|index)?\s*(?:::|\s)\s*(\{\{)/giu)) dynamicNames.add(match[0]);
        for (const match of text.matchAll(/\{\{\s*[!?~>]*([a-zA-Z]+)\s*\}\}/gu)) {
            const key = match[1]!.toLowerCase();
            const name = Object.hasOwn(slotAliases, key) ? slotAliases[key] : undefined;
            if (name) add("slot", name, active, active);
        }
    };
    for (const prompt of source.prompts) {
        if (prompt.identifier === "SPresetSettings") continue;
        const active = enabled.has(prompt.identifier) && (!Array.isArray(prompt.injection_trigger) || !prompt.injection_trigger.length || prompt.injection_trigger.includes(generationType));
        if (prompt.marker && slotNames.includes(prompt.identifier)) add("slot", prompt.identifier, active, active);
        if (!prompt.marker) scan(prompt.content ?? "", active);
    }
    // Formatting fields and regex macro inputs can also read variables.
    for (const key of ["scenario_format", "personality_format", "wi_format", "new_chat_prompt", "new_example_chat_prompt", "continue_nudge_prompt", "send_if_empty"]) {
        const value = source[key]; if (typeof value === "string") scan(value, key !== "continue_nudge_prompt" || generationType === "continue");
    }
    for (const regex of source.extensions?.regex_scripts ?? []) {
        const active = !regex.disabled && Boolean(regex.promptOnly) && regex.placement.some(value => value === 1 || value === 2);
        if (regex.substituteRegex) scan(regex.findRegex, active);
        scan(regex.replaceString, active);
        for (const text of regex.trimStrings ?? []) scan(text, active);
    }
    return {fields: [...fields.values()], dynamicNames: [...dynamicNames]};
}

export function createDefaultWriterMappings(purposeId: string, sourceJson: string): TavernWriterMappings {
    const available = discoverWriterMappingFields(sourceJson).fields.filter(field => field.active && field.read && field.name !== "dialogueExamples");
    const slot = (name: string) => available.find(field => field.kind === "slot" && field.name === name);
    return Object.fromEntries(writerMappingSections(purposeId).map(section => {
        const preferred = section.id === "characters" ? "charDescription" : ["techniques", "background", "supplements"].includes(section.id) ? "worldInfoBefore"
            : ["overview", "scene-description", "location", "attire", "plot", "description"].includes(section.id) ? "scenario" : "chatHistory";
        const target = slot(preferred) ?? slot("chatHistory") ?? slot("scenario") ?? available[0];
        return [section.id, target ? {kind: target.kind, name: target.name} : null];
    }));
}

export type TavernWriterInjection = {slots: Record<string, TavernMessage[]>; local: Record<string, string>; global: Record<string, string>; prompts: Record<string, string>};

export function enableWriterMappings(purposeId: string, sourceJson: string, bindings: TavernBindings) {
    const mappings = createDefaultWriterMappings(purposeId, sourceJson);
    const slots = Object.fromEntries(Object.entries(bindings.slots).map(([name, messages]) => [name, messages.map(message => ({...message}))]));
    for (const section of writerMappingSections(purposeId)) {
        for (const [name, messages] of Object.entries(slots)) {
            if (!messages.some(message => message.content.includes(section.content))) continue;
            mappings[section.id] = {kind: "slot", name};
            slots[name] = messages.map(message => ({...message, content: message.content.replaceAll(section.content, "").trim()})).filter(message => message.content);
        }
    }
    return {writerMappings: mappings, bindings: {...bindings, slots}};
}

/** Merge source sections in their canonical order, preserving local/global name isolation. */
export function materializeWriterMappings(purposeId: string, sourceJson: string, bindings: TavernBindings, mappings: TavernWriterMappings,
    render: (text: string) => string = text => text,
): TavernWriterInjection {
    const sections = writerMappingSections(purposeId), ids = new Set(sections.map(section => section.id));
    for (const id of Object.keys(mappings)) if (!ids.has(id)) throw new Error(`未知的写作映射条目：${id}`);
    const source = SourceSchema.parse(JSON.parse(sourceJson));
    const available = discoverWriterMappingFields(sourceJson, bindings.generationType).fields;
    const grouped = new Map<string, {target: TavernWriterMappingTarget; sections: typeof sections}>();
    const direct: Record<string, string> = {};
    for (const section of sections) {
        const target = Object.hasOwn(mappings, section.id) ? mappings[section.id] : null;
        if (!target) continue;
        if (target.kind === "prompt") {
            const prompt = source.prompts.find(prompt => prompt.identifier === target.name);
            const order = source.prompt_order.find(order => order.character_id === 100001)?.order.find(entry => entry.identifier === target.name);
            if (!prompt || prompt.marker || !order?.enabled || (Array.isArray(prompt.injection_trigger) && prompt.injection_trigger.length && !prompt.injection_trigger.includes(bindings.generationType ?? "normal"))) {
                throw new Error(`${section.name}的直接条目不存在或未启用：${target.name}`);
            }
            if (Object.hasOwn(direct, target.name)) throw new Error("多个写作条目不能共用同一个直接条目");
            Object.defineProperty(direct, target.name, {value: render(prompt.content ?? ""), enumerable: true});
            continue;
        }
        const field = available.find(field => mappingTargetKey(field) === mappingTargetKey(target));
        if (!field?.active || !field.read) throw new Error(`${section.name}的映射目标不可用或未被读取：${target.kind}.${target.name}`);
        if (target.kind === "slot" && target.name === "dialogueExamples") throw new Error("示例对话需要配对消息，请通过资料绑定 JSON 配置");
        const key = mappingTargetKey(target), group = grouped.get(key) ?? {target, sections: []};
        group.sections.push(section); grouped.set(key, group);
    }
    const result: TavernWriterInjection = {slots: {}, local: {}, global: {}, prompts: direct};
    for (const {target, sections: selected} of grouped.values()) {
        if (target.kind === "slot") {
            const messages: TavernMessage[] = target.name === "chatHistory" ? selected.map(section => ({role: ["previous-ending", "accepted-prose"].includes(section.id) ? "assistant" : "user", content: render(section.content)}))
                : [{role: "system", content: selected.map(section => render(section.content)).join("\n\n")}];
            Object.defineProperty(result.slots, target.name, {value: messages, enumerable: true});
        } else if (target.kind !== "prompt") Object.defineProperty(result[target.kind], target.name, {value: selected.map(section => render(section.content)).join("\n\n"), enumerable: true});
    }
    return result;
}
