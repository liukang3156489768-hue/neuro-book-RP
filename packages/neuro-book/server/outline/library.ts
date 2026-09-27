import {randomUUID} from "node:crypto";
import {
    OUTLINE_ENTRY_SCHEMA, canParentEntry, contentHash, createStableId, parseEntryMarkdown, serializeEntryMarkdown, serializeManifest, stableFileName,
    type DetailAnalysis, type OutlineEntry, type OutlineEntryKind, type OutlineId,
} from "./format";
import type {PlanningPublishInput, PlanningSnapshot} from "./index";
import {buildPlanningWrite, draftOf, lineEntryIds} from "./line-planning";

export class OutlineLibraryError extends Error {
    constructor(message: string, readonly code: "INVALID_ACTION" | "CAS_CONFLICT" = "INVALID_ACTION") {
        super(message);
        this.name = "OutlineLibraryError";
    }
}

export type LibraryNode = Readonly<{
    entry: OutlineEntry;
    children: readonly LibraryNode[];
}>;

export function getLibraryTrees(snapshot: PlanningSnapshot): readonly Readonly<{id: string; title: string; root: LibraryNode}>[] {
    const entries = new Map(snapshot.entries.map(({value}) => [value.id, value]));
    return snapshot.manifest.plans.map((plan) => {
        const children = new Map<OutlineId, typeof plan.placements[number][]>();
        for (const placement of plan.placements) {
            if (placement.parentId !== null) {
                const siblings = children.get(placement.parentId) ?? [];
                siblings.push(placement);
                children.set(placement.parentId, siblings);
            }
        }
        const node = (entryId: OutlineId): LibraryNode => ({
            entry: entries.get(entryId)!,
            children: (children.get(entryId) ?? []).sort((a, b) => a.position - b.position).map((place) => node(place.entryId)),
        });
        return {id: plan.id, title: plan.title, root: node(snapshot.manifest.totalId!)};
    });
}

export type EntryMetadata = Pick<OutlineEntry, "materialRefs" | "writingGuidance" | "references" | "targetWords">;

export type EntryMetadataPatch = Readonly<{[K in keyof EntryMetadata]?: NonNullable<EntryMetadata[K]> | null}>;

export type LibraryAction =
    | Readonly<{kind: "create-total"; title: string; body: string}>
    | Readonly<{kind: "create-plan"; title: string}>
    | Readonly<{kind: "rename-plan"; planId: string; title: string}>
    | Readonly<{kind: "create-entry"; planId: string; parentId: OutlineId; entryKind: Exclude<OutlineEntryKind, "total">; title: string; body: string} & EntryMetadata>
    | Readonly<{kind: "adopt-entry"; planId: string; entryId: OutlineId; expectedVersion: number; expectedContentHash: string}>
    | Readonly<{kind: "edit-entry"; planId: string; entryId: OutlineId; expectedVersion: number; expectedContentHash: string;
        title: string; body: string; confirmGlobal?: true} & EntryMetadataPatch>
    | Readonly<{kind: "move-entry"; planId: string; entryId: OutlineId; parentId: OutlineId; expectedVersion: number; expectedContentHash: string}>
    | Readonly<{kind: "attach-entry"; planId: string; parentId: OutlineId; entryId: OutlineId}>
    | Readonly<{kind: "reorder-entry"; planId: string; entryId: OutlineId; siblingIndex: number}>;

export type LibraryChange = Readonly<{publish: PlanningPublishInput; entryId?: OutlineId; planId?: string}>;

