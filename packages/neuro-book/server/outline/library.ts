import {randomUUID} from "node:crypto";
import {
    OUTLINE_ENTRY_SCHEMA, canParentEntry, contentHash, createStableId, parseEntryMarkdown, serializeEntryMarkdown, serializeManifest, stableFileName,
    type DetailAnalysis, type OutlineAdaptation, type OutlineEntry, type OutlineEntryKind, type OutlineId,
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
        return {id: plan.id, title: plan.title, root: node(plan.totalId)};
    });
}

export type EntryMetadata = Pick<OutlineEntry, "materialRefs" | "writingGuidance" | "references" | "targetWords" | "adaptation" | "materialUpdates">;

export type EntryMetadataPatch = Readonly<{[K in keyof EntryMetadata]?: NonNullable<EntryMetadata[K]> | null}>;

/** 剧情正文改变时，调用者必须核对关联计划，不能只刷新旧记录的版本冒充同步。 */
export function assertMaterialUpdateMaintenance(
    source: Pick<OutlineEntry, "body" | "materialUpdates">, body: string, updates: EntryMetadataPatch["materialUpdates"],
): void {
    if ((source.materialUpdates?.length ?? 0) > 0 && source.body !== body && updates === undefined) {
        throw new OutlineLibraryError("修改剧情正文时必须同步提交 materialUpdates，核对并维护角色经历、关系及物品地点计划；如不再使用，请明确传 null 清除");
    }
}

export type LibraryAction =
    /** 新建方案时同步新建一个空总纲，返回的 entryId 是该总纲；方案不能没有自己的总纲。 */
    | Readonly<{kind: "create-plan"; title: string}>
    /** 让方案改用另一个方案的总纲（手动共用）；方案当前总纲有正文时须 confirmReplace。 */
    | Readonly<{kind: "associate-total"; planId: string; totalId: OutlineId; confirmReplace?: true}>
    /** 解除共用：为方案分叉出专属总纲，内容沿用被共用的总纲。 */
    | Readonly<{kind: "unshare-total"; planId: string}>
    | Readonly<{kind: "rename-plan"; planId: string; title: string}>
    | Readonly<{kind: "create-entry"; planId: string; parentId: OutlineId; entryKind: Exclude<OutlineEntryKind, "total">; title: string; body: string} & EntryMetadata>
    | Readonly<{kind: "adopt-entry"; planId: string; entryId: OutlineId; expectedVersion: number; expectedContentHash: string}>
    | Readonly<{kind: "edit-entry"; planId: string; entryId: OutlineId; expectedVersion: number; expectedContentHash: string;
        title: string; body: string} & EntryMetadataPatch>
    | Readonly<{kind: "move-entry"; planId: string; entryId: OutlineId; parentId: OutlineId; expectedVersion: number; expectedContentHash: string}>
    | Readonly<{kind: "attach-entry"; planId: string; parentId: OutlineId; entryId: OutlineId}>
    | Readonly<{kind: "reorder-entry"; planId: string; entryId: OutlineId; siblingIndex: number}>;

export type LibraryChange = Readonly<{publish: PlanningPublishInput; entryId?: OutlineId; planId?: string}>;

export type AdaptationWorkspaceInput = Readonly<{
    sourcePlanId: string;
    title?: string;
    source?: OutlineAdaptation;
}>;

