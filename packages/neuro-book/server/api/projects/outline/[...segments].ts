import {createError} from "h3";
import {z} from "zod";
import {requireProjectRefQuery} from "nbook/server/api/projects/project-control-plane";
import {withProjectHttpError} from "nbook/server/api/projects/project-http-error";
import {validateBody} from "nbook/server/utils/novel-chapter";
import {requireActiveReadyProject, runReadyProjectOperation} from "nbook/server/workspace-files/project-session";
import {FORESHADOW_MARKER_PARSER_VERSION, OutlineFormatError, type OutlineId} from "nbook/server/outline/format";
import {readForeshadowingSnapshot, readPlanningSnapshot} from "nbook/server/outline";
import {getLibraryTrees, OutlineLibraryError} from "nbook/server/outline/library";
import {OutlineLineError} from "nbook/server/outline/line-planning";
import {deriveForeshadowingElapsed, deriveForeshadowingStates} from "nbook/server/outline/foreshadowing";
import {OutlineGenerationError} from "nbook/server/outline/direction";
import {adoptReadyDetail, analyzeReadyDetail, analyzeReadyLine, fixReadyLine, inspectReadyLine, readReadyFixedLineNodes, readReadyWriterOutlineContext, applyReadyForeshadowingAction, applyReadyLibraryAction, applyReadyLineAction, forkReadyLibraryEntry, generateReadyDirectionDraft, openReadyPlanning, previewReadyForeshadowingMarkerRepair, previewReadyGraphDeletion, previewReadyPlanningObjectDeletion, previewReadyPlanningPlacementRemoval, previewReadyPlanningPlanRemoval, publishReadyPlanningFiles, repairReadyForeshadowingMarker, repairReadyMissingEntry, removeReadyPlanningObject, removeReadyPlanningPlacement, removeReadyPlanningPlan, undoReadyPlanningFiles} from "nbook/server/outline/host";
import {OutlineTransactionError} from "nbook/server/outline/transaction";

const PublishBody = z.object({
    expectedManifestRevision: z.number().int().nonnegative(),
    mutations: z.array(z.object({
        relativePath: z.string().min(1),
        content: z.string().nullable(),
        expectedHash: z.string().nullable().optional(),
    }).strict()).min(1),
}).strict();
const UndoBody = z.object({transactionId: z.string().uuid()}).strict();
const ObjectId = z.string().regex(/^(?:ol|fo|ln)-[a-z0-9][a-z0-9-]*$/u);
const ObjectPreviewBody = z.object({targetId: ObjectId}).strict();
const ObjectRemoveBody = ObjectPreviewBody.extend({
    expectedRevision: z.number().int().nonnegative(),
    expectedObjectHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    confirmedTotal: z.boolean().default(false),
}).strict();
const PlacementPreviewBody = z.object({planId: z.string().min(1), targetId: ObjectId}).strict();
const PlacementRemoveBody = PlacementPreviewBody.extend({expectedRevision: z.number().int().nonnegative()}).strict();
const PlanPreviewBody = z.object({planId: z.string().min(1)}).strict();
const PlanRemoveBody = PlanPreviewBody.extend({expectedRevision: z.number().int().nonnegative()}).strict();

const EntryId = z.string().regex(/^ol-[a-z0-9][a-z0-9-]*$/u);
const ForeshadowId = z.string().regex(/^fo-[a-z0-9][a-z0-9-]*$/u);
// 形状在此收窄，路径合法性、待补缺省路径等语义仍由 frontmatter parser 在候选快照中统一校验。
const OutlineReferenceBody = z.object({path: z.string().min(1).optional(), locator: z.string().trim().min(1).optional(),
    purpose: z.string().trim().min(1).optional(), pending: z.boolean().optional()}).strict();
