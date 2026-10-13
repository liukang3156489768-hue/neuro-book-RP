import {
    OutlineComparisonItemSchema, OutlineOverwriteConfirmationSchema,
    type OutlineComparisonItem, type OutlineExtractionParamsDto, type OutlineOverwriteItemKind,
} from "nbook/shared/dto/inspiration-outline-extraction.dto";
import type {ExtractionChapterDto} from "nbook/shared/dto/inspiration-outline-structure.dto";
import type {
    ExtractionSourceRef, ExtractionTask, ExtractionUnit, JsonRecord,
} from "nbook/shared/dto/inspiration-extraction-task.dto";
import type {OutlineId} from "nbook/server/outline/format";
import {ExtractionTaskError} from "./errors";
import {
    CHAPTER_SYSTEM_PROMPT, chapterOutlineGoal, detailGoal, renderDetailSupplement,
} from "./outline-prompts";
import {prepareOutlinePlan} from "./outline-destination";
import {
    applyUnitId, candidateKey, chapterDetailUnitId, chapterDisplayTitle, chapterOutlineUnitId, OUTLINE_COMPARE_UNIT_ID,
    OUTLINE_STEP, OUTLINE_TOTAL_UNIT_ID, parseOutlineParams, readOutlineState, STALE_TOTAL_KEY, staleVolumeKey,
    stateOfPlan, unitChapter, unitVolume, volumeDisplayTitle, volumeGroup, volumeUnitId, type OutlineState,
} from "./outline-params";
import {detailsOfChapter, entryOf, hasBody, readPlanLayout, type OutlinePlanningPort} from "./outline-planning";
import {totalSummaryRequest, volumeSummaryRequest} from "./outline-summary";
import {
    validateChapterOutlineBody, validateCitedOutput, validateDetailBody, chapterRange, formatRange, paragraphNumber,
} from "./outline-validation";
import {
    candidateOf, candidateRecord, chapterDetails, createChapterDetail, fillEntryBody, overwriteChapterDetail,
    overwriteChapterOutline, readChapterOldState, type OutlineWriter, type StoredCandidate,
} from "./outline-writer";
import {renderSourcePrefix} from "./prompt";
import type {
    ExtractionPipeline, ExtractionTaskPatch, ExtractionUnitContext, NewExtractionUnit, PipelineSettlement, PreparedExtraction,
} from "./types";

/**
 * 大纲提取流水线（`kind: outline`）。
 *
 * 单元与依赖：每章一个细纲单元和一个章节大纲单元（共用同一份系统提示与原文前缀，章节大纲再附上细纲）；
 * 每卷一个卷纲单元（只读本卷章节大纲）；最后一个总纲单元（只读各卷卷纲）。卷纲与总纲不接触原文。
 * 数据去向为覆盖时不建卷纲／总纲单元：先把全部章节提取成候选存入任务记录，生成新旧对比后暂停，
 * 用户逐项确认后才写入大纲库，所以确认之前大纲库没有任何改动。
 */

export type SourceParagraph = Readonly<{id: string; text: string}>;

export type OutlinePipelineDeps = Readonly<{
    planning: OutlinePlanningPort;
    /** 读取来源的全部段落；来源已变化时应抛 `ExtractionFatalError`。实现自行缓存，流水线每个单元都会调用。 */
    loadParagraphs(source: ExtractionSourceRef): Promise<readonly SourceParagraph[]>;
    /** 已有的提取任务记录，用于校验补充／覆盖的目标方案。 */
    listTasks(): Promise<readonly ExtractionTask[]>;
}>;

const COMPARISON_KEY = "comparison";
const CONFIRMED_KEY = "confirmed";
/** `settle` 的等待原因；任务记录限制 100 字。 */
const AWAITING_CONFIRMATION = "等待确认覆盖";

function isResolved(unit: ExtractionUnit): boolean {
    return unit.status === "done" || unit.status === "skipped";
}

function truncateLabel(text: string): string {
    return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}

function chapterLabel(chapter: ExtractionChapterDto): string {
    return truncateLabel(`第${chapter.index}章 ${chapterDisplayTitle(chapter)}`);
}

const KIND_LABEL: Record<OutlineOverwriteItemKind, string> = {detail: "细纲", outline: "章节大纲"};

