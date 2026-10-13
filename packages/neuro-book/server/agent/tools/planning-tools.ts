import {createHash, randomUUID} from "node:crypto";
import {Type} from "typebox";
import {Value} from "typebox/value";
import type {Static} from "typebox";
import type {OperationActor} from "@notnotype/nb-history";
import {normalizeToolResultDetails} from "nbook/server/agent/messages/message-utils";
import type {JsonValue} from "nbook/server/agent/messages/types";
import type {NeuroAgentTool, NeuroToolResult, ToolExecutionContext} from "nbook/server/agent/tools/types";
import {createPlanningAuditRecord, type PlanningAuditRecord} from "nbook/server/agent/planning-contracts";
import {assertPlanningWriteGrant} from "nbook/server/agent/tools/planning-delegation";
import {PLANNING_SPECIALIST_PROFILE_KEYS} from "nbook/server/agent/tools/planning-specialist-tool";
import {
    applyReadyForeshadowingAction,
    applyReadyLibraryAction,
    applyReadyLineAction,
    preparePlanningPublication,
    previewReadyPlanningObjectDeletion,
    previewReadyPlanningPlacementRemoval,
    previewReadyPlanningPlanRemoval,
    repairReadyForeshadowingMarker,
    removeReadyPlanningObject,
    removeReadyPlanningPlacement,
    removeReadyPlanningPlan,
    undoReadyPlanningFiles,
} from "nbook/server/outline/host";
import {deriveForeshadowingElapsed, deriveForeshadowingStates} from "nbook/server/outline/foreshadowing";
import {prepareForeshadowingAction, type ForeshadowingAction} from "nbook/server/outline/foreshadowing";
import {prepareForeshadowingMarkerRepair, prepareForeshadowingMarkerSuggestion, type ForeshadowingMarkerRepairAction, type ForeshadowingMarkerSuggestionInput} from "nbook/server/outline/foreshadowing-suggestions";
import {prepareLibraryAction, type LibraryAction} from "nbook/server/outline/library";
import type {OutlineId} from "nbook/server/outline/format";
import {prepareLineAction, type LineAction} from "nbook/server/outline/line-planning";
import {parsePlanningFiles, readForeshadowingSnapshot, readPlanningSnapshot} from "nbook/server/outline/index";
import {preparePlanningMaterialMutations} from "nbook/server/outline/adaptation";
import {createOutlineRepository} from "nbook/server/outline/repository";
import {hashText} from "nbook/server/outline/transaction";
import type {PlanningSnapshot} from "nbook/server/outline/index";

