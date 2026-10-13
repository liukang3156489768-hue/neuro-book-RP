import {randomUUID} from "node:crypto";
import type {MaterialParagraphReference} from "nbook/shared/dto/inspiration-material.dto";
import type {ExtractionTaskPatch, ExtractionUnitContext, NewExtractionUnit, ValidationResult} from "./types";
import type {ExtractionUnit} from "nbook/shared/dto/inspiration-extraction-task.dto";
import {
    CHARACTER_SUBNODE_ROLES, blockFileName, materialCategorySpec, nameKey, readCharacterCandidates, readEntityIndex, recordTemplateOfCategory, recordTemplateOfSubnode, referenceLabel, toFolderName,
    validateExtractedRecord, DocumentDraftSchema, FeatureFileSchema,
    type CharacterCandidate, type EntityFragment, type EntityIndex, type EntityIndexEntry, type MaterialCategorySpec, type ValidatedRecord,
} from "./material-data";
import type {MaterialIntermediate} from "./material-intermediate";
import {ExtractionModelError, ExtractionValidationFailure} from "./errors";
import {
    MATERIAL_SYSTEM_PROMPT, characterDiscoveryGoal, characterFocusedExtractionGoal, characterExtractionTemplate, characterGroupedExtractionGoal, documentExtractionGoal, entityExtractionGoal, parseJsonObject, renderKnownEntities, type DocumentRule,
} from "./material-prompts";
import type {CharacterExtractionTier} from "./material-data";

/**
 * 素材提取的逐块逐类单元：一次调用一个块的一个类别，产出写入任务目录的中间产物。
 * 同一块的各类别提示词共享逐字节相同的前缀（该块原文），差异只在追加材料与任务目标。
 */

/** 来源的一个分块：渲染好的提示词前缀与块内 P 编号范围。 */
export type SourceBlock = Readonly<{
    number: number;
    range: MaterialParagraphReference;
    prefix: string;
}>;

export function characterDiscoveryUnitId(block: number): string {
    return `discover:character:${block}`;
}

export function characterFocusedUnitId(folderKey: string, block: number): string {
    return `extract:character:${folderKey}:${block}`;
}

export function characterGroupedUnitId(tier: CharacterExtractionTier, folderKeys: readonly string[], block: number): string {
    return `extract:characters:${tier}:${folderKeys.join("+")}:${block}`;
}

export function entityFragmentPath(category: string, folderKey: string, block: number): string {
    return `entities/${category}/${folderKey}/${blockFileName(block)}`;
}

export function subnodeFragmentPath(folderKey: string, role: typeof CHARACTER_SUBNODE_ROLES[number], block: number): string {
    return `entities/character/${folderKey}/${role}/${blockFileName(block)}`;
}

export function documentDraftPath(category: string, block: number): string {
    return `documents/${category}/${blockFileName(block)}`;
}

export function featureFilePrefix(block: number): string {
    return `block-${String(block).padStart(3, "0")}-`;
}

export function featureFilePath(block: number, index: number): string {
    return `features/${featureFilePrefix(block)}${index}.json`;
}

export function documentRule(spec: MaterialCategorySpec): DocumentRule {
    switch (spec.key) {
        case "writing-technique": return {maxEntries: 8, titleField: "手法名称"};
        case "material-feature": return {maxEntries: 12, titleField: "名称"};
        default: return {maxEntries: 1, titleField: null};
    }
}

// ---------------------------------------------------------------------------
// 实体类
// ---------------------------------------------------------------------------

export type ResolvedEntity = Readonly<{
    folderKey: string;
    name: string;
    aliases: string[];
    persona: ValidatedRecord;
    subnodes: Readonly<Record<typeof CHARACTER_SUBNODE_ROLES[number], ValidatedRecord[]>>;
}>;

function findExisting(index: Readonly<Record<string, EntityIndexEntry>>, name: string): string | null {
    const key = nameKey(name);
    for (const [folderKey, entry] of Object.entries(index)) {
        if (nameKey(entry.name) === key || entry.aliases.some(alias => nameKey(alias) === key)) return folderKey;
    }
    return null;
}

function uniqueFolderKey(base: string, taken: ReadonlySet<string>): string {
    let candidate = base;
    for (let suffix = 2; taken.has(candidate.toLowerCase()); suffix += 1) candidate = `${base}-${suffix}`;
    return candidate;
}

function newCharacterId(taken: ReadonlySet<string>): string {
    let id = randomUUID();
    while (taken.has(id.toLowerCase())) id = randomUUID();
    return id;
}

function readStringList(value: unknown): string[] | null {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.some(item => typeof item !== "string")) return null;
    return (value as string[]).map(item => item.trim()).filter(Boolean);
}

