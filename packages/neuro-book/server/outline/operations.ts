import {serializeManifest, type OutlineId} from "./format";
import {readPlanningSnapshot, type PlanningPublishInput, type PlanningSnapshot} from "./index";
import type {OutlineRepositoryOptions} from "./repository";
import {OutlineLibraryError} from "./library";
import {buildPlanningWrite, findPlanGraph, lineEntryIds} from "./line-planning";

export type PlanningObjectImpact = Readonly<{
    targetId: OutlineId;
    objectFile: string | null;
    /** 条目类型：用于判断删除行为（容器条目级联删除，叶子条目直接删除） */
    entryKind: "total" | "volume" | "chapter" | "detail" | "foreshadowing" | "line" | null;
    /** 子条目（会被级联删除） */
    children: readonly OutlineId[];
    /** 外部引用（不阻止删除，但需要处理孤立节点） */
    references: readonly Readonly<{sourceFile: string; relation: string; sourceId?: string}>[];
    /** 线路图中引用此条目的节点（删除后会失效） */
    affectedGraphNodes: readonly Readonly<{graphId: OutlineId; nodeId: OutlineId; planId: string}>[];
    canDeleteObject: boolean;
    /** 级联删除的总数（包括自身） */
    cascadeCount: number;
}>;

/**
 * 删除逻辑重构：
 * 1. 章节/细纲（叶子条目）：直接删除，线路图中的失效节点自动标记（由前端处理）
 * 2. 卷纲/总纲（容器条目）：级联删除所有子条目
 * 3. 不再要求删除前必须解除所有引用
 */
export function inspectPlanningObject(snapshot: PlanningSnapshot, targetId: OutlineId): PlanningObjectImpact {
    const object = [...snapshot.entries, ...snapshot.foreshadowing, ...snapshot.lines]
        .find((item) => item.value.id === targetId);

    if (!object) {
        return {
            targetId,
            objectFile: null,
            entryKind: null,
            children: [],
            references: [],
            affectedGraphNodes: [],
            canDeleteObject: false,
            cascadeCount: 0
        };
    }

    // 确定条目类型
    const entry = snapshot.entries.find((item) => item.value.id === targetId);
    const entryKind = entry ? entry.value.kind :
                      snapshot.foreshadowing.find((item) => item.value.id === targetId) ? "foreshadowing" as const :
                      "line" as const;

    // 收集直接子条目（会被级联删除）
    const children: OutlineId[] = [];
    if (entry) {
        // 找出所有以此条目为 parent 的条目
        for (const child of snapshot.entries) {
            if (child.value.parentId === targetId) {
                children.push(child.value.id);
            }
        }
    }

    // 递归计算级联删除数量
    const countCascade = (id: OutlineId): number => {
        let count = 1;
        for (const child of snapshot.entries) {
            if (child.value.parentId === id) {
                count += countCascade(child.value.id);
            }
        }
        return count;
    };
    const cascadeCount = countCascade(targetId);

    // 收集外部引用（不阻止删除，仅用于提示）
    const references: Array<{sourceFile: string; relation: string; sourceId?: string}> = [];

    // Placement 引用（总纲的 placement 不算引用，因为删除总纲会删除整个方案关系）
    for (const plan of snapshot.manifest.plans) {
        for (const placement of plan.placements) {
            if (placement.entryId === targetId && entryKind !== "total") {
                references.push({sourceFile: "outline/manifest.yaml", relation: "placement", sourceId: plan.id});
            }
        }
    }

    // 伏笔标记引用（不阻止删除）
    for (const checkEntry of snapshot.entries) {
        if (checkEntry.value.id !== targetId) {
            for (const marker of checkEntry.markers) {
                if (marker.foreshadowId === targetId) {
                    references.push({sourceFile: checkEntry.path, relation: `marker:${marker.marker}`, sourceId: checkEntry.value.id});
                }
            }
        }
    }

    // 收集线路图中受影响的节点（删除后会失效，但不阻止删除）
    const affectedGraphNodes: Array<{graphId: OutlineId; nodeId: OutlineId; planId: string}> = [];
    for (const graph of snapshot.graphs) {
        for (const node of graph.value.nodes) {
            if (node.entryId === targetId) {
                affectedGraphNodes.push({
                    graphId: graph.value.id,
                    nodeId: node.id,
                    planId: graph.value.planId
                });
            }
        }
    }

    // 总纲、卷纲、章节、细纲、伏笔、线路都可以直接删除
    // 容器条目会级联删除子条目
    const canDeleteObject = true;

    return {
        targetId,
        objectFile: object.path,
        entryKind,
        children,
        references,
        affectedGraphNodes,
        canDeleteObject,
        cascadeCount
    };
}