const NonEmpty = Type.String({minLength: 1});
const OutlineIdSchema = Type.String({pattern: "^(ol|fo|ln|nd|fm|gr|eg)-[a-z0-9][a-z0-9-]*$"});
const PlanIdSchema = Type.String({pattern: "^plan-[a-z0-9][a-z0-9-]*$"});
const HashSchema = Type.String({pattern: "^sha256:[0-9a-f]{64}$"});
// 待补参考文件可以只有 locator；其余语义由 frontmatter parser 在候选快照中统一校验。
const ReferenceSchema = Type.Object({
    path: Type.Optional(NonEmpty), locator: Type.Optional(NonEmpty), purpose: Type.Optional(NonEmpty), pending: Type.Optional(Type.Boolean()),
}, {additionalProperties: false});
const ReferencesSchema = Type.Array(ReferenceSchema, {maxItems: 64});
const AdaptationSchema = Type.Union([
    Type.Object({kind: Type.Literal("chapter"), sourcePlanId: PlanIdSchema, sourceEntryId: OutlineIdSchema}, {additionalProperties: false}),
    Type.Object({kind: Type.Literal("between"), sourcePlanId: PlanIdSchema, beforeEntryId: OutlineIdSchema, afterEntryId: OutlineIdSchema}, {additionalProperties: false}),
]);
const MaterialUpdatesSchema = Type.Array(Type.Object({
    materialPath: NonEmpty,
    kind: Type.Union([Type.Literal("experience"), Type.Literal("relationship"), Type.Literal("item"), Type.Literal("location")]),
    body: NonEmpty,
}, {additionalProperties: false}), {maxItems: 64});
const PlantSchema = Type.Object({situation: NonEmpty, presentation: NonEmpty, subtlety: NonEmpty}, {additionalProperties: false});
const RecoverSchema = Type.Object({condition: NonEmpty, echo: NonEmpty, effect: NonEmpty}, {additionalProperties: false});
const MetadataFields = {
    adaptation: Type.Optional(AdaptationSchema),
    materialUpdates: Type.Optional(MaterialUpdatesSchema),
    materialRefs: Type.Optional(Type.Array(NonEmpty, {maxItems: 64})),
    writingGuidance: Type.Optional(Type.Union([NonEmpty, Type.Null()])),
    references: Type.Optional(ReferencesSchema),
    targetWords: Type.Optional(Type.Union([Type.Integer({minimum: 1}), Type.Null()])),
};
const CreateEntry = Type.Intersect([
    Type.Object({kind: Type.Literal("create-entry"), planId: PlanIdSchema, parentId: OutlineIdSchema,
        entryKind: Type.Union([Type.Literal("volume"), Type.Literal("chapter"), Type.Literal("detail")]),
        title: NonEmpty, body: Type.String()},
    ),
    Type.Object(MetadataFields),
]);
const EditEntry = Type.Intersect([
    Type.Object({kind: Type.Literal("edit-entry"), planId: PlanIdSchema, entryId: OutlineIdSchema,
        expectedVersion: Type.Integer({minimum: 0}), expectedContentHash: HashSchema, title: NonEmpty, body: Type.String()}),
    Type.Object({
        adaptation: Type.Optional(Type.Union([AdaptationSchema, Type.Null()])),
        materialUpdates: Type.Optional(Type.Union([MaterialUpdatesSchema, Type.Null()])),
        materialRefs: Type.Optional(Type.Union([Type.Array(NonEmpty, {maxItems: 64}), Type.Null()])),
        writingGuidance: Type.Optional(Type.Union([NonEmpty, Type.Null()])),
        references: Type.Optional(Type.Union([ReferencesSchema, Type.Null()])),
        targetWords: Type.Optional(Type.Union([Type.Integer({minimum: 1}), Type.Null()])),
    }),
]);
const LibraryActionSchema = Type.Union([
    Type.Object({kind: Type.Literal("create-plan"), title: NonEmpty}, {additionalProperties: false}),
    Type.Object({kind: Type.Literal("associate-total"), planId: PlanIdSchema, totalId: OutlineIdSchema,
        confirmReplace: Type.Optional(Type.Literal(true))}, {additionalProperties: false}),
    Type.Object({kind: Type.Literal("unshare-total"), planId: PlanIdSchema}, {additionalProperties: false}),
    Type.Object({kind: Type.Literal("rename-plan"), planId: PlanIdSchema, title: NonEmpty}, {additionalProperties: false}),
    CreateEntry,
    Type.Object({kind: Type.Literal("adopt-entry"), planId: PlanIdSchema, entryId: OutlineIdSchema,
        expectedVersion: Type.Integer({minimum: 0}), expectedContentHash: HashSchema}, {additionalProperties: false}),
    EditEntry,
    Type.Object({kind: Type.Literal("move-entry"), planId: PlanIdSchema, entryId: OutlineIdSchema, parentId: OutlineIdSchema,
        expectedVersion: Type.Integer({minimum: 0}), expectedContentHash: HashSchema}, {additionalProperties: false}),
    Type.Object({kind: Type.Literal("attach-entry"), planId: PlanIdSchema, parentId: OutlineIdSchema, entryId: OutlineIdSchema}, {additionalProperties: false}),
    Type.Object({kind: Type.Literal("reorder-entry"), planId: PlanIdSchema, entryId: OutlineIdSchema, siblingIndex: Type.Integer({minimum: 0})}, {additionalProperties: false}),
]);
const ForeshadowingActionSchema = Type.Union([
    Type.Object({kind: Type.Literal("create-foreshadowing"), title: NonEmpty, body: Type.String(),
        surface: Type.Optional(NonEmpty), connection: Type.Optional(NonEmpty),
        plant: Type.Optional(PlantSchema), recover: Type.Optional(RecoverSchema)}, {additionalProperties: false}),
    Type.Object({kind: Type.Literal("edit-foreshadowing"), id: OutlineIdSchema, expectedVersion: Type.Integer({minimum: 0}), expectedContentHash: HashSchema, title: NonEmpty, body: Type.String(),
        surface: Type.Optional(Type.Union([NonEmpty, Type.Null()])), connection: Type.Optional(Type.Union([NonEmpty, Type.Null()])),
        plant: Type.Optional(Type.Union([PlantSchema, Type.Null()])), recover: Type.Optional(Type.Union([RecoverSchema, Type.Null()]))}, {additionalProperties: false}),
    Type.Object({kind: Type.Literal("confirm-foreshadowing"), id: OutlineIdSchema, expectedVersion: Type.Integer({minimum: 0}), expectedContentHash: HashSchema}, {additionalProperties: false}),
]);
// 模型 API 要求函数参数顶层为 object，“至少指定一项”由执行入口校验，不能写成顶层 union。
const ForeshadowingContextSchema = Type.Object({
    foreshadowingId: Type.Optional(Type.String({pattern: "^fo-[a-z0-9][a-z0-9-]*$"})),
    entryIds: Type.Optional(Type.Array(Type.String({pattern: "^ol-[a-z0-9][a-z0-9-]*$"}), {minItems: 1, maxItems: 8})),
}, {additionalProperties: false});
const ForeshadowingSuggestionSchema = Type.Object({
    action: Type.Union([Type.Literal("plant"), Type.Literal("strengthen"), Type.Literal("resolve"), Type.Literal("repair")]),
    expectedRevision: Type.Integer({minimum: 0}),
    planId: PlanIdSchema,
    entryId: Type.String({pattern: "^ol-[a-z0-9][a-z0-9-]*$"}),
    foreshadowingId: Type.String({pattern: "^fo-[a-z0-9][a-z0-9-]*$"}),
    expectedVersion: Type.Integer({minimum: 0}),
    expectedContentHash: HashSchema,
    body: Type.String(),
    rationale: NonEmpty,
    materialUpdates: Type.Optional(Type.Union([MaterialUpdatesSchema, Type.Null()])),
}, {additionalProperties: false});
const ForeshadowingMarkerRepairActionSchema = Type.Object({
    kind: Type.Literal("repair-foreshadowing-marker"),
    expectedRevision: Type.Integer({minimum: 0}),
    planId: PlanIdSchema,
    entryId: Type.String({pattern: "^ol-[a-z0-9][a-z0-9-]*$"}),
    foreshadowingId: Type.String({pattern: "^fo-[a-z0-9][a-z0-9-]*$"}),
    expectedVersion: Type.Integer({minimum: 0}),
    expectedContentHash: HashSchema,
    body: Type.String(),
    materialUpdates: Type.Optional(Type.Union([MaterialUpdatesSchema, Type.Null()])),
}, {additionalProperties: false});
const LineTypeSchema = Type.Union([Type.Literal("main"), Type.Literal("branch"), Type.Literal("character"), Type.Literal("if")]);
const GraphCasSchema = {planId: PlanIdSchema, expectedGraphVersion: Type.Integer({minimum: 0})};
const LineCasSchema = {lineId: OutlineIdSchema, expectedVersion: Type.Integer({minimum: 0}), expectedContentHash: HashSchema};
const CellSchema = Type.Integer({minimum: 0});
const LineNodeIdsSchema = Type.Array(OutlineIdSchema, {maxItems: 500});
const LineActionSchema = Type.Union([
    Type.Object({kind: Type.Literal("add-graph-node"), ...GraphCasSchema, column: CellSchema, row: CellSchema,
        entryId: Type.Optional(Type.Union([OutlineIdSchema, Type.Null()]))}, {additionalProperties: false}),
    Type.Object({kind: Type.Literal("move-graph-node"), ...GraphCasSchema, nodeId: OutlineIdSchema, column: CellSchema, row: CellSchema},
        {additionalProperties: false}),
    Type.Object({kind: Type.Literal("insert-graph-column"), ...GraphCasSchema, column: CellSchema}, {additionalProperties: false}),
    Type.Object({kind: Type.Literal("relink-graph-node"), ...GraphCasSchema, nodeId: OutlineIdSchema,
        entryId: Type.Union([OutlineIdSchema, Type.Null()])}, {additionalProperties: false}),
    Type.Object({kind: Type.Literal("connect-graph-nodes"), ...GraphCasSchema, from: OutlineIdSchema, to: OutlineIdSchema},
        {additionalProperties: false}),
    Type.Object({kind: Type.Literal("remove-graph-edge"), ...GraphCasSchema, edgeId: OutlineIdSchema, expectedImpactHash: HashSchema,
        confirmDeletion: Type.Literal(true)}, {additionalProperties: false}),
    Type.Object({kind: Type.Literal("remove-graph-node"), ...GraphCasSchema, nodeId: OutlineIdSchema, expectedImpactHash: HashSchema,
        confirmDeletion: Type.Literal(true)}, {additionalProperties: false}),
    Type.Object({kind: Type.Literal("create-line"), planId: PlanIdSchema, title: NonEmpty, type: LineTypeSchema,
        nodeIds: LineNodeIdsSchema}, {additionalProperties: false}),
    Type.Object({kind: Type.Literal("edit-draft-line"), ...LineCasSchema, title: NonEmpty, type: LineTypeSchema,
        nodeIds: LineNodeIdsSchema}, {additionalProperties: false}),
    Type.Object({kind: Type.Literal("reopen-fixed-line"), ...LineCasSchema, confirmReopen: Type.Literal(true)}, {additionalProperties: false}),
    Type.Object({kind: Type.Literal("switch-main-line"), ...LineCasSchema, previousLineId: OutlineIdSchema,
        previousVersion: Type.Integer({minimum: 0}), previousContentHash: HashSchema, confirmSwitch: Type.Literal(true)},
        {additionalProperties: false}),
]);const MutationSchema = Type.Object({operation: Type.Literal("mutate"), expectedRevision: Type.Integer({minimum: 0}),
    action: Type.Union([LibraryActionSchema, ForeshadowingActionSchema, ForeshadowingMarkerRepairActionSchema, LineActionSchema])}, {additionalProperties: false});