const ForeshadowDesignFields = {
    surface: z.string().trim().min(1), connection: z.string().trim().min(1),
    plant: z.object({situation: z.string().trim().min(1), presentation: z.string().trim().min(1), subtlety: z.string().trim().min(1)}).strict(),
    recover: z.object({condition: z.string().trim().min(1), echo: z.string().trim().min(1), effect: z.string().trim().min(1)}).strict(),
};
const ForeshadowActionBody = z.object({
    expectedRevision: z.number().int().nonnegative(),
    action: z.discriminatedUnion("kind", [
        z.object({kind: z.literal("create-foreshadowing"), title: z.string().trim().min(1), body: z.string(),
            surface: ForeshadowDesignFields.surface.optional(), connection: ForeshadowDesignFields.connection.optional(),
            plant: ForeshadowDesignFields.plant.optional(), recover: ForeshadowDesignFields.recover.optional()}).strict(),
        z.object({kind: z.literal("edit-foreshadowing"), id: ForeshadowId,
            expectedVersion: z.number().int().nonnegative(), expectedContentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
            title: z.string().trim().min(1), body: z.string(),
            surface: ForeshadowDesignFields.surface.nullable().optional(), connection: ForeshadowDesignFields.connection.nullable().optional(),
            plant: ForeshadowDesignFields.plant.nullable().optional(), recover: ForeshadowDesignFields.recover.nullable().optional()}).strict(),
        z.object({kind: z.literal("confirm-foreshadowing"), id: ForeshadowId,
            expectedVersion: z.number().int().nonnegative(), expectedContentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u)}).strict(),
    ]),
}).strict();
const ForeshadowingMarkerRepairBody = z.object({
    expectedRevision: z.number().int().nonnegative(), planId: z.string().trim().min(1), entryId: EntryId,
    foreshadowingId: ForeshadowId, expectedVersion: z.number().int().nonnegative(),
    expectedContentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u), body: z.string(),
}).strict();
const LineId = z.string().regex(/^ln-[a-z0-9][a-z0-9-]*$/u);
const NodeId = z.string().regex(/^nd-[a-z0-9][a-z0-9-]*$/u);
const LineType = z.enum(["main", "branch", "character", "if"]);
const EdgeId = z.string().regex(/^eg-[a-z0-9][a-z0-9-]*$/u);
const PlanId = z.string().trim().min(1);
const Sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const Cell = z.number().int().nonnegative();
const GraphDeletionPreviewBody = z.discriminatedUnion("kind", [
    z.object({kind: z.literal("node"), planId: PlanId, targetId: NodeId}).strict(),
    z.object({kind: z.literal("edge"), planId: PlanId, targetId: EdgeId}).strict(),
]);
const GraphCas = {planId: PlanId, expectedGraphVersion: z.number().int().nonnegative()};
const LineCas = {lineId: LineId, expectedVersion: z.number().int().nonnegative(), expectedContentHash: Sha256};
const LineNodeIds = z.array(NodeId).max(500);
const LineBody = z.object({
    expectedRevision: z.number().int().nonnegative(),
    action: z.discriminatedUnion("kind", [
        z.object({kind: z.literal("add-graph-node"), ...GraphCas, column: Cell, row: Cell, entryId: EntryId.nullable().optional()}).strict(),
        z.object({kind: z.literal("move-graph-node"), ...GraphCas, nodeId: NodeId, column: Cell, row: Cell}).strict(),
        z.object({kind: z.literal("insert-graph-column"), ...GraphCas, column: Cell}).strict(),
        z.object({kind: z.literal("relink-graph-node"), ...GraphCas, nodeId: NodeId, entryId: EntryId.nullable()}).strict(),
        z.object({kind: z.literal("connect-graph-nodes"), ...GraphCas, from: NodeId, to: NodeId}).strict(),
        z.object({kind: z.literal("remove-graph-edge"), ...GraphCas, edgeId: EdgeId, expectedImpactHash: Sha256,
            confirmDeletion: z.literal(true)}).strict(),
        z.object({kind: z.literal("remove-graph-node"), ...GraphCas, nodeId: NodeId, expectedImpactHash: Sha256,
            confirmDeletion: z.literal(true)}).strict(),
        z.object({kind: z.literal("create-line"), planId: PlanId, title: z.string().trim().min(1), type: LineType,
            nodeIds: LineNodeIds}).strict(),
        z.object({kind: z.literal("edit-draft-line"), ...LineCas, title: z.string().trim().min(1), type: LineType,
            nodeIds: LineNodeIds}).strict(),
        z.object({kind: z.literal("reopen-fixed-line"), ...LineCas, confirmReopen: z.literal(true)}).strict(),
        z.object({kind: z.literal("switch-main-line"), ...LineCas, previousLineId: LineId,
            previousVersion: z.number().int().nonnegative(), previousContentHash: Sha256, confirmSwitch: z.literal(true)}).strict(),
    ]),
}).strict();
const LibraryBody = z.object({
    expectedRevision: z.number().int().nonnegative(),
    action: z.discriminatedUnion("kind", [
        z.object({kind: z.literal("create-total"), title: z.string().min(1), body: z.string()}).strict(),
        z.object({kind: z.literal("create-plan"), title: z.string().min(1)}).strict(),
        z.object({kind: z.literal("rename-plan"), planId: z.string().min(1), title: z.string().min(1)}).strict(),
        z.object({kind: z.literal("create-entry"), planId: z.string().min(1), parentId: EntryId,
            entryKind: z.enum(["volume", "chapter", "detail"]), title: z.string().min(1), body: z.string(),
            materialRefs: z.array(z.string()).optional(), writingGuidance: z.string().optional(),
            references: z.array(OutlineReferenceBody).max(64).optional(), targetWords: z.number().int().positive().optional()}).strict(),
        z.object({kind: z.literal("adopt-entry"), planId: z.string().min(1), entryId: EntryId,
            expectedVersion: z.number().int().nonnegative(), expectedContentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u)}).strict(),
        z.object({kind: z.literal("edit-entry"), planId: z.string().min(1), entryId: EntryId,
            expectedVersion: z.number().int().nonnegative(), expectedContentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
            title: z.string().min(1), body: z.string(), confirmGlobal: z.literal(true).optional(),
            materialRefs: z.array(z.string()).nullable().optional(), writingGuidance: z.string().nullable().optional(),
            references: z.array(OutlineReferenceBody).max(64).nullable().optional(), targetWords: z.number().int().positive().nullable().optional()}).strict(),
        z.object({kind: z.literal("move-entry"), planId: z.string().min(1), entryId: EntryId, parentId: EntryId,
            expectedVersion: z.number().int().nonnegative(), expectedContentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u)}).strict(),
        z.object({kind: z.literal("attach-entry"), planId: z.string().min(1), parentId: EntryId, entryId: EntryId}).strict(),
        z.object({kind: z.literal("reorder-entry"), planId: z.string().min(1), entryId: EntryId,
            siblingIndex: z.number().int().nonnegative()}).strict(),
    ]),
}).strict();
const MissingEntryRepairBody = z.object({
    missingEntryId: EntryId, expectedRevision: z.number().int().nonnegative(),
    expectedMissingHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u), confirmRepair: z.literal(true),
}).strict();
const InspectLineBody = z.object({lineId: LineId}).strict();
const LineAnalysisBody = z.object({
    lineId: LineId, expectedRevision: z.number().int().nonnegative(),
    expectedVersion: z.number().int().nonnegative(), expectedContentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
}).strict();
const WriterContextBody = LineAnalysisBody.extend({
    materialPaths: z.array(z.string().min(1)).min(1).max(8).refine((paths) => new Set(paths).size === paths.length,
        "materialPaths 不能包含重复路径").optional(),
}).strict();
const FixLineBody = LineAnalysisBody.extend({
    reportId: z.string().uuid(),
    resolutions: z.array(z.object({index: z.number().int().nonnegative(), decision: z.enum(["resolved", "ignored"]),
        reason: z.string().trim().min(1).max(2000)}).strict()).max(30),
}).strict();
const DetailAnalysisBody = z.object({
    planId: z.string().min(1), entryId: EntryId, expectedRevision: z.number().int().nonnegative(),
    expectedVersion: z.number().int().nonnegative(), expectedContentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
}).strict();
const AdoptDetailBody = DetailAnalysisBody.extend({
    reportId: z.string().uuid(), confirmDeviations: z.boolean(),
    resolutions: z.array(z.object({index: z.number().int().nonnegative(), decision: z.enum(["resolved", "ignored"]),
        reason: z.string().trim().min(1).max(2000)}).strict()).max(30),
}).strict();
const DirectionBody = z.object({
    planId: z.string().min(1), parentId: EntryId, entryKind: z.enum(["volume", "chapter", "detail"]),
    direction: z.string().trim().min(1).max(4000),
}).strict();
const ForkBody = z.object({planId: z.string().min(1), sourceId: EntryId, title: z.string().min(1), body: z.string(),
    expectedRevision: z.number().int().nonnegative(), confirmShared: z.literal(true),
    materialRefs: z.array(z.string()).nullable().optional(), writingGuidance: z.string().nullable().optional(),
    references: z.array(OutlineReferenceBody).max(64).nullable().optional(), targetWords: z.number().int().positive().nullable().optional()}).strict();
