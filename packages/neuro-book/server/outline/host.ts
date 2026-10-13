import {consola} from "consola";
import fs from "node:fs/promises";
import path from "node:path";
import {requireActiveReadyProject, requireReadyModuleHandle, runReadyProjectOperation} from "nbook/server/workspace-files/project-session";
import type {ProjectWorkspaceRef} from "nbook/server/workspace-files/project-identity";
import type {ReadyProjectSessionRef} from "nbook/server/workspace-files/project-session-types";
import {PROJECT_FILE_INDEX_MODULE_TOKEN} from "nbook/server/workspace-files/project-file-index";
import {PROJECT_HISTORY_MODULE_TOKEN, recordProjectDelete, recordProjectRename, recordProjectWrite} from "nbook/server/workspace-history/project-history";
import type {OperationActor} from "@notnotype/nb-history";
import {TextEncoder} from "node:util";
import {createEmptyManifest, serializeManifest, type OutlineId, type OutlineManifest} from "./format";
import {assertNonDestructivePlanningEdit, assertPlanningUndoCandidate, publishForeshadowingMarkerRepairFiles, publishMissingEntryRepairFiles, publishPlanningFiles, readForeshadowingSnapshot, readLineInspectionSnapshot, readPlanningSnapshot, type PlanningMarkerIssue, type PlanningPublishInput, type PlanningSnapshot} from "./index";
import {preparePlanningFork} from "./fork";
import {prepareForeshadowingAction, type ForeshadowingAction} from "./foreshadowing";
import {prepareForeshadowingMarkerRepair, type ForeshadowingMarkerRepairAction} from "./foreshadowing-suggestions";
import {prepareAdaptationWorkspace, prepareLibraryAction, prepareSourceExtractionDetail, type AdaptationWorkspaceInput, type EntryMetadataPatch, type LibraryAction, type SourceExtractionDetail} from "./library";
import {prepareLineAction, previewGraphDeletion, type GraphDeletionTarget, type LineAction} from "./line-planning";
import {OutlineLineError} from "./line-planning";
import {prepareMissingEntryRepair, type MissingEntryRepair} from "./line-repair";
import {analyzeLine, confirmLine, inspectFixedLine, lineAnalysisContext, readValidFixedLineNodes, type IssuedLineReport, type LineAnalysisRequest, type LineResolution} from "./line-analysis";
import {generateDirectionDraft, type DirectionInput} from "./direction";
import {readWriterChapterContext, readWriterChapterDirectory, sameWriterChapterBasis, type WriterChapterContextRequest} from "./writer-context";
import {readSelectedWriterMaterials} from "./writer-materials";
import {analyzeDetail, confirmDetail, detailAnalysisContext, type DetailAnalysisRequest,
    type DetailResolution, type IssuedDetailReport} from "./detail-analysis";
import {OutlineLibraryError} from "./library";
import {invalidateDependentDetails as preparePlanningPublication} from "./analysis-invalidation";
import {completeDirectionWithModel} from "./direction-model";
import {inspectPlanningObject, inspectPlanningPlacement, inspectPlanningPlan, preparePlanningObjectDeletion, preparePlanningPlacementRemoval, preparePlanningPlanRemoval} from "./operations";
import {rebuildPlanningIndex} from "./planning-index";
import {createOutlineRepository} from "./repository";
import {hashText, OutlineTransactionError, recoverOutlineTransactions, resolveOutlinePath, undoOutlineTransaction, type OutlinePublishReceipt, type OutlineTransactionOptions, type OutlineUndoResult, type OutlineRecoveryResult} from "./transaction";

/** 预览与提交使用同一纯准备函数，包含上游改动引发的细纲和线路失效。 */
export {preparePlanningPublication};

/** 产品入口从当前 Project 获取精确 generation；关闭重开后旧 ready 不能再用于新调用。 */
export function openProjectPlanning(ref: ProjectWorkspaceRef): Promise<PlanningSnapshot> {
    return openReadyPlanning(requireActiveReadyProject(ref));
}

export function publishProjectPlanning(ref: ProjectWorkspaceRef, input: PlanningPublishInput, actor: OperationActor): Promise<OutlinePublishReceipt> {
    return publishReadyPlanningFiles(requireActiveReadyProject(ref), input, actor);
}

export function undoProjectPlanning(ref: ProjectWorkspaceRef, transactionId: string, actor: OperationActor): Promise<OutlineUndoResult> {
    return undoReadyPlanningFiles(requireActiveReadyProject(ref), transactionId, actor);
}