export async function previewPlanningObjectDeletion(options: OutlineRepositoryOptions, targetId: OutlineId): Promise<PlanningObjectImpact> {
    return inspectPlanningObject(await readPlanningSnapshot(options), targetId);
}

/** 对象删除支持级联删除子条目；线路图中的失效节点由前端标记处理。 */
export async function preparePlanningObjectDeletion(
    options: OutlineRepositoryOptions, targetId: OutlineId, confirmedTotal = false,
): Promise<PlanningPublishInput> {
    const snapshot = await readPlanningSnapshot(options);
    return preparePlanningObjectDeletionFromSnapshot(snapshot, targetId, confirmedTotal);
}

/** 从已有快照准备删除操作（用于测试和批量操作） */
export function preparePlanningObjectDeletionFromSnapshot(
    snapshot: PlanningSnapshot, targetId: OutlineId, confirmedTotal = false,
): PlanningPublishInput {
    const impact = inspectPlanningObject(snapshot, targetId);

    if (!impact.canDeleteObject || !impact.objectFile) {
        throw new Error("对象不存在");
    }

    if (impact.entryKind === "total" && !confirmedTotal) {
        throw new Error("删除总纲需要二次确认");
    }

    // 收集所有需要删除的条目 ID（包括级联删除的子条目）
    const allDeleteIds = new Set<OutlineId>([targetId]);
    const collectChildren = (id: OutlineId) => {
        for (const entry of snapshot.entries) {
            if (entry.value.parentId === id && !allDeleteIds.has(entry.value.id)) {
                allDeleteIds.add(entry.value.id);
                collectChildren(entry.value.id);
            }
        }
    };
    collectChildren(targetId);

    // 收集所有需要删除的文件
    const mutations: Array<{relativePath: string; content: string | null}> = [];

    // 删除条目文件
    for (const id of allDeleteIds) {
        const entry = [...snapshot.entries, ...snapshot.foreshadowing, ...snapshot.lines]
            .find((item) => item.value.id === id);
        if (entry) {
            mutations.push({relativePath: entry.path, content: null});
        }
    }

    // 更新 manifest：移除所有被删除的条目
    const manifest = snapshot.manifest;
    const newManifest = {
        ...manifest,
        revision: manifest.revision + 1,
        totalId: manifest.totalId === targetId ? null : manifest.totalId,
        entries: manifest.entries.filter((item) => !allDeleteIds.has(item.id)),
        foreshadowing: manifest.foreshadowing.filter((item) => !allDeleteIds.has(item.id)),
        lines: manifest.lines.filter((item) => !allDeleteIds.has(item.id)),
        // 清理所有方案中被删除条目的 placement
        plans: manifest.plans.map((plan) => ({
            ...plan,
            placements: plan.placements.filter((p) => !allDeleteIds.has(p.entryId))
        }))
    };

    mutations.push({
        relativePath: "outline/manifest.yaml",
        content: serializeManifest(newManifest)
    });

    return {expectedManifestRevision: manifest.revision, mutations};
}

export type PlanningRelationImpact = Readonly<{
    planId: string; targetId: OutlineId; sourceFile: "outline/manifest.yaml";
    objectFileRemains: true;
    childReferences: readonly OutlineId[];
    blockingFixedLineIds: readonly OutlineId[];
    /** 本方案线路图中关联该条目的节点；节点只能关联本方案挂载的条目。 */
    graphNodeIds: readonly OutlineId[];
    canRemovePlacement: boolean;
}>;

