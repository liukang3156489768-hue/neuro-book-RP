import {randomUUID} from "node:crypto";
import {z} from "zod";
import {contentHash, resolveLineChain, type LineChainProblem, type LineSemanticReport, type OutlineGraph, type OutlineId, type OutlineLine,
    type OutlineManifest} from "./format";
import type {PlanningPublishInput, PlanningSnapshot} from "./index";
import {OutlineGenerationError} from "./direction";
import {buildPlanningWrite, findPlanGraph, OutlineLineError} from "./line-planning";

const ModelReport = z.object({
    summary: z.string().trim().min(1).max(2000),
    conflicts: z.array(z.string().trim().min(1).max(1200)).max(30),
}).strict();

export type LineAnalysisRequest = Readonly<{lineId: OutlineId; expectedRevision: number;
    expectedVersion: number; expectedContentHash: string}>;
export type LineResolution = LineSemanticReport["resolutions"][number];
export type IssuedLineReport = Readonly<{lineId: OutlineId; expectedRevision: number; expectedVersion: number;
    report: LineSemanticReport}>;

const CHAIN_PROBLEMS: Record<LineChainProblem, string> = {
    TOO_SHORT: "线路至少需要 2 个节点",
    UNKNOWN_NODE: "线路引用了线路图中不存在的节点",
    SAME_COLUMN: "线路中有两个节点位于同一格，线路内部不能并行",
    MISSING_EDGE: "线路中相邻节点之间缺少连线",
};

/**
 * 分析报告绑定的线路结构：标题、类型、按格号排列的节点与条目、相邻连线。
 * 不含绝对格号和行号，因此插入列或调整排版不会使报告过期。
 */
export function lineStructureHash(line: OutlineLine, graph: OutlineGraph | undefined): string {
    const chain = resolveLineChain(graph, line.nodeIds);
    return contentHash(JSON.stringify({id: line.id, planId: line.planId, title: line.title, type: line.type,
        nodes: chain.nodes.map(({id, entryId}) => ({id, entryId})), edges: chain.edges.map(({id}) => id)}));
}

/**
 * 方案上下文只含 placements 与条目内容 hash；其他固定线路只作为提示参考，
 * 否则固定一条线路就会让同方案其他固定线路全部失效。
 */
function planContextHash(plan: OutlineManifest["plans"][number], hashOf: (entryId: OutlineId) => string | undefined): string | null {
    const context = [];
    for (const {entryId, parentId, position} of plan.placements) {
        const hash = hashOf(entryId);
        if (hash === undefined) return null;
        context.push({entryId, parentId, position, contentHash: hash});
    }
    return contentHash(JSON.stringify({planId: plan.id, context}));
}