async function withReadyMutation<T>(
    ready: ReadyProjectSessionRef,
    operation: (options: OutlineTransactionOptions) => Promise<T>,
): Promise<T> {
    return runReadyProjectOperation(ready, async (_signal, assertTarget, revalidateTarget) => {
        const fileIndex = requireReadyModuleHandle(ready, PROJECT_FILE_INDEX_MODULE_TOKEN);
        return fileIndex.mutate(async () => {
            await revalidateTarget();
            assertTarget();
            const options: OutlineTransactionOptions = {
                projectRoot: ready.workspace.root,
                projectGeneration: ready.publicId,
                readProjectGeneration: async () => {
                    await revalidateTarget();
                    assertTarget();
                    return ready.publicId;
                },
                beforePublishFile: async () => {
                    await revalidateTarget();
                    assertTarget();
                },
                beforeUndoFile: async () => {
                    await revalidateTarget();
                    assertTarget();
                },
            };
            return operation(options);
        });
    });
}

/** 打开时先恢复 journal；缺失的初始 manifest 只能由显式 ready Project 初始化。 */
export function openReadyPlanning(ready: ReadyProjectSessionRef): Promise<PlanningSnapshot> {
    return withReadyMutation(ready, async (options) => {
        await recoverOutlineTransactions(options.projectRoot);
        const manifestPath = path.join(options.projectRoot, "outline", "manifest.yaml");
        const present = await fs.stat(manifestPath).then(() => true, (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
        });
        if (!present) {
            const transactions = await fs.readdir(path.join(options.projectRoot, ".nbook", "outline-transactions")).catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return [];
                throw error;
            });
            if (transactions.length > 0) throw new Error("规划 manifest 丢失，但项目已有规划事务，拒绝重新初始化");
            for (const directory of ["entries", "foreshadowing", "graphs", "storylines"]) {
                const names = await fs.readdir(path.join(options.projectRoot, "outline", directory)).catch((error: NodeJS.ErrnoException) => {
                    if (error.code === "ENOENT") return [];
                    throw error;
                });
                if (names.length > 0) throw new Error("规划 manifest 丢失，但仍存在规划对象，拒绝初始化覆盖");
            }
            const initial = serializeManifest(createEmptyManifest());
            await createOutlineRepository(options).ensureLayout(initial);
            const history = requireReadyModuleHandle(ready, PROJECT_HISTORY_MODULE_TOKEN);
            await recordProjectWrite(history, {relativePath: "outline/manifest.yaml", actor: {kind: "user", userId: "local"}, before: null, after: new TextEncoder().encode(initial)}).catch((error: unknown) => {
                consola.warn({error}, "规划初始 manifest 已提交，但历史记账需要对账修复");
            });
        }
        const snapshot = await readPlanningSnapshot(options);
        await rebuildPlanningIndex(options).catch((error: unknown) => {
            consola.warn({error}, "规划索引刷新失败；规范文件已提交，可重新从文件构建索引");
        });
        return snapshot;
    });
}

/**
 * 在 mutation gate 内读取规范快照，不恢复 journal、不重建索引。
 * 提取流水线每个单元都要读快照；`openReadyPlanning` 每次都重建索引，对长任务过重。
 */
export function readReadyPlanningSnapshot(ready: ReadyProjectSessionRef): Promise<PlanningSnapshot> {
    return withReadyMutation(ready, options => readPlanningSnapshot(options));
}

/** 恢复入口只在同一 Project generation 的 mutation gate 中运行。 */
export function recoverReadyPlanning(ready: ReadyProjectSessionRef): Promise<OutlineRecoveryResult> {
    return withReadyMutation(ready, async (options) => {
        const result = await recoverOutlineTransactions(options.projectRoot);
        await rebuildPlanningIndex(options).catch((error: unknown) => {
            consola.warn({error}, "规划索引刷新失败；规范文件已提交，可重新从文件构建索引");
        });
        return result;
    });
}

/** 删除预览与提交均在 ready Project mutation gate 内读取当前规范文件。 */
export function previewReadyPlanningObjectDeletion(ready: ReadyProjectSessionRef, targetId: OutlineId) {
    return withReadyMutation(ready, async (options) => {
        const snapshot = await readPlanningSnapshot(options);
        const impact = inspectPlanningObject(snapshot, targetId);
        const objectHash = [...snapshot.entries, ...snapshot.foreshadowing, ...snapshot.graphs, ...snapshot.lines]
            .find((item) => item.value.id === targetId)?.contentHash ?? null;
        return {revision: snapshot.manifest.revision, objectHash, impact};
    });
}