/** 一次生成改编方案、总纲、第一卷和第一章，避免 Agent 连续 create-entry 留下半成品。 */
export function prepareAdaptationWorkspace(snapshot: PlanningSnapshot, input: AdaptationWorkspaceInput, creationSeed?: string): LibraryChange & {volumeId: OutlineId; chapterId: OutlineId} {
    const sourcePlan = snapshot.manifest.plans.find((plan) => plan.id === input.sourcePlanId);
    if (!sourcePlan) throw new OutlineLibraryError("来源提取方案不存在");
    const sourceEntries = new Map(snapshot.entries.map((item) => [item.value.id, item.value]));
    const extracted = sourcePlan.placements.some((place) => sourceEntries.get(place.entryId)?.basis?.kind === "source-extraction");
    if (!extracted) throw new OutlineLibraryError("来源方案不是作品提取方案，不能作为改编起点");
    const sourceChapter = [...sourcePlan.placements]
        .sort((a, b) => a.position - b.position)
        .map((place) => sourceEntries.get(place.entryId))
        .find((entry) => entry?.kind === "chapter");
    const adaptation = input.source ?? (sourceChapter ? {kind: "chapter", sourcePlanId: input.sourcePlanId, sourceEntryId: sourceChapter.id} : undefined);
    if (!adaptation) throw new OutlineLibraryError("来源方案没有可定位的章节");
    if (adaptation.sourcePlanId !== input.sourcePlanId) throw new OutlineLibraryError("来源定位与来源方案不一致");
    const title = requiredTitle(input.title ?? nextAdaptationTitle(snapshot.manifest.plans.map((plan) => plan.title), sourcePlan.title));
    assertUniquePlanTitle(snapshot.manifest.plans, title);
    const planId = `plan-${randomUUID()}`;
    const totalId = createStableId("ol", `${creationSeed ?? randomUUID()}:total`);
    const volumeId = createStableId("ol", `${creationSeed ?? randomUUID()}:volume`);
    const chapterId = createStableId("ol", `${creationSeed ?? randomUUID()}:chapter`);
    const total: OutlineEntry = {schema: OUTLINE_ENTRY_SCHEMA, id: totalId, version: 0, kind: "total", status: "draft", title: `${title}·总纲`, parentId: null, chapterId: null, body: ""};
    const volume: OutlineEntry = {schema: OUTLINE_ENTRY_SCHEMA, id: volumeId, version: 0, kind: "volume", status: "draft", title: "第一卷", parentId: totalId, chapterId: null, body: ""};
    const chapter: OutlineEntry = {schema: OUTLINE_ENTRY_SCHEMA, id: chapterId, version: 0, kind: "chapter", status: "draft", title: "第一章", parentId: volumeId, chapterId: null, body: "", adaptation};
    const entries = [total, volume, chapter].map((entry) => {
        const content = serializeEntryMarkdown(entry);
        parseEntryMarkdown(content);
        return {entry, content, path: `outline/entries/${stableFileName(entry.title, entry.id, "md")}`};
    });
    const manifest = snapshot.manifest;
    return {
        planId, volumeId, chapterId, entryId: chapterId,
        publish: {expectedManifestRevision: manifest.revision, mutations: [
            ...entries.map(({path, content}) => ({relativePath: path, content, expectedHash: null})),
            {relativePath: "outline/manifest.yaml", content: serializeManifest({...manifest, revision: manifest.revision + 1,
                plans: [...manifest.plans, {id: planId, title, totalId, placements: [
                    {entryId: totalId, parentId: null, position: 0},
                    {entryId: volumeId, parentId: totalId, position: 1},
                    {entryId: chapterId, parentId: volumeId, position: 2},
                ]}],
                entries: [...manifest.entries, ...entries.map(({entry, path, content}) => ({id: entry.id, path, version: entry.version, contentHash: contentHash(content)}))],
            }), expectedHash: contentHash(serializeManifest(manifest))},
        ]},
    };
}

function nextAdaptationTitle(existing: readonly string[], sourceTitle: string): string {
    const prefix = "改编方案";
    let index = 1;
    while (existing.includes(`${prefix}${index}${sourceTitle}`)) index += 1;
    return `${prefix}${index}${sourceTitle}`;
}

/** 领域操作只生成草稿与关系变更；正式采用必须经独立分析和授权入口。 */
export type SourceExtractionDetail = Readonly<{
    planId: string; chapterId: OutlineId; title: string; body: string; sources: NonNullable<OutlineEntry["basis"]>["sources"];
}>;

/**
 * 提取流水线的领域入口：直接写入以原文引用为依据的正式细纲，免偏差分析。
 * 它不是 LibraryAction，HTTP 与 Agent 的动作 schema 到不了这里；原始发布又被 assertNonDestructivePlanningEdit 拒绝，
 * 所以用户和普通 Agent 无法设置 basis。章节大纲可以仍是草稿：提取流水线先写细纲再写章节大纲。
 */