type CharacterDiscovery = Readonly<{name: string; aliases: string[]}>;

function validateCharacterDiscovery(output: string): ValidationResult<CharacterDiscovery[]> {
    const parsed = parseJsonObject(output);
    if (!parsed.ok) return parsed;
    const list = parsed.value.candidates;
    if (!Array.isArray(list)) return {ok: false, error: "产出必须包含数组字段 candidates（没有角色时为空数组）"};
    const result: CharacterDiscovery[] = [];
    const errors: string[] = [];
    for (const [position, item] of list.entries()) {
        const label = `第 ${position + 1} 个角色候选`;
        if (typeof item !== "object" || item === null || Array.isArray(item)) { errors.push(`${label}必须是对象`); continue; }
        const raw = item as Record<string, unknown>;
        const name = typeof raw.name === "string" ? raw.name.trim() : "";
        if (!name || !toFolderName(name)) { errors.push(`${label}缺少有效的 name`); continue; }
        const aliases = readStringList(raw.aliases);
        if (!aliases) { errors.push(`${label}“${name}”的 aliases 必须是文本数组`); continue; }
        // 发现阶段只保存名单；引用由第二阶段的完整提取重新校验，避免粗读输出因引用格式阻塞整个角色队列。
        result.push({name, aliases: aliases.filter(alias => nameKey(alias) !== nameKey(name))});
    }
    return errors.length ? {ok: false, error: errors.join("\n")} : {ok: true, value: result};
}

function applyCharacterDiscovery(state: Readonly<Record<string, unknown>>, block: number, discoveries: readonly CharacterDiscovery[]): CharacterCandidate[] {
    // 保留本轮重做前的候选身份，即使该候选只在当前块出现；否则重试会随机生成新 ID，
    // 使已排队的逐角色单元和审阅引用失去稳定指向。
    const previous = readCharacterCandidates(state).map(candidate => ({...candidate, blocks: candidate.blocks.filter(item => item !== block)}));
    const taken = new Set(previous.map(candidate => candidate.folderKey.toLowerCase()));
    const stableIds = new Set(previous.flatMap(candidate => candidate.stableId ? [candidate.stableId.toLowerCase()] : []));
    const result = [...previous];
    for (const discovery of discoveries) {
        const named = result.find(candidate => nameKey(candidate.name) === nameKey(discovery.name));
        const aliasMatches = result.filter(candidate => candidate.aliases.some(alias => nameKey(alias) === nameKey(discovery.name))
            || discovery.aliases.some(alias => nameKey(alias) === nameKey(candidate.name)));
        const existing = named ?? (aliasMatches.length === 1 ? aliasMatches[0] : undefined);
        if (existing) {
            // 历史任务可能没有 stableId；补齐后后续重试仍指向同一角色目录。
            if (!existing.stableId) {
                existing.stableId = newCharacterId(stableIds);
                stableIds.add(existing.stableId.toLowerCase());
            }
            existing.aliases = mergeAliases(existing.aliases, discovery.aliases, [discovery.name]).filter(alias => nameKey(alias) !== nameKey(existing.name));
            existing.blocks = [...new Set([...existing.blocks, block])].sort((left, right) => left - right);
            continue;
        }
        // folderKey 是任务中间产物的可读名称键；stableId 才是最终 lorebook 目录的稳定身份。
        const base = toFolderName(discovery.name)!;
        const folderKey = uniqueFolderKey(base, taken);
        taken.add(folderKey.toLowerCase());
        const stableId = newCharacterId(stableIds);
        stableIds.add(stableId.toLowerCase());
        result.push({folderKey, stableId, name: discovery.name, aliases: mergeAliases(discovery.aliases), blocks: [block]});
    }
    return result.filter(candidate => candidate.blocks.length > 0);
}

/** 第一阶段：只登记角色候选，不创建可整合的实体片段。 */
export async function executeCharacterDiscoveryUnit(context: ExtractionUnitContext, block: SourceBlock): Promise<ExtractionTaskPatch> {
    const discoveries = await context.generate({
        purposeId: "extraction.character.discovery",
        metadata: {block: block.number},
        variables: {range: referenceLabel(block.range)},
        system: MATERIAL_SYSTEM_PROMPT,
        prompt: {prefix: block.prefix, goal: characterDiscoveryGoal(block.range)},
        validate: output => validateCharacterDiscovery(output),
    });
    context.signal.throwIfAborted();
    const characterCandidates = applyCharacterDiscovery(context.task.state, block.number, discoveries);
    // 发现单元可能在归类暂停后被单独重试：给新发现的角色补排工作，已有单元保留结果与状态。
    const appendUnits = context.task.state.characterExtractionQueued === true
        ? planCharacterExtractionUnits(characterCandidates, typeof context.task.state.characterTotalBlocks === "number" ? context.task.state.characterTotalBlocks : undefined, context.task.units)
        : [];
    return {state: {characterCandidates}, appendUnits};
}

