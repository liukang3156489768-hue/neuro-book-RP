import {z} from "zod";
import type {ExtractionSourceRef, ExtractionTask, ExtractionUnit} from "nbook/shared/dto/inspiration-extraction-task.dto";
import type {InspirationSourcePrepareResponseDto} from "nbook/shared/dto/inspiration-source.dto";
import type {WorkspaceFileTarget} from "nbook/server/workspace-files/workspace-file-target";
import {prepareInspirationSource} from "../source";
import {ExtractionFatalError, ExtractionTaskError} from "./errors";
import {MaterialParamsSchema, readCharacterCandidates, readEntityIndex, selectedBlocks, selectedCategories} from "./material-data";
import {INDEX_STEP, INTEGRATE_STEP, acceptClassification, executeIntegrateUnit, executeWritingTechniqueIndexUnit, planIndexUnits, planIntegrationUnits} from "./material-consolidate";
import {characterDiscoveryUnitId, executeCharacterDiscoveryUnit, executeExtractUnit, planCharacterExtractionUnits, type SourceBlock} from "./material-extract";
import {createMaterialIntermediate} from "./material-intermediate";
import {executeMaterialNoteIndex} from "./material-note-index";
import {renderSourcePrefix} from "./prompt";
import {registerExtractionPipeline} from "./runtime";
import type {ExtractionPipeline, ExtractionTaskPatch, ExtractionUnitContext, PipelineSettlement, PreparedExtraction} from "./types";

/**
 * 素材提取流水线（`kind: material`）。
 *
 * 流程：角色先按块发现名单，再按角色覆盖率在同一块内分组提取；其他类别按块逐类提取；全部完成后暂停归类，随后追加整合单元。
 * 整合结果由 `material-review-service.ts` 转成待写入清单，用户确认后才写入 `lorebook/`；
 * 流水线本身从不写 `lorebook/`，因此任务取消、失败都不会在作品里留下东西。
 *
 * “不涉及剧情”的限制（写作手法与素材特点除外）只在提示词层面约束，没有程序校验：
 * 判断一段文字是否在讲剧情需要语义理解，程序校验只会制造误判。
 */

export const EXTRACT_STEP = "extract";
export const CHARACTER_DISCOVERY_STEP = "discover";
export const CHARACTER_FOCUSED_STEP = "extract-character";

export const MATERIAL_STEPS = [CHARACTER_DISCOVERY_STEP, EXTRACT_STEP, CHARACTER_FOCUSED_STEP, INTEGRATE_STEP, INDEX_STEP] as const;

/** 任务总览里按块分组展示提取单元，整合单元归到“整合”。 */
export function extractUnitId(block: number, category: string): string {
    return `extract:${block}:${category}`;
}

/**
 * 缓存最近一次读取的来源：同一任务的所有单元读同一份来源，逐单元重读和重新分块没有必要。
 * 只缓存一份并以路径与哈希为键，来源变化后缓存自然失效。
 */
type LoadedSource = Readonly<{path: string; sha256: string; blocks: ReadonlyMap<number, SourceBlock>}>;

function buildBlocks(prepared: InspirationSourcePrepareResponseDto): Map<number, SourceBlock> {
    const blocks = new Map<number, SourceBlock>();
    for (const chunk of prepared.chunks) {
        const paragraphs = prepared.paragraphs.filter(paragraph => paragraph.chunkIndex === chunk.index);
        blocks.set(chunk.index, {
            number: chunk.index,
            range: {firstParagraphId: chunk.firstParagraphId, lastParagraphId: chunk.lastParagraphId},
            prefix: renderSourcePrefix(paragraphs),
        });
    }
    return blocks;
}

function parseParams(params: Readonly<Record<string, unknown>>) {
    const parsed = MaterialParamsSchema.safeParse(params);
    if (!parsed.success) {
        throw new ExtractionTaskError("INVALID_INPUT", `素材提取参数无效：${parsed.error.issues.map(issue => issue.message).join("；")}`);
    }
}

