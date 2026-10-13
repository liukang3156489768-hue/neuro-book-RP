import {computed, getCurrentInstance, onBeforeUnmount, reactive, ref, shallowRef, toValue, watch, type MaybeRefOrGetter} from "vue";
import type {MaterialConflictDecisionDto, MaterialReviewActionDto} from "nbook/shared/dto/inspiration-extraction-api.dto";
import {MATERIAL_CATEGORIES} from "nbook/shared/dto/inspiration-material.dto";
import type {ChapterCorrectionDto, ExtractionStructureDto, VolumeDivisionDto} from "nbook/shared/dto/inspiration-outline-structure.dto";
import type {InspirationSourceFileDto, InspirationSourcePrepareResponseDto} from "nbook/shared/dto/inspiration-source.dto";
import {
    createExtractionApi,
    type ClassificationInput, type ClassificationView, type ConflictComparison, type ExtractionApi, type MaterialReview,
    type OutlineDestinationOption, type OutlineExtractionOutcome, type StructurePreview, type WriteReport, type ExtractionTaskSummary,
} from "nbook/app/utils/inspiration/extraction-api";
import {describeExtractionError, type DescribedError} from "nbook/app/utils/inspiration/extraction-labels";
import {useExtractionTaskTracker} from "nbook/app/composables/useExtractionTaskTracker";

/**
 * 作品提取工作台的服务调用与状态：来源与章节划卷、大纲提取任务、素材提取任务各自独立。
 *
 * 大纲与素材各有一个任务跟踪器和独立的错误、忙碌状态，互不阻塞。
 * 请求只经由 `ExtractionApi` 发出，且不携带确认者身份（素材写入的确认者由服务端固定为用户）。
 * 划卷草稿修改后会延迟向服务端校验，错误原样显示；任务运行期间轮询进度，离开组件时清理定时器。
 */

export type VolumeDraft = {title: string; first: string; last: string};
export type DestinationChoice = {kind: "new"} | {kind: "supplement" | "overwrite"; planId: string};
export type ExtractionOptions = Readonly<{api?: ExtractionApi; pollIntervalMs?: number; validateDelayMs?: number}>;

const DEFAULT_POLL_MS = 2000;
const DEFAULT_VALIDATE_DELAY_MS = 400;
const DEFAULT_CHUNKS_PER_VOLUME = 10;

function sourceTitle(path: string): string {
    return (path.split("/").pop() ?? path).replace(/\.(?:txt|md)$/iu, "");
}