const DeleteSchema = Type.Union([
    Type.Object({operation: Type.Literal("delete-object"), targetId: OutlineIdSchema, expectedRevision: Type.Integer({minimum: 0}), expectedObjectHash: HashSchema,
        confirmed: Type.Literal(true), confirmedTotal: Type.Optional(Type.Literal(true))}, {additionalProperties: false}),
    Type.Object({operation: Type.Literal("remove-placement"), planId: PlanIdSchema, targetId: OutlineIdSchema, expectedRevision: Type.Integer({minimum: 0}), confirmed: Type.Literal(true)}, {additionalProperties: false}),
    Type.Object({operation: Type.Literal("delete-plan"), planId: PlanIdSchema, expectedRevision: Type.Integer({minimum: 0}), confirmed: Type.Literal(true)}, {additionalProperties: false}),
]);
const ChangeSchema = Type.Union([MutationSchema, DeleteSchema]);
const AppliedMutationSchema = Type.Object({operation: Type.Literal("mutate"), expectedRevision: Type.Integer({minimum: 0}), action: Type.Union([LibraryActionSchema, ForeshadowingActionSchema, ForeshadowingMarkerRepairActionSchema, LineActionSchema]), proposalId: NonEmpty}, {additionalProperties: false});
const AppliedDeleteSchema = Type.Union([
    Type.Object({operation: Type.Literal("delete-object"), targetId: OutlineIdSchema, expectedRevision: Type.Integer({minimum: 0}), expectedObjectHash: HashSchema,
        confirmed: Type.Literal(true), confirmedTotal: Type.Optional(Type.Literal(true)), proposalId: NonEmpty}, {additionalProperties: false}),
    Type.Object({operation: Type.Literal("remove-placement"), planId: PlanIdSchema, targetId: OutlineIdSchema, expectedRevision: Type.Integer({minimum: 0}), confirmed: Type.Literal(true), proposalId: NonEmpty}, {additionalProperties: false}),
    Type.Object({operation: Type.Literal("delete-plan"), planId: PlanIdSchema, expectedRevision: Type.Integer({minimum: 0}), confirmed: Type.Literal(true), proposalId: NonEmpty}, {additionalProperties: false}),
]);
const AppliedChangeSchema = Type.Union([AppliedMutationSchema, AppliedDeleteSchema]);
const ApplySchema = Type.Object({changes: Type.Array(AppliedChangeSchema, {minItems: 1, maxItems: 32})}, {additionalProperties: false});
const PreviewSchema = Type.Union([MutationSchema, Type.Object({operation: Type.Literal("delete-object"), targetId: OutlineIdSchema}, {additionalProperties: false}), Type.Object({operation: Type.Literal("remove-placement"), planId: PlanIdSchema, targetId: OutlineIdSchema}, {additionalProperties: false}), Type.Object({operation: Type.Literal("delete-plan"), planId: PlanIdSchema}, {additionalProperties: false})]);
// 模型 API 拒绝顶层 union；对外声明按 operation 区分的扁平 object，执行时仍用 PreviewSchema 严格校验各分支。
const PreviewParametersSchema = Type.Object({
    operation: Type.Union([Type.Literal("mutate"), Type.Literal("delete-object"), Type.Literal("remove-placement"), Type.Literal("delete-plan")], {
        description: "mutate needs expectedRevision and action; delete-object needs targetId; remove-placement needs planId and targetId; delete-plan needs planId.",
    }),
    expectedRevision: Type.Optional(Type.Integer({minimum: 0})),
    action: Type.Optional(MutationSchema.properties.action),
    targetId: Type.Optional(OutlineIdSchema),
    planId: Type.Optional(PlanIdSchema),
}, {additionalProperties: false});
const ContextSchema = Type.Object({
    mode: Type.Optional(Type.Union([
        Type.Literal("overview"), Type.Literal("entries"), Type.Literal("plans"), Type.Literal("placements"),
        Type.Literal("graphs"), Type.Literal("graph-nodes"), Type.Literal("graph-edges"),
        Type.Literal("lines"), Type.Literal("foreshadowing"), Type.Literal("details"),
    ], {description: "Omit for a compact overview, or details when entryIds is set. Read other collections only as needed."})),
    entryIds: Type.Optional(Type.Array(Type.String({pattern: "^ol-[a-z0-9][a-z0-9-]*$"}), {minItems: 1, maxItems: 16, uniqueItems: true,
        description: "Read only these entries' complete body and metadata; implies details mode."})),
    planId: Type.Optional(PlanIdSchema),
    graphId: Type.Optional(Type.String({pattern: "^gr-[a-z0-9][a-z0-9-]*$"})),
    offset: Type.Optional(Type.Integer({minimum: 0, description: "Collection offset. Use page.nextOffset to continue."})),
    limit: Type.Optional(Type.Integer({minimum: 1, maximum: 100, description: "Collection page size; defaults to 32."})),
    expectedRevision: Type.Optional(Type.Integer({minimum: 0, description: "Copy revision when continuing pages to reject a changed snapshot."})),
}, {additionalProperties: false});
const UndoSchema = Type.Object({transactionId: NonEmpty}, {additionalProperties: false});

type Mutation = Static<typeof MutationSchema>;
type Change = Static<typeof AppliedChangeSchema>;
type Preview = Static<typeof PreviewSchema>;
type PlanningChange = Preview | Change;

export const OUTLINE_AGENT_TOOL_KEYS = [
    "get_planning_context", "get_foreshadowing_context", "suggest_foreshadowing_marker",
    "preview_planning_change", "apply_planning_change", "undo_planning_change",
] as const;

