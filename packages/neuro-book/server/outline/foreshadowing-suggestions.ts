import {
    contentHash,
    parseForeshadowMarkers,
    type OutlineId,
} from "./format";
import {OutlineLibraryError, prepareLibraryAction, type LibraryAction, type LibraryChange} from "./library";
import type {PlanningMarkerIssue, PlanningSnapshot} from "./index";

export type ForeshadowingSuggestionAction = "strengthen" | "resolve" | "repair";

export type ForeshadowingMarkerSuggestionInput = Readonly<{
    action: ForeshadowingSuggestionAction;
    expectedRevision: number;
    planId: string;
    entryId: OutlineId;
    foreshadowingId: OutlineId;
    expectedVersion: number;
    expectedContentHash: string;
    body: string;
    rationale: string;
}>;

export type ForeshadowingMarkerRepairAction = Readonly<{
    kind: "repair-foreshadowing-marker";
    expectedRevision: number;
    planId: string;
    entryId: OutlineId;
    foreshadowingId: OutlineId;
    expectedVersion: number;
    expectedContentHash: string;
    body: string;
}>;

export type PreparedForeshadowingMarkerSuggestion = Readonly<{
    suggestion: Readonly<{
        suggestionId: string;
        foreshadowingId: OutlineId;
        action: "strengthen" | "resolve" | "repair";
        sourceEntryIds: readonly [OutlineId];
        rationale: string;
        confidence?: number;
    }>;
    change: Readonly<{
        operation: "mutate";
        expectedRevision: number;
        action: LibraryAction;
    }>;
    requiresReadoption: boolean;
}>;

/**
 * 把 Agent 的伏笔标记建议收口为可复用的规划变更预览。
 *
 * 建议只验证候选正文和当前 CAS，不写入文件；真正写入仍由
 * apply_planning_change 经过用户审批后执行。章节编辑会回到 draft，避免把
 * 模型生成的标记直接当作正式线路来源。
 */
export function prepareForeshadowingMarkerSuggestion(
    snapshot: PlanningSnapshot,
    input: ForeshadowingMarkerSuggestionInput,
    markerIssues?: readonly PlanningMarkerIssue[],
): PreparedForeshadowingMarkerSuggestion {
    const source = snapshot.entries.find(({value}) => value.id === input.entryId);
    if (!source || source.value.kind !== "chapter") {
        throw new OutlineLibraryError("伏笔标记建议只能作用于章节大纲");
    }
    if (snapshot.manifest.revision !== input.expectedRevision) {
        throw new OutlineLibraryError("规划版本已变化，请重新读取", "CAS_CONFLICT");
    }
    if (!snapshot.manifest.plans.some((plan) => plan.id === input.planId
        && plan.placements.some((placement) => placement.entryId === input.entryId))) {
        throw new OutlineLibraryError("章节大纲未加入目标方案链");
    }
    if (source.value.version !== input.expectedVersion || source.contentHash !== input.expectedContentHash) {
        throw new OutlineLibraryError("章节大纲版本已变化，请重新读取", "CAS_CONFLICT");
    }
    if (!input.rationale.trim()) throw new OutlineLibraryError("伏笔建议必须说明理由");
    if (input.body === source.value.body) throw new OutlineLibraryError("伏笔建议没有正文变化");
    if (!snapshot.foreshadowing.some(({value}) => value.id === input.foreshadowingId)) {
        throw new OutlineLibraryError("伏笔定义不存在");
    }
    if (input.action === "repair" && markerIssues !== undefined
        && !markerIssues.some((issue) => issue.entryId === input.entryId && issue.path === source.path)) {
        throw new OutlineLibraryError("目标章节没有可修复的伏笔标记异常");
    }

    const knownForeshadowingIds = new Set(snapshot.foreshadowing.map(({value}) => value.id));
    const markers = parseForeshadowMarkers(input.body, knownForeshadowingIds, source.path);
    const expectedAction = input.action === "strengthen" ? "reinforce" : input.action === "resolve" ? "recover" : null;
    if (expectedAction !== null && !markers.some((marker) => marker.foreshadowId === input.foreshadowingId
        && marker.action === expectedAction)) {
        throw new OutlineLibraryError(`候选正文没有 ${expectedAction} 伏笔标记`);
    }

    const action: LibraryAction = {
        kind: "edit-entry",
        planId: input.planId,
        entryId: input.entryId,
        expectedVersion: input.expectedVersion,
        expectedContentHash: input.expectedContentHash,
        title: source.value.title,
        body: input.body,
    };
    const suggestionId = suggestionIdFor({
        action: input.action,
        expectedRevision: input.expectedRevision,
        planId: input.planId,
        entryId: input.entryId,
        foreshadowingId: input.foreshadowingId,
        expectedVersion: input.expectedVersion,
        expectedContentHash: input.expectedContentHash,
        body: input.body,
        rationale: input.rationale.trim(),
    });
    return {
        suggestion: {
            suggestionId,
            foreshadowingId: input.foreshadowingId,
            action: input.action,
            sourceEntryIds: [input.entryId],
            rationale: input.rationale.trim(),
        },
        change: {operation: "mutate", expectedRevision: snapshot.manifest.revision, action},
        requiresReadoption: source.value.status === "adopted",
    };
}