/** 领域操作只生成草稿与关系变更；正式采用必须经独立分析和授权入口。 */
export function prepareLibraryAction(snapshot: PlanningSnapshot, action: LibraryAction): LibraryChange {
    const manifest = snapshot.manifest;
    if (action.kind === "create-total") {
        if (manifest.totalId !== null || snapshot.entries.length > 0) throw new OutlineLibraryError("全局总纲已经存在");
        return createEntry(snapshot, "total", action.title, action.body, null, null);
    }
    if (action.kind === "create-plan") {
        if (manifest.totalId === null) throw new OutlineLibraryError("请先创建全局总纲");
        const title = requiredTitle(action.title);
        assertUniquePlanTitle(manifest.plans, title);
        const planId = `plan-${randomUUID()}`;
        return {planId, publish: manifestOnly(snapshot, {
            ...manifest, plans: [...manifest.plans, {id: planId, title, placements: [{entryId: manifest.totalId, parentId: null, position: 0}]}],
        })};
    }
    const plan = manifest.plans.find((item) => item.id === action.planId);
    if (!plan) throw new OutlineLibraryError("方案链不存在");
    if (action.kind === "rename-plan") {
        const title = requiredTitle(action.title);
        if (title === plan.title) throw new OutlineLibraryError("方案链标题与原名称相同");
        assertUniquePlanTitle(manifest.plans, title);
        return {planId: plan.id, publish: manifestOnly(snapshot, {
            ...manifest, plans: manifest.plans.map((item) => item.id === plan.id ? {...item, title} : item),
        })};
    }
    if (action.kind === "create-entry") {
        const parent = snapshot.entries.find((item) => item.value.id === action.parentId)?.value;
        if (!parent || !plan.placements.some((place) => place.entryId === parent.id)) throw new OutlineLibraryError("父级未加入目标方案链");
        if (!canParentEntry(parent.kind, action.entryKind)) throw new OutlineLibraryError("大纲条目层级不合法");
        return createEntry(snapshot, action.entryKind, action.title, action.body, parent.id, plan.id, action);
    }
    if (action.kind === "adopt-entry") return adoptEntry(snapshot, action);
    if (action.kind === "edit-entry") return editEntry(snapshot, action);
    if (action.kind === "move-entry") return moveEntry(snapshot, action);
    if (action.kind === "attach-entry") {
        const entry = snapshot.entries.find((item) => item.value.id === action.entryId)?.value;
        if (!entry || entry.kind === "total" || entry.parentId !== action.parentId) throw new OutlineLibraryError("条目不存在或父级关系不符");
        if (!plan.placements.some((place) => place.entryId === action.parentId)) throw new OutlineLibraryError("父级未加入目标方案链");
        if (plan.placements.some((place) => place.entryId === entry.id)) throw new OutlineLibraryError("条目已在此方案链中");
        return {publish: manifestOnly(snapshot, {
            ...manifest, plans: manifest.plans.map((item) => item.id === plan.id ? {...item, placements: [
                ...item.placements, {entryId: entry.id, parentId: action.parentId, position: nextPosition(item.placements)},
            ]} : item),
        })};
    }
    const target = plan.placements.find((place) => place.entryId === action.entryId);
    if (!target || target.parentId === null) throw new OutlineLibraryError("根总纲不能重排或条目不存在");
    const siblings = plan.placements.filter((place) => place.parentId === target.parentId).sort((a, b) => a.position - b.position);
    if (!Number.isInteger(action.siblingIndex) || action.siblingIndex < 0 || action.siblingIndex >= siblings.length) {
        throw new OutlineLibraryError("同级顺序超出范围");
    }
    const desired = siblings.filter((place) => place.entryId !== target.entryId);
    desired.splice(action.siblingIndex, 0, target);
    const originalPositions = siblings.map((place) => place.position);
    const byId = new Map(desired.map((place, index) => [place.entryId, originalPositions[index]!]));
    return {publish: manifestOnly(snapshot, {
        ...manifest, plans: manifest.plans.map((item) => item.id === plan.id ? {...item, placements: item.placements.map((place) => (
            byId.has(place.entryId) ? {...place, position: byId.get(place.entryId)!} : place
        ))} : item),
    })};
}

function createEntry(
    snapshot: PlanningSnapshot, kind: OutlineEntryKind, titleInput: string, body: string,
    parentId: OutlineId | null, planId: string | null, metadata: EntryMetadata = {},
): LibraryChange {
    const title = requiredTitle(titleInput);
    const id = createStableId("ol");
    const entry: OutlineEntry = {
        schema: OUTLINE_ENTRY_SCHEMA, id, version: 0, kind, status: "draft", title,
        parentId, chapterId: kind === "detail" ? parentId : null, body,
        ...(metadata.materialRefs === undefined ? {} : {materialRefs: metadata.materialRefs}),
        ...(metadata.writingGuidance === undefined ? {} : {writingGuidance: metadata.writingGuidance}),
        ...(metadata.references === undefined ? {} : {references: metadata.references}),
        ...(metadata.targetWords === undefined ? {} : {targetWords: metadata.targetWords}),
    };
    const file = serializeEntryMarkdown(entry);
    parseEntryMarkdown(file);
    const relativePath = `outline/entries/${stableFileName(title, id, "md")}`;
    const manifest = snapshot.manifest;
    const plans = planId === null ? manifest.plans : manifest.plans.map((plan) => plan.id === planId ? {
        ...plan, placements: [...plan.placements, {entryId: id, parentId, position: nextPosition(plan.placements)}],
    } : plan);
    return {entryId: id, publish: {
        expectedManifestRevision: manifest.revision,
        mutations: [
            {relativePath, content: file, expectedHash: null},
            {relativePath: "outline/manifest.yaml", content: serializeManifest({
                ...manifest, revision: manifest.revision + 1,
                totalId: kind === "total" ? id : manifest.totalId, plans,
                entries: [...manifest.entries, {id, path: relativePath, version: 0, contentHash: contentHash(file)}],
            })},
        ],
    }};
}

