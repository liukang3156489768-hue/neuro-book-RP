import {contentHash, parseManifest, serializeEntryMarkdown, serializeLineYaml, serializeManifest, type OutlineId} from "./format";
import type {PlanningPublishInput, PlanningSnapshot} from "./index";
import {draftOf, lineEntryIds} from "./line-planning";
import {detailReviewScope} from "./detail-analysis";

/**
 * 已采用细纲的上游链（见 detailReviewScope）变化时，在同一批次撤回为草稿并清除报告。
 * 同章其他细纲、其他章节、方案标题与排序的变化不撤回，否则同方案只能保留一份已审阅细纲。
 */
export function invalidateDependentDetails(snapshot: PlanningSnapshot, input: PlanningPublishInput): PlanningPublishInput {
    const manifestMutation = input.mutations.find(({relativePath}) => relativePath === "outline/manifest.yaml");
    if (!manifestMutation?.content) return input;
    const next = parseManifest(manifestMutation.content);
    const editedPaths = new Set(input.mutations.map(({relativePath}) => relativePath));
    const changedEntries = new Set<OutlineId>();
    for (const entry of snapshot.entries) if (editedPaths.has(entry.path)) changedEntries.add(entry.value.id);
    const previousPlacements = new Map(snapshot.manifest.plans.map((plan) =>
        [plan.id, new Set(plan.placements.map(({entryId}) => entryId))] as const));
    const newlyAttached = new Set<OutlineId>();
    for (const plan of next.plans) for (const {entryId} of plan.placements) {
        if (!previousPlacements.get(plan.id)?.has(entryId)) newlyAttached.add(entryId);
    }
    const extra = [];
    const replacements = new Map<OutlineId, {version: number; contentHash: string}>();
    for (const entry of snapshot.entries) {
        if (editedPaths.has(entry.path) || entry.value.kind !== "detail" || entry.value.status !== "adopted") continue;
        // 来源提取细纲的依据是原文引用，不随上游链变化；用户编辑它时 editEntry 已清除 basis。
        if (entry.value.basis) continue;
        const planId = entry.value.analysis?.planId ?? "";
        const before = detailReviewScope(snapshot.manifest, planId, entry.value.id);
        const after = detailReviewScope(next, planId, entry.value.id);
        // 报告仅绑定签发方案；新挂载到另一方案则须撤回，不能借用原方案的正式分析。
        const stale = newlyAttached.has(entry.value.id) || !before || !after || before.hash !== after.hash
            || after.chain.some((id) => changedEntries.has(id));
        if (!stale) continue;
        const content = serializeEntryMarkdown({...entry.value, version: entry.value.version + 1, status: "draft", analysis: undefined});
        extra.push({relativePath: entry.path, content, expectedHash: entry.contentHash});
        replacements.set(entry.value.id, {version: entry.value.version + 1, contentHash: contentHash(content)});
    }
    if (replacements.size === 0) return input;
    // 细纲不能成为线路节点；撤回时需要解固定承载它的章节节点。
    const affectedLineEntries = new Set<OutlineId>(replacements.keys());
    for (const entry of snapshot.entries) {
        if (replacements.has(entry.value.id) && entry.value.chapterId) affectedLineEntries.add(entry.value.chapterId);
    }
    const lines = new Map<OutlineId, {version: number; contentHash: string}>();
    for (const line of snapshot.lines) {
        if (editedPaths.has(line.path) || !line.value.fixed
            || !lineEntryIds(snapshot, line.value).some((id) => affectedLineEntries.has(id))) continue;
        const content = serializeLineYaml(draftOf(line.value, {}));
        extra.push({relativePath: line.path, content, expectedHash: line.contentHash});
        lines.set(line.value.id, {version: line.value.version + 1, contentHash: contentHash(content)});
    }
    const manifest = serializeManifest({...next,
        entries: next.entries.map((ref) => ({...ref, ...(replacements.get(ref.id) ?? {})})),
        lines: next.lines.map((ref) => ({...ref, ...(lines.get(ref.id) ?? {})})),
    });
    return {...input, mutations: [...input.mutations.filter((mutation) => mutation !== manifestMutation), ...extra,
        {...manifestMutation, content: manifest}]};
}