export function createMaterialPipeline(input: Readonly<{target: WorkspaceFileTarget}>): ExtractionPipeline {
    let cached: LoadedSource | null = null;

    async function loadSource(source: ExtractionSourceRef): Promise<LoadedSource> {
        if (cached && cached.path === source.path && cached.sha256 === source.sha256) return cached;
        const prepared = await prepareInspirationSource(input.target.root, source.path);
        if (prepared.source.sha256 !== source.sha256) {
            throw new ExtractionFatalError("source-changed", `作品「${source.path}」的内容已变化，任务无法继续`);
        }
        cached = {path: source.path, sha256: source.sha256, blocks: buildBlocks(prepared)};
        return cached;
    }

    return {
        async prepare({params, source}): Promise<PreparedExtraction> {
            parseParams(params);
            const categories = selectedCategories(params);
            const loaded = await loadSource(source).catch(error => {
                if (error instanceof ExtractionFatalError) throw new ExtractionTaskError("SOURCE_CHANGED", error.message);
                throw error;
            });
            let blocks: number[];
            try {
                blocks = selectedBlocks(params, new Set(loaded.blocks.keys()));
            } catch (error) {
                throw new ExtractionTaskError("INVALID_INPUT", error instanceof Error ? error.message : "素材提取分块选择无效", {cause: error});
            }
            // 角色先完成全书粗读，再进入逐角色阶段；其他类别随后按块顺序处理。
            const discoveryUnits = categories.some(spec => spec.key === "character") ? blocks.map(block => ({
                id: characterDiscoveryUnitId(block), step: CHARACTER_DISCOVERY_STEP,
                label: `第 ${block} 块 · 发现角色`, group: `第 ${block} 块`, data: {block, category: "character"},
            })) : [];
            const extractionUnits = blocks.flatMap(block => categories.filter(spec => spec.key !== "character").map(spec => ({
                id: extractUnitId(block, spec.key), step: EXTRACT_STEP,
                label: `第 ${block} 块 · ${spec.label}`, group: `第 ${block} 块`, data: {block, category: spec.key},
            })));
            const units = [...discoveryUnits, ...extractionUnits];
            if (!units.length) throw new ExtractionTaskError("INVALID_INPUT", "来源没有可提取的内容");
            return {units, state: {
                entities: {}, characterCandidates: [], characterTotalBlocks: blocks.length,
                characterExtractionQueued: !categories.some(spec => spec.key === "character"),
            }};
        },

        readyUnits(task: ExtractionTask): readonly ExtractionUnit[] {
            return task.units.filter(unit => unit.status === "pending");
        },

        async execute(unit: ExtractionUnit, context: ExtractionUnitContext): Promise<ExtractionTaskPatch | void> {
            const store = createMaterialIntermediate(input.target, context.task.id);
            if (unit.step === INTEGRATE_STEP) return executeIntegrateUnit(store, unit, context);
            if (unit.step === INDEX_STEP) {
                if (unit.data.category === "writing-technique") return executeWritingTechniqueIndexUnit(store, unit, context);
                if (unit.data.category === "material-feature") return executeMaterialNoteIndex(store, context.task, "material-feature", context.generate, context.signal);
                throw new Error(`未知的素材索引类别：${unit.data.category}`);
            }
            if (unit.step === CHARACTER_DISCOVERY_STEP) {
                const block = unit.data.block;
                if (typeof block !== "number") throw new Error(`角色发现单元 ${unit.id} 缺少 block`);
                const loaded = await loadSource(context.task.source);
                const sourceBlock = loaded.blocks.get(block);
                if (!sourceBlock) throw new Error(`来源不存在第 ${block} 块`);
                return executeCharacterDiscoveryUnit(context, sourceBlock);
            }
            if (unit.step !== EXTRACT_STEP && unit.step !== CHARACTER_FOCUSED_STEP) throw new Error(`未知的素材提取步骤：${unit.step}`);
            const loaded = await loadSource(context.task.source);
            return executeExtractUnit(store, unit, context, async number => {
                const block = loaded.blocks.get(number);
                if (!block) throw new Error(`来源不存在第 ${number} 块`);
                return block;
            });
        },

        settle(task: ExtractionTask): PipelineSettlement {
            // 后处理单元只追加一次；其后再无可执行单元就是结束，不再回到归类确认。
            if (task.state.integrationQueued === true) return {kind: "finished"};
            if (task.state.characterCandidates !== undefined && task.state.characterExtractionQueued !== true) {
                const candidates = readCharacterCandidates(task.state);
                const appendUnits = planCharacterExtractionUnits(candidates, typeof task.state.characterTotalBlocks === "number" ? task.state.characterTotalBlocks : undefined);
                if (appendUnits.length) return {kind: "continue", patch: {appendUnits, state: {characterExtractionQueued: true}}};
            }
            const hasEntities = Object.values(readEntityIndex(task.state)).some(folders => Object.keys(folders).length > 0);
            if (hasEntities && task.state.classified !== true) {
                return {kind: "awaiting-input", reason: "全部分块已提取，等待确认实体归类"};
            }
            const appendUnits = [...planIntegrationUnits(task), ...planIndexUnits(task)];
            if (!appendUnits.length) return {kind: "finished"};
            return {kind: "continue", patch: {appendUnits, state: {integrationQueued: true, classified: true}}};
        },

        acceptInput(task: ExtractionTask, rawInput: unknown): ExtractionTaskPatch {
            return acceptClassification(task, rawInput);
        },
    };
}

let registered = false;

/**
 * 向提取任务框架注册素材流水线。幂等：路由层与测试都可以调用而不触发“重复注册”。
 * 注册表本身由 `resetExtractionPipelinesForTests` 清空，测试清空后需要重置这里的标记。
 */
export function registerMaterialExtractionPipeline(): void {
    if (registered) return;
    registerExtractionPipeline("material", ({target}) => createMaterialPipeline({target}));
    registered = true;
}

/** 仅供测试：与 `resetExtractionPipelinesForTests` 配套使用。 */
export function resetMaterialPipelineRegistrationForTests(): void {
    registered = false;
}

export type MaterialParams = z.infer<typeof MaterialParamsSchema>;