export function characterExtractionTier(candidate: CharacterCandidate, totalBlocks: number): CharacterExtractionTier {
    const coverage = totalBlocks > 0 ? candidate.blocks.length / totalBlocks : 0;
    if (candidate.blocks.length >= 8 || coverage >= 0.4) return "primary";
    if (candidate.blocks.length >= 3) return "secondary";
    return "tertiary";
}

export function planCharacterExtractionUnits(candidates: readonly CharacterCandidate[], totalBlocks = Math.max(1, ...candidates.flatMap(candidate => candidate.blocks)), existingUnits: readonly ExtractionUnit[] = []): NewExtractionUnit[] {
    const byBlock = new Map<number, Array<{candidate: CharacterCandidate; tier: CharacterExtractionTier}>>();
    const assigned = new Map<number, Set<string>>();
    for (const unit of existingUnits) {
        if (unit.step !== "extract-character" || typeof unit.data.block !== "number") continue;
        const keys = Array.isArray(unit.data.folderKeys) ? unit.data.folderKeys : [unit.data.folderKey];
        const blockKeys = assigned.get(unit.data.block) ?? new Set<string>();
        for (const key of keys) if (typeof key === "string") blockKeys.add(key);
        assigned.set(unit.data.block, blockKeys);
    }
    for (const candidate of candidates) {
        const tier = characterExtractionTier(candidate, totalBlocks);
        for (const block of candidate.blocks) {
            // 发现阶段重试可能改变等级和组员；已排队的角色块继续由原单元拥有。
            if (assigned.get(block)?.has(candidate.folderKey)) continue;
            const list = byBlock.get(block) ?? [];
            list.push({candidate, tier});
            byBlock.set(block, list);
        }
    }
    const tierOrder: CharacterExtractionTier[] = ["primary", "secondary", "tertiary"];
    const groupSize: Record<CharacterExtractionTier, number> = {primary: 1, secondary: 2, tertiary: 3};
    return [...byBlock.entries()].sort((left, right) => left[0] - right[0]).flatMap(([block, entries]) => tierOrder.flatMap(tier => {
        // 单元 ID 会持久化；按键值排序，不依赖系统区域或 ICU 版本。
        const selected = entries.filter(entry => entry.tier === tier).sort((left, right) => compareStableKeys(left.candidate.folderKey, right.candidate.folderKey));
        const size = groupSize[tier];
        const units: NewExtractionUnit[] = [];
        for (let offset = 0; offset < selected.length; offset += size) {
            const group = selected.slice(offset, offset + size).map(entry => entry.candidate);
            const folderKeys = group.map(candidate => candidate.folderKey);
            units.push({
                id: group.length === 1 ? characterFocusedUnitId(folderKeys[0]!, block) : characterGroupedUnitId(tier, folderKeys, block), step: "extract-character",
                label: `提取角色：${group.map(candidate => candidate.name).join("、")} · 第 ${block} 块`, group: "角色提取",
                data: {block, category: "character", folderKeys, tier, characterNames: group.map(candidate => candidate.name), ...(group.length === 1 ? {folderKey: folderKeys[0]} : {})},
            });
        }
        return units;
    }));
}