export function previewReadyPlanningPlacementRemoval(ready: ReadyProjectSessionRef, planId: string, targetId: OutlineId) {
    return withReadyMutation(ready, async (options) => {
        const snapshot = await readPlanningSnapshot(options);
        return {revision: snapshot.manifest.revision, impact: inspectPlanningPlacement(snapshot, planId, targetId)};
    });
}

export function removeReadyPlanningObject(
    ready: ReadyProjectSessionRef, targetId: OutlineId, expectedRevision: number,
    expectedObjectHash: string, confirmedTotal: boolean, actor: OperationActor,
): Promise<OutlinePublishReceipt> {
    return withReadyMutation(ready, async (options) => {
        const snapshot = await readPlanningSnapshot(options);
        if (snapshot.manifest.revision !== expectedRevision) throw new OutlineTransactionError("CAS_CONFLICT", "删除预览已过期，请重新预览");
        const current = [...snapshot.entries, ...snapshot.foreshadowing, ...snapshot.graphs, ...snapshot.lines]
            .find((item) => item.value.id === targetId);
        if (!current || current.contentHash !== expectedObjectHash) throw new OutlineTransactionError("CAS_CONFLICT", "删除对象已变化，请重新预览");
        const input = await preparePlanningObjectDeletion(options, targetId, confirmedTotal);
        return commitPlanningFiles(ready, options, input, actor, true);
    });
}

export function removeReadyPlanningPlacement(
    ready: ReadyProjectSessionRef, planId: string, targetId: OutlineId,
    expectedRevision: number, actor: OperationActor,
): Promise<OutlinePublishReceipt> {
    return withReadyMutation(ready, async (options) => {
        const {publish} = await preparePlanningPlacementRemoval(options, planId, targetId);
        if (publish.expectedManifestRevision !== expectedRevision) throw new OutlineTransactionError("CAS_CONFLICT", "关系删除预览已过期，请重新预览");
        return commitPlanningFiles(ready, options, publish, actor, true);
    });
}

/** 方案删除独立于对象删除；预览提供专属条目和失去作用域的固定线路。 */
export function previewReadyPlanningPlanRemoval(ready: ReadyProjectSessionRef, planId: string) {
    return withReadyMutation(ready, async (options) => {
        const snapshot = await readPlanningSnapshot(options);
        return {revision: snapshot.manifest.revision, impact: inspectPlanningPlan(snapshot, planId)};
    });
}

export function removeReadyPlanningPlan(
    ready: ReadyProjectSessionRef, planId: string, expectedRevision: number, actor: OperationActor,
): Promise<OutlinePublishReceipt> {
    return withReadyMutation(ready, async (options) => {
        const snapshot = await readPlanningSnapshot(options);
        if (snapshot.manifest.revision !== expectedRevision) throw new OutlineTransactionError("CAS_CONFLICT", "方案删除预览已过期，请重新预览");
        return commitPlanningFiles(ready, options, preparePlanningPlanRemoval(snapshot, planId), actor, true);
    });
}

/** Phase 2 的结构化入口在 ready gate 内生成并提交同一份规范快照。 */
export function applyReadyLibraryAction(
    ready: ReadyProjectSessionRef, action: LibraryAction, expectedRevision: number, actor: OperationActor, creationSeed?: string,
): Promise<Readonly<{transactionId: string; entryId?: OutlineId; planId?: string}>> {
    return withReadyMutation(ready, async (options) => {
        const snapshot = await readPlanningSnapshot(options);
        if (snapshot.manifest.revision !== expectedRevision) throw new OutlineTransactionError("MANIFEST_REVISION_CONFLICT", "方案链已变化，请重新读取");
        const change = prepareLibraryAction(snapshot, action, creationSeed);
        const receipt = await commitPlanningFiles(ready, options, change.publish, actor, true);
        return {transactionId: receipt.transactionId, ...(change.entryId ? {entryId: change.entryId} : {}), ...(change.planId ? {planId: change.planId} : {})};
    });
}

/** 改编工作区的结构创建入口；四个规划文件在同一 mutation gate 中提交。 */
export function prepareReadyAdaptationWorkspace(
    ready: ReadyProjectSessionRef, input: AdaptationWorkspaceInput, actor: OperationActor,
): Promise<Readonly<{transactionId: string; planId: string; volumeId: OutlineId; chapterId: OutlineId}>> {
    return withReadyMutation(ready, async (options) => {
        const snapshot = await readPlanningSnapshot(options);
        const change = prepareAdaptationWorkspace(snapshot, input);
        const receipt = await commitPlanningFiles(ready, options, change.publish, actor, true);
        return {transactionId: receipt.transactionId, planId: change.planId!, volumeId: change.volumeId, chapterId: change.chapterId};
    });
}