function comparisonOf(task: Pick<ExtractionTask, "state">): OutlineComparisonItem[] | null {
    const value = task.state[COMPARISON_KEY];
    if (!Array.isArray(value)) return null;
    return value.map(item => OutlineComparisonItemSchema.parse(item));
}

function confirmedOf(task: Pick<ExtractionTask, "state">): {chapterIndex: number; kind: OutlineOverwriteItemKind}[] | null {
    const value = task.state[CONFIRMED_KEY];
    if (!Array.isArray(value)) return null;
    return OutlineOverwriteConfirmationSchema.parse({confirmedItems: value}).confirmedItems;
}

/** 提取开始时需要生成的内容：新建方案全部生成，补充只填空缺，覆盖只生成各章候选。 */
type UnitPlan = Readonly<{
    detail: ReadonlySet<number>;
    outline: ReadonlySet<number>;
    volume: ReadonlySet<number>;
    total: boolean;
    compare: boolean;
}>;

async function planUnits(deps: OutlinePipelineDeps, params: OutlineExtractionParamsDto, plan: OutlineState): Promise<UnitPlan> {
    const {structure} = params;
    const range = (count: number) => new Set(Array.from({length: count}, (_, position) => position + 1));
    if (plan.destination === "new") {
        return {detail: range(structure.chapters.length), outline: range(structure.chapters.length), volume: range(structure.volumes.length), total: true, compare: false};
    }
    if (plan.destination === "overwrite") {
        const mapped = range(plan.chapterIds.length);
        return {detail: mapped, outline: mapped, volume: new Set(), total: false, compare: true};
    }
    const snapshot = await deps.planning.snapshot();
    const layout = readPlanLayout(snapshot, plan.planId);
    if (!layout) throw new ExtractionTaskError("INVALID_INPUT", "目标方案已不存在，请重新选择数据去向。");
    const empty = (id: OutlineId) => {
        const source = entryOf(snapshot, id);
        return source === undefined || !hasBody(source.value);
    };
    const detail = new Set<number>();
    const outline = new Set<number>();
    plan.chapterIds.forEach((chapterId, position) => {
        if (detailsOfChapter(layout, chapterId).length === 0) detail.add(position + 1);
        if (empty(chapterId)) outline.add(position + 1);
    });
    const volume = new Set<number>();
    plan.volumeIds.forEach((volumeId, position) => { if (empty(volumeId)) volume.add(position + 1); });
    return {detail, outline, volume, total: empty(plan.totalId), compare: false};
}

/** 按卷排列：一卷的全部章节单元之后紧跟该卷的卷纲单元，这样第一卷汇总不必等到最后一卷的章节。 */
function buildUnits(params: OutlineExtractionParamsDto, unitPlan: UnitPlan): NewExtractionUnit[] {
    const units: NewExtractionUnit[] = [];
    for (const volume of params.structure.volumes) {
        const group = volumeGroup(volume.index);
        for (const chapter of params.structure.chapters.filter(item => item.index >= volume.firstChapterIndex && item.index <= volume.lastChapterIndex)) {
            const data = {chapter: chapter.index, volume: volume.index};
            if (unitPlan.detail.has(chapter.index)) {
                units.push({id: chapterDetailUnitId(chapter.index), step: OUTLINE_STEP.detail, label: `${chapterLabel(chapter)} · 细纲`, group, data});
            }
            if (unitPlan.outline.has(chapter.index)) {
                units.push({id: chapterOutlineUnitId(chapter.index), step: OUTLINE_STEP.outline, label: `${chapterLabel(chapter)} · 章节大纲`, group, data});
            }
        }
        if (unitPlan.volume.has(volume.index)) {
            units.push({id: volumeUnitId(volume.index), step: OUTLINE_STEP.volume, label: truncateLabel(`${volumeDisplayTitle(volume)} · 卷纲`), group, data: {volume: volume.index}});
        }
    }
    if (unitPlan.total) units.push({id: OUTLINE_TOTAL_UNIT_ID, step: OUTLINE_STEP.total, label: "总纲", group: null});
    if (unitPlan.compare) units.push({id: OUTLINE_COMPARE_UNIT_ID, step: OUTLINE_STEP.compare, label: "新旧对比", group: null});
    return units;
}

/**
 * 章节大纲写入后，其所属卷纲与总纲若在提取开始时已有正文，就不再反映新内容。
 * 这里只记录过期标志，不自动改写用户已有的汇总；重新汇总是用户主动触发的另一个动作。
 */