function compareStableKeys(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * 解析并校验一个实体类调用的产出。名称先与已有文件夹的名称和别称比对（忽略大小写）：
 * 命中则并入该文件夹，否则新建；同一次产出里两条解析到同一文件夹视为模型把一个对象写了两遍，报错让其合并。
 */
export function validateEntityOutput(spec: MaterialCategorySpec, range: MaterialParagraphReference, existing: Readonly<Record<string, EntityIndexEntry>>, output: string, allowEmptyFields = false): ValidationResult<ResolvedEntity[]> {
    const parsed = parseJsonObject(output);
    if (!parsed.ok) return parsed;
    const list = parsed.value.entities;
    if (!Array.isArray(list)) return {ok: false, error: "产出必须包含数组字段 entities（没有条目时为空数组）"};
    const errors: string[] = [];
    const resolved: ResolvedEntity[] = [];
    const taken = new Set(Object.keys(existing).map(key => key.toLowerCase()));
    const usedFolders = new Map<string, string>();
    const template = recordTemplateOfCategory(spec);
    for (const [position, item] of list.entries()) {
        const label = `第 ${position + 1} 个${spec.label}`;
        if (typeof item !== "object" || item === null || Array.isArray(item)) { errors.push(`${label}必须是对象`); continue; }
        const raw = item as Record<string, unknown>;
        const name = typeof raw.name === "string" ? raw.name.trim() : "";
        const baseKey = name ? toFolderName(name) : null;
        if (!name || !baseKey) { errors.push(`${label}缺少有效的 name（不能为空，也不能只含特殊符号）`); continue; }
        const aliases = readStringList(raw.aliases);
        if (!aliases) { errors.push(`${label}“${name}”的 aliases 必须是文本数组`); continue; }
        const prefix = `${label}“${name}”：`;
        const problems: string[] = [];
        const subnodes = {experience: [] as ValidatedRecord[], relationship: [] as ValidatedRecord[]};
        if (spec.key === "character") {
            for (const role of CHARACTER_SUBNODE_ROLES) {
                const key = role === "experience" ? "experiences" : "relationships";
                const entries = raw[key];
                if (entries === undefined || entries === null) continue;
                if (!Array.isArray(entries)) { problems.push(`${key} 必须是数组`); continue; }
                for (const [entryPosition, entry] of entries.entries()) {
                    const result = validateExtractedRecord(recordTemplateOfSubnode(role), entry, {range});
                    if (result.record) subnodes[role].push(result.record);
                    else problems.push(...result.errors.map(error => `${key} 第 ${entryPosition + 1} 条：${error}`));
                }
            }
        }
        const hasSubnodes = subnodes.experience.length + subnodes.relationship.length > 0;
        const persona = validateExtractedRecord(template, raw.fields ?? {}, {range, rawReferences: raw.references, allowEmptyFields: hasSubnodes || allowEmptyFields});
        if (persona.record === null) problems.push(...persona.errors);
        if (problems.length || persona.record === null) { errors.push(...problems.map(problem => `${prefix}${problem}`)); continue; }

        const folderKey = findExisting(existing, name) ?? uniqueFolderKey(baseKey, taken);
        const canonical = existing[folderKey]?.name ?? name;
        const earlier = usedFolders.get(folderKey);
        if (earlier !== undefined) { errors.push(`${prefix}与“${earlier}”是同一个${spec.label}，请合并为一条`); continue; }
        usedFolders.set(folderKey, name);
        taken.add(folderKey.toLowerCase());
        resolved.push({
            folderKey, name: canonical,
            aliases: aliases.filter(alias => nameKey(alias) !== nameKey(canonical)),
            persona: persona.record, subnodes,
        });
    }
    return errors.length ? {ok: false, error: errors.join("\n")} : {ok: true, value: resolved};
}

export function validateGroupedCharacterOutput(
    spec: MaterialCategorySpec,
    candidates: readonly CharacterCandidate[],
    range: MaterialParagraphReference,
    output: string,
): ValidationResult<ResolvedEntity[]> {
    const batch = validateCharacterBatch(spec, candidates, range, output);
    if (!batch.ok) return batch;
    return batch.value.failed.length
        ? {ok: false, error: batch.value.failed.map(item => item.error).join("\n")}
        : {ok: true, value: batch.value.entities};
}

type CharacterBatch = {entities: ResolvedEntity[]; failed: Array<{candidate: CharacterCandidate; error: string}>};

/** 集合不完整时整组修复；集合完整后逐角色校验，坏条目不能使有效条目丢失。 */
function validateCharacterBatch(
    spec: MaterialCategorySpec, candidates: readonly CharacterCandidate[], range: MaterialParagraphReference, output: string,
): ValidationResult<CharacterBatch> {
    const parsed = parseJsonObject(output);
    if (!parsed.ok) return parsed;
    if (!Array.isArray(parsed.value.entities)) return {ok: false, error: "产出必须包含数组字段 entities"};
    const existing = Object.fromEntries(candidates.map(candidate => [candidate.folderKey, candidate]));
    const byKey = new Map(candidates.map(candidate => [candidate.folderKey, candidate]));
    const items: Array<{candidate: CharacterCandidate; raw: Record<string, unknown>}> = [];
    const seen = new Set<string>();
    for (const raw of parsed.value.entities) {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw) || typeof raw.name !== "string") return {ok: false, error: "每个角色必须是带 name 的对象"};
        const key = candidates.find(candidate => nameKey(candidate.name) === nameKey(raw.name))?.folderKey ?? findExisting(existing, raw.name);
        const candidate = key ? byKey.get(key) : undefined;
        if (!candidate) return {ok: false, error: `产出了未请求的角色：${raw.name}`};
        if (seen.has(candidate.folderKey)) return {ok: false, error: `角色“${candidate.name}”重复输出`};
        seen.add(candidate.folderKey);
        items.push({candidate, raw});
    }
    const missing = candidates.filter(candidate => !seen.has(candidate.folderKey));
    if (missing.length) return {ok: false, error: `缺少角色：${missing.map(candidate => candidate.name).join("、")}`};
    const entities: ResolvedEntity[] = [];
    const failed: CharacterBatch["failed"] = [];
    for (const {candidate, raw} of items) {
        const resolved = validateEntityOutput(spec, range, {[candidate.folderKey]: candidate}, JSON.stringify({entities: [raw]}), true);
        if (!resolved.ok) { failed.push({candidate, error: resolved.error}); continue; }
        const entity = resolved.value[0]!;
        entities.push({...entity, name: candidate.name, aliases: mergeAliases(candidate.aliases, entity.aliases).filter(alias => nameKey(alias) !== nameKey(candidate.name))});
    }
    return {ok: true, value: {entities, failed}};
}