export function prepareDetailAdoption(snapshot: PlanningSnapshot, entryId: OutlineId, planId: string, analysis: DetailAnalysis): LibraryChange {
    const source = snapshot.entries.find(({value}) => value.id === entryId);
    if (!source || source.value.kind !== "detail" || source.value.status !== "draft") {
        throw new OutlineLibraryError("只有草稿细纲可以正式采用");
    }
    return adoptEntry(snapshot, {kind: "adopt-entry", planId, entryId, expectedVersion: source.value.version,
        expectedContentHash: source.contentHash}, analysis);
}

function adoptEntry(snapshot: PlanningSnapshot, action: Extract<LibraryAction, {kind: "adopt-entry"}>, analysis?: DetailAnalysis): LibraryChange {
    const source = snapshot.entries.find(({value}) => value.id === action.entryId);
    if (!source || !snapshot.manifest.plans.some((plan) => plan.id === action.planId
        && plan.placements.some((place) => place.entryId === action.entryId))) {
        throw new OutlineLibraryError("条目未加入目标方案链");
    }
    if (source.value.version !== action.expectedVersion || source.contentHash !== action.expectedContentHash) {
        throw new OutlineLibraryError("条目版本已变化，请重新读取", "CAS_CONFLICT");
    }
    if (source.value.kind === "detail" && !analysis) throw new OutlineLibraryError("细纲正式采用前必须完成 AI 偏差与冲突分析");
    if (source.value.status !== "draft") throw new OutlineLibraryError("条目已正式采用");
    const content = serializeEntryMarkdown({...source.value, version: source.value.version + 1, status: "adopted",
        ...(analysis ? {analysis} : {})});
    const manifest = snapshot.manifest;
    return {entryId: source.value.id, publish: {expectedManifestRevision: manifest.revision, mutations: [
        {relativePath: source.path, content, expectedHash: source.contentHash},
        {relativePath: "outline/manifest.yaml", content: serializeManifest({...manifest, revision: manifest.revision + 1,
            entries: manifest.entries.map((item) => item.id === source.value.id
                ? {...item, version: source.value.version + 1, contentHash: contentHash(content)} : item),
        })},
    ]}};
}

function editEntry(snapshot: PlanningSnapshot, action: Extract<LibraryAction, {kind: "edit-entry"}>): LibraryChange {
    const source = snapshot.entries.find(({value}) => value.id === action.entryId);
    if (!source || !snapshot.manifest.plans.some((plan) => plan.id === action.planId
        && plan.placements.some((place) => place.entryId === action.entryId))) {
        throw new OutlineLibraryError("条目未加入目标方案链");
    }
    if (snapshot.manifest.plans.filter((plan) => plan.placements.some((place) => place.entryId === action.entryId)).length > 1) {
        if (source.value.kind !== "total") throw new OutlineLibraryError("共享条目须经用户确认写时分叉，不能原地修改");
        if (action.confirmGlobal !== true) throw new OutlineLibraryError("修改全局总纲会影响所有方案，必须先确认影响范围");
    }
    if (source.value.version !== action.expectedVersion || source.contentHash !== action.expectedContentHash) {
        throw new OutlineLibraryError("条目版本已变化，请重新读取", "CAS_CONFLICT");
    }
    const update: OutlineEntry = {
        ...source.value, title: requiredTitle(action.title), body: action.body, version: source.value.version + 1, status: "draft", analysis: undefined,
        materialRefs: action.materialRefs === undefined ? source.value.materialRefs : action.materialRefs ?? undefined,
        writingGuidance: action.writingGuidance === undefined ? source.value.writingGuidance : action.writingGuidance ?? undefined,
        references: action.references === undefined ? source.value.references : action.references ?? undefined,
        targetWords: action.targetWords === undefined ? source.value.targetWords : action.targetWords ?? undefined,
    };
    return saveEntryUpdate(snapshot, source, update);
}

