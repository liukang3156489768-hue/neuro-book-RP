import {
    OUTLINE_FORESHADOW_SCHEMA, contentHash, createStableId, parseForeshadowingMarkdown, serializeForeshadowingMarkdown, serializeManifest, stableFileName,
    type ForeshadowingDesign, type OutlineId,
} from "./format";
import {OutlineLibraryError} from "./library";
import {inspectFixedLine} from "./line-analysis";
import type {PlanningPublishInput, PlanningSnapshot} from "./index";

/** 编辑时缺省字段沿用原值，null 表示清除该设计分项。 */
export type ForeshadowingDesignPatch = Readonly<{[K in keyof ForeshadowingDesign]?: NonNullable<ForeshadowingDesign[K]> | null}>;

export type ForeshadowingAction =
    | Readonly<{kind: "create-foreshadowing"; title: string; body: string} & ForeshadowingDesign>
    | Readonly<{kind: "edit-foreshadowing"; id: OutlineId; expectedVersion: number; expectedContentHash: string; title: string; body: string}
        & ForeshadowingDesignPatch>
    | Readonly<{kind: "confirm-foreshadowing"; id: OutlineId; expectedVersion: number; expectedContentHash: string}>;

export type ForeshadowingChange = Readonly<{id: OutlineId; publish: PlanningPublishInput}>;

/** 伏笔的确认状态属于定义文件；四种用户状态由正式章节标记计算，不写回此文件。 */
export function prepareForeshadowingAction(snapshot: PlanningSnapshot, action: ForeshadowingAction, creationSeed?: string): ForeshadowingChange {
    const manifest = snapshot.manifest;
    if (action.kind === "create-foreshadowing") {
        const title = action.title.trim();
        if (!title) throw new OutlineLibraryError("伏笔标题不能为空");
        const id = createStableId("fo", creationSeed);
        const path = `outline/foreshadowing/${stableFileName(title, id, "md")}`;
        const content = serializeForeshadowingMarkdown({schema: OUTLINE_FORESHADOW_SCHEMA, id, version: 0,
            status: "draft", title, body: action.body,
            ...(action.surface === undefined ? {} : {surface: action.surface}),
            ...(action.connection === undefined ? {} : {connection: action.connection}),
            ...(action.plant === undefined ? {} : {plant: action.plant}),
            ...(action.recover === undefined ? {} : {recover: action.recover})});
        parseForeshadowingMarkdown(content, path);
        return {id, publish: {expectedManifestRevision: manifest.revision, mutations: [
            {relativePath: path, content, expectedHash: null},
            {relativePath: "outline/manifest.yaml", content: serializeManifest({...manifest, revision: manifest.revision + 1,
                foreshadowing: [...manifest.foreshadowing, {id, path, version: 0, contentHash: contentHash(content)}]})},
        ]}};
    }
    const source = snapshot.foreshadowing.find(({value}) => value.id === action.id);
    if (!source) throw new OutlineLibraryError("伏笔不存在");
    if (source.value.version !== action.expectedVersion || source.contentHash !== action.expectedContentHash) {
        throw new OutlineLibraryError("伏笔版本已变化，请重新读取", "CAS_CONFLICT");
    }
    if (action.kind === "confirm-foreshadowing" && source.value.status !== "draft") {
        throw new OutlineLibraryError("只有草稿伏笔可以确认");
    }
    const next = action.kind === "edit-foreshadowing" ? {
        ...source.value, version: source.value.version + 1, status: "draft" as const,
        title: action.title.trim(), body: action.body,
        surface: action.surface === undefined ? source.value.surface : action.surface ?? undefined,
        connection: action.connection === undefined ? source.value.connection : action.connection ?? undefined,
        plant: action.plant === undefined ? source.value.plant : action.plant ?? undefined,
        recover: action.recover === undefined ? source.value.recover : action.recover ?? undefined,
    } : {...source.value, version: source.value.version + 1, status: "adopted" as const};
    if (!next.title) throw new OutlineLibraryError("伏笔标题不能为空");
    const content = serializeForeshadowingMarkdown(next);
    parseForeshadowingMarkdown(content, source.path);
    return {id: source.value.id, publish: {expectedManifestRevision: manifest.revision, mutations: [
        {relativePath: source.path, content, expectedHash: source.contentHash},
        {relativePath: "outline/manifest.yaml", content: serializeManifest({...manifest, revision: manifest.revision + 1,
            foreshadowing: manifest.foreshadowing.map((item) => item.id === source.value.id
                ? {...item, version: next.version, contentHash: contentHash(content)} : item)})},
    ]}};
}
export type ForeshadowingState = "draft" | "pending" | "planted" | "recovered";
export type ForeshadowingSource = Readonly<{
    planId: string;
    nodeId: OutlineId;
    /** 节点所在格号，即方案内的全局剧情先后。 */
    column: number;
    /** 包含该节点的有效固定线路；共享节点只产生一次来源。 */
    lineIds: readonly OutlineId[];
    chapterId: OutlineId;
    entryPath: string;
    marker: string;
    action: "plant" | "reinforce" | "recover";
    content: string;
    startOffset: number;
    valid: boolean;
}>;
export type ForeshadowingIssue = Readonly<{code: "RECOVER_BEFORE_PLANT" | "REINFORCE_BEFORE_PLANT";
    planId: string; nodeId: OutlineId; chapterId: OutlineId; marker: string}>;
export type ForeshadowingView = Readonly<{id: OutlineId; status: ForeshadowingState;
    sources: readonly ForeshadowingSource[]; issues: readonly ForeshadowingIssue[]}>;

export type ForeshadowingElapsed = Readonly<{
    planId: string;
    plantedAt?: Readonly<{entryId: OutlineId; title: string}>;
    recoveredAt?: Readonly<{entryId: OutlineId; title: string}>;
    elapsed: number | null;
}>;

