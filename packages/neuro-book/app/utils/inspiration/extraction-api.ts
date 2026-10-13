import type {ExtractionStartRequestDto, ExtractionStructureConfirmResponseDto, ExtractionStructurePreviewResponseDto, ExtractionTaskDetailResponseDto, ExtractionTaskSummaryDto, MaterialConflictDecisionDto, MaterialReviewActionDto} from "nbook/shared/dto/inspiration-extraction-api.dto";
import type {ExtractionTask} from "nbook/shared/dto/inspiration-extraction-task.dto";
import type {ChapterCorrectionDto, VolumeDivisionDto} from "nbook/shared/dto/inspiration-outline-structure.dto";
import type {InspirationSourceListResponseDto, InspirationSourcePrepareResponseDto} from "nbook/shared/dto/inspiration-source.dto";
import type {ClassificationView} from "nbook/server/inspiration/extraction/material-consolidate";
import type {MaterialReview} from "nbook/server/inspiration/extraction/material-review";
import type {ConflictComparison, WriteReport} from "nbook/server/inspiration/extraction/material-write";
import type {OutlineDestinationOption} from "nbook/server/inspiration/extraction/outline-destination";
import type {OutlineExtractionOutcome} from "nbook/server/inspiration/extraction/outline-pipeline";
import type {ResummarizeResult} from "nbook/server/inspiration/extraction/outline-resummarize";

/**
 * 作品提取 `/api/inspiration/extraction/**` 的类型化客户端。
 *
 * 只描述 HTTP 往返：所有方法都显式带 `projectRoot`，不夹带任何“确认者”字段——
 * 素材写入的确认者由服务端按调用来源固定为用户。界面组件通过 `ExtractionApi` 注入请求入口，测试可整体替换。
 */

const BASE = "/api/inspiration/extraction";

export type StructurePreview = ExtractionStructurePreviewResponseDto;
export type StructureConfirmation = ExtractionStructureConfirmResponseDto;
export type ExtractionTaskDetail = ExtractionTaskDetailResponseDto;
export type ExtractionTaskSummary = ExtractionTaskSummaryDto;
export type {ConflictComparison, MaterialReview, OutlineDestinationOption, OutlineExtractionOutcome, ResummarizeResult, WriteReport, ClassificationView};

export type StructureRequest = Readonly<{path: string; corrections: readonly ChapterCorrectionDto[]; mode?: "chapters" | "chunks"; targetCharacters?: number}>;
export type OutlineInput = Readonly<{confirmedItems: ReadonlyArray<{chapterIndex: number; kind: "detail" | "outline"}>}>;
export type ClassificationInput = Readonly<{skip?: boolean; groups?: ReadonlyArray<{category: string; folders: readonly string[]}>}>;
export type ExtractionInput = OutlineInput | ClassificationInput;

export interface ExtractionApi {
    listSources(projectRoot: string): Promise<InspirationSourceListResponseDto>;
    prepareSource(projectRoot: string, path: string): Promise<InspirationSourcePrepareResponseDto>;
    previewStructure(projectRoot: string, request: StructureRequest): Promise<StructurePreview>;
    confirmStructure(projectRoot: string, request: StructureRequest & {division: VolumeDivisionDto}): Promise<StructureConfirmation>;
    listDestinations(projectRoot: string, path: string): Promise<{source: {path: string; sha256: string}; options: OutlineDestinationOption[]}>;
    listTasks(projectRoot: string, filter?: {kind?: "outline" | "material"; path?: string}): Promise<{tasks: ExtractionTaskSummary[]}>;
    startTask(request: ExtractionStartRequestDto): Promise<{task: ExtractionTask}>;
    getTask(projectRoot: string, taskId: string): Promise<ExtractionTaskDetail>;
    removeTask(projectRoot: string, taskId: string): Promise<{deleted: true; taskId: string}>;
    cancel(projectRoot: string, taskId: string): Promise<unknown>;
    resume(projectRoot: string, taskId: string): Promise<unknown>;
    retryUnit(projectRoot: string, taskId: string, unitId: string): Promise<unknown>;
    skipUnit(projectRoot: string, taskId: string, unitId: string): Promise<unknown>;
    changeFailedUnits(projectRoot: string, taskId: string, action: "retry" | "skip", unitIds: readonly string[]): Promise<unknown>;
    provideInput(projectRoot: string, taskId: string, input: ExtractionInput): Promise<unknown>;
    getOutlineOutcome(projectRoot: string, taskId: string): Promise<OutlineExtractionOutcome>;
    resummarize(projectRoot: string, taskId: string): Promise<ResummarizeResult>;
    getClassification(projectRoot: string, taskId: string): Promise<ClassificationView>;
    getReview(projectRoot: string, taskId: string): Promise<MaterialReview>;
    reviewAction(projectRoot: string, taskId: string, action: MaterialReviewActionDto): Promise<MaterialReview>;
    getConflicts(projectRoot: string, taskId: string): Promise<ConflictComparison[]>;
    confirmWrite(projectRoot: string, taskId: string, decisions?: readonly MaterialConflictDecisionDto[]): Promise<WriteReport>;
}