/**
 * 提取流水线写入来源提取细纲的唯一宿主入口：与 `applyReadyLibraryAction` 同样在 ready gate 内生成并提交，
 * 但它不是 LibraryAction，因此 HTTP 与 Agent 的动作 schema 到不了这里。
 */
export function applyReadySourceExtractionDetail(
    ready: ReadyProjectSessionRef, input: SourceExtractionDetail, expectedRevision: number, actor: OperationActor,
): Promise<Readonly<{transactionId: string; entryId: OutlineId}>> {
    return withReadyMutation(ready, async (options) => {
        const snapshot = await readPlanningSnapshot(options);
        if (snapshot.manifest.revision !== expectedRevision) throw new OutlineTransactionError("MANIFEST_REVISION_CONFLICT", "方案链已变化，请重新读取");
        const change = prepareSourceExtractionDetail(snapshot, input);
        const receipt = await commitPlanningFiles(ready, options, change.publish, actor, true);
        return {transactionId: receipt.transactionId, entryId: change.entryId!};
    });
}

/**
 * 损坏标记的修复必须从容错只读诊断进入，并在发布时要求候选章节重新严格解析。
 * 普通 library-action 仍使用严格快照，避免把损坏源当成常规编辑入口。
 */
export function repairReadyForeshadowingMarker(
    ready: ReadyProjectSessionRef, input: ForeshadowingMarkerRepairAction, actor: OperationActor,
): Promise<Readonly<{transactionId: string; entryId: OutlineId}>> {
    return withReadyMutation(ready, async (options) => {
        const {snapshot, markerIssues} = await readForeshadowingSnapshot(options);
        if (snapshot.manifest.revision !== input.expectedRevision) {
            throw new OutlineTransactionError("MANIFEST_REVISION_CONFLICT", "伏笔标记修复预览已过期，请重新读取");
        }
        const change = prepareForeshadowingMarkerRepair(snapshot, markerIssues, input);
        const source = snapshot.entries.find(({value}) => value.id === input.entryId);
        if (!source) throw new OutlineLibraryError("待修复章节不存在");
        const receipt = await commitPlanningFiles(ready, options, change.publish, actor, true, undefined, {markerPath: source.path, snapshot});
        return {transactionId: receipt.transactionId, entryId: input.entryId};
    });
}

/** 只读返回损坏章节的诊断与待写文件摘要；预览不写入规范文件。 */
export function previewReadyForeshadowingMarkerRepair(
    ready: ReadyProjectSessionRef, input: ForeshadowingMarkerRepairAction,
): Promise<Readonly<{revision: number; markerIssues: readonly PlanningMarkerIssue[]; files: readonly Readonly<{relativePath: string; contentHash: string | null; bytes: number}>[]}>> {
    return withReadyMutation(ready, async (options) => {
        const {snapshot, markerIssues} = await readForeshadowingSnapshot(options);
        if (snapshot.manifest.revision !== input.expectedRevision) {
            throw new OutlineTransactionError("MANIFEST_REVISION_CONFLICT", "伏笔标记修复预览已过期，请重新读取");
        }
        const change = prepareForeshadowingMarkerRepair(snapshot, markerIssues, input);
        return {
            revision: snapshot.manifest.revision,
            markerIssues,
            files: change.publish.mutations.map((mutation) => ({
                relativePath: mutation.relativePath,
                contentHash: mutation.content === null ? null : hashText(mutation.content),
                bytes: mutation.content === null ? 0 : Buffer.byteLength(mutation.content),
            })),
        };
    });
}

/** 伏笔定义的版本检查和规范文件提交共用 Project mutation gate。 */
export function applyReadyForeshadowingAction(
    ready: ReadyProjectSessionRef, action: ForeshadowingAction, expectedRevision: number, actor: OperationActor, creationSeed?: string,
): Promise<Readonly<{transactionId: string; foreshadowingId: OutlineId}>> {
    return withReadyMutation(ready, async (options) => {
        const snapshot = await readPlanningSnapshot(options);
        if (snapshot.manifest.revision !== expectedRevision) throw new OutlineTransactionError("MANIFEST_REVISION_CONFLICT", "伏笔库已变化，请重新读取");
        const change = prepareForeshadowingAction(snapshot, action, creationSeed);
        const receipt = await commitPlanningFiles(ready, options, change.publish, actor, true);
        return {transactionId: receipt.transactionId, foreshadowingId: change.id};
    });
}