export function prepareSourceExtractionDetail(snapshot: PlanningSnapshot, input: SourceExtractionDetail): LibraryChange {
    const plan = snapshot.manifest.plans.find((item) => item.id === input.planId);
    if (!plan) throw new OutlineLibraryError("方案链不存在");
    const chapter = snapshot.entries.find(({value}) => value.id === input.chapterId)?.value;
    if (!chapter || chapter.kind !== "chapter" || !plan.placements.some((place) => place.entryId === chapter.id)) {
        throw new OutlineLibraryError("来源提取细纲必须挂在方案内的章节大纲下");
    }
    if (input.sources.length === 0) throw new OutlineLibraryError("来源提取细纲必须带原文引用");
    const title = requiredTitle(input.title);
    const id = createStableId("ol");
    const entry: OutlineEntry = {
        schema: OUTLINE_ENTRY_SCHEMA, id, version: 1, kind: "detail", status: "adopted", title,
        parentId: chapter.id, chapterId: chapter.id, body: input.body,
        basis: {kind: "source-extraction", sources: input.sources},
    };
    const file = serializeEntryMarkdown(entry);
    parseEntryMarkdown(file);
    const relativePath = `outline/entries/${stableFileName(title, id, "md")}`;
    const manifest = snapshot.manifest;
    return {entryId: id, planId: plan.id, publish: {expectedManifestRevision: manifest.revision, mutations: [
        {relativePath, content: file, expectedHash: null},
        {relativePath: "outline/manifest.yaml", content: serializeManifest({
            ...manifest, revision: manifest.revision + 1,
            plans: manifest.plans.map((item) => item.id === plan.id ? {
                ...item, placements: [...item.placements, {entryId: id, parentId: chapter.id, position: nextPosition(item.placements)}],
            } : item),
            entries: [...manifest.entries, {id, path: relativePath, version: 1, contentHash: contentHash(file)}],
        })},
    ]}};
}

export function prepareLibraryAction(snapshot: PlanningSnapshot, action: LibraryAction, creationSeed?: string): LibraryChange {
    const manifest = snapshot.manifest;
    if (action.kind === "create-plan") return createPlanWithTotal(snapshot, action.title, creationSeed);
    const plan = manifest.plans.find((item) => item.id === action.planId);
    if (!plan) throw new OutlineLibraryError("方案链不存在");
    if (action.kind === "associate-total") return associateTotal(snapshot, plan, action);
    if (action.kind === "unshare-total") {
        const source = snapshot.entries.find(({value}) => value.id === plan.totalId)!.value;
        return forkPlanTotal(snapshot, plan.id, `${source.title}·${plan.title}`, source.body, {}, creationSeed);
    }
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
        return createEntry(snapshot, action.entryKind, action.title, action.body, parent.id, plan.id, action, creationSeed);
    }
    if (action.kind === "adopt-entry") return adoptEntry(snapshot, action);
    if (action.kind === "edit-entry") return editEntry(snapshot, action);
    if (action.kind === "move-entry") return moveEntry(snapshot, action);
    if (action.kind === "attach-entry") {
        const entry = snapshot.entries.find((item) => item.value.id === action.entryId)?.value;
        if (!entry || entry.kind === "total") throw new OutlineLibraryError("条目不存在或父级关系不符");
        // 总纲直属条目的 parentId 只记录创建时的总纲；各方案总纲不同，所以挂到本方案自己的总纲即可。
        const originalParent = snapshot.entries.find((item) => item.value.id === entry.parentId)?.value;
        const topLevel = originalParent?.kind === "total" && action.parentId === plan.totalId;
        if (entry.parentId !== action.parentId && !topLevel) throw new OutlineLibraryError("条目不存在或父级关系不符");
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
    parentId: OutlineId | null, planId: string | null, metadata: EntryMetadata = {}, creationSeed?: string,
): LibraryChange {
    const title = requiredTitle(titleInput);
    const id = createStableId("ol", creationSeed);
    const entry: OutlineEntry = {
        schema: OUTLINE_ENTRY_SCHEMA, id, version: 0, kind, status: "draft", title,
        parentId, chapterId: kind === "detail" ? parentId : null, body,
        ...(metadata.materialRefs === undefined ? {} : {materialRefs: metadata.materialRefs}),
        ...(metadata.writingGuidance === undefined ? {} : {writingGuidance: metadata.writingGuidance}),
        ...(metadata.references === undefined ? {} : {references: metadata.references}),
        ...(metadata.targetWords === undefined ? {} : {targetWords: metadata.targetWords}),
        ...(metadata.adaptation === undefined ? {} : {adaptation: metadata.adaptation}),
        ...(metadata.materialUpdates === undefined ? {} : {materialUpdates: metadata.materialUpdates}),
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
                plans,
                entries: [...manifest.entries, {id, path: relativePath, version: 0, contentHash: contentHash(file)}],
            })},
        ],
    }};
}