function stalePatch(plan: OutlineState, volume: number | null): ExtractionTaskPatch | undefined {
    const state: JsonRecord = {};
    if (volume !== null && plan.volumesWithBody.includes(volume)) state[staleVolumeKey(volume)] = true;
    if (plan.totalHadBody) state[STALE_TOTAL_KEY] = true;
    return Object.keys(state).length > 0 ? {state} : undefined;
}

export function createOutlinePipeline(deps: OutlinePipelineDeps): ExtractionPipeline {
    // 启动参数在任务创建后不变；每个单元都重新解析整份提取结构会白白放大成本。
    const parsedParams = new Map<string, OutlineExtractionParamsDto>();

    function paramsOf(task: ExtractionTask): OutlineExtractionParamsDto {
        let params = parsedParams.get(task.id);
        if (!params) {
            params = parseOutlineParams(task.params, task.source);
            parsedParams.set(task.id, params);
        }
        return params;
    }

    function chapterOf(params: OutlineExtractionParamsDto, index: number): ExtractionChapterDto {
        const chapter = params.structure.chapters[index - 1];
        if (!chapter) throw new Error(`提取结构里没有第 ${index} 章`);
        return chapter;
    }

    async function chapterParagraphs(task: ExtractionTask, chapter: ExtractionChapterDto): Promise<readonly SourceParagraph[]> {
        const range = chapterRange(chapter);
        const selected = (await deps.loadParagraphs(task.source)).filter(paragraph => {
            const number = paragraphNumber(paragraph.id);
            return number >= range.first && number <= range.last;
        });
        if (selected.length === 0) throw new Error(`第 ${chapter.index} 章的原文段落 ${formatRange(range)} 不存在`);
        return selected;
    }

    function writerOf(plan: OutlineState): OutlineWriter {
        return {port: deps.planning, planId: plan.planId};
    }

    function chapterIdOf(plan: OutlineState, index: number): OutlineId {
        const id = plan.chapterIds[index - 1];
        if (!id) throw new Error(`方案里没有对应第 ${index} 章的条目`);
        return id;
    }

    async function executeDetail(unit: ExtractionUnit, context: ExtractionUnitContext): Promise<ExtractionTaskPatch | void> {
        const {task} = context;
        const params = paramsOf(task);
        const plan = readOutlineState(task);
        const chapter = chapterOf(params, unitChapter(unit));
        const chapterId = chapterIdOf(plan, chapter.index);
        const overwrite = plan.destination === "overwrite";
        // 单元重做时上一次已经写入的细纲不重复生成；覆盖模式的结果在任务记录里，写入前不会有库内产物。
        if (!overwrite && (await chapterDetails(deps.planning, plan.planId, chapterId)).length > 0) return;
        const range = chapterRange(chapter);
        const output = await context.generate({
            purposeId: "extraction.outline.detail",
            variables: {range: `P${range.first}-P${range.last}`},
            system: CHAPTER_SYSTEM_PROMPT,
            prompt: {prefix: renderSourcePrefix(await chapterParagraphs(task, chapter)), goal: detailGoal(range)},
            validate: validateCitedOutput(range, validateDetailBody),
        });
        const title = `${chapterDisplayTitle(chapter)} - 细纲`;
        if (overwrite) return {state: {[candidateKey(chapter.index, "detail")]: candidateRecord({title, body: output.body, locator: output.locator})}};
        await createChapterDetail(writerOf(plan), {chapterId, title, body: output.body, sourcePath: task.source.path, locator: output.locator});
    }

    async function executeOutline(unit: ExtractionUnit, context: ExtractionUnitContext): Promise<ExtractionTaskPatch | void> {
        const {task} = context;
        const params = paramsOf(task);
        const plan = readOutlineState(task);
        const chapter = chapterOf(params, unitChapter(unit));
        const chapterId = chapterIdOf(plan, chapter.index);
        const overwrite = plan.destination === "overwrite";
        const writer = writerOf(plan);
        const stale = stalePatch(plan, unitVolume(unit));
        const snapshot = await deps.planning.snapshot();
        const entry = entryOf(snapshot, chapterId);
        if (!entry) throw new Error("章节条目已不存在");
        if (!overwrite && hasBody(entry.value)) {
            await fillEntryBody(writer, {entryId: chapterId, body: ""});
            return stale;
        }
        // 细纲单元被明确跳过时没有细纲可附，提示词随之改为直接依据原文。
        const layout = readPlanLayout(snapshot, plan.planId);
        const detailBody = overwrite
            ? candidateOf(task.state[candidateKey(chapter.index, "detail")])?.body
            : layout ? detailsOfChapter(layout, chapterId).find(hasBody)?.body : undefined;
        const range = chapterRange(chapter);
        const output = await context.generate({
            purposeId: "extraction.outline.chapter",
            variables: {range: `P${range.first}-P${range.last}`, detailRule: detailBody !== undefined
                ? "- 上面附有本章已提取的细纲，保持与它一致；细纲是对原文场景的展开，章节大纲更概括。"
                : "- 本章没有可用的细纲（提取失败后被跳过），请直接依据原文概括。"},
            system: CHAPTER_SYSTEM_PROMPT,
            prompt: {
                prefix: renderSourcePrefix(await chapterParagraphs(task, chapter)),
                ...(detailBody ? {supplements: [renderDetailSupplement(detailBody)]} : {}),
                goal: chapterOutlineGoal(range, detailBody !== undefined),
            },
            validate: validateCitedOutput(range, validateChapterOutlineBody),
        });
        if (overwrite) {
            return {state: {[candidateKey(chapter.index, "outline")]: candidateRecord({title: chapterDisplayTitle(chapter), body: output.body, locator: output.locator})}};
        }
        await fillEntryBody(writer, {entryId: chapterId, body: output.body, reference: {path: task.source.path, locator: output.locator}});
        return stale;
    }

    async function executeSummary(unit: ExtractionUnit, context: ExtractionUnitContext): Promise<ExtractionTaskPatch | void> {
        const {task} = context;
        const params = paramsOf(task);
        const plan = readOutlineState(task);
        const writer = writerOf(plan);
        const isTotal = unit.step === OUTLINE_STEP.total;
        const entryId: OutlineId | undefined = isTotal ? plan.totalId : plan.volumeIds[unitVolume(unit) - 1];
        if (!entryId) throw new Error("方案里没有对应的卷纲条目");
        const snapshot = await deps.planning.snapshot();
        const entry = entryOf(snapshot, entryId);
        if (!entry) throw new Error("汇总目标条目已不存在");
        // 总纲或卷纲在提取开始前已有的汇总不在重新汇总范围内；新写入的卷纲让已有总纲过期。
        const stale = isTotal ? undefined : stalePatch(plan, null);
        if (hasBody(entry.value)) {
            await fillEntryBody(writer, {entryId, body: ""});
            return stale;
        }
        const body = await context.generate(isTotal
            ? totalSummaryRequest(snapshot, plan.planId, params.workTitle)
            : volumeSummaryRequest(snapshot, plan.planId, entryId));
        await fillEntryBody(writer, {entryId, body});
        return stale;
    }

    /** 为每个候选生成新旧对比；这是覆盖前唯一一次读取现有内容，之后确认的依据是这里记录的版本。 */
    async function executeCompare(context: ExtractionUnitContext): Promise<ExtractionTaskPatch> {
        const {task} = context;
        const params = paramsOf(task);
        const plan = readOutlineState(task);
        const items: OutlineComparisonItem[] = [];
        for (const chapter of params.structure.chapters) {
            const detail = candidateOf(task.state[candidateKey(chapter.index, "detail")]);
            const outline = candidateOf(task.state[candidateKey(chapter.index, "outline")]);
            if (!detail && !outline) continue;
            const old = await readChapterOldState(deps.planning, plan.planId, chapterIdOf(plan, chapter.index));
            const title = chapterDisplayTitle(chapter);
            const push = (kind: OutlineOverwriteItemKind, candidate: StoredCandidate, previous: typeof old.detail) => items.push({
                chapterIndex: chapter.index, chapterTitle: title, kind, oldText: previous.oldText, newText: candidate.body,
                changed: (previous.oldText ?? "").trim() !== candidate.body.trim(), locator: candidate.locator,
                oldEntries: previous.oldEntries.map(entry => ({...entry})),
            });
            if (detail) push("detail", detail, old.detail);
            if (outline) push("outline", outline, old.outline);
        }
        return {state: {[COMPARISON_KEY]: items.map(item => OutlineComparisonItemSchema.parse(item))}};
    }

    async function executeApply(unit: ExtractionUnit, context: ExtractionUnitContext): Promise<ExtractionTaskPatch | void> {
        const {task} = context;
        const params = paramsOf(task);
        const plan = readOutlineState(task);
        const index = unitChapter(unit);
        const kind: OutlineOverwriteItemKind = unit.step === OUTLINE_STEP.applyDetail ? "detail" : "outline";
        const item = comparisonOf(task)?.find(candidate => candidate.chapterIndex === index && candidate.kind === kind);
        const candidate = candidateOf(task.state[candidateKey(index, kind)]);
        const chapter = chapterOf(params, index);
        const label = `第${index}章「${chapterDisplayTitle(chapter)}」的${KIND_LABEL[kind]}`;
        if (!item || !candidate) throw new Error(`${label}缺少对比记录或候选内容，原内容未改动`);
        const writer = writerOf(plan);
        if (kind === "detail") {
            await overwriteChapterDetail(writer, {label, item, candidate, chapterId: chapterIdOf(plan, index), sourcePath: task.source.path});
            return;
        }
        await overwriteChapterOutline(writer, {label, item, candidate, sourcePath: task.source.path});
        return stalePatch(plan, unitVolume(unit));
    }

    function isReady(unit: ExtractionUnit, task: ExtractionTask): boolean {
        const units = task.units;
        switch (unit.step) {
            case OUTLINE_STEP.outline: {
                const detail = units.find(other => other.id === chapterDetailUnitId(unitChapter(unit)));
                return detail === undefined || isResolved(detail);
            }
            case OUTLINE_STEP.volume: {
                // 失败的章节让所属卷纲留在等待，直到章节被重试成功或被明确跳过。
                const volume = unitVolume(unit);
                return units.every(other => other.step === OUTLINE_STEP.volume || other.data.volume !== volume || isResolved(other));
            }
            case OUTLINE_STEP.total:
                return units.every(other => other.step !== OUTLINE_STEP.volume || isResolved(other));
            case OUTLINE_STEP.compare:
                return units.every(other => (other.step !== OUTLINE_STEP.detail && other.step !== OUTLINE_STEP.outline) || isResolved(other));
            default:
                return true;
        }
    }

    return {
        async prepare({params: rawParams, source}): Promise<PreparedExtraction> {
            const params = parseOutlineParams(rawParams, source);
            const plan = await prepareOutlinePlan({port: deps.planning, params, source, tasks: await deps.listTasks()});
            const unitPlan = await planUnits(deps, params, plan);
            if (plan.destination === "overwrite" && plan.chapterIds.length === 0) {
                throw new ExtractionTaskError("INVALID_INPUT", `方案「${plan.planTitle}」没有任何章节，没有可以覆盖的内容。`);
            }
            return {units: buildUnits(params, unitPlan), state: stateOfPlan(plan)};
        },

        readyUnits: task => task.units.filter(unit => unit.status === "pending" && isReady(unit, task)),

        async execute(unit, context) {
            switch (unit.step) {
                case OUTLINE_STEP.detail: return executeDetail(unit, context);
                case OUTLINE_STEP.outline: return executeOutline(unit, context);
                case OUTLINE_STEP.volume:
                case OUTLINE_STEP.total: return executeSummary(unit, context);
                case OUTLINE_STEP.compare: return executeCompare(context);
                case OUTLINE_STEP.applyDetail:
                case OUTLINE_STEP.applyOutline: return executeApply(unit, context);
                default: throw new Error(`未知的大纲提取单元类型：${unit.step}`);
            }
        },

        settle(task): PipelineSettlement {
            const compare = task.units.find(unit => unit.id === OUTLINE_COMPARE_UNIT_ID);
            if (compare?.status === "done" && confirmedOf(task) === null) return {kind: "awaiting-input", reason: AWAITING_CONFIRMATION};
            return {kind: "finished"};
        },

        acceptInput(task, input): ExtractionTaskPatch {
            const parsed = OutlineOverwriteConfirmationSchema.safeParse(input);
            if (!parsed.success) {
                throw new ExtractionTaskError("INVALID_INPUT", `覆盖确认无效：${parsed.error.issues.map(issue => `${issue.path.join(".") || "输入"} ${issue.message}`).join("；")}`);
            }
            const comparison = comparisonOf(task);
            if (!comparison) throw new ExtractionTaskError("INVALID_INPUT", "任务还没有生成新旧对比，不能确认覆盖。");
            const confirmed = new Map<string, {chapterIndex: number; kind: OutlineOverwriteItemKind}>();
            for (const entry of parsed.data.confirmedItems) {
                if (!comparison.some(item => item.chapterIndex === entry.chapterIndex && item.kind === entry.kind)) {
                    throw new ExtractionTaskError("INVALID_INPUT", `对比里没有第 ${entry.chapterIndex} 章的${KIND_LABEL[entry.kind]}。`);
                }
                confirmed.set(`${entry.chapterIndex}:${entry.kind}`, entry);
            }
            const params = paramsOf(task);
            // 与现有内容一致的项即使被确认也不产生写入。
            const writes = comparison
                .filter(item => item.changed && confirmed.has(`${item.chapterIndex}:${item.kind}`))
                .sort((left, right) => left.chapterIndex - right.chapterIndex || left.kind.localeCompare(right.kind));
            const appendUnits = writes.map((item): NewExtractionUnit => {
                const volume = params.structure.volumes.find(candidate => candidate.firstChapterIndex <= item.chapterIndex && item.chapterIndex <= candidate.lastChapterIndex);
                return {
                    id: applyUnitId(item.chapterIndex, item.kind),
                    step: item.kind === "detail" ? OUTLINE_STEP.applyDetail : OUTLINE_STEP.applyOutline,
                    label: truncateLabel(`第${item.chapterIndex}章 ${item.chapterTitle} · 覆盖${KIND_LABEL[item.kind]}`),
                    group: volume ? volumeGroup(volume.index) : null,
                    data: {chapter: item.chapterIndex, volume: volume?.index ?? 0},
                };
            });
            return {state: {[CONFIRMED_KEY]: [...confirmed.values()]}, appendUnits};
        },
    };
}