async function executeGroupedCharacterUnit(
    store: MaterialIntermediate,
    unit: ExtractionUnit,
    context: ExtractionUnitContext,
    block: SourceBlock,
): Promise<ExtractionTaskPatch> {
    const rawKeys = unit.data.folderKeys;
    const folderKeys = Array.isArray(rawKeys) && rawKeys.every((key): key is string => typeof key === "string" && Boolean(key)) ? rawKeys : null;
    if (!folderKeys || folderKeys.length < 2 || new Set(folderKeys).size !== folderKeys.length) {
        throw new Error(`角色分组提取单元 ${unit.id} 缺少有效 folderKeys`);
    }
    const candidateByKey = new Map(readCharacterCandidates(context.task.state).map(candidate => [candidate.folderKey, candidate]));
    const candidates = folderKeys.flatMap(key => {
        const candidate = candidateByKey.get(key);
        return candidate?.blocks.includes(block.number) ? [candidate] : [];
    });
    if (candidates.length !== folderKeys.length) throw new Error(`角色分组提取单元 ${unit.id} 引用了不存在的角色候选`);
    const spec = materialCategorySpec("character");
    const index: EntityIndex = readEntityIndex(context.task.state);
    const existing = index.character ?? {};
    const generate = () => context.generate({
        purposeId: "extraction.character.grouped",
        metadata: {block: block.number, characterKeys: candidates.map(candidate => candidate.folderKey), tier: typeof unit.data.tier === "string" ? unit.data.tier : undefined},
        variables: {
            range: referenceLabel(block.range),
            characterTargets: candidates.map(candidate => candidate.aliases.length ? `${candidate.name}（别名：${candidate.aliases.join("、")}）` : candidate.name).join("、"),
            characterOutputExample: JSON.stringify({entities: candidates.map(candidate => ({name: candidate.name, aliases: [], fields: {}, references: "", experiences: [], relationships: []}))}),
        },
        system: MATERIAL_SYSTEM_PROMPT,
        prompt: {
            prefix: block.prefix,
            supplements: [characterExtractionTemplate(spec, block.range)],
            goal: characterGroupedExtractionGoal(spec, candidates, block.range),
        },
        validate: output => validateCharacterBatch(spec, candidates, block.range, output),
    });
    let batch: CharacterBatch;
    try {
        batch = await generate();
    } catch (error) {
        context.signal.throwIfAborted();
        // 网络、配置、来源和文件错误不能靠拆组修复，保持原有任务失败语义。
        if (!(error instanceof ExtractionValidationFailure) && !(error instanceof ExtractionModelError && error.stopReason === "length")) throw error;
        batch = {entities: [], failed: candidates.map(candidate => ({candidate, error: error.message}))};
    }
    const {entities} = batch;
    const targetKeys = new Set(entities.map(entity => entity.folderKey));
    const remove: string[] = [];
    for (const folderKey of targetKeys) {
        remove.push(entityFragmentPath("character", folderKey, block.number));
        for (const role of CHARACTER_SUBNODE_ROLES) remove.push(subnodeFragmentPath(folderKey, role, block.number));
    }
    const write: Array<{path: string; data: unknown}> = [];
    const populated = entities.filter(entity => Object.values(entity.persona.fields).some(value => value.trim()) || CHARACTER_SUBNODE_ROLES.some(role => entity.subnodes[role].length));
    for (const entity of populated) {
        write.push({path: entityFragmentPath("character", entity.folderKey, block.number), data: {
            block: block.number, name: entity.name, aliases: entity.aliases, fields: entity.persona.fields, citations: entity.persona.citations,
        }});
        for (const role of CHARACTER_SUBNODE_ROLES) if (entity.subnodes[role].length) {
            write.push({path: subnodeFragmentPath(entity.folderKey, role, block.number), data: {block: block.number, entries: entity.subnodes[role]}});
        }
    }
    context.signal.throwIfAborted();
    await store.commit({remove, write});
    const next: Record<string, EntityIndexEntry> = {};
    for (const [key, entry] of Object.entries(existing)) {
        const blocks = targetKeys.has(key) ? entry.blocks.filter(item => item !== block.number) : entry.blocks;
        if (blocks.length > 0) next[key] = {...entry, blocks};
    }
    for (const entity of populated) {
        const current = next[entity.folderKey];
        const candidate = candidates.find(candidate => candidate.folderKey === entity.folderKey)!;
        next[entity.folderKey] = {
            name: entity.name, aliases: mergeAliases(current?.aliases ?? [], entity.aliases),
            blocks: [...new Set([...(current?.blocks ?? []), block.number])].sort((left, right) => left - right),
            ...(candidate.stableId ? {stableId: candidate.stableId} : {}),
        };
    }
    return {
        state: {entities: {...index, character: next}},
        appendUnits: batch.failed.map(({candidate, error}) => ({
            id: characterFocusedUnitId(candidate.folderKey, block.number), step: "extract-character",
            label: `补提取角色：${candidate.name} · 第 ${block.number} 块`, group: "角色提取",
            data: {block: block.number, category: "character", folderKey: candidate.folderKey, parentUnitId: unit.id, groupError: error, tier: unit.data.tier ?? "single"},
        })).filter(child => !context.task.units.some(known => known.id === child.id)),
    };
}