/**
 * 仅对已被只读诊断确认存在标记损坏的章节开放修复事务。
 *
 * 该入口故意从容错快照生成普通章节编辑批次，但要求候选正文重新通过严格
 * 标记解析；发布后章节回到草稿并由现有线路失效逻辑处理，不能把修复候选
 * 直接恢复成正式来源。
 */
export function prepareForeshadowingMarkerRepair(
    snapshot: PlanningSnapshot,
    markerIssues: readonly PlanningMarkerIssue[],
    input: ForeshadowingMarkerRepairAction,
): LibraryChange {
    const source = snapshot.entries.find(({value}) => value.id === input.entryId);
    if (!source || source.value.kind !== "chapter") {
        throw new OutlineLibraryError("伏笔标记修复只能作用于章节大纲");
    }
    if (!markerIssues.some((issue) => issue.entryId === input.entryId && issue.path === source.path)) {
        throw new OutlineLibraryError("目标章节没有可修复的伏笔标记异常");
    }
    if (!snapshot.manifest.plans.some((plan) => plan.id === input.planId
        && plan.placements.some((placement) => placement.entryId === input.entryId))) {
        throw new OutlineLibraryError("章节大纲未加入目标方案链");
    }
    if (source.value.version !== input.expectedVersion || source.contentHash !== input.expectedContentHash) {
        throw new OutlineLibraryError("章节大纲版本已变化，请重新读取", "CAS_CONFLICT");
    }
    if (input.body === source.value.body) throw new OutlineLibraryError("伏笔修复没有正文变化");
    if (!snapshot.foreshadowing.some(({value}) => value.id === input.foreshadowingId)) {
        throw new OutlineLibraryError("伏笔定义不存在");
    }

    // 这是 repair 的关键门禁：候选正文必须完整可解析，不能把损坏标记再次写回。
    parseForeshadowMarkers(input.body, new Set(snapshot.foreshadowing.map(({value}) => value.id)), source.path);
    return prepareLibraryAction(snapshot, {
        kind: "edit-entry",
        planId: input.planId,
        entryId: input.entryId,
        expectedVersion: input.expectedVersion,
        expectedContentHash: input.expectedContentHash,
        title: source.value.title,
        body: input.body,
    });
}

function suggestionIdFor(input: ForeshadowingMarkerSuggestionInput): string {
    const digest = contentHash(JSON.stringify(input)).slice("sha256:".length, "sha256:".length + 24);
    return `fo-suggestion-${digest}`;
}