export function createPlanningTools(): NeuroAgentTool[] {
    return [
        {
            key: "get_planning_context", name: "get_planning_context", label: "读取规划上下文",
            description: `Read the current ready Project planning snapshot. This is the only planning context entry point; do not read raw outline files.

Omit arguments for a compact overview: revision, counts, up to 32 plan summaries and the first entry-index page. This is not the complete project.
Use mode=entries/plans/graphs/lines/foreshadowing for a selected collection, optionally filtered by planId. Follow page.nextOffset with offset and copy expectedRevision until it is null. limit defaults to 32 (max 100).
Plans and graphs contain summaries; read mode=placements with planId for plan topology, or mode=graph-nodes/graph-edges with graphId for graph topology, using the same pagination.
Pass entryIds (1-16 ol-* ids, implicit mode=details) to read ONLY those entries' complete bodies, metadata, markers and their immediate placement context. No unrelated project collection is repeated. A mode cannot be mixed with selectors belonging to another mode.
edit-entry replaces the whole body and keeps omitted metadata fields. If an entry already has materialUpdates and its body changes, explicitly send the reviewed complete materialUpdates or null to clear them. Build changes from these details and copy expectedVersion/expectedContentHash from them.`,
            parameters: ContextSchema, executionMode: "parallel", mutatesWorkspace: false,
            async executeWithContext(context, _toolCallId, raw) {
                const input = parse(ContextSchema, raw ?? {}, "get_planning_context");
                const snapshot = await currentSnapshot(context);
                const details = planningContext(snapshot, input);
                // 模型可见读取与原始日志可分离；作用域和内容哈希让压缩能识别重复读取，不必裁剪正文。
                const contextHash = `sha256:${hash(JSON.stringify(details))}`;
                const text = JSON.stringify({title: "规划上下文", ...details, contextHash});
                return {content: [{type: "text", text}], details: normalizeToolResultDetails({...details, contextHash})};
            },
        },
        {
            key: "get_foreshadowing_context", name: "get_foreshadowing_context", label: "读取伏笔标记上下文",
            description: `Read selected chapter outline bodies and structured foreshadowing markers. This is the only way to obtain marker-edit context; it never writes.

The returned 'entries' contain chapter bodies with existing foreshadowing markers. To add or modify markers, use the following syntax in suggest_foreshadowing_marker:

Marker syntax:
<!-- nb:foreshadow marker="fm-01" foreshadow="fo-xxx" action="plant" -->text<!-- /nb:foreshadow marker="fm-01" -->

where:
- marker: unique ID within the chapter (e.g., fm-01, fm-02)
- foreshadow: the foreshadowing object ID (e.g., fo-xxx)
- action: "plant" (埋设), "reinforce" (强化), or "recover" (回收)`,
            parameters: ForeshadowingContextSchema, executionMode: "parallel", mutatesWorkspace: false,
            async executeWithContext(context, _toolCallId, raw) {
                const input = parse(ForeshadowingContextSchema, raw, "get_foreshadowing_context");
                if (!input.foreshadowingId && !input.entryIds?.length) throw new Error("至少指定 foreshadowingId 或 entryIds");
                const ready = requireProject(context);
                const diagnostic = await readForeshadowingSnapshot({projectRoot: ready.workspace.root});
                const snapshot = diagnostic.snapshot;
                const requestedEntryIds = new Set(input.entryIds ?? []);
                if (input.foreshadowingId) {
                    for (const state of deriveForeshadowingStates(snapshot)) {
                        if (state.id !== input.foreshadowingId) continue;
                        for (const source of state.sources) requestedEntryIds.add(source.chapterId);
                    }
                }
                const entries = snapshot.entries.filter(({value}) => requestedEntryIds.has(value.id)
                    && value.kind === "chapter").map(({value, path, contentHash, markers}) => ({
                    id: value.id, path, version: value.version, status: value.status, title: value.title,
                    body: value.body, contentHash, markers,
                    ...(value.adaptation ? {adaptation: value.adaptation} : {}),
                    ...(value.materialUpdates ? {materialUpdates: value.materialUpdates} : {}),
                }));
                const allStates = deriveForeshadowingStates(snapshot);
                const states = allStates.filter((state) => !input.foreshadowingId || state.id === input.foreshadowingId);
                // 已历章节只是按方案派生的度量，供调整埋设与回收建议，不是伏笔状态。
                const elapsed = deriveForeshadowingElapsed(snapshot, allStates).filter((item) =>
                    !input.foreshadowingId || item.id === input.foreshadowingId);
                const definitions = snapshot.foreshadowing.filter(({value}) =>
                    !input.foreshadowingId || value.id === input.foreshadowingId).map(({value, path, contentHash}) => ({
                    id: value.id, path, version: value.version, status: value.status, title: value.title,
                    ...(value.surface === undefined ? {} : {surface: value.surface}),
                    ...(value.connection === undefined ? {} : {connection: value.connection}),
                    ...(value.plant === undefined ? {} : {plant: value.plant}),
                    ...(value.recover === undefined ? {} : {recover: value.recover}),
                    body: value.body, contentHash,
                }));
                return result("伏笔标记上下文", {
                    manifestRevision: snapshot.manifest.revision,
                    definitions,
                    states,
                    elapsed,
                    entries,
                    markerIssues: diagnostic.markerIssues,
                });
            },
        },
        {
            key: "suggest_foreshadowing_marker", name: "suggest_foreshadowing_marker", label: "提出伏笔标记建议",
            description: `Validate a marker edit proposal without writing. The returned change must still be passed to apply_planning_change after explicit user approval.

IMPORTANT: The 'body' parameter must contain properly formatted foreshadowing markers using HTML comment syntax:

Marker syntax:
<!-- nb:foreshadow marker="fm-01" foreshadow="fo-xxx" action="plant" -->埋设文本<!-- /nb:foreshadow marker="fm-01" -->
<!-- nb:foreshadow marker="fm-02" foreshadow="fo-xxx" action="reinforce" -->强化文本<!-- /nb:foreshadow marker="fm-02" -->
<!-- nb:foreshadow marker="fm-03" foreshadow="fo-xxx" action="recover" -->回收文本<!-- /nb:foreshadow marker="fm-03" -->

Rules:
1. Each marker must have a unique marker ID (fm-xxx) within the chapter
2. The foreshadow attribute references the foreshadowing object ID (fo-xxx)
3. action must be one of: "plant" (first mention), "reinforce" (strengthen), "recover" (payoff)
4. Opening and closing tags must match exactly
5. Markers cannot nest or overlap
6. The tool action selects which marker the candidate body must add: 'plant' needs action="plant" (use it for the first plant in a chapter that has no marker yet), 'strengthen' needs action="reinforce", 'resolve' needs action="recover"
7. 'repair' is only for chapters that get_foreshadowing_context reports as having broken markers
8. Keep every existing marker unchanged unless the task is to change it; the body is the full new chapter body
9. If the chapter has materialUpdates, send the complete reviewed materialUpdates (or null to clear them) along with the changed body

Example:
Original chapter body:
"第三章内容..."

Updated body for plant action (first marker in the chapter):
"第三章内容...<!-- nb:foreshadow marker="fm-01" foreshadow="fo-b9fd550e" action="plant" -->她注意到桌上那条银纹项链<!-- /nb:foreshadow marker="fm-01" -->..."`,
            parameters: ForeshadowingSuggestionSchema, executionMode: "parallel", mutatesWorkspace: false,
            async executeWithContext(context, _toolCallId, raw) {
                const input = parse(ForeshadowingSuggestionSchema, raw, "suggest_foreshadowing_marker") as ForeshadowingMarkerSuggestionInput;
                const ready = requireProject(context);
                const diagnostic = input.action === "repair"
                    ? await readForeshadowingSnapshot({projectRoot: ready.workspace.root})
                    : {snapshot: await currentSnapshot(context), markerIssues: undefined};
                const snapshot = diagnostic.snapshot;
                const operationId = randomUUID();
                try {
                    const prepared = prepareForeshadowingMarkerSuggestion(snapshot, input, diagnostic.markerIssues);
                    const action: LibraryAction | ForeshadowingMarkerRepairAction = input.action === "repair"
                        ? {kind: "repair-foreshadowing-marker", planId: input.planId, entryId: input.entryId as OutlineId,
                            expectedRevision: prepared.change.expectedRevision,
                            foreshadowingId: input.foreshadowingId as OutlineId, expectedVersion: input.expectedVersion,
                            expectedContentHash: input.expectedContentHash, body: input.body,
                            ...(input.materialUpdates === undefined ? {} : {materialUpdates: input.materialUpdates})}
                        : prepared.change.action;
                    const change = {...prepared.change, action, proposalId: planningProposalId({...prepared.change, action})};
                    const audit = createPlanningAuditRecord({
                        operationId,
                        suggestionId: prepared.suggestion.suggestionId,
                        projectGeneration: ready.generation,
                        manifestRevision: snapshot.manifest.revision,
                        targetIds: [input.entryId, input.foreshadowingId],
                        beforeHash: input.expectedContentHash,
                        mode: agentMode(context),
                        actor: {kind: "agent", sessionId: String(context.sessionId)},
                        approvalDecision: "not-required",
                        phase: "preview",
                        result: "previewed",
                    });
                    savePlanningAudit(context, audit);
                    publishPlanningEvent(context, audit);
                    return result("伏笔标记建议", {
                        suggestion: prepared.suggestion,
                        preview: {...prepared.change, action},
                        change,
                        requiresReadoption: prepared.requiresReadoption,
                        operationId,
                        audit,
                    });
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    const audit = createPlanningAuditRecord({
                        operationId,
                        projectGeneration: ready.generation,
                        manifestRevision: snapshot.manifest.revision,
                        targetIds: [input.entryId, input.foreshadowingId],
                        beforeHash: input.expectedContentHash,
                        mode: agentMode(context),
                        actor: {kind: "agent", sessionId: String(context.sessionId)},
                        approvalDecision: "not-required",
                        phase: "preview",
                        result: "failed",
                        error: message,
                    });
                    savePlanningAudit(context, audit);
                    publishPlanningEvent(context, audit);
                    throw error;
                }
            },
        },
        {
            key: "preview_planning_change", name: "preview_planning_change", label: "预览规划变更",
            description: `Validate one planning mutation or deletion and return its current revision, impact, proposed files and risks. Preview never writes.

Detail scenes additionally support H3 场景地点 (actual position, movement, existing material link and relevant conditions) and 角色服饰与外观状态 (per-character attire/state/changes). Under each 参与角色 item, indented fields 角色资料 (existing Markdown link), 当前状态 and 外貌要求 are supported. Keep these concise; the writing assistant reads the full lorebook materials and an independent reviewer checks its supplementation. Do not invent paths or create new characters/items/locations.

Detail entries (entryKind "detail") carry all writing information in the body; follow the detail template in the novel-outline-planning references already loaded in context, do not read them by file path. Body: H1 "# 章节总览" with field lines 章节标题, 剧情概括, 核心冲突, 情绪基调, 目标字数 (required, whole-chapter prose target); H1 "# 章节细纲" with one H2 per scene "## 场景1：名称", numbered from 1, each with field lines 场景简述, 字数要求, 人称要求 (all required), 情绪基调, 剧情节奏, then H3 subsections 参与角色 ("- 角色：目的"), 具体情节 (at least one numbered item; the last item is where the scene ends), 描写, 写作指导, 参考资料 (markdown links to project files; an item without a link is pending), 伏笔 (one item per foreshadow, with sub-items 标记: a chapter outline marker id such as fm-01, 状态: 埋设/强化/回收 matching that marker's action, 作用, 效果); H1 "# 禁止事项" listing plot outcomes that must not happen in this chapter (plot only, never style or wording rules). Do not pass writingGuidance, references or targetWords for details; they are not stored.`,
            parameters: PreviewParametersSchema, executionMode: "parallel", mutatesWorkspace: false,
            async executeWithContext(context, _toolCallId, raw) {
                const preview = parse(PreviewSchema, raw, "preview_planning_change");
                const ready = requireProject(context);
                const snapshot = preview.operation === "mutate" && preview.action.kind === "repair-foreshadowing-marker"
                    ? (await readForeshadowingSnapshot({projectRoot: ready.workspace.root})).snapshot
                    : await currentSnapshot(context);
                const operationId = randomUUID();
                try {
                    const proposal = await previewChange(ready, snapshot, preview);
                    const audit = createPlanningAuditRecord({
                        operationId,
                        projectGeneration: ready.generation,
                        manifestRevision: snapshot.manifest.revision,
                        targetIds: targetIdsForChange(preview),
                        beforeHash: beforeHashForPreview(snapshot, preview),
                        mode: agentMode(context),
                        actor: {kind: "agent", sessionId: String(context.sessionId)},
                        approvalDecision: preview.operation === "mutate" ? "not-required" : "not-required",
                        phase: "preview",
                        result: "previewed",
                    });
                    savePlanningAudit(context, audit);
                    publishPlanningEvent(context, audit);
                    return result("规划变更预览", {...proposal, operationId, audit});
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    const audit = createPlanningAuditRecord({
                        operationId,
                        projectGeneration: ready.generation,
                        manifestRevision: snapshot.manifest.revision,
                        targetIds: targetIdsForChange(preview),
                        beforeHash: beforeHashForPreview(snapshot, preview),
                        mode: agentMode(context),
                        actor: {kind: "agent", sessionId: String(context.sessionId)},
                        approvalDecision: "not-required",
                        phase: "preview",
                        result: "failed",
                        error: message,
                    });
                    savePlanningAudit(context, audit);
                    publishPlanningEvent(context, audit);
                    throw error;
                }
            },
        },
        {
            key: "apply_planning_change", name: "apply_planning_change", label: "确认并执行规划变更",
            description: "Apply explicitly reviewed planning changes. Discuss mode pauses for user approval; auto mode applies non-deleting changes directly and still pauses for deletions (total-outline deletion also needs confirmedTotal).",
            parameters: ApplySchema, approvalRequired: true, approvalConditional: true, mutatesWorkspace: true, executionMode: "sequential",
            requiresApproval: ({args}) => (args as Static<typeof ApplySchema>).changes.some((change) => change.operation !== "mutate"),
            async executeWithContext(context, _toolCallId, raw, _userInput, signal) {
                if (signal?.aborted) throw new Error("规划变更已取消");
                const input = parse(ApplySchema, raw, "apply_planning_change");
                const ready = requireProject(context);
                const actor: OperationActor = {kind: "agent", sessionId: String(context.sessionId)};
                const results: Array<Record<string, unknown>> = [];
                for (const [index, change] of input.changes.entries()) {
                    const operationId = randomUUID();
                    if (signal?.aborted) throw new Error("规划变更已取消");
                    try {
                        assertProposal(change);
                        const applied = await applyChange(ready, change, actor);
                        const audit = createPlanningAuditRecord({
                            operationId,
                            projectGeneration: ready.generation,
                            manifestRevision: change.expectedRevision,
                            targetIds: targetIdsForChange(change),
                            beforeHash: beforeHashForChange(change),
                            mode: "unknown",
                            actor,
                            approvalDecision: "approved",
                            phase: "apply",
                            result: "applied",
                            transactionId: transactionIdFrom(applied),
                        });
                        savePlanningAudit(context, audit);
                        results.push({index, status: "applied", operationId, ...applied, audit});
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        const audit = createPlanningAuditRecord({
                            operationId,
                            projectGeneration: ready.generation,
                            manifestRevision: change.expectedRevision,
                            targetIds: targetIdsForChange(change),
                            beforeHash: beforeHashForChange(change),
                            mode: "unknown",
                            actor,
                            approvalDecision: "approved",
                            phase: "apply",
                            result: "failed",
                            error: message,
                        });
                        savePlanningAudit(context, audit);
                        results.push({index, status: "failed", operationId, error: message, audit});
                    }
                }
                return result("规划变更执行结果", {results, partialFailure: results.some((item) => item.status === "failed")});
            },
        },
        {
            key: "undo_planning_change", name: "undo_planning_change", label: "撤销规划变更",
            description: "Undo one prior planning transaction using CAS. Discuss mode pauses for user approval; auto mode undoes directly. Never overwrites later user changes.",
            parameters: UndoSchema, approvalRequired: true, approvalConditional: true, mutatesWorkspace: true, executionMode: "sequential",
            requiresApproval: () => false,
            async executeWithContext(context, _toolCallId, raw) {
                const input = parse(UndoSchema, raw, "undo_planning_change");
                const ready = requireProject(context);
                const actor: OperationActor = {kind: "agent", sessionId: String(context.sessionId)};
                const operationId = randomUUID();
                const before = await tryReadSnapshot(ready);
                try {
                    const undone = await undoReadyPlanningFiles(ready, input.transactionId, actor);
                    const after = await tryReadSnapshot(ready);
                    const audit = createPlanningAuditRecord({
                        operationId,
                        projectGeneration: ready.generation,
                        manifestRevision: after?.manifest.revision ?? before?.manifest.revision ?? 0,
                        targetIds: [],
                        beforeHash: snapshotHash(before),
                        afterHash: snapshotHash(after),
                        mode: agentMode(context),
                        actor,
                        approvalDecision: "approved",
                        phase: "undo",
                        result: undone.kind === "conflict" ? "failed" : "undone",
                        transactionId: input.transactionId,
                        ...(undone.kind === "conflict" ? {error: "撤销与后续规划修改冲突"} : {}),
                    });
                    savePlanningAudit(context, audit);
                    publishPlanningEvent(context, audit);
                    return result("规划变更撤销结果", {...undone, operationId, audit});
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    const audit = createPlanningAuditRecord({
                        operationId, projectGeneration: ready.generation,
                        manifestRevision: before?.manifest.revision ?? 0, targetIds: [],
                        beforeHash: snapshotHash(before), mode: agentMode(context), actor,
                        approvalDecision: "approved", phase: "undo", result: "failed",
                        transactionId: input.transactionId, error: message,
                    });
                    savePlanningAudit(context, audit);
                    publishPlanningEvent(context, audit);
                    throw error;
                }
            },
        },
    ];
}

