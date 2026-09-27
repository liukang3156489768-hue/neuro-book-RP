import {contentHash, parseManifest, serializeEntryMarkdown, serializeLineYaml, serializeManifest, type OutlineId} from "./format";
import type {PlanningPublishInput, PlanningSnapshot} from "./index";
import {draftOf, lineEntryIds} from "./line-planning";

/** 规划上下文变动时，同方案已采用细纲不能保留依赖旧报告的正式状态。 */
export function invalidateDependentDetails(snapshot: PlanningSnapshot, input: PlanningPublishInput): PlanningPublishInput {
    const manifestMutation = input.mutations.find(({relativePath}) => relativePath === "outline/manifest.yaml");
    if (!manifestMutation?.content) return input;
    const next = parseManifest(manifestMutation.content);
    const changedEntries = new Set<OutlineId>();
    const editedPaths = new Set(input.mutations.map(({relativePath}) => relativePath));
    for (const entry of snapshot.entries) if (editedPaths.has(entry.path)) changedEntries.add(entry.value.id);
    const touchedPlans = new Set<string>();
    for (const plan of snapshot.manifest.plans) {
        const updated = next.plans.find(({id}) => id === plan.id);
        if (!updated || JSON.stringify(plan) !== JSON.stringify(updated)
            || plan.placements.some(({entryId}) => changedEntries.has(entryId))) touchedPlans.add(plan.id);
    }
    for (const plan of next.plans) {
        if (plan.placements.some(({entryId}) => changedEntries.has(entryId))) touchedPlans.add(plan.id);
    }
    if (touchedPlans.size === 0) return input;
    const affected = new Set<OutlineId>();
    for (const plan of snapshot.manifest.plans) {
        if (!touchedPlans.has(plan.id)) continue;
        for (const placement of plan.placements) affected.add(placement.entryId);
    }
    // 新挂载的已采用细纲不在旧方案快照中，仍必须撤回原方案分析报告。
    for (const plan of next.plans) {
        if (!touchedPlans.has(plan.id)) continue;
        for (const placement of plan.placements) affected.add(placement.entryId);
    }
    const previousPlacements = new Map(snapshot.manifest.plans.map((plan) =>
        [plan.id, new Set(plan.placements.map(({entryId}) => entryId))] as const));
    const newlyAttached = new Set<OutlineId>();
    for (const plan of next.plans) for (const {entryId} of plan.placements) {
        if (!previousPlacements.get(plan.id)?.has(entryId)) newlyAttached.add(entryId);
    }
    const extra = [];
    const replacements = new Map<OutlineId, {version: number; contentHash: string}>();
    for (const entry of snapshot.entries) {
        if (!affected.has(entry.value.id) || editedPaths.has(entry.path)
            || entry.value.kind !== "detail" || entry.value.status !== "adopted") continue;
        // 报告仅绑定签发方案；新挂载到另一方案则须撤回，不能借用原方案的正式分析。
        if (!touchedPlans.has(entry.value.analysis?.planId ?? "") && !newlyAttached.has(entry.value.id)) continue;
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
