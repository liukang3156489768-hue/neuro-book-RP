import {readonly, ref, toValue, watch, type MaybeRefOrGetter, type Ref} from "vue";
import {resolveApiErrorMessage} from "nbook/app/utils/api-error";

export type OutlineWorkbenchEntry = Readonly<{
    id: string;
    kind: "total" | "volume" | "chapter" | "detail";
    version: number;
    status: "draft" | "adopted";
    title: string;
    parentId: string | null;
    chapterId: string | null;
    body: string;
    materialRefs?: readonly string[];
    writingGuidance?: string;
    references?: readonly OutlineWorkbenchReference[];
    targetWords?: number;
    materialUpdates?: readonly OutlineWorkbenchMaterialUpdate[];
    /** 细纲偏差分析记录；编辑后服务端清除，采用前必须重新分析。 */
    analysis?: OutlineWorkbenchDetailAnalysis;
}>;

export type OutlineWorkbenchMaterialUpdate = Readonly<{
    materialPath: string;
    kind: "experience" | "relationship" | "item" | "location";
    body: string;
}>;

export type OutlineWorkbenchDetailAnalysis = Readonly<{
    reportId: string;
    summary: string;
    deviations: readonly string[];
    conflicts: readonly string[];
    resolutions: readonly Readonly<{index: number; decision: "resolved" | "ignored"; reason: string}>[];
}>;

/** 待补参考文件可以没有 path，此时 locator 说明需要补的资料。 */
export type OutlineWorkbenchReference = Readonly<{path?: string; locator?: string; purpose?: string; pending?: boolean}>;

export type OutlineWorkbenchForeshadowingDefinition = Readonly<{
    id: string;
    version: number;
    status: "draft" | "adopted";
    title: string;
    body: string;
    surface?: string;
    connection?: string;
    plant?: Readonly<{situation: string; presentation: string; subtlety: string}>;
    recover?: Readonly<{condition: string; echo: string; effect: string}>;
}>;

export type OutlineWorkbenchLineType = "main" | "branch" | "character" | "if";

/** 线路只是方案线路图上节点的集合；顺序由节点格号派生。 */
export type OutlineWorkbenchLine = Readonly<{
    schema: "nbook.outline-line/v3";
    id: string;
    planId: string;
    version: number;
    title: string;
    type: OutlineWorkbenchLineType;
    fixed: boolean;
    nodeIds: readonly string[];
    analysis?: Readonly<{
        summary: string;
        conflicts: readonly string[];
        resolutions: readonly Readonly<{index: number; decision: "resolved" | "ignored"; reason: string}>[];
    }>;
}>;

export type OutlineWorkbenchGraphNode = Readonly<{id: string; entryId: string | null; column: number; row: number}>;
export type OutlineWorkbenchGraphEdge = Readonly<{id: string; from: string; to: string}>;

/** 每个方案一张线路图：column 是方案内的剧情先后，row 只是排版。 */
export type OutlineWorkbenchGraph = Readonly<{
    id: string;
    planId: string;
    version: number;
    nodes: readonly OutlineWorkbenchGraphNode[];
    edges: readonly OutlineWorkbenchGraphEdge[];
}>;

export type OutlineWorkbenchSnapshot = Readonly<{
    manifest: Readonly<{
        revision: number;
        /** 挂载关系只用于展示共享与父级，写入资格仍由服务端动作判定；totalId 是该方案自己的总纲。 */
        plans: readonly Readonly<{id: string; title: string; totalId: string; placements: readonly Readonly<{entryId: string; parentId: string | null; position: number}>[]}>[];
    }>;
    entries: readonly Readonly<{path: string; contentHash: string; value: OutlineWorkbenchEntry}>[];
    foreshadowing: readonly Readonly<{path: string; contentHash: string; value: OutlineWorkbenchForeshadowingDefinition}>[];
    graphs: readonly Readonly<{path: string; contentHash: string; value: OutlineWorkbenchGraph}>[];
    lines: readonly Readonly<{
        path: string;
        contentHash: string;
        value: OutlineWorkbenchLine;
    }>[];
}>;

export type OutlineWorkbenchLibraryNode = Readonly<{
    entry: OutlineWorkbenchEntry;
    children: readonly OutlineWorkbenchLibraryNode[];
}>;

export type OutlineWorkbenchLibraryTree = Readonly<{
    id: string;
    title: string;
    root: OutlineWorkbenchLibraryNode;
}>;