/** 专家写入白名单：条目与伏笔的新增、编辑和确认。删除、解除关系与线路编排都会波及共享对象或固定资格，留给规划助手预览并审核。 */
const SPECIALIST_COMMIT_KINDS: ReadonlySet<string> = new Set([
    "create-plan", "associate-total", "unshare-total", "rename-plan", "create-entry", "adopt-entry", "edit-entry", "move-entry",
    "attach-entry", "reorder-entry", "create-foreshadowing", "edit-foreshadowing", "confirm-foreshadowing",
    "repair-foreshadowing-marker",
]);
const SpecialistCommitSchema = Type.Object({changes: Type.Array(AppliedMutationSchema, {minItems: 1, maxItems: 32})}, {additionalProperties: false});

export function createSpecialistPlanningTools(): NeuroAgentTool[] {
    return [{
        key: "commit_planning_change", name: "commit_planning_change", label: "写入规划条目",
        description: "Planning specialists only, during a delegate_planning_task call: apply previewed non-deleting entry and foreshadowing changes. Each change must carry the proposalId returned by preview_planning_change or suggest_foreshadowing_marker. Deletions and line-planning actions are rejected.",
        parameters: SpecialistCommitSchema, mutatesWorkspace: true, executionMode: "sequential",
        async executeWithContext(context, _toolCallId, raw, _userInput, signal) {
            if (!(Object.values(PLANNING_SPECIALIST_PROFILE_KEYS) as string[]).includes(context.profileKey)) {
                throw new Error("commit_planning_change 只供规划专家使用；规划助手请使用 apply_planning_change");
            }
            assertPlanningWriteGrant(context.sessionId);
            const input = parse(SpecialistCommitSchema, raw, "commit_planning_change");
            for (const change of input.changes) {
                if (!SPECIALIST_COMMIT_KINDS.has(change.action.kind)) {
                    throw new Error(`规划专家不能执行 ${change.action.kind}：删除、解除关系和线路操作须交回规划助手审核`);
                }
            }
            const ready = requireProject(context);
            const actor: OperationActor = {kind: "agent", sessionId: String(context.sessionId)};
            const results: Array<Record<string, unknown>> = [];
            for (const [index, change] of input.changes.entries()) {
                if (signal?.aborted) throw new Error("规划变更已取消");
                const operationId = randomUUID();
                const base = {operationId, projectGeneration: ready.generation, manifestRevision: change.expectedRevision,
                    targetIds: targetIdsForChange(change), beforeHash: beforeHashForChange(change), mode: agentMode(context),
                    actor, approvalDecision: "approved" as const, phase: "apply" as const};
                try {
                    assertProposal(change);
                    const applied = await applyChange(ready, change, actor);
                    const audit = createPlanningAuditRecord({...base, result: "applied", transactionId: transactionIdFrom(applied)});
                    savePlanningAudit(context, audit);
                    publishPlanningEvent(context, audit);
                    results.push({index, status: "applied", operationId, ...applied, audit});
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    const audit = createPlanningAuditRecord({...base, result: "failed", error: message});
                    savePlanningAudit(context, audit);
                    publishPlanningEvent(context, audit);
                    results.push({index, status: "failed", operationId, error: message, audit});
                }
            }
            return result("规划专家写入结果", {results, partialFailure: results.some((item) => item.status === "failed")});
        },
    }];
}

