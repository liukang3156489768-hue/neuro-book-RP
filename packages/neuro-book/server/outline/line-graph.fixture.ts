import {contentHash, createEmptyManifest, serializeManifest, type OutlineId, type OutlineLineType} from "./format";
import {parsePlanningFiles, type PlanningPublishInput, type PlanningSnapshot} from "./index";
import {prepareLibraryAction, type LibraryAction} from "./library";
import {analyzeLine, confirmLine} from "./line-analysis";
import {findPlanGraph, prepareLineAction, type LineAction, type LineChange} from "./line-planning";

type GraphActionInput<K extends LineAction["kind"]> = Omit<Extract<LineAction, {kind: K}>, "kind" | "planId" | "expectedGraphVersion">;

/**
 * 纯内存的规划文件集：发布批次先按 expectedHash 做 CAS，再用与磁盘读取相同的完整校验重建快照。
 * 领域测试借此走真实的发布合同，而不必为每个断言打开 ready Project。
 */
export class PlanningFixture {
    readonly files = new Map<string, string>();
    snapshot: PlanningSnapshot;

    constructor() {
        this.files.set("outline/manifest.yaml", serializeManifest(createEmptyManifest()));
        this.snapshot = this.reparse();
    }

    reparse(): PlanningSnapshot {
        this.snapshot = parsePlanningFiles([...this.files].map(([relativePath, content]) =>
            ({relativePath, content, contentHash: contentHash(content)})));
        return this.snapshot;
    }

    publish(input: PlanningPublishInput): PlanningSnapshot {
        if (input.expectedManifestRevision !== this.snapshot.manifest.revision) throw new Error("fixture: manifest revision 冲突");
        const next = new Map(this.files);
        for (const mutation of input.mutations) {
            const current = next.get(mutation.relativePath);
            if (mutation.expectedHash !== undefined && (current === undefined ? null : contentHash(current)) !== mutation.expectedHash) {
                throw new Error(`fixture: ${mutation.relativePath} expectedHash 冲突`);
            }
            if (mutation.content === null) next.delete(mutation.relativePath);
            else next.set(mutation.relativePath, mutation.content);
        }
        const previous = new Map(this.files);
        this.files.clear();
        for (const [key, value] of next) this.files.set(key, value);
        try {
            return this.reparse();
        } catch (error) {
            this.files.clear();
            for (const [key, value] of previous) this.files.set(key, value);
            this.reparse();
            throw error;
        }
    }

    library(action: LibraryAction) {
        const change = prepareLibraryAction(this.snapshot, action);
        this.publish(change.publish);
        return change;
    }

    line(action: LineAction): LineChange {
        const change = prepareLineAction(this.snapshot, action);
        this.publish(change.publish);
        return change;
    }

    graphVersion(planId: string): number {
        return findPlanGraph(this.snapshot, planId)?.value.version ?? 0;
    }

    graph<K extends LineAction["kind"]>(kind: K, planId: string, input: GraphActionInput<K>): LineChange {
        return this.line({kind, planId, expectedGraphVersion: this.graphVersion(planId), ...input} as unknown as LineAction);
    }

    lineSource(lineId: OutlineId) {
        const source = this.snapshot.lines.find(({value}) => value.id === lineId);
        if (!source) throw new Error(`fixture: 线路不存在 ${lineId}`);
        return source;
    }

    lineCas(lineId: OutlineId) {
        const source = this.lineSource(lineId);
        return {lineId, expectedVersion: source.value.version, expectedContentHash: source.contentHash};
    }

    analysisRequest(lineId: OutlineId) {
        return {...this.lineCas(lineId), expectedRevision: this.snapshot.manifest.revision};
    }

    entry(entryId: OutlineId) {
        const source = this.snapshot.entries.find(({value}) => value.id === entryId);
        if (!source) throw new Error(`fixture: 条目不存在 ${entryId}`);
        return source;
    }