function mergeAliases(...lists: ReadonlyArray<readonly string[]>): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const alias of lists.flat()) {
        const key = nameKey(alias);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(alias);
    }
    return result;
}

/** 本块的贡献从索引中撤销后再加入新结果；块号保持升序，空文件夹最后统一丢弃。 */
export function applyBlockToIndex(index: Readonly<Record<string, EntityIndexEntry>>, block: number, entities: readonly ResolvedEntity[]): Record<string, EntityIndexEntry> {
    const next: Record<string, EntityIndexEntry> = Object.fromEntries(Object.entries(index).map(([key, entry]) => [key, {...entry, blocks: entry.blocks.filter(item => item !== block)}]));
    for (const entity of entities) {
        const current = next[entity.folderKey];
        next[entity.folderKey] = {
            name: entity.name,
            aliases: mergeAliases(current?.aliases ?? [], entity.aliases),
            blocks: [...(current?.blocks ?? []), block].sort((left, right) => left - right),
        };
    }
    return Object.fromEntries(Object.entries(next).filter(([, entry]) => entry.blocks.length > 0));
}

async function executeEntityUnit(store: MaterialIntermediate, unit: ExtractionUnit, context: ExtractionUnitContext, spec: MaterialCategorySpec, block: SourceBlock): Promise<ExtractionTaskPatch> {
    const index: EntityIndex = readEntityIndex(context.task.state);
    const existing = index[spec.key] ?? {};
    const entities = await context.generate({
        purposeId: `extraction.extract.${spec.key}`,
        metadata: {block: block.number},
        variables: {range: referenceLabel(block.range)},
        system: MATERIAL_SYSTEM_PROMPT,
        prompt: {
            prefix: block.prefix,
            // 名单只给实体类调用；它在原文之后，不影响同块各类别共享的前缀。
            supplements: [renderKnownEntities(spec, Object.values(existing))],
            goal: entityExtractionGoal(spec, block.range),
        },
        validate: output => validateEntityOutput(spec, block.range, existing, output),
    });

    // 幂等：先清掉磁盘上本块在所有文件夹里的旧片段（含取消时遗留、索引未记录的），再整体写入新片段。
    const remove: string[] = [];
    for (const folderKey of await store.list(`entities/${spec.key}`)) {
        remove.push(entityFragmentPath(spec.key, folderKey, block.number));
        if (spec.key === "character") for (const role of CHARACTER_SUBNODE_ROLES) remove.push(subnodeFragmentPath(folderKey, role, block.number));
    }
    const write: Array<{path: string; data: unknown}> = [];
    for (const entity of entities) {
        const fragment: EntityFragment = {block: block.number, name: entity.name, aliases: entity.aliases, fields: entity.persona.fields, citations: entity.persona.citations};
        write.push({path: entityFragmentPath(spec.key, entity.folderKey, block.number), data: fragment});
        for (const role of CHARACTER_SUBNODE_ROLES) {
            if (!entity.subnodes[role].length) continue;
            write.push({path: subnodeFragmentPath(entity.folderKey, role, block.number), data: {block: block.number, entries: entity.subnodes[role]}});
        }
    }
    context.signal.throwIfAborted();
    await store.commit({remove, write});
    return {state: {entities: {...index, [spec.key]: applyBlockToIndex(existing, block.number, entities)}}};
}