async function currentSnapshot(context: ToolExecutionContext): Promise<PlanningSnapshot> {
    requireProject(context);
    return readPlanningSnapshot({projectRoot: context.currentProject!.workspace.root});
}

function requireProject(context: ToolExecutionContext) {
    if (!context.currentProject) throw new Error("规划 Agent 必须绑定当前 ready Project");
    return context.currentProject;
}

function parse<TSchema extends import("typebox").TSchema>(schema: TSchema, value: unknown, name: string): Static<TSchema> {
    if (!Value.Check(schema, value)) throw new Error(`${name} 参数无效`);
    return value as Static<TSchema>;
}

function planningContext(snapshot: PlanningSnapshot, input: Static<typeof ContextSchema>) {
    const mode = input.mode ?? (input.entryIds ? "details" : "overview");
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 32;
    if (input.expectedRevision !== undefined && input.expectedRevision !== snapshot.manifest.revision) {
        throw new Error("规划版本已变化，请重新读取第一页");
    }
    if (mode === "details") {
        if (!input.entryIds || input.planId || input.graphId || input.offset !== undefined || input.limit !== undefined) {
            throw new Error("details 仅支持 entryIds 和 expectedRevision，不支持分页或其它筛选条件");
        }
        const details = entryDetails(snapshot, input.entryIds);
        const relatedIds = new Set(details.flatMap((entry) => [entry.parentId, entry.chapterId,
            ...entry.placements.flatMap((placement) => [placement.parentId, placement.totalId])]).filter((id) => id !== null));
        for (const id of input.entryIds) relatedIds.delete(id as OutlineId);
        return {revision: snapshot.manifest.revision, contextScope: {mode, entryIds: [...input.entryIds].sort()}, details,
            relatedEntries: snapshot.entries.filter(({value}) => relatedIds.has(value.id)).map(entryIndex)};
    }
    if (input.entryIds) throw new Error("entryIds 仅支持 details 模式");
    const topology = mode === "graph-nodes" || mode === "graph-edges";
    if (input.graphId && !topology) throw new Error("graphId 仅支持 graph-nodes 或 graph-edges 模式");
    if (mode === "placements" && !input.planId) throw new Error("placements 需要 planId");
    if (topology && !input.graphId) throw new Error(`${mode} 需要 graphId`);
    const selectedPlan = input.planId ? snapshot.manifest.plans.find((plan) => plan.id === input.planId) : undefined;
    if (input.planId && !selectedPlan) throw new Error(`规划方案不存在：${input.planId}`);
    const base = {revision: snapshot.manifest.revision, contextScope: {mode,
        ...(input.planId ? {planId: input.planId} : {}), ...(input.graphId ? {graphId: input.graphId} : {}), offset, limit}};
    const page = (total: number) => ({offset, limit, total, nextOffset: offset + limit < total ? offset + limit : null});
    const window = <T>(items: readonly T[]) => items.slice(offset, offset + limit);
    const plans = selectedPlan ? [selectedPlan] : snapshot.manifest.plans;
    const entryIds = selectedPlan ? new Set(selectedPlan.placements.map((placement) => placement.entryId)) : undefined;
    const entries = entryIds ? snapshot.entries.filter(({value}) => entryIds.has(value.id)) : snapshot.entries;
    const graphs = input.planId ? snapshot.graphs.filter(({value}) => value.planId === input.planId) : snapshot.graphs;
    const lines = input.planId ? snapshot.lines.filter(({value}) => value.planId === input.planId) : snapshot.lines;
    switch (mode) {
        case "overview":
            return {...base, counts: {plans: plans.length, entries: entries.length,
                foreshadowing: snapshot.foreshadowing.length, graphs: graphs.length, lines: lines.length},
                plans: plans.slice(0, limit).map(planSummary), plansPage: {...page(plans.length), offset: 0,
                    nextOffset: limit < plans.length ? limit : null}, entries: window(entries).map(entryIndex), page: page(entries.length)};
        case "entries":
            return {...base, entries: window(entries).map(entryIndex), page: page(entries.length)};
        case "plans":
            return {...base, plans: window(plans).map(planSummary), page: page(plans.length)};
        case "placements": {
            const placements = selectedPlan!.placements;
            return {...base, plan: planSummary(selectedPlan!), placements: window(placements), page: page(placements.length)};
        }
        case "graphs":
            return {...base, graphs: window(graphs).map(({value, contentHash}) => ({id: value.id, planId: value.planId,
                version: value.version, contentHash, nodeCount: value.nodes.length, edgeCount: value.edges.length})), page: page(graphs.length)};
        case "graph-nodes":
        case "graph-edges": {
            const graph = graphs.find(({value}) => value.id === input.graphId);
            if (!graph) throw new Error(`规划线路图不存在：${input.graphId}`);
            const titles = new Map(snapshot.entries.map(({value}) => [value.id, value.title]));
            const graphVersion = graph.value.version;
            // 格号是方案内剧情先后，行号只是排版；分页仅改变传输范围，不改变节点或边的顺序。
            return mode === "graph-nodes"
                ? {...base, graphVersion, nodes: window(graph.value.nodes).map((node) => ({...node,
                    title: node.entryId === null ? null : titles.get(node.entryId) ?? null})), page: page(graph.value.nodes.length)}
                : {...base, graphVersion, edges: window(graph.value.edges), page: page(graph.value.edges.length)};
        }
        case "lines":
            return {...base, lines: window(lines).map(({value, contentHash}) => ({id: value.id, planId: value.planId,
                title: value.title, type: value.type, fixed: value.fixed, version: value.version, contentHash, nodeIds: value.nodeIds})),
                page: page(lines.length)};
        case "foreshadowing": {
            const states = deriveForeshadowingStates(snapshot).filter((item) => !input.planId || item.sources.some((source) => source.planId === input.planId));
            return {...base, foreshadowing: window(states).map((item) => ({id: item.id, status: item.status,
                sourceCount: item.sources.length, issues: item.issues})), page: page(states.length)};
        }
    }
}