/** 删除预览只读规范快照，提交入口仍会在 mutation gate 中重新计算影响。 */
export function previewReadyGraphDeletion(ready: ReadyProjectSessionRef, target: GraphDeletionTarget) {
    return runReadyProjectOperation(ready, async (_signal, assertTarget, revalidateTarget) => {
        await revalidateTarget();
        assertTarget();
        const snapshot = await readPlanningSnapshot({projectRoot: ready.workspace.root});
        const impact = previewGraphDeletion(snapshot, target);
        await revalidateTarget();
        assertTarget();
        return impact;
    });
}

/** 线路图与线路的领域变更走 ready Project 的 manifest CAS、文件事务与 History 归因。 */
export function applyReadyLineAction(
    ready: ReadyProjectSessionRef, action: LineAction, expectedRevision: number, actor: OperationActor, creationSeed?: string,
): Promise<Readonly<{transactionId: string; planId: string; lineId?: OutlineId; graphId?: OutlineId; nodeId?: OutlineId; edgeId?: OutlineId}>> {
    return withReadyMutation(ready, async (options) => {
        const snapshot = await readPlanningSnapshot(options);
        if (snapshot.manifest.revision !== expectedRevision) throw new OutlineTransactionError("MANIFEST_REVISION_CONFLICT", "线路已变化，请重新读取");
        const change = prepareLineAction(snapshot, action, creationSeed);
        const receipt = await commitPlanningFiles(ready, options, change.publish, actor, true);
        const {publish: _publish, ...ids} = change;
        return {transactionId: receipt.transactionId, ...ids};
    });
}

/** 展示当前规范快照中的节点有效性，不缓存黄色／红色推导状态。 */
export function inspectReadyLine(ready: ReadyProjectSessionRef, lineId: OutlineId) {
    return runReadyProjectOperation(ready, async (_signal, assertTarget, revalidateTarget) => {
        await revalidateTarget();
        assertTarget();
        const snapshot = await readLineInspectionSnapshot({projectRoot: ready.workspace.root});
        const source = snapshot.lines.find(({value}) => value.id === lineId);
        const inspected = inspectFixedLine(snapshot, lineId);
        await revalidateTarget();
        assertTarget();
        return {revision: snapshot.manifest.revision, version: source!.value.version,
            contentHash: source!.contentHash, ...inspected};
    });
}

/** 正文交接使用当前 ready generation，并对调用者持有的版本执行 CAS，拒绝部分有效的线路。 */
export function readReadyFixedLineNodes(ready: ReadyProjectSessionRef, input: LineAnalysisRequest) {
    return runReadyProjectOperation(ready, async (_signal, assertTarget, revalidateTarget) => {
        await revalidateTarget();
        assertTarget();
        const snapshot = await readPlanningSnapshot({projectRoot: ready.workspace.root});
        const source = snapshot.lines.find(({value}) => value.id === input.lineId);
        if (!source) throw new OutlineLineError("线路不存在");
        if (snapshot.manifest.revision !== input.expectedRevision || source.value.version !== input.expectedVersion
            || source.contentHash !== input.expectedContentHash) {
            throw new OutlineLineError("规划版本已变化，请重新读取", "CAS_CONFLICT");
        }
        const nodes = readValidFixedLineNodes(snapshot, input.lineId);
        await revalidateTarget();
        assertTarget();
        return {lineId: input.lineId, revision: snapshot.manifest.revision,
            version: source.value.version, contentHash: source.contentHash, nodes};
    });
}

/** 只读正文交接仍由 ready Project 持有代际门禁，不让调用者传入任意路径。 */
export function readReadyWriterChapterDirectory(ready: ReadyProjectSessionRef, input: Readonly<{planId: string}>) {
    return runReadyProjectOperation(ready, async (_signal, assertTarget, revalidateTarget) => {
        await revalidateTarget();
        assertTarget();
        const directory = readWriterChapterDirectory(await readPlanningSnapshot({projectRoot: ready.workspace.root}), input);
        await revalidateTarget();
        assertTarget();
        return directory;
    });
}

export function readReadyWriterChapterContext(ready: ReadyProjectSessionRef, input: WriterChapterContextRequest, materialPaths?: readonly string[]) {
    return runReadyProjectOperation(ready, async (_signal, assertTarget, revalidateTarget) => {
        await revalidateTarget();
        assertTarget();
        const snapshot = await readPlanningSnapshot({projectRoot: ready.workspace.root});
        const context = readWriterChapterContext(snapshot, input);
        const materials = materialPaths === undefined ? undefined
            : await readSelectedWriterMaterials(ready.workspace.root, context, materialPaths);
        if (materials !== undefined) {
            // 素材读取期间规划可能由外部程序改写；返回前再验证资格，且素材来源必须对应同一份依据。
            const after = readWriterChapterContext(await readPlanningSnapshot({projectRoot: ready.workspace.root}), input);
            if (!sameWriterChapterBasis(after.basis, context.basis)) {
                throw new OutlineLineError("规划在素材读取期间已变化，请重新读取", "CAS_CONFLICT");
            }
        }
        await revalidateTarget();
        assertTarget();
        return materials === undefined ? context : {...context, materials};
    });
}