/** 任务产出的、界面需要展示的信息；纯函数，只读任务记录。 */
export type OutlineExtractionOutcome = Readonly<{
    planId: string;
    planTitle: string;
    destination: OutlineState["destination"];
    /** 覆盖等待确认或已确认时的新旧对比；其他情况为 null。 */
    comparison: readonly OutlineComparisonItem[] | null;
    /** 已确认的覆盖项；尚未确认为 null。 */
    confirmed: readonly Readonly<{chapterIndex: number; kind: OutlineOverwriteItemKind}>[] | null;
    /** 覆盖项写入失败的单元（含点名失败项的错误说明）；原内容保持不变。 */
    failedOverwrites: readonly Readonly<{unitId: string; chapterIndex: number; kind: OutlineOverwriteItemKind; error: string}>[];
    /** 覆盖模式下，结构里有而方案里没有对应章节的章序号，这些章没有提取。 */
    unmappedChapters: readonly number[];
    /** 过期的卷序号；非空或总纲过期时 `staleNotice` 有值。 */
    staleVolumes: readonly number[];
    staleTotal: boolean;
    staleNotice: string | null;
    /** 任务不在运行或等待输入，且存在过期汇总时才可触发“重新汇总本卷与总纲”。 */
    canResummarize: boolean;
}>;

