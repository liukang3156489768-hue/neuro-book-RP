import {z} from "zod";
import type {TavernBindings, TavernMessage, TavernOutputPolicy} from "nbook/shared/dto/tavern-preset.dto";
import {WRITER_SYSTEM_SECTIONS, SCENE_WRITER_SECTIONS, REWRITE_WRITER_SECTIONS} from "./writing-templates";
import {createDefaultWriterMappings, discoverWriterMappingFields} from "./tavern-writer-mapping";

/** New imports use explicit section mappings; old saved bindings are never migrated implicitly. */
export function createMappedTavernImport(purposeId: string, sourceJson: string) {
    const source = SourceSchema.parse(JSON.parse(sourceJson));
    const slots = Object.fromEntries(source.prompts.filter(prompt => prompt.marker).map(prompt => [prompt.identifier, []]));
    const fields = discoverWriterMappingFields(sourceJson).fields;
    for (const field of fields) if (field.kind === "slot" && !Object.hasOwn(slots, field.name)) slots[field.name] = [];
    const bindings: TavernBindings = {user: "作者", char: "写手", slots, variablePersistence: "writing-session", generationType: "normal"};
    return {bindings, writerMappings: createDefaultWriterMappings(purposeId, sourceJson)};
}

const SourceSchema = z.object({
    prompts: z.array(z.object({identifier: z.string(), marker: z.boolean().optional(), content: z.string().optional(),
        injection_trigger: z.union([z.array(z.string()), z.string()]).optional()})),
    prompt_order: z.array(z.object({character_id: z.number(), order: z.array(z.object({identifier: z.string(), enabled: z.boolean()}))})),
});

/** Bind reviewed writing facts without changing the preset's own ordinary prompts or macro identities. */
export function createDefaultTavernBindings(purposeId: string, sourceJson: string): TavernBindings {
    if (purposeId !== "writing.writer.scene" && purposeId !== "writing.writer.rewrite") throw new Error("酒馆预设仅支持写手用途");
    const source = SourceSchema.parse(JSON.parse(sourceJson));
    const order = source.prompt_order.find(value => value.character_id === 100001);
    if (!order) throw new Error("预设缺少全局提示词顺序");
    const active = new Set(order.order.filter(value => value.enabled).map(value => value.identifier));
    const slots: Record<string, TavernMessage[]> = {};
    for (const prompt of source.prompts) if (prompt.marker && active.has(prompt.identifier)
        && (!Array.isArray(prompt.injection_trigger) || !prompt.injection_trigger.length || prompt.injection_trigger.includes("normal"))) slots[prompt.identifier] = [];
    const sections = [...WRITER_SYSTEM_SECTIONS, ...(purposeId === "writing.writer.scene" ? SCENE_WRITER_SECTIONS : REWRITE_WRITER_SECTIONS)];
    // Instructions remain in the native preset; only source facts are mapped to its enabled slots.
    const facts = sections.filter(section => section.id !== "role" && section.id !== "output");
    const assigned = new Set<string>();
    const assign = (slot: string, ids: string[]) => {
        if (!Object.hasOwn(slots, slot)) return;
        const selected = facts.filter(section => ids.includes(section.id));
        if (!selected.length) return;
        slots[slot] = [{role: "system", content: selected.map(section => section.content).join("\n\n")}];
        for (const section of selected) assigned.add(section.id);
    };
    assign("charDescription", ["characters"]);
    assign("worldInfoBefore", ["techniques", "background", "supplements"]);
    assign("scenario", ["overview", "scene-description", "location", "attire", "plot", "description"]);
    const historical = Object.hasOwn(slots, "chatHistory")
        ? facts.filter(section => section.id === "previous-ending" || section.id === "accepted-prose") : [];
    for (const section of historical) assigned.add(section.id);
    const remaining = facts.filter(section => !assigned.has(section.id)).map(section => section.content).join("\n\n");
    if (Object.hasOwn(slots, "chatHistory")) slots.chatHistory = [
        ...(historical.length ? [{role: "assistant" as const, content: historical.map(section => section.content).join("\n\n")}] : []),
        {role: "user", content: remaining},
    ];
    else {
        const target = ["scenario", "charDescription", "worldInfoAfter", "worldInfoBefore", "personaDescription"].find(id => Object.hasOwn(slots, id));
        if (!target) throw new Error("预设需要启用聊天历史、场景或人物等资料槽位，才能接收作品资料");
        slots[target] = [{role: "system", content: [slots[target]?.[0]?.content, remaining].filter(Boolean).join("\n\n")}];
    }
    return {user: "作者", char: "写手", slots, variablePersistence: "writing-session", generationType: "normal"};
}

export function defaultTavernOutputPolicy(sourceJson: string): TavernOutputPolicy {
    const source = SourceSchema.parse(JSON.parse(sourceJson));
    const active = new Set(source.prompt_order.find(value => value.character_id === 100001)?.order.filter(value => value.enabled).map(value => value.identifier));
    return source.prompts.some(prompt => active.has(prompt.identifier) && /<content>/iu.test(prompt.content ?? ""))
        ? {mode: "tag", tag: "content", qualityCheck: true} : {mode: "full", qualityCheck: true};
}