// 同一 ready generation 内签发的草稿线路报告不能跨项目重开复用。
const issuedLineReports = new WeakMap<ReadyProjectSessionRef, Map<OutlineId, IssuedLineReport>>();

export function analyzeReadyLine(ready: ReadyProjectSessionRef, input: LineAnalysisRequest): Promise<IssuedLineReport> {
    return runReadyProjectOperation(ready, async (signal, assertTarget, revalidateTarget) => {
        await revalidateTarget();
        assertTarget();
        const snapshot = await readPlanningSnapshot({projectRoot: ready.workspace.root});
        const issued = await analyzeLine(snapshot, input, (prompt) => completeDirectionWithModel(ready, prompt, signal, "outline.line-analysis"));
        await revalidateTarget();
        assertTarget();
        const current = await readPlanningSnapshot({projectRoot: ready.workspace.root});
        // 分析期间任何规范 revision 变化都需重新分析，避免将报告附着于不同事务。
        if (lineAnalysisContext(current, input).contextHash !== issued.report.contextHash) {
            throw new OutlineLineError("线路分析期间上下文已变化，请重新分析", "CAS_CONFLICT");
        }
        const reports = issuedLineReports.get(ready) ?? new Map<OutlineId, IssuedLineReport>();
        reports.set(input.lineId, issued);
        issuedLineReports.set(ready, reports);
        return issued;
    });
}

export function fixReadyLine(ready: ReadyProjectSessionRef, input: LineAnalysisRequest, reportId: string,
    resolutions: readonly LineResolution[], actor: OperationActor): Promise<Readonly<{transactionId: string; lineId: OutlineId}>> {
    return withReadyMutation(ready, async (options) => {
        const issued = issuedLineReports.get(ready)?.get(input.lineId);
        if (!issued) throw new OutlineLineError("没有当前会话签发的线路分析，请重新分析", "CAS_CONFLICT");
        const snapshot = await readPlanningSnapshot(options);
        const publish = confirmLine(snapshot, input, issued, reportId, resolutions);
        const receipt = await commitPlanningFiles(ready, options, publish, actor, true);
        issuedLineReports.get(ready)?.delete(input.lineId);
        return {transactionId: receipt.transactionId, lineId: input.lineId};
    });
}

// 报告签发仅在当前 ready generation 内有效；重开后仍可读已采用报告，未采用的需重新分析。
const issuedDetailReports = new WeakMap<ReadyProjectSessionRef, Map<OutlineId, IssuedDetailReport>>();

export function analyzeReadyDetail(ready: ReadyProjectSessionRef, input: DetailAnalysisRequest): Promise<IssuedDetailReport> {
    return runReadyProjectOperation(ready, async (signal, assertTarget, revalidateTarget) => {
        await revalidateTarget();
        assertTarget();
        const snapshot = await readPlanningSnapshot({projectRoot: ready.workspace.root});
        const issued = await analyzeDetail(snapshot, input, (prompt) => completeDirectionWithModel(ready, prompt, signal, "outline.detail-analysis"));
        await revalidateTarget();
        assertTarget();
        const current = await readPlanningSnapshot({projectRoot: ready.workspace.root});
        if (detailAnalysisContext(current, input).contextHash !== issued.report.contextHash) {
            throw new OutlineLibraryError("分析期间方案上下文已变化，请重新分析", "CAS_CONFLICT");
        }
        const reports = issuedDetailReports.get(ready) ?? new Map<OutlineId, IssuedDetailReport>();
        reports.set(input.entryId, issued);
        issuedDetailReports.set(ready, reports);
        return issued;
    });
}

export function adoptReadyDetail(
    ready: ReadyProjectSessionRef, input: DetailAnalysisRequest, reportId: string, confirmDeviations: boolean,
    resolutions: readonly DetailResolution[], actor: OperationActor,
): Promise<Readonly<{transactionId: string; entryId: OutlineId}>> {
    return withReadyMutation(ready, async (options) => {
        const issued = issuedDetailReports.get(ready)?.get(input.entryId);
        if (!issued) throw new OutlineLibraryError("没有当前会话签发的细纲分析，请重新分析", "CAS_CONFLICT");
        const snapshot = await readPlanningSnapshot(options);
        const change = confirmDetail(snapshot, input, issued, reportId, confirmDeviations, resolutions);
        const receipt = await commitPlanningFiles(ready, options, change.publish, actor, true);
        issuedDetailReports.get(ready)?.delete(input.entryId);
        return {transactionId: receipt.transactionId, entryId: input.entryId};
    });
}

