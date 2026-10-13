import {contentHash, createStableId, parseEntryMarkdown, serializeEntryMarkdown, serializeManifest, stableFileName, type OutlineId} from "./format";
import {OutlineLibraryError, assertMaterialUpdateMaintenance, forkPlanTotal, type EntryMetadataPatch} from "./library";
import {readPlanningSnapshot, type PlanningPublishInput} from "./index";
import type {OutlineRepositoryOptions} from "./repository";

export type PlanningFork = Readonly<{id: OutlineId; path: string; publish: PlanningPublishInput}>;

/** 为一个共享 placement 构造独立新对象；原条目保持不变，最终仍由发布入口 CAS 校验。 */
export async function preparePlanningFork(
    options: OutlineRepositoryOptions,
    input: Readonly<{planId: string; sourceId: OutlineId; title: string; body: string} & EntryMetadataPatch>,
): Promise<PlanningFork> {
    const snapshot = await readPlanningSnapshot(options);
    const source = snapshot.entries.find((item) => item.value.id === input.sourceId);
    if (!source) throw new OutlineLibraryError("源条目不存在");
    const plan = snapshot.manifest.plans.find((item) => item.id === input.planId);
    if (!plan?.placements.some((item) => item.entryId === input.sourceId)) throw new OutlineLibraryError("目标方案未引用源条目");
    if (source.value.kind === "total") {
        const change = forkPlanTotal(snapshot, plan.id, input.title, input.body, input);
        return {id: change.entryId!, path: change.publish.mutations[0]!.relativePath, publish: change.publish};
    }
    if (snapshot.manifest.plans.filter((item) => item.placements.some((place) => place.entryId === input.sourceId)).length < 2) {
        throw new OutlineLibraryError("条目尚未跨方案共享，无需写时分叉");
    }
    const title = input.title.trim();
    if (!title || title === source.value.title.trim()) throw new OutlineLibraryError("分叉必须使用与源条目不同的名称");
    if (plan.placements.some((item) => item.parentId === input.sourceId)) {
        throw new OutlineLibraryError("当前条目在此方案仍有子级，须先处理关系影响后再分叉");
    }
    // 分叉移除目标方案的原 placement；线路图节点不能悬空或被静默改绑到草稿。
    if (snapshot.graphs.some(({value}) => value.planId === plan.id && value.nodes.some(({entryId}) => entryId === source.value.id))) {
        throw new OutlineLibraryError("本方案线路图仍有节点关联共享条目；请先将节点改为空节点或关联其他条目，再分叉");
    }
    assertMaterialUpdateMaintenance(source.value, input.body, input.materialUpdates);
    const id = createStableId("ol");
    const path = `outline/entries/${stableFileName(title, id, "md")}`;
    // 分析报告绑定原条目和方案上下文，分叉后的新 ID 与草稿不能继承。
    const content = serializeEntryMarkdown({...source.value, id, version: 0, status: "draft", analysis: undefined, basis: undefined, title, body: input.body,
        materialRefs: input.materialRefs === undefined ? source.value.materialRefs : input.materialRefs ?? undefined,
        writingGuidance: input.writingGuidance === undefined ? source.value.writingGuidance : input.writingGuidance ?? undefined,
        references: input.references === undefined ? source.value.references : input.references ?? undefined,
        targetWords: input.targetWords === undefined ? source.value.targetWords : input.targetWords ?? undefined,
        adaptation: input.adaptation === undefined ? source.value.adaptation : input.adaptation ?? undefined,
        materialUpdates: input.materialUpdates === undefined ? source.value.materialUpdates : input.materialUpdates ?? undefined,
    });
    parseEntryMarkdown(content, path);
    const manifest = {
        ...snapshot.manifest,
        revision: snapshot.manifest.revision + 1,
        plans: snapshot.manifest.plans.map((item) => item.id === input.planId ? {
            ...item, placements: item.placements.map((placement) => placement.entryId === input.sourceId ? {...placement, entryId: id} : placement),
        } : item),
        entries: [...snapshot.manifest.entries, {id, path, version: 0, contentHash: contentHash(content)}],
    };
    return {id, path, publish: {expectedManifestRevision: snapshot.manifest.revision, mutations: [
        {relativePath: path, content, expectedHash: null},
        {relativePath: "outline/manifest.yaml", content: serializeManifest(manifest)},
    ]}};
}