function planSummary(plan: PlanningSnapshot["manifest"]["plans"][number]) {
    return {id: plan.id, title: plan.title, totalId: plan.totalId, placementCount: plan.placements.length};
}

function entryIndex({value, path, contentHash}: PlanningSnapshot["entries"][number]) {
    return {id: value.id, kind: value.kind, status: value.status, title: value.title, parentId: value.parentId,
        version: value.version, contentHash, path, ...(value.adaptation ? {adaptation: value.adaptation} : {})};
}

function entryDetails(snapshot: PlanningSnapshot, entryIds: readonly string[]) {
    const missing = entryIds.filter((id) => !snapshot.entries.some(({value}) => value.id === id));
    if (missing.length) throw new Error(`规划条目不存在：${missing.join(", ")}`);
    return entryIds.map((id) => {
        const {value, path, contentHash, markers} = snapshot.entries.find((entry) => entry.value.id === id)!;
        const {schema: _schema, ...fields} = value;
        const placements = snapshot.manifest.plans.flatMap((plan) => plan.placements.filter((placement) => placement.entryId === id)
            .map((placement) => ({planId: plan.id, totalId: plan.totalId, ...placement})));
        return {...fields, contentHash, path,
            // 多于一个方案挂载即为共享条目：非总纲不能原地编辑或移动，只能由用户在工作台写时分叉。
            planIds: placements.map((placement) => placement.planId), placements,
            ...(value.kind === "chapter" ? {markers} : {})};
    });
}

async function previewChange(ready: NonNullable<ToolExecutionContext["currentProject"]>, snapshot: PlanningSnapshot, change: Preview) {
    if (change.operation === "mutate") {
        const prepared = change.action.kind === "repair-foreshadowing-marker"
            ? await prepareMarkerRepair(ready, change.action as ForeshadowingMarkerRepairAction)
            : prepareChange(snapshot, change, planningCreationSeed(ready, change));
        const publish = preparePlanningPublication(snapshot, prepared.publish);
        const files = await createOutlineRepository({projectRoot: ready.workspace.root}).readCanonicalFiles();
        const candidateFiles = new Map(files.map(file => [file.relativePath, file]));
        for (const mutation of publish.mutations) {
            if (mutation.content === null) candidateFiles.delete(mutation.relativePath);
            else candidateFiles.set(mutation.relativePath, {relativePath: mutation.relativePath, content: mutation.content, contentHash: hashText(mutation.content)});
        }
        const candidate = parsePlanningFiles([...candidateFiles.values()]);
        const materialMutations = await preparePlanningMaterialMutations(ready.workspace.root, snapshot, candidate);
        return {
            kind: "mutation", expectedRevision: change.expectedRevision, nextRevision: change.expectedRevision + 1,
            action: change.action, files: [...publish.mutations, ...materialMutations].map((mutation) => ({relativePath: mutation.relativePath, contentHash: mutation.content === null ? null : `sha256:${hash(mutation.content)}`, bytes: mutation.content === null ? 0 : Buffer.byteLength(mutation.content)})),
            proposalId: planningProposalId(change),
        };
    }
    if (change.operation === "delete-object") {
        const impact = await previewReadyPlanningObjectDeletion(ready, change.targetId as OutlineId);
        if (!impact.objectHash) throw new Error("删除对象预览缺少对象版本");
        const applied = {operation: change.operation, targetId: change.targetId, expectedRevision: impact.revision, expectedObjectHash: impact.objectHash};
        return {kind: "delete-object", ...impact, proposalId: planningProposalId(applied)};
    }
    if (change.operation === "remove-placement") {
        const impact = await previewReadyPlanningPlacementRemoval(ready, change.planId, change.targetId as OutlineId);
        const applied = {operation: change.operation, planId: change.planId, targetId: change.targetId, expectedRevision: impact.revision};
        return {kind: "remove-placement", ...impact, proposalId: planningProposalId(applied)};
    }
    const impact = await previewReadyPlanningPlanRemoval(ready, change.planId);
    const applied = {operation: change.operation, planId: change.planId, expectedRevision: impact.revision};
    return {kind: "delete-plan", ...impact, proposalId: planningProposalId(applied)};
}

function prepareChange(snapshot: PlanningSnapshot, change: Mutation, creationSeed?: string) {
    if (change.expectedRevision !== snapshot.manifest.revision) throw new Error("规划版本已变化，请重新读取并预览");
    if (change.action.kind === "repair-foreshadowing-marker") {
        throw new Error("损坏伏笔标记必须从专用修复预览进入");
    }
    if (isLineAction(change.action)) return prepareLineAction(snapshot, change.action as unknown as LineAction, creationSeed);
    if (change.action.kind.startsWith("create-foreshadowing") || change.action.kind.startsWith("edit-foreshadowing") || change.action.kind.startsWith("confirm-foreshadowing")) {
        return prepareForeshadowingAction(snapshot, change.action as ForeshadowingAction, creationSeed);
    }
    return prepareLibraryAction(snapshot, change.action as LibraryAction, creationSeed);
}

function planningCreationSeed(ready: NonNullable<ToolExecutionContext["currentProject"]>, change: Mutation): string {
    // 一次提案的创建身份必须跨预览与提交一致；方案 revision 变化后生成新的身份。
    return `${ready.workspace.root}:${planningProposalId(change)}`;
}