type PlanChapterNode = Readonly<{planId: string; nodeId: OutlineId; column: number; lineIds: readonly OutlineId[];
    entry: PlanningSnapshot["entries"][number]}>;

/**
 * 方案内可证明先后的章节节点：来自有效固定线路的有效节点，按节点去重。
 * 失效节点、草稿线路和历史 fixed 标志都不能证明顺序。
 */
function collectPlanChapterNodes(snapshot: PlanningSnapshot): ReadonlyMap<string, readonly PlanChapterNode[]> {
    const entries = new Map(snapshot.entries.map((entry) => [entry.value.id, entry]));
    const byPlan = new Map<string, Map<OutlineId, {planId: string; nodeId: OutlineId; column: number; lineIds: OutlineId[];
        entry: PlanningSnapshot["entries"][number]}>>();
    for (const {value: line} of snapshot.lines) {
        if (!line.fixed || !line.analysis) continue;
        const nodes = byPlan.get(line.planId) ?? new Map();
        byPlan.set(line.planId, nodes);
        for (const node of inspectFixedLine(snapshot, line.id).nodes) {
            if (node.status !== "valid" || node.entryId === null) continue;
            const entry = entries.get(node.entryId);
            if (!entry || entry.value.kind !== "chapter" || entry.value.status !== "adopted") continue;
            const existing = nodes.get(node.nodeId);
            if (existing) existing.lineIds.push(line.id);
            else nodes.set(node.nodeId, {planId: line.planId, nodeId: node.nodeId, column: node.column, lineIds: [line.id], entry});
        }
    }
    return new Map([...byPlan].map(([planId, nodes]) => [planId, [...nodes.values()].sort((a, b) => a.column - b.column)]));
}

/**
 * 已过格数是派生指标，不是第五种状态：回收格号减埋设格号；未回收时用方案内
 * 最后一个有效固定章节节点的格号。方案没有可证明顺序的章节时不给出数字。
 */
export function deriveForeshadowingElapsed(
    snapshot: PlanningSnapshot,
    states: readonly ForeshadowingView[] = deriveForeshadowingStates(snapshot),
): readonly Readonly<{id: OutlineId; plans: readonly ForeshadowingElapsed[]}>[] {
    const planNodes = collectPlanChapterNodes(snapshot);
    const entries = new Map(snapshot.entries.map((item) => [item.value.id, item.value]));
    const at = (source: ForeshadowingSource) => ({entryId: source.chapterId, title: entries.get(source.chapterId)?.title ?? ""});
    const earliest = (sources: readonly ForeshadowingSource[]) =>
        sources.reduce<ForeshadowingSource | undefined>((first, item) => !first || item.column < first.column ? item : first, undefined);
    return states.map(({id, sources}) => ({id, plans: snapshot.manifest.plans.flatMap(({id: planId}): ForeshadowingElapsed[] => {
        const nodes = planNodes.get(planId) ?? [];
        if (nodes.length === 0) return [];
        const valid = sources.filter((source) => source.planId === planId && source.valid);
        const plant = earliest(valid.filter(({action}) => action === "plant"));
        if (!plant) return [{planId, elapsed: null}];
        const recover = earliest(valid.filter(({action}) => action === "recover"));
        const end = recover?.column ?? nodes[nodes.length - 1]!.column;
        return [{planId, plantedAt: at(plant), ...(recover ? {recoveredAt: at(recover)} : {}), elapsed: end - plant.column}];
    })}));
}

/** 先埋后收按方案内格号判定：同一节点内按标记位置，不同节点必须位于更大的格号，同格不算之后。 */
export function deriveForeshadowingStates(snapshot: PlanningSnapshot): readonly ForeshadowingView[] {
    const observations = new Map(snapshot.foreshadowing.map(({value}) => [value.id, {
        definition: value, sources: [] as ForeshadowingSource[], issues: [] as ForeshadowingIssue[],
    }]));
    for (const nodes of collectPlanChapterNodes(snapshot).values()) {
        const pending: Array<{foreshadowId: OutlineId; source: Omit<ForeshadowingSource, "valid">}> = [];
        for (const {planId, nodeId, column, lineIds, entry} of nodes) {
            for (const marker of [...entry.markers].sort((a, b) => a.startOffset - b.startOffset)) {
                const found = observations.get(marker.foreshadowId);
                if (!found || found.definition.status !== "adopted") continue;
                pending.push({foreshadowId: marker.foreshadowId, source: {planId, nodeId, column, lineIds,
                    chapterId: entry.value.id, entryPath: entry.path, marker: marker.marker, action: marker.action,
                    content: marker.content, startOffset: marker.startOffset}});
            }
        }
        for (const {foreshadowId, source} of pending) {
            const found = observations.get(foreshadowId)!;
            const valid = source.action === "plant" || pending.some((other) => other.foreshadowId === foreshadowId
                && other.source.action === "plant" && (other.source.column < source.column
                    || (other.source.nodeId === source.nodeId && other.source.startOffset < source.startOffset)));
            if (!valid) found.issues.push({code: source.action === "recover" ? "RECOVER_BEFORE_PLANT" : "REINFORCE_BEFORE_PLANT",
                planId: source.planId, nodeId: source.nodeId, chapterId: source.chapterId, marker: source.marker});
            found.sources.push({...source, valid});
        }
    }
    return [...observations].map(([id, {definition, sources, issues}]) => ({id,
        status: definition.status === "draft" ? "draft"
            : sources.some((source) => source.valid && source.action === "recover") ? "recovered"
                : sources.some((source) => source.valid && source.action === "plant") ? "planted" : "pending",
        sources, issues,
    }));
}