/** 方案与它的空总纲在同一次提交里诞生，保证任何时刻都不存在没有总纲的方案。 */
function createPlanWithTotal(snapshot: PlanningSnapshot, titleInput: string, creationSeed?: string): LibraryChange {
    const manifest = snapshot.manifest;
    const title = requiredTitle(titleInput);
    assertUniquePlanTitle(manifest.plans, title);
    const planId = creationSeed === undefined ? `plan-${randomUUID()}` : `plan-${createStableId("ol", `${creationSeed}:plan`).slice(3)}`;
    const totalId = createStableId("ol", creationSeed);
    const total: OutlineEntry = {
        schema: OUTLINE_ENTRY_SCHEMA, id: totalId, version: 0, kind: "total", status: "draft", title: `${title}·总纲`,
        parentId: null, chapterId: null, body: "",
    };
    const file = serializeEntryMarkdown(total);
    parseEntryMarkdown(file);
    const relativePath = `outline/entries/${stableFileName(total.title, totalId, "md")}`;
    return {planId, entryId: totalId, publish: {expectedManifestRevision: manifest.revision, mutations: [
        {relativePath, content: file, expectedHash: null},
        {relativePath: "outline/manifest.yaml", content: serializeManifest({
            ...manifest, revision: manifest.revision + 1,
            plans: [...manifest.plans, {id: planId, title, totalId, placements: [{entryId: totalId, parentId: null, position: 0}]}],
            entries: [...manifest.entries, {id: totalId, path: relativePath, version: 0, contentHash: contentHash(file)}],
        })},
    ]}};
}

type PlanRecord = PlanningSnapshot["manifest"]["plans"][number];

/** 方案的根与直属子级整体切换到另一个总纲；旧总纲条目保留，是否删除由用户另行决定。 */
function reparentPlanTotal(plan: PlanRecord, from: OutlineId, to: OutlineId): PlanRecord {
    return {...plan, totalId: to, placements: plan.placements.map((place) => place.entryId === from ? {...place, entryId: to}
        : place.parentId === from ? {...place, parentId: to} : place)};
}

function associateTotal(snapshot: PlanningSnapshot, plan: PlanRecord, action: Extract<LibraryAction, {kind: "associate-total"}>): LibraryChange {
    const target = snapshot.entries.find(({value}) => value.id === action.totalId)?.value;
    if (!target || target.kind !== "total") throw new OutlineLibraryError("目标总纲不存在");
    if (target.id === plan.totalId) throw new OutlineLibraryError("方案已在使用该总纲");
    const current = snapshot.entries.find(({value}) => value.id === plan.totalId)!.value;
    if (current.body.trim() !== "" && action.confirmReplace !== true) {
        throw new OutlineLibraryError("方案当前总纲已有正文，改用其他总纲须先确认");
    }
    return {planId: plan.id, entryId: target.id, publish: manifestOnly(snapshot, {
        ...snapshot.manifest,
        plans: snapshot.manifest.plans.map((item) => item.id === plan.id ? reparentPlanTotal(item, current.id, target.id) : item),
    })};
}