/** 线路图节点只能关联本方案挂载的条目，预览与提交必须按同一快照阻断。 */
export function inspectPlanningPlacement(snapshot: PlanningSnapshot, planId: string, targetId: OutlineId): PlanningRelationImpact {
    const plan = snapshot.manifest.plans.find((item) => item.id === planId);
    if (!plan?.placements.some((item) => item.entryId === targetId)) throw new Error("方案关系不存在");
    const childReferences = plan.placements.filter((item) => item.parentId === targetId).map((item) => item.entryId);
    const graphNodeIds = findPlanGraph(snapshot, planId)?.value.nodes
        .filter(({entryId}) => entryId === targetId).map(({id}) => id) ?? [];
    const blockingFixedLineIds = snapshot.lines.filter(({value}) => value.planId === planId && value.fixed
        && lineEntryIds(snapshot, value).includes(targetId)).map(({value}) => value.id);
    return {
        planId, targetId, sourceFile: "outline/manifest.yaml", objectFileRemains: true,
        childReferences, blockingFixedLineIds, graphNodeIds,
        canRemovePlacement: childReferences.length === 0 && snapshot.manifest.totalId !== targetId
            && graphNodeIds.length === 0,
    };
}

export async function preparePlanningPlacementRemoval(
    options: OutlineRepositoryOptions, planId: string, targetId: OutlineId,
): Promise<Readonly<{impact: PlanningRelationImpact; publish: PlanningPublishInput}>> {
    const snapshot = await readPlanningSnapshot(options);
    const impact = inspectPlanningPlacement(snapshot, planId, targetId);
    if (impact.childReferences.length > 0) throw new Error("方案关系存在子级，必须先处理删除影响");
    if (snapshot.manifest.totalId === targetId) throw new Error("方案不能移除共享的唯一总纲根引用");
    if (impact.graphNodeIds.length > 0) throw new OutlineLibraryError("方案线路图仍有节点关联该条目，请先改为空节点或删除节点");
    return {impact, publish: {expectedManifestRevision: snapshot.manifest.revision, mutations: [
        {relativePath: "outline/manifest.yaml", content: serializeManifest({
            ...snapshot.manifest, revision: snapshot.manifest.revision + 1,
            plans: snapshot.manifest.plans.map((plan) => plan.id === planId ? {
                ...plan, placements: plan.placements.filter((item) => item.entryId !== targetId),
            } : plan),
        })},
    ]}};
}

export type PlanningPlanImpact = Readonly<{
    planId: string;
    sourceFile: "outline/manifest.yaml";
    placementIds: readonly OutlineId[];
    exclusiveEntryIds: readonly OutlineId[];
    blockingFixedLineIds: readonly OutlineId[];
    /** 随方案一起删除的线路图与草稿线路；它们只属于这个方案。 */
    graphId: OutlineId | null;
    draftLineIds: readonly OutlineId[];
    objectFilesRemain: true;
    canRemovePlan: boolean;
}>;

/** 移除方案解除条目关系并删除其线路图与草稿线路；固定线路须先重开，不能随方案静默消失。 */
export function inspectPlanningPlan(snapshot: PlanningSnapshot, planId: string): PlanningPlanImpact {
    const plan = snapshot.manifest.plans.find(({id}) => id === planId);
    if (!plan) throw new OutlineLibraryError("方案链不存在");
    const placementIds = plan.placements.map(({entryId}) => entryId);
    const otherIds = new Set(snapshot.manifest.plans.filter(({id}) => id !== planId)
        .flatMap(({placements}) => placements.map(({entryId}) => entryId)));
    const exclusiveEntryIds = placementIds.filter((id) => !otherIds.has(id));
    const lines = snapshot.lines.filter(({value}) => value.planId === planId);
    const blockingFixedLineIds = lines.filter(({value}) => value.fixed).map(({value}) => value.id);
    return {planId, sourceFile: "outline/manifest.yaml", placementIds, exclusiveEntryIds, blockingFixedLineIds,
        graphId: findPlanGraph(snapshot, planId)?.value.id ?? null,
        draftLineIds: lines.filter(({value}) => !value.fixed).map(({value}) => value.id),
        objectFilesRemain: true, canRemovePlan: blockingFixedLineIds.length === 0};
}

export function preparePlanningPlanRemoval(snapshot: PlanningSnapshot, planId: string): PlanningPublishInput {
    const impact = inspectPlanningPlan(snapshot, planId);
    if (!impact.canRemovePlan) throw new OutlineLibraryError("方案仍有固定线路，请先重开线路");
    const removed = [...snapshot.graphs, ...snapshot.lines]
        .filter(({value}) => value.planId === planId)
        .map(({path, contentHash, value}) => ({path, contentHash, id: value.id}));
    return buildPlanningWrite(snapshot, {removed, manifest: {...snapshot.manifest,
        plans: snapshot.manifest.plans.filter(({id}) => id !== planId)}});
}