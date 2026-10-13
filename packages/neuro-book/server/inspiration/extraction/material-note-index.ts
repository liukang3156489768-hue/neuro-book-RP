import {createHash} from "node:crypto";
import {z} from "zod";
import type {ExtractionTask, ExtractionUnit} from "nbook/shared/dto/inspiration-extraction-task.dto";
import {DocumentDraftSchema, FeatureFileSchema, materialCategorySpec, type MaterialDraftItem} from "./material-data";
import {documentDraftPath, featureFilePrefix} from "./material-extract";
import type {MaterialIntermediate} from "./material-intermediate";
import {MATERIAL_SYSTEM_PROMPT, noteIndexGoal, parseJsonObject} from "./material-prompts";
import type {GenerateRequest, ValidationResult} from "./types";

export const NOTE_INDEX_CATEGORIES = ["writing-technique", "material-feature"] as const;
export type NoteIndexCategory = typeof NOTE_INDEX_CATEGORIES[number];

export function isNoteIndexCategory(category: string): category is NoteIndexCategory {
    return category === "writing-technique" || category === "material-feature";
}

const IndexEntrySchema = z.object({
    key: z.string().regex(/^[0-9a-f]{64}$/u),
    group: z.string().trim().min(1).max(32),
    summary: z.string().trim().min(1).max(160),
    keywords: z.array(z.string().trim().min(1).max(24)).min(1).max(5),
}).strict();

export const MaterialNoteIndexSchema = z.object({
    version: z.literal(1),
    category: z.enum(NOTE_INDEX_CATEGORIES),
    entries: z.array(IndexEntrySchema),
}).strict();
export type MaterialNoteIndex = z.infer<typeof MaterialNoteIndexSchema>;
export type NoteIndexEntry = z.infer<typeof IndexEntrySchema>;

export function materialNoteIndexPath(category: NoteIndexCategory): string {
    return `indexes/${category}.json`;
}

/** 摘要缓存绑定正文；编辑或手动合并后摘要失效，目录改名不影响内容身份。 */
export function noteIndexKey(item: MaterialDraftItem): string {
    const nodes = item.nodes.map(node => ({
        role: node.role,
        entries: node.entries.map(entry => ({block: entry.block, fields: Object.entries(entry.fields).sort(([left], [right]) => left.localeCompare(right))})),
        citations: node.citations,
    }));
    return createHash("sha256").update(JSON.stringify({category: item.category, title: item.title, nodes})).digest("hex");
}

/** 审阅与索引共用成功分块的条目投影，失败单元及取消留下的文件不会被收录。 */
export async function readNoteDrafts(store: MaterialIntermediate, unit: ExtractionUnit): Promise<MaterialDraftItem[] | null> {
    if (unit.step !== "extract" || !isNoteIndexCategory(String(unit.data.category))) return null;
    const block = unit.data.block;
    if (typeof block !== "number" || !Number.isInteger(block) || block < 1) throw new Error(`素材索引单元 ${unit.id} 的块号无效`);
    if (unit.data.category === "writing-technique") {
        const draft = await store.readJson(documentDraftPath("writing-technique", block), DocumentDraftSchema);
        return draft ? draft.entries.map(entry => ({
            category: "writing-technique", title: entry.title, aliases: [],
            nodes: [{role: "main", entries: [{fields: entry.fields, block: draft.block}], citations: entry.citations}],
        })) : null;
    }
    const names = (await store.list("features")).filter(name => name.startsWith(featureFilePrefix(block))).sort((left, right) => left.localeCompare(right, "en", {numeric: true}));
    const drafts: MaterialDraftItem[] = [];
    for (const name of names) {
        const feature = await store.readJson(`features/${name}`, FeatureFileSchema);
        if (!feature) throw new Error(`素材特点草稿缺失：${name}`);
        drafts.push({category: "material-feature", title: feature.title, aliases: [], nodes: [{
            role: "main", entries: [{fields: feature.fields, block: feature.block}], citations: feature.citations,
        }]});
    }
    return drafts;
}

type Generate = <T>(request: GenerateRequest<T>) => Promise<T>;

/** AI 阅读完整字段，只返回检索注释；分批限制输出规模，所有条目均须被覆盖。 */
export async function generateMaterialNoteIndex(input: {
    category: NoteIndexCategory;
    items: readonly MaterialDraftItem[];
    cached?: MaterialNoteIndex | null;
    generate: Generate;
    signal: AbortSignal;
}): Promise<MaterialNoteIndex> {
    const unique = new Map(input.items.map(item => [noteIndexKey(item), item]));
    const entries = new Map((input.cached?.category === input.category ? input.cached.entries : []).map(entry => [entry.key, entry]));
    const missing = [...unique].filter(([key]) => !entries.has(key));
    // 限制每次的条目数和输入体积；单条字段保持完整，不用字符截断掩盖内容丢失。
    const batches: Array<Array<{key: string; title: string; nodes: MaterialDraftItem["nodes"]}>> = [];
    let batch: typeof batches[number] = [];
    let size = 0;
    for (const [key, item] of missing) {
        const entry = {key, title: item.title, nodes: item.nodes};
        const length = JSON.stringify(entry).length;
        if (batch.length && (batch.length >= 24 || size + length > 48_000)) { batches.push(batch); batch = []; size = 0; }
        batch.push(entry);
        size += length;
    }
    if (batch.length) batches.push(batch);
    const label = materialCategorySpec(input.category).label;
    for (const items of batches) {
        input.signal.throwIfAborted();
        const keys = new Set(items.map(item => item.key));
        const annotations = await input.generate({
            purposeId: `extraction.index.${input.category}`,
            system: MATERIAL_SYSTEM_PROMPT,
            prompt: {
                prefix: `【待索引条目】\n${JSON.stringify(items)}`,
                goal: noteIndexGoal(label),
            },
            validate(output): ValidationResult<NoteIndexEntry[]> {
                const parsed = parseJsonObject(output);
                if (!parsed.ok) return parsed;
                const result = z.object({entries: z.array(IndexEntrySchema)}).strict().safeParse(parsed.value);
                if (!result.success) return {ok: false, error: result.error.message};
                const given = new Set(result.data.entries.map(entry => entry.key));
                if (given.size !== keys.size || result.data.entries.length !== keys.size || [...given].some(key => !keys.has(key))) {
                    return {ok: false, error: "索引必须逐条覆盖输入 key，不能遗漏、重复或新增条目"};
                }
                return {ok: true, value: result.data.entries};
            },
        });
        for (const entry of annotations) entries.set(entry.key, entry);
    }
    input.signal.throwIfAborted();
    return MaterialNoteIndexSchema.parse({version: 1, category: input.category, entries: [...unique.keys()].map(key => entries.get(key))});
}

export async function executeMaterialNoteIndex(store: MaterialIntermediate, task: ExtractionTask, category: NoteIndexCategory, generate: Generate, signal: AbortSignal): Promise<void> {
    const items: MaterialDraftItem[] = [];
    for (const unit of task.units) {
        if (unit.step !== "extract" || unit.status !== "done" || unit.data.category !== category) continue;
        signal.throwIfAborted();
        const drafts = await readNoteDrafts(store, unit);
        if (!drafts) throw new Error(`已完成的素材提取单元缺少草稿：${unit.id}`);
        items.push(...drafts);
    }
    const cached = await store.readJson(materialNoteIndexPath(category), MaterialNoteIndexSchema);
    const index = await generateMaterialNoteIndex({category, items, cached, generate, signal});
    await store.commit({write: [{path: materialNoteIndexPath(category), data: index}]});
}
