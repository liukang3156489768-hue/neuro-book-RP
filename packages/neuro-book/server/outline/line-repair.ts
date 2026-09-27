import type {OutlineId} from "./format";
import type {PlanningPublishInput, PlanningSnapshot} from "./index";
import {buildPlanningWrite, draftOf, OutlineLineError, type GraphWrite, type LineWrite} from "./line-planning";

export type MissingEntryRepair = Readonly<{
    missingEntryId: OutlineId;
    expectedRevision: number;
    expectedMissingHash: string;
    confirmRepair: true;
}>;

/**
 * 仅处理唯一丢失的叶条目：引用它的图节点改为空节点，涉及方案的固定线路全部回到草稿。
 * 方案上下文随条目移除而变化，因此即使固定线路不含该节点也不能沿用旧分析。
 */
export function prepareMissingEntryRepair(snapshot: PlanningSnapshot, input: MissingEntryRepair): PlanningPublishInput {
    const {manifest} = snapshot;
    if (manifest.revision !== input.expectedRevision) {
        throw new OutlineLineError("规划版本已变化，请重新读取", "CAS_CONFLICT");
    }
    const existing = new Set(snapshot.entries.map(({value}) => value.id));
    const missing = manifest.entries.filter(({id}) => !existing.has(id));
    if (missing.length !== 1 || missing[0]?.id !== input.missingEntryId) {
        throw new OutlineLineError("丢失条目状态已变化或存在其他缺失文件，请重新预览", "CAS_CONFLICT");
    }
    const target = missing[0];
    if (target.contentHash !== input.expectedMissingHash) {
        throw new OutlineLineError("丢失条目的引用已变化，请重新预览", "CAS_CONFLICT");
    }
    if (input.confirmRepair !== true) throw new OutlineLineError("移除丢失条目引用需要明确确认");
    if (manifest.totalId === target.id || snapshot.entries.some(({value}) =>
        value.parentId === target.id || value.chapterId === target.id)
        || manifest.plans.some(({placements}) => placements.some(({parentId}) => parentId === target.id))) {
        throw new OutlineLineError("丢失条目仍有下级依赖，请先恢复原文件再调整层级");
    }
    const touchedPlans = new Set(manifest.plans.filter(({placements}) =>
        placements.some(({entryId}) => entryId === target.id)).map(({id}) => id));
    const graphs: GraphWrite[] = snapshot.graphs
        .filter(({value}) => value.nodes.some(({entryId}) => entryId === target.id))
        .map((source) => ({source, value: {...source.value, version: source.value.version + 1,
            nodes: source.value.nodes.map((node) => node.entryId === target.id ? {...node, entryId: null} : node)}}));
    const lines: LineWrite[] = snapshot.lines
        .filter(({value}) => value.fixed && touchedPlans.has(value.planId))
        .map((source) => ({source, value: draftOf(source.value, {})}));
    return buildPlanningWrite(snapshot, {graphs, lines, manifest: {...manifest,
        entries: manifest.entries.filter(({id}) => id !== target.id),
        plans: manifest.plans.map((plan) => ({...plan,
            placements: plan.placements.filter(({entryId}) => entryId !== target.id)})),
    }});
}