async function applyChange(ready: NonNullable<ToolExecutionContext["currentProject"]>, change: Change, actor: OperationActor) {
    if (change.operation === "mutate") {
        if (change.action.kind === "repair-foreshadowing-marker") {
            return await repairReadyForeshadowingMarker(ready, change.action as ForeshadowingMarkerRepairAction, actor);
        }
        const snapshot = await readPlanningSnapshot({projectRoot: ready.workspace.root});
        const creationSeed = planningCreationSeed(ready, change);
        prepareChange(snapshot, change, creationSeed);
        if (isLineAction(change.action)) return await applyReadyLineAction(ready, change.action as unknown as LineAction, change.expectedRevision, actor, creationSeed);
        if (change.action.kind.startsWith("create-foreshadowing") || change.action.kind.startsWith("edit-foreshadowing") || change.action.kind.startsWith("confirm-foreshadowing")) {
            return await applyReadyForeshadowingAction(ready, change.action as ForeshadowingAction, change.expectedRevision, actor, creationSeed);
        }
        return await applyReadyLibraryAction(ready, change.action as LibraryAction, change.expectedRevision, actor, creationSeed);
    }
    if (change.operation === "delete-object") {
        return await removeReadyPlanningObject(ready, change.targetId as OutlineId, change.expectedRevision, change.expectedObjectHash, Boolean(change.confirmedTotal), actor);
    }
    if (change.operation === "remove-placement") return await removeReadyPlanningPlacement(ready, change.planId, change.targetId as OutlineId, change.expectedRevision, actor);
    return await removeReadyPlanningPlan(ready, change.planId, change.expectedRevision, actor);
}

async function prepareMarkerRepair(
    ready: NonNullable<ToolExecutionContext["currentProject"]>, action: ForeshadowingMarkerRepairAction,
) {
    const {snapshot, markerIssues} = await readForeshadowingSnapshot({projectRoot: ready.workspace.root});
    if (snapshot.manifest.revision !== action.expectedRevision) {
        throw new Error("规划版本已变化，请重新读取并预览");
    }
    return prepareForeshadowingMarkerRepair(snapshot, markerIssues, action);
}

function savePlanningAudit(context: ToolExecutionContext, audit: PlanningAuditRecord): void {
    if (!context.sessionWrites) return;
    context.sessionWrites.savePointAppend("outline.operation.audit", {
        type: "custom",
        key: `outline.audit.${audit.operationId}`,
        value: audit as unknown as JsonValue,
    });
}

function publishPlanningEvent(context: ToolExecutionContext, audit: PlanningAuditRecord): void {
    const eventType = audit.phase === "preview"
        ? "outline.operation.previewed"
        : audit.result === "undone"
            ? "outline.operation.applied"
            : audit.result === "partial"
                ? "outline.operation.partial"
                : audit.result === "failed" && audit.phase === "undo"
                    ? "outline.operation.undo_conflict"
                    : audit.result === "failed"
                        ? "outline.operation.failed"
                        : "outline.operation.applied";
    context.harness?.eventHub?.publish({
        sessionId: context.sessionId,
        ...(context.invocationId ? {invocationId: context.invocationId} : {}),
        kind: "session",
        event: {type: eventType, operationId: audit.operationId, phase: audit.phase, result: audit.result, targetIds: [...audit.targetIds], ...(audit.transactionId ? {transactionId: audit.transactionId} : {}), ...(audit.error ? {error: audit.error} : {})},
    });
}

/**
 * 规划审计记录用的模式。会话模式是 normal/discuss/plan；规划模块的“自动”对应 normal，
 * “讨论”对应 discuss/plan，因此这里映射而不是取原值。
 */
function agentMode(context: ToolExecutionContext): PlanningAuditRecord["mode"] {
    return context.agentMode === "normal" ? "auto" : "discuss";
}

async function tryReadSnapshot(ready: NonNullable<ToolExecutionContext["currentProject"]>): Promise<PlanningSnapshot | undefined> {
    try {
        return await readPlanningSnapshot({projectRoot: ready.workspace.root});
    } catch {
        return undefined;
    }
}

function snapshotHash(snapshot: PlanningSnapshot | undefined): string | undefined {
    if (!snapshot) return undefined;
    return `sha256:${hash(JSON.stringify({manifest: snapshot.manifest, entries: snapshot.entries, foreshadowing: snapshot.foreshadowing, graphs: snapshot.graphs, lines: snapshot.lines}))}`;
}

function beforeHashForPreview(snapshot: PlanningSnapshot, change: Preview): string | undefined {
    return beforeHashForChange(change) ?? snapshotHash(snapshot);
}
function targetIdsForChange(change: PlanningChange): string[] {
    if (change.operation === "mutate") {
        const action = change.action as Record<string, unknown>;
        return ["id", "entryId", "foreshadowingId", "lineId", "nodeId", "edgeId", "planId"].flatMap((key) =>
            typeof action[key] === "string" ? [action[key] as string] : []);
    }
    if (change.operation === "delete-object" || change.operation === "remove-placement") return [change.targetId];
    return [change.planId];
}

function beforeHashForChange(change: PlanningChange): string | undefined {
    if (change.operation === "delete-object" && "expectedObjectHash" in change) return change.expectedObjectHash;
    if (change.operation === "mutate") {
        const action = change.action as Record<string, unknown>;
        return typeof action.expectedContentHash === "string" ? action.expectedContentHash : undefined;
    }
    return undefined;
}

function transactionIdFrom(value: unknown): string | undefined {
    return typeof value === "object" && value !== null && "transactionId" in value
        && typeof value.transactionId === "string" ? value.transactionId : undefined;
}
function isLineAction(action: Mutation["action"]): boolean {
    return action.kind.endsWith("-line") || action.kind.startsWith("add-graph-") || action.kind.startsWith("move-graph-")
        || action.kind.startsWith("insert-graph-") || action.kind.startsWith("relink-graph-")
        || action.kind.startsWith("connect-graph-") || action.kind.startsWith("remove-graph-");
}
export function planningProposalId(change: {operation: string; expectedRevision: number; action?: unknown; targetId?: string; expectedObjectHash?: string; planId?: string}): string {
    const canonical = change.operation === "mutate"
        ? {operation: change.operation, expectedRevision: change.expectedRevision, action: change.action}
        : change.operation === "delete-object"
            ? {operation: change.operation, targetId: change.targetId, expectedRevision: change.expectedRevision, expectedObjectHash: change.expectedObjectHash}
            : change.operation === "remove-placement"
                ? {operation: change.operation, planId: change.planId, targetId: change.targetId, expectedRevision: change.expectedRevision}
                : {operation: change.operation, planId: change.planId, expectedRevision: change.expectedRevision};
    return `outline:${hash(JSON.stringify(canonical))}`;
}

function assertProposal(change: Change): void {
    const {proposalId: actual, confirmed: _confirmed, confirmedTotal: _confirmedTotal, ...candidate} = change as Change & {proposalId: string; confirmed?: true; confirmedTotal?: true};
    if (actual !== planningProposalId(candidate)) throw new Error("规划预览已变化或已过期，请重新预览");
}

function result(title: string, details: unknown): NeuroToolResult {
    const text = JSON.stringify({title, ...details as Record<string, unknown>}, null, 2);
    return {content: [{type: "text", text}], details: normalizeToolResultDetails(details)};
}

function hash(value: string): string {
    return requireHash(value);
}

function requireHash(value: string): string {
    // Keep this seam dependency-free; outline content hashes use the same SHA-256 format.
    return createHash("sha256").update(value).digest("hex");
}