/** 默认实现读取全局 `$fetch`：Nuxt 运行时由自动导入提供，测试用 `vi.stubGlobal` 替换。 */
export function createExtractionApi(): ExtractionApi {
    const post = <T>(path: string, body: Record<string, unknown>): Promise<T> => $fetch<T>(`${BASE}${path}`, {method: "POST", body});
    const get = <T>(path: string, query: Record<string, unknown>): Promise<T> => $fetch<T>(`${BASE}${path}`, {query});
    const task = (taskId: string, suffix = "") => `/tasks/${encodeURIComponent(taskId)}${suffix}`;
    return {
        listSources: projectRoot => $fetch<InspirationSourceListResponseDto>("/api/inspiration/sources", {query: {projectRoot}}),
        prepareSource: (projectRoot, path) => $fetch<InspirationSourcePrepareResponseDto>("/api/inspiration/source-prepare", {method: "POST", body: {projectRoot, path}}),
        previewStructure: (projectRoot, request) => post("/structure", {projectRoot, ...request}),
        confirmStructure: (projectRoot, request) => post("/structure-confirm", {projectRoot, ...request}),
        listDestinations: (projectRoot, path) => get("/outline/destinations", {projectRoot, path}),
        listTasks: (projectRoot, filter) => get("/tasks", {projectRoot, ...filter}),
        startTask: request => post("/tasks", request),
        getTask: (projectRoot, taskId) => get(task(taskId), {projectRoot}),
        removeTask: (projectRoot, taskId) => $fetch<{deleted: true; taskId: string}>(`${BASE}${task(taskId)}`, {method: "DELETE", body: {projectRoot}}),
        cancel: (projectRoot, taskId) => post(task(taskId, "/cancel"), {projectRoot}),
        resume: (projectRoot, taskId) => post(task(taskId, "/resume"), {projectRoot}),
        retryUnit: (projectRoot, taskId, unitId) => post(task(taskId, "/retry-unit"), {projectRoot, unitId}),
        skipUnit: (projectRoot, taskId, unitId) => post(task(taskId, "/skip-unit"), {projectRoot, unitId}),
        changeFailedUnits: (projectRoot, taskId, action, unitIds) => post(task(taskId, "/failed-units"), {projectRoot, action, unitIds}),
        provideInput: (projectRoot, taskId, input) => post(task(taskId, "/input"), {projectRoot, input}),
        getOutlineOutcome: (projectRoot, taskId) => get(task(taskId, "/outline"), {projectRoot}),
        resummarize: (projectRoot, taskId) => post(task(taskId, "/outline/resummarize"), {projectRoot}),
        getClassification: (projectRoot, taskId) => get(task(taskId, "/material/classification"), {projectRoot}),
        getReview: (projectRoot, taskId) => get(task(taskId, "/material/review"), {projectRoot}),
        reviewAction: (projectRoot, taskId, action) => post(task(taskId, "/material/review/action"), {projectRoot, action}),
        getConflicts: (projectRoot, taskId) => get(task(taskId, "/material/review/conflicts"), {projectRoot}),
        confirmWrite: (projectRoot, taskId, decisions) => post(task(taskId, "/material/confirm-write"), {projectRoot, ...(decisions?.length ? {decisions} : {})}),
    };
}