/** 在调用模型前先执行可确定的固定门禁；模型只判断语义，不负责结构或引用合法性。 */
export function lineAnalysisContext(snapshot: PlanningSnapshot, request: LineAnalysisRequest): {prompt: string; contextHash: string;
    sourceHash: string; entryHashes: LineSemanticReport["entryHashes"]} {
    const source = snapshot.lines.find(({value}) => value.id === request.lineId);
    if (!source || source.value.fixed) throw new OutlineLineError("仅草稿线路可以分析固定");
    if (snapshot.manifest.revision !== request.expectedRevision || source.value.version !== request.expectedVersion
        || source.contentHash !== request.expectedContentHash) {
        throw new OutlineLineError("线路或方案上下文已变化，请重新分析", "CAS_CONFLICT");
    }
    const line = source.value;
    const plan = snapshot.manifest.plans.find(({id}) => id === line.planId);
    if (!plan) throw new OutlineLineError("线路所属方案不存在");
    const graph = findPlanGraph(snapshot, plan.id)?.value;
    const chain = resolveLineChain(graph, line.nodeIds);
    if (chain.problem) throw new OutlineLineError(CHAIN_PROBLEMS[chain.problem]);
    const entries = new Map(snapshot.entries.map((item) => [item.value.id, item]));
    const entryHashes = chain.nodes.map((node) => {
        if (node.entryId === null) throw new OutlineLineError("线路含空节点，请先关联条目");
        const entry = entries.get(node.entryId);
        if (!entry || entry.value.status !== "adopted" || entry.value.kind === "detail"
            || !plan.placements.some(({entryId}) => entryId === node.entryId)) {
            throw new OutlineLineError("线路节点必须关联所属方案的正式非细纲条目");
        }
        return {nodeId: node.id, entryId: node.entryId, contentHash: entry.contentHash};
    });
    const contextHash = planContextHash(plan, (id) => entries.get(id)?.contentHash);
    if (contextHash === null) throw new OutlineLineError("方案引用条目不存在");
    const title = (id: OutlineId | null) => id === null ? null : entries.get(id)?.value.title ?? null;
    const referenceLines = snapshot.lines.filter(({value}) => value.id !== line.id && value.planId === plan.id && value.fixed)
        .map(({value}) => ({title: value.title, type: value.type, nodes: resolveLineChain(graph, value.nodeIds).nodes
            .map((node) => ({column: node.column, entryId: node.entryId, title: title(node.entryId)}))}));
    const prompt = JSON.stringify({
        plan: {id: plan.id, title: plan.title, entries: plan.placements.map(({entryId}) => entries.get(entryId)?.value)},
        candidate: {title: line.title, type: line.type,
            nodes: chain.nodes.map((node) => ({column: node.column, entryId: node.entryId, title: title(node.entryId)}))},
        referenceLines,
    });
    if (prompt.length > 80_000) throw new OutlineLineError("线路分析上下文过长，请先缩减方案");
    return {prompt, contextHash, sourceHash: lineStructureHash(line, graph), entryHashes};
}

/** 报告仅在当前 ready 会话中签发，固定前仍需重算规范文件与语义上下文。 */
export async function analyzeLine(snapshot: PlanningSnapshot, request: LineAnalysisRequest,
    complete: (prompt: string) => Promise<string>): Promise<IssuedLineReport> {
    const {prompt, contextHash, sourceHash, entryHashes} = lineAnalysisContext(snapshot, request);
    let raw: string;
    try {
        raw = await complete(prompt);
    } catch (error) {
        if (error instanceof OutlineGenerationError) throw error;
        throw new OutlineGenerationError("线路语义分析失败，请重试", "MODEL_FAILED", error);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new OutlineGenerationError("模型没有返回合法的线路分析 JSON", "INVALID_RESULT", error);
    }
    const result = ModelReport.safeParse(parsed);
    if (!result.success) throw new OutlineGenerationError("模型线路报告格式无效，不能固定", "INVALID_RESULT", result.error);
    const source = snapshot.lines.find(({value}) => value.id === request.lineId)!;
    return {lineId: request.lineId, expectedRevision: request.expectedRevision, expectedVersion: request.expectedVersion, report: {
        reportId: randomUUID(), planId: source.value.planId, sourceHash, contextHash, entryHashes, ...result.data, resolutions: [],
    }};
}

export function confirmLine(snapshot: PlanningSnapshot, request: LineAnalysisRequest, issued: IssuedLineReport,
    reportId: string, resolutions: readonly LineResolution[]): PlanningPublishInput {
    const {contextHash, sourceHash, entryHashes} = lineAnalysisContext(snapshot, request);
    const source = snapshot.lines.find(({value}) => value.id === request.lineId)!;
    if (issued.lineId !== request.lineId || issued.report.reportId !== reportId
        || issued.expectedRevision !== request.expectedRevision || issued.expectedVersion !== request.expectedVersion
        || issued.report.sourceHash !== sourceHash || issued.report.contextHash !== contextHash
        || issued.report.planId !== source.value.planId
        || JSON.stringify(issued.report.entryHashes) !== JSON.stringify(entryHashes)) {
        throw new OutlineLineError("线路分析报告已过期或来源无效，请重新分析", "CAS_CONFLICT");
    }
    if (resolutions.length !== issued.report.conflicts.length
        || new Set(resolutions.map(({index}) => index)).size !== resolutions.length
        || resolutions.some(({index, decision, reason}) => !Number.isInteger(index) || index < 0
            || index >= issued.report.conflicts.length || (decision !== "resolved" && decision !== "ignored")
            || !reason.trim())) {
        throw new OutlineLineError("存在未处理的线路冲突，请逐项记录处理方式与理由");
    }
    const fixed: OutlineLine = {...source.value, fixed: true, version: source.value.version + 1,
        analysis: {...issued.report, resolutions: resolutions.map(({index, decision, reason}) =>
            ({index, decision, reason: reason.trim()}))}};
    return buildPlanningWrite(snapshot, {lines: [{source, value: fixed}]});
}