export const STALE_NOTICE = "所属卷纲与总纲已过期，可以重新汇总本卷与总纲。";

export function readOutlineExtractionOutcome(task: ExtractionTask): OutlineExtractionOutcome {
    const plan = readOutlineState(task);
    const staleVolumes = plan.volumeIds.flatMap((_, position) => task.state[staleVolumeKey(position + 1)] === true ? [position + 1] : []);
    const staleTotal = task.state[STALE_TOTAL_KEY] === true;
    const stale = staleVolumes.length > 0 || staleTotal;
    return {
        planId: plan.planId,
        planTitle: plan.planTitle,
        destination: plan.destination,
        comparison: comparisonOf(task),
        confirmed: confirmedOf(task),
        failedOverwrites: task.units.flatMap(unit => unit.status === "failed" && (unit.step === OUTLINE_STEP.applyDetail || unit.step === OUTLINE_STEP.applyOutline)
            ? [{unitId: unit.id, chapterIndex: unitChapter(unit), kind: unit.step === OUTLINE_STEP.applyDetail ? "detail" as const : "outline" as const, error: unit.error ?? "覆盖失败"}]
            : []),
        unmappedChapters: plan.unmappedChapters,
        staleVolumes,
        staleTotal,
        staleNotice: stale ? STALE_NOTICE : null,
        canResummarize: stale && task.status !== "running" && task.status !== "awaiting-input",
    };
}