/** 存储数据面只接受已打开 Project；规范内容始终从文件重新解析。 */
export default defineEventHandler((event) => withProjectHttpError(async () => {
    try {
        const ready = requireActiveReadyProject(requireProjectRefQuery(event));
        const raw = event.context.params?.segments;
        const segments = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split("/") : [];
        if (event.method === "POST" && segments.length === 1 && segments[0] === "open") {
            return await openReadyPlanning(ready);
        }
        if (event.method === "GET" && segments.length === 1 && segments[0] === "snapshot") {
            return await runReadyProjectOperation(ready, async (_signal, assertTarget, revalidateTarget) => {
                await revalidateTarget();
                assertTarget();
                const snapshot = await readPlanningSnapshot({projectRoot: ready.workspace.root});
                await revalidateTarget();
                assertTarget();
                return snapshot;
            });
        }
        if (event.method === "GET" && segments.length === 1 && segments[0] === "library-trees") {
            return await runReadyProjectOperation(ready, async (_signal, assertTarget, revalidateTarget) => {
                await revalidateTarget();
                assertTarget();
                const trees = getLibraryTrees(await readPlanningSnapshot({projectRoot: ready.workspace.root}));
                await revalidateTarget();
                assertTarget();
                return trees;
            });
        }
        if (event.method === "GET" && segments.length === 1 && segments[0] === "foreshadowing-states") {
            return await runReadyProjectOperation(ready, async (_signal, assertTarget, revalidateTarget) => {
                await revalidateTarget();
                assertTarget();
                const {snapshot, markerIssues} = await readForeshadowingSnapshot({projectRoot: ready.workspace.root});
                const states = deriveForeshadowingStates(snapshot);
                const elapsed = deriveForeshadowingElapsed(snapshot, states);
                await revalidateTarget();
                assertTarget();
                return {parserVersion: FORESHADOW_MARKER_PARSER_VERSION, states, elapsed, markerIssues};
            });
        }
        if (event.method === "POST" && segments.length === 1 && segments[0] === "library-action") {
            const {action, expectedRevision} = await validateBody(event, LibraryBody);
            return await applyReadyLibraryAction(ready, action as import("nbook/server/outline/library").LibraryAction,
                expectedRevision, {kind: "user", userId: "local"});
        }
        if (event.method === "POST" && segments.length === 1 && segments[0] === "preview-graph-deletion") {
            const target = await validateBody(event, GraphDeletionPreviewBody);
            return await previewReadyGraphDeletion(ready, target as import("nbook/server/outline/line-planning").GraphDeletionTarget);
        }
        if (event.method === "POST" && segments.length === 1 && segments[0] === "line-action") {
            const {action, expectedRevision} = await validateBody(event, LineBody);
            return await applyReadyLineAction(ready, action as import("nbook/server/outline/line-planning").LineAction,
                expectedRevision, {kind: "user", userId: "local"});
        }
        if (event.method === "POST" && segments.length === 1 && segments[0] === "foreshadowing-action") {
            const {action, expectedRevision} = await validateBody(event, ForeshadowActionBody);
            return await applyReadyForeshadowingAction(ready, action as import("nbook/server/outline/foreshadowing").ForeshadowingAction,
                expectedRevision, {kind: "user", userId: "local"});
        }
        if (event.method === "POST" && segments.length === 1 && segments[0] === "preview-foreshadowing-marker-repair") {
            const input = await validateBody(event, ForeshadowingMarkerRepairBody);
            return await previewReadyForeshadowingMarkerRepair(ready, {...input,
                kind: "repair-foreshadowing-marker", entryId: input.entryId as OutlineId,
                foreshadowingId: input.foreshadowingId as OutlineId});
        }
        if (event.method === "POST" && segments.length === 1 && segments[0] === "repair-foreshadowing-marker") {
            const input = await validateBody(event, ForeshadowingMarkerRepairBody);
            return await repairReadyForeshadowingMarker(ready, {...input,
                kind: "repair-foreshadowing-marker", entryId: input.entryId as OutlineId,
                foreshadowingId: input.foreshadowingId as OutlineId}, {kind: "user", userId: "local"});
        }
        if (event.method === "POST" && segments.length === 1 && segments[0] === "repair-missing-entry") {
            const input = await validateBody(event, MissingEntryRepairBody);
            return await repairReadyMissingEntry(ready, {...input, missingEntryId: input.missingEntryId as OutlineId},
            {kind: "user", userId: "local"});
        }
        if (event.method === "POST" && segments.length === 1 && segments[0] === "inspect-line") {
            const {lineId} = await validateBody(event, InspectLineBody);
            return await inspectReadyLine(ready, lineId as OutlineId);
        }
        if (event.method === "POST" && segments.length === 1 && segments[0] === "read-fixed-line") {
            const input = await validateBody(event, LineAnalysisBody);
            return await readReadyFixedLineNodes(ready, {...input, lineId: input.lineId as OutlineId});
        }
        if (event.method === "POST" && segments.length === 1 && segments[0] === "read-writer-context") {
            const {materialPaths, ...input} = await validateBody(event, WriterContextBody);
            const request = {...input, lineId: input.lineId as OutlineId};
            return materialPaths === undefined
                ? await readReadyWriterOutlineContext(ready, request)
                : await readReadyWriterOutlineContext(ready, request, materialPaths);
        }
        if (event.method === "POST" && segments.length === 1 && segments[0] === "analyze-line") {
            const input = await validateBody(event, LineAnalysisBody);
            return await analyzeReadyLine(ready, {...input, lineId: input.lineId as OutlineId});
        }
        if (event.method === "POST" && segments.length === 1 && segments[0] === "fix-line") {
            const {reportId, resolutions, ...input} = await validateBody(event, FixLineBody);
            return await fixReadyLine(ready, {...input, lineId: input.lineId as OutlineId}, reportId, resolutions,
                {kind: "user", userId: "local"});
        }
        if (event.method === "POST" && segments.length === 1 && segments[0] === "analyze-detail") {
            const input = await validateBody(event, DetailAnalysisBody);
            return await analyzeReadyDetail(ready, {...input, entryId: input.entryId as OutlineId});
        }
        if (event.method === "POST" && segments.length === 1 && segments[0] === "adopt-detail") {
            const {reportId, confirmDeviations, resolutions, ...input} = await validateBody(event, AdoptDetailBody);
            return await adoptReadyDetail(ready, {...input, entryId: input.entryId as OutlineId},
                reportId, confirmDeviations, resolutions, {kind: "user", userId: "local"});
        }
        if (event.method === "POST" && segments.length === 1 && segments[0] === "generate-direction") {
            const input = await validateBody(event, DirectionBody);
            return await generateReadyDirectionDraft(ready, {...input, parentId: input.parentId as OutlineId});
        }
        if (event.method === "POST" && segments.length === 1 && segments[0] === "fork-entry") {
            const {confirmShared: _confirmed, ...input} = await validateBody(event, ForkBody);
            return await forkReadyLibraryEntry(ready, {...input, sourceId: input.sourceId as OutlineId}, {kind: "user", userId: "local"});
        }
        if (event.method === "POST" && segments.length === 1 && segments[0] === "publish") {
            const input = await validateBody(event, PublishBody);
            return await publishReadyPlanningFiles(ready, input, {kind: "user", userId: "local"});
        }
        const actor = {kind: "user", userId: "local"} as const;
        if (event.method === "POST" && segments.length === 1 && segments[0] === "preview-object-deletion") {
            const {targetId} = await validateBody(event, ObjectPreviewBody);
            return await previewReadyPlanningObjectDeletion(ready, targetId as OutlineId);
        }
        if (event.method === "POST" && segments.length === 1 && segments[0] === "remove-object") {
            const {targetId, expectedRevision, expectedObjectHash, confirmedTotal} = await validateBody(event, ObjectRemoveBody);
            return await removeReadyPlanningObject(ready, targetId as OutlineId, expectedRevision, expectedObjectHash, confirmedTotal, actor);
        }
        if (event.method === "POST" && segments.length === 1 && segments[0] === "preview-placement-removal") {
            const {planId, targetId} = await validateBody(event, PlacementPreviewBody);
            return await previewReadyPlanningPlacementRemoval(ready, planId, targetId as OutlineId);
        }
        if (event.method === "POST" && segments.length === 1 && segments[0] === "remove-placement") {
            const {planId, targetId, expectedRevision} = await validateBody(event, PlacementRemoveBody);
            return await removeReadyPlanningPlacement(ready, planId, targetId as OutlineId, expectedRevision, actor);
        }
        if (event.method === "POST" && segments.length === 1 && segments[0] === "preview-plan-removal") {
            const {planId} = await validateBody(event, PlanPreviewBody);
            return await previewReadyPlanningPlanRemoval(ready, planId);
        }
        if (event.method === "POST" && segments.length === 1 && segments[0] === "remove-plan") {
            const {planId, expectedRevision} = await validateBody(event, PlanRemoveBody);
            return await removeReadyPlanningPlan(ready, planId, expectedRevision, actor);
        }
        if (event.method === "POST" && segments.length === 1 && segments[0] === "undo") {
            const {transactionId} = await validateBody(event, UndoBody);
            return await undoReadyPlanningFiles(ready, transactionId, {kind: "user", userId: "local"});
        }
        throw createError({statusCode: 404, message: "未知 Project 大纲规划存储 API"});
    } catch (error) {
        if (error instanceof OutlineTransactionError) {
            throw createError({statusCode: error.code === "INVALID_PATH" ? 400 : 409, message: error.message, data: {code: error.code}});
        }
        if (error instanceof OutlineGenerationError) {
            throw createError({statusCode: error.code === "MODEL_UNAVAILABLE" ? 503 : 502,
                message: error.message, data: {code: error.code}});
        }
        if (error instanceof OutlineLineError) {
            throw createError({statusCode: error.code === "CAS_CONFLICT" ? 409 : 422, message: error.message, data: {code: error.code}});
        }
        if (error instanceof OutlineLibraryError) {
            throw createError({statusCode: error.code === "CAS_CONFLICT" ? 409 : 422, message: error.message, data: {code: error.code}});
        }
        if (error instanceof OutlineFormatError) {
            throw createError({statusCode: 422, message: error.message, data: {diagnostics: error.diagnostics}});
        }
        throw error;
    }
}));