export type OutlineWorkbenchForeshadowingState = Readonly<{
    id: string;
    status: "draft" | "pending" | "planted" | "recovered";
    sources: readonly Readonly<{
        planId: string;
        nodeId: string;
        column: number;
        /** 共享节点只产生一次来源，这里列出它所属的全部有效固定线路。 */
        lineIds: readonly string[];
        chapterId: string;
        entryPath: string;
        marker: string;
        action: "plant" | "reinforce" | "recover";
        content: string;
        startOffset: number;
        valid: boolean;
    }>[];
    issues: readonly Readonly<{code: string; planId: string; nodeId: string; chapterId: string; marker: string}>[];
}>;

export type OutlineWorkbenchChapterRef = Readonly<{entryId: string; title: string}>;

export type OutlineWorkbenchForeshadowingResponse = Readonly<{
    parserVersion: number;
    states: readonly OutlineWorkbenchForeshadowingState[];
    /** 按方案派生的已过格数；无法计算时 elapsed 为 null，不是伏笔状态。 */
    elapsed: readonly Readonly<{id: string; plans: readonly Readonly<{planId: string; plantedAt?: OutlineWorkbenchChapterRef; recoveredAt?: OutlineWorkbenchChapterRef; elapsed: number | null}>[]}>[];
    markerIssues: readonly Readonly<{entryId: string; path: string; diagnostics: readonly Readonly<{message: string}>[]}>[];
}>;

export type OutlineWorkbenchData = Readonly<{
    snapshot: Readonly<Ref<OutlineWorkbenchSnapshot | null>>;
    libraryTrees: Readonly<Ref<readonly OutlineWorkbenchLibraryTree[]>>;
    foreshadowing: Readonly<Ref<OutlineWorkbenchForeshadowingResponse | null>>;
    loading: Readonly<Ref<boolean>>;
    error: Readonly<Ref<string | null>>;
    refresh(): Promise<void>;
}>;

export function useOutlineWorkbenchData(projectRoot: MaybeRefOrGetter<string | null>): OutlineWorkbenchData {
    const snapshot = ref<OutlineWorkbenchSnapshot | null>(null);
    const libraryTrees = ref<readonly OutlineWorkbenchLibraryTree[]>([]);
    const foreshadowing = ref<OutlineWorkbenchForeshadowingResponse | null>(null);
    const loading = ref(false);
    const error = ref<string | null>(null);
    let generation = 0;
    // 只读接口不会创建 manifest；每个 Project 首次加载先走 open 完成初始化与事务恢复，失败时下次刷新重试。
    let openedRoot: string | null = null;

    async function refresh(): Promise<void> {
        const root = toValue(projectRoot);
        const currentGeneration = ++generation;
        if (!root) {
            snapshot.value = null;
            libraryTrees.value = [];
            foreshadowing.value = null;
            loading.value = false;
            error.value = null;
            return;
        }
        loading.value = true;
        error.value = null;
        try {
            const query = {query: {projectRoot: root}};
            if (openedRoot !== root) {
                await $fetch("/api/projects/outline/open", {method: "POST", ...query});
                if (currentGeneration !== generation || toValue(projectRoot) !== root) return;
                openedRoot = root;
            }
            const [nextSnapshot, nextTrees, nextForeshadowing] = await Promise.all([
                $fetch<OutlineWorkbenchSnapshot>("/api/projects/outline/snapshot", query),
                $fetch<readonly OutlineWorkbenchLibraryTree[]>("/api/projects/outline/library-trees", query),
                $fetch<OutlineWorkbenchForeshadowingResponse>("/api/projects/outline/foreshadowing-states", query),
            ]);
            if (currentGeneration !== generation || toValue(projectRoot) !== root) return;
            snapshot.value = nextSnapshot;
            libraryTrees.value = nextTrees;
            foreshadowing.value = nextForeshadowing;
        } catch (cause) {
            if (currentGeneration !== generation) return;
            error.value = resolveApiErrorMessage(cause, "读取大纲规划数据失败");
        } finally {
            if (currentGeneration === generation) loading.value = false;
        }
    }

    watch(() => toValue(projectRoot), () => { void refresh(); }, {immediate: true});

    return {snapshot: snapshot as Readonly<Ref<OutlineWorkbenchSnapshot | null>>,
        libraryTrees: libraryTrees as Readonly<Ref<readonly OutlineWorkbenchLibraryTree[]>>,
        foreshadowing: foreshadowing as Readonly<Ref<OutlineWorkbenchForeshadowingResponse | null>>,
        loading: readonly(loading), error: readonly(error), refresh};
}