/** 总纲的写时分叉：被多个方案共用的总纲不原地修改，当前方案改用新建的专属总纲。 */
export function forkPlanTotal(
    snapshot: PlanningSnapshot, planId: string, titleInput: string, body: string, patch: EntryMetadataPatch = {}, creationSeed?: string,
): LibraryChange {
    const manifest = snapshot.manifest;
    const plan = manifest.plans.find((item) => item.id === planId);
    const source = plan && snapshot.entries.find(({value}) => value.id === plan.totalId)?.value;
    if (!plan || !source) throw new OutlineLibraryError("方案链或其总纲不存在");
    if (manifest.plans.filter((item) => item.totalId === source.id).length < 2) {
        throw new OutlineLibraryError("总纲尚未被多个方案共用，无需分叉");
    }
    const title = requiredTitle(titleInput);
    if (title === source.title.trim()) throw new OutlineLibraryError("分叉必须使用与源条目不同的名称");
    assertMaterialUpdateMaintenance(source, body, patch.materialUpdates);
    const id = createStableId("ol", creationSeed);
    const fork: OutlineEntry = {...source, id, version: 0, status: "draft", analysis: undefined, title, body,
        materialRefs: patch.materialRefs === undefined ? source.materialRefs : patch.materialRefs ?? undefined,
        writingGuidance: patch.writingGuidance === undefined ? source.writingGuidance : patch.writingGuidance ?? undefined,
        references: patch.references === undefined ? source.references : patch.references ?? undefined,
        targetWords: patch.targetWords === undefined ? source.targetWords : patch.targetWords ?? undefined,
        adaptation: patch.adaptation === undefined ? source.adaptation : patch.adaptation ?? undefined,
        materialUpdates: patch.materialUpdates === undefined ? source.materialUpdates : patch.materialUpdates ?? undefined};
    const file = serializeEntryMarkdown(fork);
    const relativePath = `outline/entries/${stableFileName(title, id, "md")}`;
    parseEntryMarkdown(file, relativePath);
    return {planId: plan.id, entryId: id, publish: {expectedManifestRevision: manifest.revision, mutations: [
        {relativePath, content: file, expectedHash: null},
        {relativePath: "outline/manifest.yaml", content: serializeManifest({
            ...manifest, revision: manifest.revision + 1,
            plans: manifest.plans.map((item) => item.id === plan.id ? reparentPlanTotal(item, source.id, id) : item),
            entries: [...manifest.entries, {id, path: relativePath, version: 0, contentHash: contentHash(file)}],
        })},
    ]}};
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
        throw new OutlineLibraryError(source.value.kind === "total"
            ? "总纲被多个方案共用，须经用户确认写时分叉，不能原地修改"
            : "共享条目须经用户确认写时分叉，不能原地修改");
    }
    if (source.value.version !== action.expectedVersion || source.contentHash !== action.expectedContentHash) {
        throw new OutlineLibraryError("条目版本已变化，请重新读取", "CAS_CONFLICT");
    }
    assertMaterialUpdateMaintenance(source.value, action.body, action.materialUpdates);
    const update: OutlineEntry = {
        ...source.value, title: requiredTitle(action.title), body: action.body, version: source.value.version + 1, status: "draft", analysis: undefined, basis: undefined,
        materialRefs: action.materialRefs === undefined ? source.value.materialRefs : action.materialRefs ?? undefined,
        writingGuidance: action.writingGuidance === undefined ? source.value.writingGuidance : action.writingGuidance ?? undefined,
        references: action.references === undefined ? source.value.references : action.references ?? undefined,
        targetWords: action.targetWords === undefined ? source.value.targetWords : action.targetWords ?? undefined,
        adaptation: action.adaptation === undefined ? source.value.adaptation : action.adaptation ?? undefined,
        materialUpdates: action.materialUpdates === undefined ? source.value.materialUpdates : action.materialUpdates ?? undefined,
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
        version: source.value.version + 1,
        // 移动不改变来源提取细纲的依据（原文引用与所属章节的上游无关）；其余细纲须重新审阅。
        ...(source.value.basis ? {} : {status: "draft" as const, analysis: undefined})};
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