/** 生成只读建议；调用者必须审阅后使用独立的 create-entry 领域入口提交。 */
export function generateReadyDirectionDraft(ready: ReadyProjectSessionRef, input: DirectionInput) {
    return runReadyProjectOperation(ready, async (signal, assertTarget, revalidateTarget) => {
        await revalidateTarget();
        assertTarget();
        const snapshot = await readPlanningSnapshot({projectRoot: ready.workspace.root});
        const draft = await generateDirectionDraft(snapshot, input, (prompt) => completeDirectionWithModel(ready, prompt, signal));
        await revalidateTarget();
        assertTarget();
        return draft;
    });
}
export function forkReadyLibraryEntry(
    ready: ReadyProjectSessionRef,
    input: Readonly<{planId: string; sourceId: OutlineId; title: string; body: string; expectedRevision: number} & EntryMetadataPatch>,
    actor: OperationActor,
): Promise<Readonly<{transactionId: string; entryId: OutlineId}>> {
    return withReadyMutation(ready, async (options) => {
        const snapshot = await readPlanningSnapshot(options);
        if (snapshot.manifest.revision !== input.expectedRevision) throw new OutlineTransactionError("MANIFEST_REVISION_CONFLICT", "共享引用已变化，请重新读取");
        const fork = await preparePlanningFork(options, input);
        const receipt = await commitPlanningFiles(ready, options, fork.publish, actor, true);
        return {transactionId: receipt.transactionId, entryId: fork.id};
    });
}
/** 只对唯一缺失叶条目开放受限修复，普通发布仍须完整旧快照。 */
export function repairReadyMissingEntry(
    ready: ReadyProjectSessionRef, input: MissingEntryRepair, actor: OperationActor,
): Promise<OutlinePublishReceipt> {
    return withReadyMutation(ready, async (options) => {
        const snapshot = await readLineInspectionSnapshot(options);
        const publish = prepareMissingEntryRepair(snapshot, input);
        const missing = snapshot.manifest.entries.find(({id}) => id === input.missingEntryId)!;
        return commitPlanningFiles(ready, options, publish, actor, true, {snapshot, missing});
    });
}

/** 发布后 History 按已提交的规范字节记账；派生索引失败不反向回滚已提交文件。 */
export function publishReadyPlanningFiles(ready: ReadyProjectSessionRef, input: PlanningPublishInput, actor: OperationActor): Promise<OutlinePublishReceipt> {
    return withReadyMutation(ready, (options) => commitPlanningFiles(ready, options, input, actor, false));
}

async function commitPlanningFiles(
    ready: ReadyProjectSessionRef, options: OutlineTransactionOptions,
    input: PlanningPublishInput, actor: OperationActor, trustedDomainMutation: boolean,
    recovery?: Readonly<{snapshot: PlanningSnapshot; missing: OutlineManifest["entries"][number]}>,
    markerRepair?: Readonly<{markerPath: string; snapshot: PlanningSnapshot}>,
): Promise<OutlinePublishReceipt> {
    const snapshot = recovery?.snapshot ?? markerRepair?.snapshot ?? await readPlanningSnapshot(options);
    if (!trustedDomainMutation) assertNonDestructivePlanningEdit(snapshot, input);
    const publishInput = trustedDomainMutation ? preparePlanningPublication(snapshot, input) : input;
    const history = requireReadyModuleHandle(ready, PROJECT_HISTORY_MODULE_TOKEN);
    const before = new Map((await createOutlineRepository(options).readCanonicalFiles()).map((file) => [file.relativePath, file.content]));
    const publishOptions = {...options, beforePublishFile: async (relativePath: string) => {
        await options.beforePublishFile?.(relativePath);
        if (!relativePath.startsWith("outline/")) await capturePlanningFile(options.projectRoot, relativePath, before);
    }};
    const receipt = recovery
        ? await publishMissingEntryRepairFiles(publishOptions, publishInput, recovery.missing)
        : markerRepair
            ? await publishForeshadowingMarkerRepairFiles(publishOptions, publishInput, markerRepair.markerPath)
            : await publishPlanningFiles(publishOptions, publishInput);
    const after = new Map(before);
    for (const mutation of publishInput.mutations) {
        if (mutation.content === null) after.delete(mutation.relativePath);
        else after.set(mutation.relativePath, mutation.content);
    }
    try {
        for (const relativePath of receipt.files.filter((relativePath) => !relativePath.startsWith("outline/"))) {
            await capturePlanningFile(options.projectRoot, relativePath, after);
        }
        await attributeFiles(history, actor, receipt.files, before, after);
    } catch (error) {
        consola.warn({error}, "规划文件已提交，但历史记账需要对账修复");
    }
    await rebuildPlanningIndex(options).catch((error: unknown) => {
        consola.warn({error}, "规划索引刷新失败；规范文件已提交，可重新从文件构建索引");
    });
    return receipt;
}