function validateFocusedCharacterOutput(
    spec: MaterialCategorySpec,
    candidate: CharacterCandidate,
    range: MaterialParagraphReference,
    output: string,
): ValidationResult<ResolvedEntity | null> {
    const parsed = parseJsonObject(output);
    if (!parsed.ok) return parsed;
    const raw = parsed.value.entity;
    if (raw === null) return {ok: true, value: null};
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {ok: false, error: "产出必须包含对象字段 entity"};
    const resolved = validateEntityOutput(spec, range, {
        [candidate.folderKey]: {name: candidate.name, aliases: candidate.aliases, blocks: candidate.blocks},
    }, JSON.stringify({entities: [raw]}));
    if (!resolved.ok) return resolved;
    const entity = resolved.value[0];
    if (!entity) return {ok: false, error: "entity 不能为空"};
    if (entity.folderKey !== candidate.folderKey) return {ok: false, error: `产出的角色必须是“${candidate.name}”，不能改成其他角色`};
    return {ok: true, value: {
        ...entity,
        name: candidate.name,
        aliases: mergeAliases(candidate.aliases, entity.aliases).filter(alias => nameKey(alias) !== nameKey(candidate.name)),
        folderKey: candidate.folderKey,
    }};
}

/** 第二阶段：单人组一次调用，写入角色级中间片段；多角色组由 executeGroupedCharacterUnit 处理。 */
export async function executeFocusedCharacterUnit(
    store: MaterialIntermediate,
    unit: ExtractionUnit,
    context: ExtractionUnitContext,
    block: SourceBlock,
): Promise<ExtractionTaskPatch> {
    const dataFolder = unit.data.folderKey;
    if (typeof dataFolder !== "string" || !dataFolder) throw new Error(`角色提取单元 ${unit.id} 缺少 folderKey`);
    const candidates = readCharacterCandidates(context.task.state);
    const candidate = candidates.find(item => item.folderKey === dataFolder && item.blocks.includes(block.number));
    if (!candidate) throw new Error(`角色提取单元 ${unit.id} 引用了不存在的角色候选`);
    const index: EntityIndex = readEntityIndex(context.task.state);
    const existing = index.character ?? {};
    const entity = await context.generate({
        purposeId: "extraction.character.focused",
        metadata: {block: block.number, characterKeys: [candidate.folderKey], tier: typeof unit.data.tier === "string" ? unit.data.tier : "single"},
        variables: {
            range: referenceLabel(block.range), characterName: candidate.name,
            characterNameJson: JSON.stringify(candidate.name),
            aliasesRule: candidate.aliases.length ? `- 该角色已知别称：${candidate.aliases.join("、")}。命中这些称呼时仍写同一个 name。` : "",
        },
        system: MATERIAL_SYSTEM_PROMPT,
        prompt: {
            prefix: block.prefix,
            supplements: [characterExtractionTemplate(materialCategorySpec("character"), block.range), renderKnownEntities(materialCategorySpec("character"), [{name: candidate.name, aliases: candidate.aliases}])],
            goal: characterFocusedExtractionGoal(materialCategorySpec("character"), candidate.name, candidate.aliases, block.range),
        },
        validate: output => validateFocusedCharacterOutput(materialCategorySpec("character"), candidate, block.range, output),
    });
    const remove = [entityFragmentPath("character", candidate.folderKey, block.number),
        ...CHARACTER_SUBNODE_ROLES.map(role => subnodeFragmentPath(candidate.folderKey, role, block.number))];
    if (!entity) {
        context.signal.throwIfAborted();
        await store.commit({remove});
        const next = {...existing};
        const previous = next[candidate.folderKey];
        if (previous) {
            const blocks = previous.blocks.filter(number => number !== block.number);
            if (blocks.length) next[candidate.folderKey] = {...previous, blocks};
            else delete next[candidate.folderKey];
        }
        return {state: {entities: {...index, character: next}}};
    }
    const fragment: EntityFragment = {block: block.number, name: entity.name, aliases: entity.aliases, fields: entity.persona.fields, citations: entity.persona.citations};
    const write: Array<{path: string; data: unknown}> = [{path: entityFragmentPath("character", candidate.folderKey, block.number), data: fragment}];
    for (const role of CHARACTER_SUBNODE_ROLES) {
        if (!entity.subnodes[role].length) continue;
        write.push({path: subnodeFragmentPath(candidate.folderKey, role, block.number), data: {block: block.number, entries: entity.subnodes[role]}});
    }
    context.signal.throwIfAborted();
    await store.commit({remove, write});
    return {state: {
        entities: {...index, character: {
            ...existing,
            [candidate.folderKey]: {
                name: entity.name,
                aliases: mergeAliases(existing[candidate.folderKey]?.aliases ?? [], entity.aliases),
                blocks: [...new Set([...(existing[candidate.folderKey]?.blocks ?? []), block.number])].sort((left, right) => left - right),
                ...(candidate.stableId ? {stableId: candidate.stableId} : {}),
            },
        }},
    }};
}