    /** 创建并采用章节条目；线路固定只接受正式条目。 */
    adoptedChapter(planId: string, parentId: OutlineId, title: string, body = title): OutlineId {
        const entryId = this.library({kind: "create-entry", planId, parentId, entryKind: "chapter", title, body}).entryId!;
        const source = this.entry(entryId);
        this.library({kind: "adopt-entry", planId, entryId, expectedVersion: source.value.version, expectedContentHash: source.contentHash});
        return entryId;
    }

    createLine(planId: string, title: string, type: OutlineLineType, nodeIds: readonly OutlineId[]): OutlineId {
        return this.line({kind: "create-line", planId, title, type, nodeIds}).lineId!;
    }

    /** 用固定的模型回复完成分析与固定；每个冲突都记为已忽略。 */
    async fix(lineId: OutlineId, conflicts: readonly string[] = []): Promise<void> {
        const request = this.analysisRequest(lineId);
        const issued = await analyzeLine(this.snapshot, request, async () => JSON.stringify({summary: "线路一致", conflicts}));
        this.publish(confirmLine(this.snapshot, request, issued, issued.report.reportId,
            conflicts.map((_, index) => ({index, decision: "ignored" as const, reason: "测试忽略"}))));
    }
}

export type DesignNodeKey = "m0" | "m1" | "b2" | "a2" | "k1" | "m3" | "k3" | "b4" | "j4" | "m6";

/**
 * 开发者图示的最小复现：主线分出两条死路支线；两条角色线从主线分出后在第 4 格汇合，再汇回主线终点。
 *
 * 格号  0    1    2    3    4    6
 * 行 0  m0 → m1 ─────→ m3 ─────→ m6
 * 行 1       └→ b2      └→ b4     ↑
 * 行 2       m1 → a2 ──────→ j4 ─┘
 * 行 3  m0 → k1 ─────→ k3 ─┘
 */
export function buildDesignGraph(fixture = new PlanningFixture()) {
    const totalId = fixture.library({kind: "create-total", title: "总纲", body: "开端"}).entryId!;
    const planId = fixture.library({kind: "create-plan", title: "主方案"}).planId!;
    const cells: Record<DesignNodeKey, readonly [number, number]> = {
        m0: [0, 0], m1: [1, 0], b2: [2, 1], a2: [2, 2], k1: [1, 3], m3: [3, 0], k3: [3, 3], b4: [4, 1], j4: [4, 2], m6: [6, 0],
    };
    const entries = {} as Record<DesignNodeKey, OutlineId>;
    const nodes = {} as Record<DesignNodeKey, OutlineId>;
    for (const [key, [column, row]] of Object.entries(cells) as [DesignNodeKey, readonly [number, number]][]) {
        entries[key] = fixture.adoptedChapter(planId, totalId, `章节 ${key}`, `${key} 的剧情`);
        nodes[key] = fixture.graph("add-graph-node", planId, {column, row, entryId: entries[key]}).nodeId!;
    }
    const edges: readonly (readonly [DesignNodeKey, DesignNodeKey])[] = [
        ["m0", "m1"], ["m1", "m3"], ["m3", "m6"], ["m1", "b2"], ["m3", "b4"],
        ["m1", "a2"], ["a2", "j4"], ["m0", "k1"], ["k1", "k3"], ["k3", "j4"], ["j4", "m6"],
    ];
    for (const [from, to] of edges) fixture.graph("connect-graph-nodes", planId, {from: nodes[from], to: nodes[to]});
    const pick = (...keys: DesignNodeKey[]) => keys.map((key) => nodes[key]);
    const lines = {
        main: fixture.createLine(planId, "主线", "main", pick("m0", "m1", "m3", "m6")),
        branch: fixture.createLine(planId, "支线", "branch", pick("m1", "b2")),
        branch2: fixture.createLine(planId, "支线2", "branch", pick("m3", "b4")),
        characterA: fixture.createLine(planId, "角色线甲", "character", pick("m1", "a2", "j4", "m6")),
        characterB: fixture.createLine(planId, "角色线乙", "character", pick("m0", "k1", "k3", "j4", "m6")),
    };
    return {fixture, totalId, planId, entries, nodes, lines};
}