function latestOfKind<T extends {kind: string; createdAt: string; id: string}>(tasks: readonly T[], kind: string): T | null {
    return tasks.filter(task => task.kind === kind).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

export function useInspirationExtraction(projectRoot: MaybeRefOrGetter<string | null>, options: ExtractionOptions = {}) {
    const api = options.api ?? createExtractionApi();
    const root = (): string | null => toValue(projectRoot) || null;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;

    // -----------------------------------------------------------------------
    // 来源
    // -----------------------------------------------------------------------
    const sources = ref<InspirationSourceFileDto[]>([]);
    const sourcesLoading = ref(false);
    const sourceError = ref<DescribedError | null>(null);
    const selectedPath = ref("");
    const preparedSource = shallowRef<InspirationSourcePrepareResponseDto | null>(null);
    /** source-prepare 的段落文本，仅用于修正章节时预览 P 编号对应的原文。 */
    const paragraphText = shallowRef<ReadonlyMap<string, string>>(new Map());
    const sourceWarnings = ref<string[]>([]);
    /** 来源切换后丢弃迟到的响应。 */
    let sourceGeneration = 0;

    async function loadSources(): Promise<void> {
        const projectPath = root();
        if (!projectPath) { sources.value = []; return; }
        sourcesLoading.value = true;
        try {
            sources.value = (await api.listSources(projectPath)).sources;
            sourceError.value = null;
        } catch (cause) {
            sourceError.value = describeExtractionError(cause);
        } finally {
            sourcesLoading.value = false;
        }
    }

    // -----------------------------------------------------------------------
    // 大纲：结构、划卷、去向、任务
    // -----------------------------------------------------------------------
    const corrections = ref<ChapterCorrectionDto[]>([]);
    const structureMode = ref<"chapters" | "chunks" | null>(null);
    const targetCharacters = ref("50000");
    const preview = shallowRef<StructurePreview | null>(null);
    const previewLoading = ref(false);
    const previewError = ref<DescribedError | null>(null);
    const correctionError = ref<DescribedError | null>(null);
    const volumes = ref<VolumeDraft[]>([]);
    const chunksPerVolume = ref(String(DEFAULT_CHUNKS_PER_VOLUME));
    const divisionError = ref<DescribedError | null>(null);
    const divisionChecking = ref(false);
    const confirmedStructure = shallowRef<ExtractionStructureDto | null>(null);
    const destinations = ref<OutlineDestinationOption[]>([]);
    const destination = ref<DestinationChoice>({kind: "new"});
    const workTitle = ref("");
    const outcome = shallowRef<OutlineExtractionOutcome | null>(null);
    const outcomeError = ref<DescribedError | null>(null);
    const resultBusy = ref(false);
    const outlineTasks = ref<ExtractionTaskSummary[]>([]);
    const outlineTasksLoading = ref(false);
    const outlineTasksError = ref<DescribedError | null>(null);
    let outlineViewGeneration = 0;
    let outlineListGeneration = 0;

    const outlineTracker = useExtractionTaskTracker({
        api, projectRoot: root, pollIntervalMs,
        onSettled: async (_detail, changed) => {
            if (changed) await Promise.all([loadOutcome(), loadOutlineTasks()]);
        },
    });

    async function loadOutlineTasks(): Promise<void> {
        const projectPath = root();
        const path = selectedPath.value;
        const generation = ++outlineListGeneration;
        if (!projectPath || !path) { outlineTasks.value = []; return; }
        outlineTasksLoading.value = true;
        try {
            const listed = await api.listTasks(projectPath, {kind: "outline", path});
            if (generation !== outlineListGeneration) return;
            outlineTasks.value = listed.tasks;
            outlineTasksError.value = null;
        } catch (cause) {
            if (generation === outlineListGeneration) outlineTasksError.value = describeExtractionError(cause);
        } finally {
            if (generation === outlineListGeneration) outlineTasksLoading.value = false;
        }
    }

    async function loadOutcome(): Promise<void> {
        const projectPath = root();
        const id = outlineTracker.task.value?.id;
        if (!projectPath || !id) return;
        const generation = outlineViewGeneration;
        try {
            const loaded = await api.getOutlineOutcome(projectPath, id);
            if (generation !== outlineViewGeneration || id !== outlineTracker.task.value?.id) return;
            outcome.value = loaded;
            outcomeError.value = null;
        } catch (cause) {
            if (generation !== outlineViewGeneration || id !== outlineTracker.task.value?.id) return;
            outcomeError.value = describeExtractionError(cause);
        }
        if (outlineTracker.task.value?.status === "completed") await loadDestinations();
    }

    async function loadDestinations(): Promise<void> {
        const projectPath = root();
        if (!projectPath || !selectedPath.value) { destinations.value = []; return; }
        const generation = sourceGeneration;
        try {
            const result = await api.listDestinations(projectPath, selectedPath.value);
            if (generation !== sourceGeneration) return;
            destinations.value = result.options;
            const choice = destination.value;
            const stillValid = choice.kind === "new" || destinations.value.some(option => option.planId === choice.planId
                && (choice.kind === "supplement" ? option.canSupplement : option.canOverwrite));
            if (!stillValid) destination.value = {kind: "new"};
        } catch {
            // 去向列表只是增强选项，加载失败时退回只能新建，不阻断提取。
            if (generation === sourceGeneration) destinations.value = [];
        }
    }

    /** 重放修正并刷新章节预览；成功才替换当前修正，失败保留原状态并返回错误。 */
    async function replay(next: ChapterCorrectionDto[]): Promise<DescribedError | null> {
        const projectPath = root();
        if (!projectPath || !selectedPath.value) return null;
        const generation = sourceGeneration;
        const viewGeneration = outlineViewGeneration;
        previewLoading.value = true;
        try {
            const result = await api.previewStructure(projectPath, {
                path: selectedPath.value,
                corrections: next,
                ...(structureMode.value ? {mode: structureMode.value} : {}),
                ...(Number(targetCharacters.value) === 50_000 ? {} : {targetCharacters: Number(targetCharacters.value)}),
            });
            if (generation !== sourceGeneration || viewGeneration !== outlineViewGeneration) return null;
            preview.value = result;
            if (structureMode.value === null) structureMode.value = result.mode;
            corrections.value = next;
            previewError.value = null;
            // 修正会改变章序号，先前的划卷作废，按新的默认建议重来。
            volumes.value = result.suggestedVolumes.map(volume => ({title: volume.title ?? "", first: String(volume.firstChapterIndex), last: String(volume.lastChapterIndex)}));
            chunksPerVolume.value = String(Math.max(1, Math.min(DEFAULT_CHUNKS_PER_VOLUME, result.chapters.length)));
            void validateDivision();
            return null;
        } catch (cause) {
            if (generation !== sourceGeneration || viewGeneration !== outlineViewGeneration) return null;
            return describeExtractionError(cause);
        } finally {
            if (generation === sourceGeneration && viewGeneration === outlineViewGeneration) previewLoading.value = false;
        }
    }

    async function loadPreview(): Promise<void> {
        const error = await replay([]);
        if (error) previewError.value = error;
    }

    async function refreshPreview(): Promise<void> {
        const error = await replay(corrections.value);
        if (error) previewError.value = error;
    }

    async function addCorrection(correction: ChapterCorrectionDto): Promise<boolean> {
        const error = await replay([...corrections.value, correction]);
        correctionError.value = error;
        return error === null;
    }

    async function undoCorrection(): Promise<void> {
        correctionError.value = await replay(corrections.value.slice(0, -1));
    }

    async function clearCorrections(): Promise<void> {
        correctionError.value = await replay([]);
    }

    function restoreSuggestedVolumes(): void {
        volumes.value = (preview.value?.suggestedVolumes ?? []).map(volume => ({title: volume.title ?? "", first: String(volume.firstChapterIndex), last: String(volume.lastChapterIndex)}));
    }

    /** 把划卷草稿转成请求；草稿里有无法解析的序号时返回本地提示，不打扰服务端。 */
    function buildDivision(): {division: VolumeDivisionDto} | {error: DescribedError} {
        if (preview.value?.mode === "chunks") {
            const count = Number(chunksPerVolume.value);
            return Number.isInteger(count) && count > 0 ? {division: {mode: "chunks", chunksPerVolume: count}} : {error: {code: null, message: "每卷块数需要是正整数。"}};
        }
        const ranges = volumes.value.map(volume => ({title: volume.title.trim() || null, first: Number(volume.first), last: Number(volume.last)}));
        if (!ranges.length) return {error: {code: null, message: "至少需要划分一卷。"}};
        if (ranges.some(range => !Number.isInteger(range.first) || !Number.isInteger(range.last) || range.first < 1 || range.last < 1)) {
            return {error: {code: null, message: "请为每一卷填写完整的起止章序号（正整数）。"}};
        }
        return {division: {mode: "chapters", volumes: ranges.map(range => ({title: range.title, firstChapterIndex: range.first, lastChapterIndex: range.last}))}};
    }

    let validateTimer: ReturnType<typeof setTimeout> | null = null;
    let validateToken = 0;
    /** 最近一次已发起校验的划卷内容；草稿被程序性重置为同样内容时不必重复校验。 */
    let validatedSignature = "";

    /** 立即向服务端校验当前划卷；结果同时给出确认后的结构供启动使用。 */
    async function validateDivision(): Promise<boolean> {
        const projectPath = root();
        if (validateTimer !== null) clearTimeout(validateTimer);
        validateTimer = null;
        if (!projectPath || !selectedPath.value || !preview.value) return false;
        const built = buildDivision();
        validatedSignature = JSON.stringify(built);
        const token = ++validateToken;
        if ("error" in built) {
            confirmedStructure.value = null;
            divisionError.value = built.error;
            divisionChecking.value = false;
            return false;
        }
        divisionChecking.value = true;
        const generation = sourceGeneration;
        try {
            const result = await api.confirmStructure(projectPath, {
                path: selectedPath.value,
                corrections: corrections.value,
                division: built.division,
                ...(structureMode.value ? {mode: structureMode.value} : {}),
                ...(Number(targetCharacters.value) === 50_000 ? {} : {targetCharacters: Number(targetCharacters.value)}),
            });
            if (token !== validateToken || generation !== sourceGeneration) return false;
            confirmedStructure.value = result.structure;
            divisionError.value = null;
            return true;
        } catch (cause) {
            if (token !== validateToken || generation !== sourceGeneration) return false;
            confirmedStructure.value = null;
            divisionError.value = describeExtractionError(cause);
            return false;
        } finally {
            if (token === validateToken) divisionChecking.value = false;
        }
    }

    watch([volumes, chunksPerVolume], () => {
        if (!preview.value || JSON.stringify(buildDivision()) === validatedSignature) return;
        confirmedStructure.value = null;
        divisionChecking.value = true;
        if (validateTimer !== null) clearTimeout(validateTimer);
        validateTimer = setTimeout(() => { void validateDivision(); }, options.validateDelayMs ?? DEFAULT_VALIDATE_DELAY_MS);
    }, {deep: true});

    const startError = ref<DescribedError | null>(null);
    const canStartOutline = computed(() => !outlineTracker.busy.value && !previewLoading.value && Boolean(preview.value) && workTitle.value.trim().length > 0 && !divisionError.value);

    async function startOutline(modelKey?: string): Promise<boolean> {
        const projectPath = root();
        const source = preview.value?.source;
        if (!projectPath || !source) return false;
        startError.value = null;
        // 启动前以最新状态再校验一次，避免防抖窗口内的修改被漏掉。
        if (!await validateDivision() || !confirmedStructure.value) {
            startError.value = divisionError.value ?? {code: null, message: "划卷还没有通过校验。"};
            return false;
        }
        outcome.value = null;
        const started = await outlineTracker.start({
            kind: "outline", projectRoot: projectPath, source, workTitle: workTitle.value.trim(), structure: confirmedStructure.value,
            corrections: corrections.value, destination: destination.value, ...(modelKey ? {modelKey} : {}),
        });
        if (!started) startError.value = outlineTracker.error.value;
        else await loadOutlineTasks();
        return started;
    }

    async function confirmOverwrite(items: ReadonlyArray<{chapterIndex: number; kind: "detail" | "outline"}>): Promise<boolean> {
        const ok = await outlineTracker.provideInput({confirmedItems: items});
        await loadOutcome();
        return ok;
    }

    async function resummarize(): Promise<boolean> {
        const projectPath = root();
        const id = outlineTracker.task.value?.id;
        if (!projectPath || !id) return false;
        resultBusy.value = true;
        try {
            await api.resummarize(projectPath, id);
            outcomeError.value = null;
            await outlineTracker.refresh();
            await loadOutcome();
            return true;
        } catch (cause) {
            outcomeError.value = describeExtractionError(cause);
            return false;
        } finally {
            resultBusy.value = false;
        }
    }

    async function outlineUnitAction(action: () => Promise<boolean>): Promise<void> {
        if (await action()) await loadOutcome();
    }

    /** 离开结果视图回到设置；任务保留在服务端，重新选择来源会恢复它。 */
    function dismissOutline(): void {
        outlineViewGeneration += 1;
        outlineTracker.clear();
        outcome.value = null;
        outcomeError.value = null;
        startError.value = null;
        void loadDestinations();
    }

    function createOutlineTask(): void {
        dismissOutline();
        validateToken += 1;
        validatedSignature = "";
        if (validateTimer !== null) clearTimeout(validateTimer);
        validateTimer = null;
        preview.value = null;
        previewError.value = null;
        corrections.value = [];
        correctionError.value = null;
        structureMode.value = null;
        targetCharacters.value = "50000";
        destination.value = {kind: "new"};
        workTitle.value = sourceTitle(selectedPath.value);
        divisionError.value = null;
        divisionChecking.value = false;
        confirmedStructure.value = null;
        void loadPreview();
    }

    async function selectOutlineTask(taskId: string): Promise<void> {
        if (!taskId || taskId === "new") { createOutlineTask(); return; }
        if (taskId === outlineTracker.task.value?.id) return;
        outlineViewGeneration += 1;
        outlineTracker.clear();
        outcome.value = null;
        outcomeError.value = null;
        startError.value = null;
        await outlineTracker.adopt(taskId);
    }

    async function removeOutlineTask(taskId: string): Promise<boolean> {
        const projectPath = root();
        if (!projectPath || !taskId) return false;
        const generation = sourceGeneration;
        try {
            await api.removeTask(projectPath, taskId);
            if (generation !== sourceGeneration) return true;
            if (outlineTracker.task.value?.id === taskId) createOutlineTask();
            await loadOutlineTasks();
            return true;
        } catch (cause) {
            if (generation === sourceGeneration) outlineTasksError.value = describeExtractionError(cause);
            return false;
        }
    }

    const outline = reactive({
        preview, previewLoading, previewError, corrections, correctionError, volumes, chunksPerVolume, divisionError, divisionChecking, structureMode, targetCharacters,
        confirmedStructure, destinations, destination, workTitle, startError, canStartOutline, outcome, outcomeError, resultBusy,
        tasks: outlineTasks, tasksLoading: outlineTasksLoading, tasksError: outlineTasksError,
        task: outlineTracker.task, progress: outlineTracker.progress, error: outlineTracker.error, busy: outlineTracker.busy, running: outlineTracker.running,
        paragraphText,
        addCorrection, undoCorrection, clearCorrections, restoreSuggestedVolumes, validateDivision, refreshPreview, startOutline,
        cancel: () => outlineTracker.cancel(),
        resume: () => outlineTracker.resume(),
        retryUnit: (unitId: string) => outlineUnitAction(() => outlineTracker.retryUnit(unitId)),
        skipUnit: (unitId: string) => outlineUnitAction(() => outlineTracker.skipUnit(unitId)),
        retryFailed: (unitIds: string[]) => outlineUnitAction(() => outlineTracker.changeFailedUnits("retry", unitIds)),
        skipFailed: (unitIds: string[]) => outlineUnitAction(() => outlineTracker.changeFailedUnits("skip", unitIds)),
        refresh: () => outlineTracker.refresh(),
        confirmOverwrite, resummarize, dismiss: dismissOutline,
        loadTasks: loadOutlineTasks, selectTask: selectOutlineTask, createTask: createOutlineTask, removeTask: removeOutlineTask,
    });

    // -----------------------------------------------------------------------
    // 素材：类别、归类、整合进度、待写入清单
    // -----------------------------------------------------------------------
    const categories = ref<string[]>(MATERIAL_CATEGORIES.map(category => category.key));
    const classification = shallowRef<ClassificationView | null>(null);
    /** 只锁定归类提交本身；分类数据加载完成后，任务跟踪器的启动收尾不应禁用勾选。 */
    const classificationActionBusy = ref(false);
    const review = shallowRef<MaterialReview | null>(null);
    const materialError = ref<DescribedError | null>(null);
    const reviewBusy = ref(false);
    const pendingConflicts = shallowRef<ConflictComparison[]>([]);
    const writeReport = shallowRef<WriteReport | null>(null);
    const materialStartError = ref<DescribedError | null>(null);
    const materialTasks = ref<ExtractionTaskSummary[]>([]);
    const materialTasksLoading = ref(false);
    const materialTasksError = ref<DescribedError | null>(null);
    const selectedBlocks = ref<number[]>([]);
    const lastBlockAnchor = ref<number | null>(null);

    function setSelectedBlocks(blocks: readonly number[]): void {
        selectedBlocks.value = [...new Set(blocks)].sort((left, right) => left - right);
    }

    function toggleBlock(index: number, range = false): void {
        const available = preparedSource.value?.chunks.map(chunk => chunk.index) ?? [];
        if (range && lastBlockAnchor.value !== null) {
            const start = Math.min(lastBlockAnchor.value, index);
            const end = Math.max(lastBlockAnchor.value, index);
            setSelectedBlocks([...selectedBlocks.value, ...available.filter(item => item >= start && item <= end)]);
        } else {
            setSelectedBlocks(selectedBlocks.value.includes(index)
                ? selectedBlocks.value.filter(item => item !== index)
                : [...selectedBlocks.value, index]);
        }
        lastBlockAnchor.value = index;
    }

    function selectAllBlocks(): void { setSelectedBlocks(preparedSource.value?.chunks.map(chunk => chunk.index) ?? []); }
    function clearBlocks(): void { setSelectedBlocks([]); }
    function invertBlocks(): void {
        const selected = new Set(selectedBlocks.value);
        setSelectedBlocks((preparedSource.value?.chunks.map(chunk => chunk.index) ?? []).filter(index => !selected.has(index)));
    }

    const materialTracker = useExtractionTaskTracker({
        api, projectRoot: root, pollIntervalMs,
        onSettled: async ({task}, changed) => {
            if (!changed) return;
            await loadMaterialTasks();
            if (task.status === "awaiting-input") await loadClassification();
            else if (task.status === "completed" || task.status === "partial-failed") await loadReview();
        },
    });

    async function loadMaterialTasks(): Promise<void> {
        const projectPath = root();
        if (!projectPath || !selectedPath.value) {
            materialTasks.value = [];
            return;
        }
        materialTasksLoading.value = true;
        try {
            materialTasks.value = (await api.listTasks(projectPath, {kind: "material", path: selectedPath.value})).tasks;
            materialTasksError.value = null;
        } catch (cause) {
            materialTasksError.value = describeExtractionError(cause);
        } finally {
            materialTasksLoading.value = false;
        }
    }

    async function loadClassification(): Promise<void> {
        const projectPath = root();
        const id = materialTracker.task.value?.id;
        if (!projectPath || !id) return;
        try {
            classification.value = await api.getClassification(projectPath, id);
            materialError.value = null;
        } catch (cause) {
            materialError.value = describeExtractionError(cause);
        }
    }

    async function loadReview(): Promise<void> {
        const projectPath = root();
        const id = materialTracker.task.value?.id;
        if (!projectPath || !id) return;
        reviewBusy.value = true;
        try {
            review.value = await api.getReview(projectPath, id);
            materialError.value = null;
        } catch (cause) {
            materialError.value = describeExtractionError(cause);
        } finally {
            reviewBusy.value = false;
        }
    }

    function toggleCategory(key: string): void {
        categories.value = categories.value.includes(key) ? categories.value.filter(item => item !== key) : [...categories.value, key];
    }

    async function startMaterial(modelKey?: string): Promise<boolean> {
        const projectPath = root();
        // source-prepare 还会附带文件展示元数据；任务合同只接受路径与哈希，不能把展示字段写入启动请求。
        const prepared = preparedSource.value?.source ?? preview.value?.source;
        const source = prepared ? {path: prepared.path, sha256: prepared.sha256} : undefined;
        const hasSelectableBlocks = (preparedSource.value?.chunks?.length ?? 0) > 0;
        if (!projectPath || !source || !categories.value.length || (hasSelectableBlocks && !selectedBlocks.value.length)) {
            if (hasSelectableBlocks && !selectedBlocks.value.length) materialStartError.value = {code: "INVALID_INPUT", message: "至少选择一个分块后才能开始提取"};
            return false;
        }
        materialStartError.value = null;
        classification.value = null;
        review.value = null;
        writeReport.value = null;
        pendingConflicts.value = [];
        const started = await materialTracker.start({
            kind: "material", projectRoot: projectPath, source,
            // 保持九类的固定顺序，不随点选顺序变化。
            categories: MATERIAL_CATEGORIES.map(category => category.key).filter(key => categories.value.includes(key)),
            ...(hasSelectableBlocks ? {blocks: selectedBlocks.value} : {}),
            ...(modelKey ? {modelKey} : {}),
        });
        if (started) await loadMaterialTasks();
        if (!started) materialStartError.value = materialTracker.error.value;
        return started;
    }

    async function selectMaterialTask(taskId: string): Promise<void> {
        if (!taskId || taskId === "new") {
            createMaterialTask();
            return;
        }
        materialTracker.clear();
        classification.value = null;
        review.value = null;
        writeReport.value = null;
        pendingConflicts.value = [];
        materialError.value = null;
        await materialTracker.adopt(taskId);
    }

    function createMaterialTask(): void {
        materialTracker.clear();
        categories.value = MATERIAL_CATEGORIES.map(category => category.key);
        selectedBlocks.value = preparedSource.value?.chunks.map(chunk => chunk.index) ?? [];
        lastBlockAnchor.value = null;
        classification.value = null;
        review.value = null;
        writeReport.value = null;
        pendingConflicts.value = [];
        materialError.value = null;
        materialStartError.value = null;
    }

    async function removeMaterialTask(taskId: string): Promise<boolean> {
        const projectPath = root();
        if (!projectPath || !taskId) return false;
        try {
            await api.removeTask(projectPath, taskId);
            if (materialTracker.task.value?.id === taskId) createMaterialTask();
            await loadMaterialTasks();
            return true;
        } catch (cause) {
            materialTasksError.value = describeExtractionError(cause);
            return false;
        }
    }

    async function submitClassification(input: ClassificationInput): Promise<boolean> {
        classificationActionBusy.value = true;
        try {
            const ok = await materialTracker.provideInput(input);
            if (ok) classification.value = null;
            return ok;
        } finally {
            classificationActionBusy.value = false;
        }
    }

    async function reviewAction(action: MaterialReviewActionDto): Promise<boolean> {
        const projectPath = root();
        const id = materialTracker.task.value?.id;
        if (!projectPath || !id) return false;
        reviewBusy.value = true;
        try {
            review.value = await api.reviewAction(projectPath, id, action);
            materialError.value = null;
            return true;
        } catch (cause) {
            materialError.value = describeExtractionError(cause);
            return false;
        } finally {
            reviewBusy.value = false;
        }
    }

    /** 先预览同名冲突：有冲突时交给用户决定，无冲突直接写入，避免在用户表态前写出一部分文件。 */
    async function requestWrite(): Promise<boolean> {
        const projectPath = root();
        const id = materialTracker.task.value?.id;
        if (!projectPath || !id) return false;
        reviewBusy.value = true;
        try {
            const conflicts = await api.getConflicts(projectPath, id);
            materialError.value = null;
            if (conflicts.length) { pendingConflicts.value = conflicts; return false; }
        } catch (cause) {
            materialError.value = describeExtractionError(cause);
            return false;
        } finally {
            reviewBusy.value = false;
        }
        return confirmWrite();
    }

    async function confirmWrite(decisions?: readonly MaterialConflictDecisionDto[]): Promise<boolean> {
        const projectPath = root();
        const id = materialTracker.task.value?.id;
        if (!projectPath || !id) return false;
        reviewBusy.value = true;
        try {
            const report = await api.confirmWrite(projectPath, id, decisions);
            review.value = report.review;
            writeReport.value = report;
            pendingConflicts.value = [...report.conflicts];
            materialError.value = null;
            return true;
        } catch (cause) {
            materialError.value = describeExtractionError(cause);
            return false;
        } finally {
            reviewBusy.value = false;
        }
    }

    function cancelConflicts(): void {
        pendingConflicts.value = [];
    }

    function dismissMaterial(): void {
        materialTracker.clear();
        classification.value = null;
        review.value = null;
        writeReport.value = null;
        pendingConflicts.value = [];
        materialError.value = null;
        materialStartError.value = null;
    }

    const material = reactive({
        categories, classification, classificationBusy: classificationActionBusy, review, reviewBusy, pendingConflicts, writeReport, selectedBlocks, tasks: materialTasks, tasksLoading: materialTasksLoading, tasksError: materialTasksError, startError: materialStartError, resultError: materialError,
        task: materialTracker.task, progress: materialTracker.progress, error: materialTracker.error, busy: materialTracker.busy, running: materialTracker.running,
        toggleCategory, startMaterial, submitClassification, reviewAction, requestWrite, confirmWrite, cancelConflicts, toggleBlock, selectAllBlocks, clearBlocks, invertBlocks,
        loadTasks: loadMaterialTasks, selectTask: selectMaterialTask, createTask: createMaterialTask, removeTask: removeMaterialTask,
        cancel: () => materialTracker.cancel(),
        resume: () => materialTracker.resume(),
        retryUnit: (unitId: string) => materialTracker.retryUnit(unitId),
        skipUnit: (unitId: string) => materialTracker.skipUnit(unitId),
        retryFailed: (unitIds: string[]) => materialTracker.changeFailedUnits("retry", unitIds),
        skipFailed: (unitIds: string[]) => materialTracker.changeFailedUnits("skip", unitIds),
        refresh: () => materialTracker.refresh(),
        dismiss: dismissMaterial,
    });

    // -----------------------------------------------------------------------
    // 来源切换：两侧状态一起重置，再恢复该来源最近的任务
    // -----------------------------------------------------------------------
    function resetForSource(): void {
        sourceGeneration += 1;
        outlineViewGeneration += 1;
        outlineListGeneration += 1;
        outlineTasks.value = [];
        outlineTasksLoading.value = false;
        outlineTasksError.value = null;
        validateToken += 1;
        validatedSignature = "";
        if (validateTimer !== null) clearTimeout(validateTimer);
        validateTimer = null;
        corrections.value = [];
        preview.value = null;
        preparedSource.value = null;
        structureMode.value = null;
        targetCharacters.value = "50000";
        previewError.value = null;
        correctionError.value = null;
        volumes.value = [];
        divisionError.value = null;
        divisionChecking.value = false;
        confirmedStructure.value = null;
        destinations.value = [];
        destination.value = {kind: "new"};
        paragraphText.value = new Map();
        sourceWarnings.value = [];
        sourceError.value = null;
        outlineTracker.clear();
        materialTracker.clear();
        outcome.value = null;
        outcomeError.value = null;
        classification.value = null;
        review.value = null;
        writeReport.value = null;
        pendingConflicts.value = [];
        materialError.value = null;
        startError.value = null;
        materialStartError.value = null;
        selectedBlocks.value = [];
        lastBlockAnchor.value = null;
        materialTasks.value = [];
        materialTasksError.value = null;
    }

    async function selectSource(path: string): Promise<void> {
        selectedPath.value = path;
        resetForSource();
        const projectPath = root();
        if (!path || !projectPath) return;
        workTitle.value = sourceTitle(path);
        const generation = sourceGeneration;
        const outlineGeneration = outlineViewGeneration;
        const [, , , listed] = await Promise.all([
            loadPreview(),
            loadDestinations(),
            api.prepareSource(projectPath, path).then(prepared => {
                if (generation !== sourceGeneration) return;
                preparedSource.value = prepared;
                selectedBlocks.value = prepared.chunks.map(chunk => chunk.index);
                paragraphText.value = new Map(prepared.paragraphs.map(paragraph => [paragraph.id, paragraph.text]));
                sourceWarnings.value = prepared.warnings;
            }).catch(() => undefined),
            api.listTasks(projectPath, {path}).catch(() => null),
        ]);
        if (generation !== sourceGeneration || !listed) return;
        const outlineTask = latestOfKind(listed.tasks, "outline");
        outlineTasks.value = listed.tasks.filter(task => task.kind === "outline");
        const materialCandidates = listed.tasks.filter(task => task.kind === "material");
        materialTasks.value = materialCandidates;
        const materialTask = latestOfKind(materialCandidates, "material");
        await Promise.all([
            outlineTask && outlineGeneration === outlineViewGeneration ? outlineTracker.adopt(outlineTask.id) : undefined,
            materialTask ? materialTracker.adopt(materialTask.id) : undefined,
        ]);
    }

    function dispose(): void {
        sourceGeneration += 1;
        outlineViewGeneration += 1;
        outlineListGeneration += 1;
        validateToken += 1;
        if (validateTimer !== null) clearTimeout(validateTimer);
        validateTimer = null;
        outlineTracker.dispose();
        materialTracker.dispose();
    }
    if (getCurrentInstance()) onBeforeUnmount(dispose);

    watch(() => root(), (value) => {
        selectedPath.value = "";
        preparedSource.value = null;
        resetForSource();
        sources.value = [];
        if (value) void loadSources();
    }, {immediate: true});

    return {sources, sourcesLoading, sourceError, sourceWarnings, selectedPath, preparedSource, selectedBlocks, loadSources, selectSource, outline, material, toggleBlock, selectAllBlocks, clearBlocks, invertBlocks, dispose};
}

export type InspirationExtraction = ReturnType<typeof useInspirationExtraction>;
export type OutlineController = InspirationExtraction["outline"];
export type MaterialController = InspirationExtraction["material"];