// ---------------------------------------------------------------------------
// 文档类与逐条类
// ---------------------------------------------------------------------------

export type DraftEntry = Readonly<{title: string; fields: Record<string, string>; citations: MaterialParagraphReference[]}>;

/** 文档类与逐条类共用的产出校验；标题取自标题字段，没有标题字段的类别（文风、世界观）在整合时再命名。 */
export function validateEntriesOutput(spec: MaterialCategorySpec, range: MaterialParagraphReference, rule: DocumentRule, output: string): ValidationResult<DraftEntry[]> {
    const parsed = parseJsonObject(output);
    if (!parsed.ok) return parsed;
    const list = parsed.value.entries;
    if (!Array.isArray(list)) return {ok: false, error: "产出必须包含数组字段 entries（没有内容时为空数组）"};
    if (list.length > rule.maxEntries) return {ok: false, error: `entries 最多 ${rule.maxEntries} 条，实际 ${list.length} 条，请合并或取舍`};
    const errors: string[] = [];
    const entries: DraftEntry[] = [];
    for (const [position, item] of list.entries()) {
        const label = `第 ${position + 1} 条${spec.label}`;
        if (typeof item !== "object" || item === null || Array.isArray(item)) { errors.push(`${label}必须是对象`); continue; }
        const raw = item as Record<string, unknown>;
        const result = validateExtractedRecord(recordTemplateOfCategory(spec), raw.fields ?? {}, {range, rawReferences: raw.references});
        if (!result.record) { errors.push(...result.errors.map(error => `${label}：${error}`)); continue; }
        const title = rule.titleField ? result.record.fields[rule.titleField] : spec.label;
        if (!title) { errors.push(`${label}：“${rule.titleField}”必须填写`); continue; }
        entries.push({title, fields: result.record.fields, citations: result.record.citations});
    }
    return errors.length ? {ok: false, error: errors.join("\n")} : {ok: true, value: entries};
}

async function executeEntriesUnit(store: MaterialIntermediate, context: ExtractionUnitContext, spec: MaterialCategorySpec, block: SourceBlock): Promise<void> {
    const rule = documentRule(spec);
    const entries = await context.generate({
        purposeId: `extraction.extract.${spec.key}`,
        metadata: {block: block.number},
        variables: {range: referenceLabel(block.range)},
        system: MATERIAL_SYSTEM_PROMPT,
        prompt: {prefix: block.prefix, goal: documentExtractionGoal(spec, block.range, rule)},
        validate: output => validateEntriesOutput(spec, block.range, rule, output),
    });
    context.signal.throwIfAborted();
    if (spec.mode === "itemized") {
        const stale = (await store.list("features")).filter(name => name.startsWith(featureFilePrefix(block.number)));
        await store.commit({
            remove: stale.map(name => `features/${name}`),
            write: entries.map((entry, position) => ({
                path: featureFilePath(block.number, position + 1),
                data: FeatureFileSchema.parse({block: block.number, index: position + 1, ...entry}),
            })),
        });
        return;
    }
    // 同一路径整体覆盖，重做时不会留下重复片段。
    await store.commit({write: [{path: documentDraftPath(spec.key, block.number), data: DocumentDraftSchema.parse({block: block.number, entries})}]});
}

/** 单元数据：块号与类别由 `prepare` 写入，这里重新校验而不是信任。 */
export function readExtractUnitData(unit: ExtractionUnit): {block: number; category: MaterialCategorySpec} {
    const block = unit.data.block;
    const category = unit.data.category;
    if (typeof block !== "number" || !Number.isInteger(block) || block < 1 || typeof category !== "string") {
        throw new Error(`素材提取单元 ${unit.id} 的数据无效`);
    }
    return {block, category: materialCategorySpec(category)};
}

export async function executeExtractUnit(store: MaterialIntermediate, unit: ExtractionUnit, context: ExtractionUnitContext, loadBlock: (block: number) => Promise<SourceBlock>): Promise<ExtractionTaskPatch | void> {
    const {block: number, category: spec} = readExtractUnitData(unit);
    const block = await loadBlock(number);
    if (spec.key === "character" && Array.isArray(unit.data.folderKeys) && unit.data.folderKeys.length > 1) {
        return executeGroupedCharacterUnit(store, unit, context, block);
    }
    if (spec.key === "character" && typeof unit.data.folderKey === "string") {
        return executeFocusedCharacterUnit(store, unit, context, block);
    }
    if (spec.mode === "entity") return executeEntityUnit(store, unit, context, spec, block);
    await executeEntriesUnit(store, context, spec, block);
}