function moveEntry(snapshot: PlanningSnapshot, action: Extract<LibraryAction, {kind: "move-entry"}>): LibraryChange {
    const source = snapshot.entries.find(({value}) => value.id === action.entryId);
    const plan = snapshot.manifest.plans.find((item) => item.id === action.planId);
    const placement = plan?.placements.find((item) => item.entryId === action.entryId);
    const parent = snapshot.entries.find(({value}) => value.id === action.parentId)?.value;
    if (!source || !plan || !placement || source.value.kind === "total") throw new OutlineLibraryError("移动条目未加入目标方案链");
    if (!parent || !plan.placements.some((item) => item.entryId === parent.id)
        || !canParentEntry(parent.kind, source.value.kind) || action.entryId === action.parentId) {
        throw new OutlineLibraryError("移动目标父级不存在或类型不合法");
    }
    if (source.value.version !== action.expectedVersion || source.contentHash !== action.expectedContentHash) {
        throw new OutlineLibraryError("条目版本已变化，请重新读取", "CAS_CONFLICT");
    }
    if (snapshot.manifest.plans.some((item) => item.id !== plan.id && item.placements.some((place) => place.entryId === action.entryId))) {
        throw new OutlineLibraryError("共享条目不能直接移动，请先确认分叉并处理引用关系");
    }
    if (source.value.parentId === parent.id) throw new OutlineLibraryError("条目已位于该父级，可使用同级重排");
    const update: OutlineEntry = {...source.value, parentId: parent.id,
        chapterId: source.value.kind === "detail" ? parent.id : null,
        version: source.value.version + 1, status: "draft", analysis: undefined};
    const plans = snapshot.manifest.plans.map((item) => item.id === plan.id ? {
        ...item, placements: item.placements.map((place) => place.entryId === source.value.id
            ? {...place, parentId: parent.id, position: nextPosition(item.placements)} : place),
    } : item);
    return saveEntryUpdate(snapshot, source, update, plans);
}

function saveEntryUpdate(
    snapshot: PlanningSnapshot, source: PlanningSnapshot["entries"][number], update: OutlineEntry,
    plans: PlanningSnapshot["manifest"]["plans"] = snapshot.manifest.plans,
): LibraryChange {
    const content = serializeEntryMarkdown(update);
    parseEntryMarkdown(content, source.path);
    // 已采用细纲不能成为线路节点；改动它时，所属章节的固定线路也必须失效。
    const affectedEntries = new Set<OutlineId>([update.id]);
    if (source.value.kind === "detail" && source.value.status === "adopted" && source.value.chapterId) {
        affectedEntries.add(source.value.chapterId);
    }
    const lines = snapshot.lines
        .filter(({value}) => value.fixed && lineEntryIds(snapshot, value).some((id) => affectedEntries.has(id)))
        .map((line) => ({source: line, value: draftOf(line.value, {})}));
    const manifest = snapshot.manifest;
    const publish = buildPlanningWrite(snapshot, {lines, manifest: {...manifest, plans,
        entries: manifest.entries.map((item) => item.id === update.id ? {...item, version: update.version, contentHash: contentHash(content)} : item),
    }});
    return {entryId: update.id, publish: {...publish, mutations: [
        {relativePath: source.path, content, expectedHash: source.contentHash}, ...publish.mutations]}};
}

function manifestOnly(snapshot: PlanningSnapshot, manifest: PlanningSnapshot["manifest"]): PlanningPublishInput {
    return {expectedManifestRevision: snapshot.manifest.revision, mutations: [{
        relativePath: "outline/manifest.yaml", content: serializeManifest({...manifest, revision: snapshot.manifest.revision + 1}),
    }]};
}

function nextPosition(placements: readonly {position: number}[]): number {
    return Math.max(-1, ...placements.map((item) => item.position)) + 1;
}

function assertUniquePlanTitle(plans: PlanningSnapshot["manifest"]["plans"], title: string): void {
    if (plans.some((plan) => plan.title === title)) throw new OutlineLibraryError("方案链已有同名标题");
}

function requiredTitle(value: string): string {
    const title = value.trim();
    if (!title) throw new OutlineLibraryError("标题不能为空");
    return title;
}