export function undoReadyPlanningFiles(ready: ReadyProjectSessionRef, transactionId: string, actor: OperationActor): Promise<OutlineUndoResult> {
    return withReadyMutation(ready, async (options) => {
        const history = requireReadyModuleHandle(ready, PROJECT_HISTORY_MODULE_TOKEN);
        const before = new Map((await createOutlineRepository(options).readCanonicalFiles()).map((file) => [file.relativePath, file.content]));
        const result = await undoOutlineTransaction({...options, beforeUndoFile: async (relativePath) => {
            await options.beforeUndoFile?.(relativePath);
            if (!relativePath.startsWith("outline/")) await capturePlanningFile(options.projectRoot, relativePath, before);
        }, validateUndoCandidate: async (originals) => {
            const byPath = new Map((await createOutlineRepository(options).readCanonicalFiles())
                .map((file) => [file.relativePath, file] as const));
            for (const {relativePath, content} of originals) {
                if (content === null) byPath.delete(relativePath);
                else byPath.set(relativePath, {relativePath, content, contentHash: hashText(content)});
            }
            try {
                assertPlanningUndoCandidate([...byPath.values()]);
            } catch (cause) {
                throw new OutlineTransactionError("CAS_CONFLICT", "撤销将恢复不完整的规划快照；请先恢复缺失文件或处理外部修改", {cause});
            }
        }}, transactionId);
        if (result.kind === "undone") {
            await createOutlineRepository(options).readCanonicalFiles().then(async (files) => {
                const after = new Map(files.map((file) => [file.relativePath, file.content]));
                for (const relativePath of result.files.filter((relativePath) => !relativePath.startsWith("outline/"))) {
                    await capturePlanningFile(options.projectRoot, relativePath, after);
                }
                await attributeFiles(history, actor, result.files, before, after);
            }).catch((error: unknown) => {
                consola.warn({error}, "规划撤销已提交，但历史记账需要对账修复");
            });
            await rebuildPlanningIndex(options).catch((error: unknown) => {
            consola.warn({error}, "规划索引刷新失败；规范文件已提交，可重新从文件构建索引");
        });
        }
        return result;
    });
}

async function capturePlanningFile(projectRoot: string, relativePath: string, files: Map<string, string>): Promise<void> {
    const content = await fs.readFile(await resolveOutlinePath(projectRoot, relativePath), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
    });
    if (content === null) files.delete(relativePath);
    else files.set(relativePath, content);
}

async function attributeFiles(
    history: Parameters<typeof recordProjectWrite>[0], actor: OperationActor, paths: readonly string[],
    before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>,
): Promise<void> {
    const encoder = new TextEncoder();
    const handled = new Set<string>();
    for (const fromPath of paths) {
        if (after.has(fromPath) || !before.has(fromPath)) continue;
        const original = before.get(fromPath);
        const suffix = fromPath.match(/--((?:ol|fo|ln)-[a-z0-9-]+)\.(?:md|yaml)$/u)?.[1];
        if (!suffix) continue;
        const toPath = paths.find((candidate) => candidate !== fromPath && !before.has(candidate)
            && after.get(candidate) === original && candidate.includes("--" + suffix + "."));
        if (!toPath) continue;
        await recordProjectRename(history, {fromPath, toPath, actor});
        handled.add(fromPath);
        handled.add(toPath);
    }
    for (const relativePath of paths) {
        if (handled.has(relativePath)) continue;
        const previous = before.get(relativePath);
        const next = after.get(relativePath);
        if (next === undefined) {
            if (previous === undefined) throw new Error(`规划删除缺少原文件：${relativePath}`);
            await recordProjectDelete(history, {relativePath, actor, before: encoder.encode(previous)});
        } else {
            await recordProjectWrite(history, {
                relativePath, actor, before: previous === undefined ? null : encoder.encode(previous), after: encoder.encode(next),
            });
        }
    }
}





