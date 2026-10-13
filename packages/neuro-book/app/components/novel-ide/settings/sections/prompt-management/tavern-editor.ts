import {z} from "zod";
import {TavernWriterDirectDraftSchema, type TavernWriterPreset} from "nbook/shared/dto/tavern-preset.dto";
import {createDefaultWriterMappings, writerMappingSections} from "nbook/shared/prompt-management/tavern-writer-mapping";

const PromptSchema = z.object({identifier: z.string().min(1), name: z.string().optional(), role: z.enum(["system", "user", "assistant"]).optional(), content: z.string().optional(), marker: z.boolean().optional(),
    injection_position: z.number().int().optional(), injection_depth: z.number().int().optional(), injection_order: z.number().int().optional(), injection_trigger: z.union([z.array(z.string()), z.string()]).optional(),
}).passthrough();
const SourceSchema = z.object({prompts: z.array(PromptSchema), prompt_order: z.array(z.object({character_id: z.number(), order: z.array(z.object({identifier: z.string(), enabled: z.boolean()}).passthrough())}).passthrough())}).passthrough();
export type EditableTavernSource = z.infer<typeof SourceSchema>;

export function parseEditableTavernSource(json: string): EditableTavernSource {
    const source = SourceSchema.parse(JSON.parse(json));
    if (new Set(source.prompts.map(prompt => prompt.identifier)).size !== source.prompts.length) throw new Error("条目标识重复。");
    const orders = source.prompt_order.filter(order => order.character_id === 100001);
    if (orders.length !== 1) throw new Error("需要唯一的全局提示词顺序（100001）。");
    const ids = orders[0]!.order.map(entry => entry.identifier);
    if (new Set(ids).size !== ids.length) throw new Error("顺序中的条目标识重复。");
    if (ids.some(id => !source.prompts.some(prompt => prompt.identifier === id))) throw new Error("顺序引用了不存在的条目。");
    return source;
}

export function tavernEditorOrder(source: EditableTavernSource) {
    return source.prompt_order.find(order => order.character_id === 100001)!.order;
}

/** One ownership path per writer section prevents direct prompts and variable mappings sending duplicate facts. */
export function changeWriterSectionMode(preset: TavernWriterPreset, purposeId: string, sectionId: string, mode: "prompt" | "mapping", identifier: string): TavernWriterPreset {
    if (!preset.writerMappings) throw new Error("请先启用写作条目配置");
    const section = writerMappingSections(purposeId).find(section => section.id === sectionId);
    if (!section) throw new Error("未知的写作条目");
    const previous = preset.writerMappings[sectionId];
    if (mode === "prompt" && previous?.kind === "prompt") return preset;
    const source = parseEditableTavernSource(preset.sourceJson);
    if (mode === "prompt") {
        if (source.prompts.some(prompt => prompt.identifier === identifier)) throw new Error("直接条目标识重复");
        const draft = preset.writerDirectDrafts && Object.hasOwn(preset.writerDirectDrafts, sectionId) ? preset.writerDirectDrafts[sectionId] : undefined;
        source.prompts.push({...draft, identifier, name: draft?.name ?? section.name, role: draft?.role ?? section.role, content: draft?.content ?? section.content, marker: false});
        tavernEditorOrder(source).push({identifier, enabled: true});
        return {...preset, sourceJson: JSON.stringify(source, null, 2), writerMappings: {...preset.writerMappings, [sectionId]: {kind: "prompt", name: identifier,
            previousMapping: previous && previous.kind !== "prompt" ? {kind: previous.kind, name: previous.name} : null}}};
    }
    if (previous?.kind !== "prompt") return preset;
    const prompt = source.prompts.find(prompt => prompt.identifier === previous.name);
    const draft = prompt ? TavernWriterDirectDraftSchema.parse({...prompt, role: prompt.role ?? section.role, content: prompt.content ?? "", marker: false}) : undefined;
    const removed = removeTavernPrompts(preset, [previous.name]);
    return {...removed, ...(draft ? {writerDirectDrafts: {...removed.writerDirectDrafts, [sectionId]: draft}} : {}),
        writerMappings: {...removed.writerMappings, [sectionId]: previous.previousMapping === undefined ? createDefaultWriterMappings(purposeId, removed.sourceJson)[sectionId] ?? null : previous.previousMapping}};
}

/** Deletion removes every order reference and marker data, while keeping variable mappings visibly unresolved. */
export function removeTavernPrompts(preset: TavernWriterPreset, identifiers: readonly string[]): TavernWriterPreset {
    const ids = new Set(identifiers), source = parseEditableTavernSource(preset.sourceJson);
    source.prompts = source.prompts.filter(prompt => !ids.has(prompt.identifier));
    for (const order of source.prompt_order) order.order = order.order.filter(entry => !ids.has(entry.identifier));
    const slots = Object.fromEntries(Object.entries(preset.bindings.slots).filter(([id]) => !ids.has(id)));
    const writerMappings = preset.writerMappings === undefined ? undefined : Object.fromEntries(Object.entries(preset.writerMappings)
        .map(([id, target]) => [id, target?.kind === "prompt" && ids.has(target.name) ? null : target]));
    const writerDirectDrafts = preset.writerDirectDrafts === undefined ? undefined : Object.fromEntries(Object.entries(preset.writerDirectDrafts)
        .filter(([id, draft]) => !ids.has(draft.identifier) && !(preset.writerMappings?.[id]?.kind === "prompt" && ids.has(preset.writerMappings[id]!.name))));
    return {...preset, sourceJson: JSON.stringify(source, null, 2), bindings: {...preset.bindings, slots}, ...(writerMappings ? {writerMappings} : {}), ...(writerDirectDrafts ? {writerDirectDrafts} : {})};
}

export function moveTavernPromptGroup(source: EditableTavernSource, identifiers: readonly string[], targetId: string): void {
    const ids = new Set(identifiers), order = tavernEditorOrder(source);
    const targetIndex = order.findIndex(entry => entry.identifier === targetId), firstIndex = order.findIndex(entry => ids.has(entry.identifier));
    if (targetIndex < 0 || firstIndex < 0 || ids.has(targetId)) return;
    const selected = order.filter(entry => ids.has(entry.identifier)), rest = order.filter(entry => !ids.has(entry.identifier));
    const to = rest.findIndex(entry => entry.identifier === targetId) + (firstIndex < targetIndex ? 1 : 0);
    rest.splice(to, 0, ...selected);
    order.splice(0, order.length, ...rest);
}