export type FixedLineNodeStatus = "valid" | "yellow" | "red" | "empty";
export type FixedLineNode = Readonly<{nodeId: OutlineId; entryId: OutlineId | null; column: number; status: FixedLineNodeStatus}>;

/** 从当前规范快照重新判定资格，不将历史 fixed 标志或报告直接当作正文读取许可。 */
export function inspectFixedLine(snapshot: PlanningSnapshot, lineId: OutlineId): Readonly<{
    lineId: OutlineId; chainProblem: LineChainProblem | null; nodes: readonly FixedLineNode[];
}> {
    const source = snapshot.lines.find(({value}) => value.id === lineId);
    if (!source) throw new OutlineLineError("线路不存在");
    const line = source.value;
    const graph = findPlanGraph(snapshot, line.planId)?.value;
    const chain = resolveLineChain(graph, line.nodeIds);
    const entries = new Map(snapshot.entries.map((entry) => [entry.value.id, entry]));
    const plan = snapshot.manifest.plans.find(({id}) => id === line.planId);
    const report = line.analysis;
    const reviewedHashes = new Map(report?.entryHashes.map(({entryId, contentHash: hash}) => [entryId, hash]) ?? []);
    // 线路自身条目的修改只让对应节点变黄；其余方案条目变化会改变 contextHash，使整条线路变黄。
    const contextFresh = Boolean(line.fixed && plan && report && report.planId === plan.id && chain.problem === null
        && report.sourceHash === lineStructureHash(line, graph)
        && snapshot.manifest.entries.length === snapshot.entries.length
        && planContextHash(plan, (id) => reviewedHashes.get(id) ?? entries.get(id)?.contentHash) === report.contextHash);
    const nodeHashes = new Map(report?.entryHashes.map(({nodeId, contentHash: hash}) => [nodeId, hash]) ?? []);
    return {lineId, chainProblem: chain.problem, nodes: chain.nodes.map((node) => {
        const entry = node.entryId === null ? undefined : entries.get(node.entryId);
        const status: FixedLineNodeStatus = node.entryId === null ? "empty" : !entry ? "red"
            : (!contextFresh || entry.value.status !== "adopted" || entry.value.kind === "detail"
                || !plan?.placements.some(({entryId}) => entryId === node.entryId)
                || nodeHashes.get(node.id) !== entry.contentHash ? "yellow" : "valid");
        return {nodeId: node.id, entryId: node.entryId, column: node.column, status};
    })};
}

/** 正文交接必须完整通过，不允许只读取部分有效节点而跳过失效节点。 */
export function readValidFixedLineNodes(snapshot: PlanningSnapshot, lineId: OutlineId): readonly FixedLineNode[] {
    const source = snapshot.lines.find(({value}) => value.id === lineId);
    const inspected = inspectFixedLine(snapshot, lineId);
    if (!source?.value.fixed || !source.value.analysis || inspected.chainProblem !== null
        || inspected.nodes.length === 0 || inspected.nodes.some(({status}) => status !== "valid")) {
        throw new OutlineLineError("线路节点失效或未完成固定分析，不能用于正文");
    }
    return inspected.nodes;
}
