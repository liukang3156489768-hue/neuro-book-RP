import {createHash, randomUUID} from "node:crypto";
import YAML from "yaml";

export const OUTLINE_SCHEMA = "nbook.outline/v2" as const;
/** v1 manifest 的 lines 指向已废弃的自带节点线路；读取时丢弃，写回一律为 v2。 */
export const OUTLINE_SCHEMA_V1 = "nbook.outline/v1" as const;
/** v1 条目只有路径数组形式的参考文件；读取分支仍须接受它，写入一律使用 v2。 */
export const OUTLINE_ENTRY_SCHEMA_V1 = "nbook.outline-entry/v1" as const;
export const OUTLINE_ENTRY_SCHEMA = "nbook.outline-entry/v2" as const;
export const OUTLINE_FORESHADOW_SCHEMA_V1 = "nbook.outline-foreshadowing/v1" as const;
export const OUTLINE_FORESHADOW_SCHEMA = "nbook.outline-foreshadowing/v2" as const;
export const FORESHADOW_MARKER_PARSER_VERSION = 1 as const;
export const OUTLINE_GRAPH_SCHEMA = "nbook.outline-graph/v1" as const;
export const OUTLINE_LINE_SCHEMA = "nbook.outline-line/v3" as const;

type OutlineIdPrefix = "ol" | "fo" | "ln" | "nd" | "fm" | "gr" | "eg";
export type OutlineId = `${OutlineIdPrefix}-${string}`;
export type OutlineEntryKind = "total" | "volume" | "chapter" | "detail";
export type OutlineEntryStatus = "draft" | "adopted";
export type OutlineLineType = "main" | "branch" | "character" | "if";
export type ForeshadowAction = "plant" | "reinforce" | "recover";

export type OutlineManifest = Readonly<{
    schema: typeof OUTLINE_SCHEMA;
    revision: number;
    totalId: OutlineId | null;
    plans: readonly Readonly<{
        id: string;
        title: string;
        placements: readonly Readonly<{
            entryId: OutlineId;
            parentId: OutlineId | null;
            position: number;
        }>[];
    }>[];
    entries: readonly Readonly<{id: OutlineId; path: string; version: number; contentHash: string}>[];
    foreshadowing: readonly Readonly<{id: OutlineId; path: string; version: number; contentHash: string}>[];
    graphs: readonly Readonly<{id: OutlineId; path: string; version: number; contentHash: string}>[];
    lines: readonly Readonly<{id: OutlineId; path: string; version: number; contentHash: string}>[];
}>;

/**
 * 参考文件的可审阅元数据：定位说明所用部分，purpose 说明用途，pending 表示资料未取得。
 * 待补资料可以没有路径，此时 locator 描述需要补的资料，避免为满足 schema 编造路径。
 */
export type OutlineReference = Readonly<{
    path?: string;
    locator?: string;
    purpose?: string;
    pending?: boolean;
}>;

/** “待补”参考文件由程序派生告警：不阻止采用，但分析结果和正文交接都必须显式呈现。 */
export type PendingReferenceWarning = Readonly<{
    code: "PENDING_REFERENCE";
    entryId: OutlineId;
    entryPath: string;
    path?: string;
    locator?: string;
    purpose?: string;
}>;

export function pendingReferenceWarnings(
    entryId: OutlineId, entryPath: string, references: readonly OutlineReference[] = [],
): PendingReferenceWarning[] {
    return references.filter((reference) => reference.pending === true).map((reference) => ({
        code: "PENDING_REFERENCE", entryId, entryPath,
        ...(reference.path === undefined ? {} : {path: reference.path}),
        ...(reference.locator === undefined ? {} : {locator: reference.locator}),
        ...(reference.purpose === undefined ? {} : {purpose: reference.purpose}),
    }));
}

export type OutlineEntry = Readonly<{
    schema: typeof OUTLINE_ENTRY_SCHEMA;
    id: OutlineId;
    kind: OutlineEntryKind;
    version: number;
    status: OutlineEntryStatus;
    title: string;
    parentId: OutlineId | null;
    chapterId: OutlineId | null;
    materialRefs?: readonly string[];
    writingGuidance?: string;
    references?: readonly OutlineReference[];
    targetWords?: number;
    analysis?: DetailAnalysis;
    body: string;
}>;

export type DetailAnalysis = Readonly<{
    reportId: string;
    planId: string;
    sourceHash: string;
    contextHash: string;
    summary: string;
    deviations: readonly string[];
    conflicts: readonly string[];
    resolutions: readonly Readonly<{index: number; decision: "resolved" | "ignored"; reason: string}>[];
}>;

/** 伏笔设计分项：表面线索、背后关联、埋设与回收建议；v1 文件读作缺席。 */
export type ForeshadowingDesign = Readonly<{
    surface?: string;
    connection?: string;
    plant?: Readonly<{situation: string; presentation: string; subtlety: string}>;
    recover?: Readonly<{condition: string; echo: string; effect: string}>;
}>;

export type Foreshadowing = Readonly<{
    schema: typeof OUTLINE_FORESHADOW_SCHEMA;
    id: OutlineId;
    version: number;
    status: OutlineEntryStatus;
    title: string;
    body: string;
} & ForeshadowingDesign>;

/**
 * 方案唯一的线路图。column 是方案内的全局剧情先后，row 只是排版；
 * 连线只能从小格号指向大格号，因此图天然无环。
 */
export type OutlineGraph = Readonly<{
    schema: typeof OUTLINE_GRAPH_SCHEMA;
    id: OutlineId;
    planId: string;
    version: number;
    nodes: readonly OutlineGraphNode[];
    edges: readonly OutlineGraphEdge[];
}>;
export type OutlineGraphNode = Readonly<{id: OutlineId; entryId: OutlineId | null; column: number; row: number}>;
export type OutlineGraphEdge = Readonly<{id: OutlineId; from: OutlineId; to: OutlineId}>;

/** 线路只是图上节点集合的分类；顺序由节点格号派生，不另存。 */
export type OutlineLine = Readonly<{
    schema: typeof OUTLINE_LINE_SCHEMA;
    id: OutlineId;
    planId: string;
    version: number;
    title: string;
    type: OutlineLineType;
    fixed: boolean;
    nodeIds: readonly OutlineId[];
    analysis?: LineSemanticReport;
}>;

export type LineSemanticReport = Readonly<{
    reportId: string;
    planId: string;
    sourceHash: string;
    contextHash: string;
    summary: string;
    conflicts: readonly string[];
    resolutions: readonly Readonly<{index: number; decision: "resolved" | "ignored"; reason: string}>[];
    entryHashes: readonly Readonly<{nodeId: OutlineId; entryId: OutlineId; contentHash: string}>[];
}>;

export type ForeshadowMarker = Readonly<{
    marker: string;
    foreshadowId: OutlineId;
    action: ForeshadowAction;
    content: string;
    startOffset: number;
    endOffset: number;
}>;

export type GuidanceAnnotation = Readonly<{
    marker: string;
    scene: string;
    words?: number;
    text: string;
    startOffset: number;
    endOffset: number;
}>;

export type OutlineDiagnostic = Readonly<{
    code: string;
    message: string;
    path?: string;
    offset?: number;
}>;

export class OutlineFormatError extends Error {
    readonly diagnostics: readonly OutlineDiagnostic[];

    constructor(message: string, diagnostics: readonly OutlineDiagnostic[], options?: ErrorOptions) {
        super(message, options);
        this.name = "OutlineFormatError";
        this.diagnostics = diagnostics;
    }
}

export function parseYaml<T>(content: string, path = "outline"): T {
    try {
        const document = YAML.parseDocument(content, {prettyErrors: true, strict: true, uniqueKeys: true});
        if (document.errors.length > 0) {
            throw new OutlineFormatError(`YAML 解析失败：${path}`, document.errors.map((error) => ({code: "YAML_PARSE", message: error.message, path})));
        }
        return document.toJSON() as T;
    } catch (error) {
        if (error instanceof OutlineFormatError) throw error;
        throw new OutlineFormatError(`YAML 解析失败：${path}`, [{code: "YAML_PARSE", message: error instanceof Error ? error.message : String(error), path}], {cause: error});
    }
}

export function serializeYaml(value: unknown): string {
    return YAML.stringify(value, {sortMapEntries: true, indent: 2});
}

export function createEmptyManifest(): OutlineManifest {
    return {
        schema: OUTLINE_SCHEMA,
        revision: 0,
        totalId: null,
        plans: [],
        entries: [],
        foreshadowing: [],
        graphs: [],
        lines: [],
    };
}

export function serializeManifest(manifest: OutlineManifest): string {
    return serializeYaml(manifest);
}
export function parseManifest(content: string, path = "outline/manifest.yaml"): OutlineManifest {
    const value = parseYaml<unknown>(content, path);
    assertRecord(value, path);
    if (value.schema !== OUTLINE_SCHEMA && value.schema !== OUTLINE_SCHEMA_V1) {
        fail("UNSUPPORTED_SCHEMA", `不支持的 schema：${String(value.schema)}`, `${path}.schema`);
    }
    const legacy = value.schema === OUTLINE_SCHEMA_V1;
    const manifest: OutlineManifest = {
        schema: OUTLINE_SCHEMA,
        revision: positiveInteger(value.revision, `${path}.revision`, true),
        totalId: value.totalId === null ? null : stableId(value.totalId, `${path}.totalId`, "ol"),
        plans: array(value.plans, `${path}.plans`).map((plan, index) => parsePlan(plan, `${path}.plans[${index}]`)),
        entries: parseManifestRefs(value.entries, `${path}.entries`, "ol"),
        foreshadowing: parseManifestRefs(value.foreshadowing, `${path}.foreshadowing`, "fo"),
        graphs: legacy ? [] : parseManifestRefs(value.graphs, `${path}.graphs`, "gr"),
        lines: legacy ? [] : parseManifestRefs(value.lines, `${path}.lines`, "ln"),
    };
    const refs = [...manifest.entries, ...manifest.foreshadowing, ...manifest.graphs, ...manifest.lines];
    assertUnique(refs.map((item) => item.id), `${path} 中的稳定 ID`);
    const paths = refs.map((item) => item.path);
    if (new Set(paths).size !== paths.length) fail("DUPLICATE_PATH", "manifest 文件路径重复", path);
    if (manifest.totalId !== null && !manifest.entries.some((entry) => entry.id === manifest.totalId)) {
        fail("UNKNOWN_TOTAL", "manifest.totalId 未出现在 entries 中", path);
    }
    return manifest;
}

export function parseEntryMarkdown(content: string, path = "outline/entries/entry.md"): OutlineEntry {
    const {frontmatter, body} = parseMarkdownFrontmatter(content, path);
    if (frontmatter.schema !== OUTLINE_ENTRY_SCHEMA && frontmatter.schema !== OUTLINE_ENTRY_SCHEMA_V1) {
        fail("UNSUPPORTED_SCHEMA", `不支持的 schema：${String(frontmatter.schema)}`, `${path}.schema`);
    }
    // v1 的路径数组与 v2 的结构化参考不能在同一文件里混用，否则来源不明。
    if (frontmatter.referenceFiles !== undefined && frontmatter.references !== undefined) {
        fail("CONFLICTING_REFERENCES", "referenceFiles 与 references 不能同时出现", path);
    }
    const kind = enumValue(frontmatter.kind, ["total", "volume", "chapter", "detail"] as const, `${path}.kind`);
    const references = frontmatter.references !== undefined
        ? parseReferences(frontmatter.references, `${path}.references`)
        : frontmatter.referenceFiles === undefined ? undefined
            : parseFileRefs(frontmatter.referenceFiles, `${path}.referenceFiles`).map((ref) => ({path: ref}));
    const entry: OutlineEntry = {
        schema: OUTLINE_ENTRY_SCHEMA,
        id: stableId(frontmatter.id, `${path}.id`, "ol"),
        kind,
        version: positiveInteger(frontmatter.version, `${path}.version`, true),
        status: enumValue(frontmatter.status, ["draft", "adopted"] as const, `${path}.status`),
        title: nonEmptyString(frontmatter.title, `${path}.title`),
        parentId: nullableStableId(frontmatter.parentId, `${path}.parentId`),
        chapterId: nullableStableId(frontmatter.chapterId, `${path}.chapterId`),
        ...(frontmatter.materialRefs === undefined ? {} : {materialRefs: parseFileRefs(frontmatter.materialRefs, `${path}.materialRefs`)}),
        ...(frontmatter.writingGuidance === undefined ? {} : {writingGuidance: stringValue(frontmatter.writingGuidance, `${path}.writingGuidance`)}),
        ...(references === undefined ? {} : {references}),
        ...(frontmatter.targetWords === undefined ? {} : {targetWords: positiveInteger(frontmatter.targetWords, `${path}.targetWords`)}),
        ...(frontmatter.analysis === undefined ? {} : {analysis: parseDetailAnalysis(frontmatter.analysis, `${path}.analysis`)}),
        body,
    };
    if (entry.analysis && entry.kind !== "detail") fail("INVALID_ANALYSIS", "只有细纲可保存分析报告", path);
    if (entry.kind === "total" && (entry.parentId !== null || entry.chapterId !== null)) fail("INVALID_PARENT", "总纲不能有父级或章节关联", path);
    if (entry.kind === "detail" && entry.chapterId === null) fail("DETAIL_WITHOUT_CHAPTER", "细纲必须关联章节大纲", path);
    return entry;
}

export function serializeEntryMarkdown(entry: OutlineEntry): string {
    return `---\n${serializeYaml({
        chapterId: entry.chapterId,
        id: entry.id,
        kind: entry.kind,
        ...(entry.materialRefs === undefined ? {} : {materialRefs: entry.materialRefs}),
        ...(entry.writingGuidance === undefined ? {} : {writingGuidance: entry.writingGuidance}),
        ...(entry.references === undefined ? {} : {references: entry.references.map((reference) => ({
            ...(reference.path === undefined ? {} : {path: reference.path}),
            locator: reference.locator ?? null, purpose: reference.purpose ?? null, pending: reference.pending ?? null,
        }))}),
        ...(entry.targetWords === undefined ? {} : {targetWords: entry.targetWords}),
        ...(entry.analysis === undefined ? {} : {analysis: entry.analysis}),
        parentId: entry.parentId,
        schema: entry.schema,
        status: entry.status,
        title: entry.title,
        version: entry.version,
    })}---\n${entry.body}`;
}

function parseDetailAnalysis(value: unknown, location: string): DetailAnalysis {
    assertRecord(value, location);
    const deviations = array(value.deviations, location + ".deviations").map((item, index) => nonEmptyString(item, location + ".deviations[" + index + "]"));
    const conflicts = array(value.conflicts, location + ".conflicts").map((item, index) => nonEmptyString(item, location + ".conflicts[" + index + "]"));
    const resolutions = array(value.resolutions, location + ".resolutions").map((item, index) => {
        const at = location + ".resolutions[" + index + "]";
        assertRecord(item, at);
        const conflictIndex = nonNegativeInteger(item.index, at + ".index");
        if (conflictIndex >= conflicts.length) fail("INVALID_ANALYSIS", "冲突处理索引越界", at);
        return {index: conflictIndex, decision: enumValue(item.decision, ["resolved", "ignored"] as const, at + ".decision"),
            reason: nonEmptyString(item.reason, at + ".reason")};
    });
    if (new Set(resolutions.map((item) => item.index)).size !== resolutions.length) fail("INVALID_ANALYSIS", "冲突处理重复", location);
    return {reportId: nonEmptyString(value.reportId, location + ".reportId"),
        planId: nonEmptyString(value.planId, location + ".planId"),
        sourceHash: hashValue(value.sourceHash, location + ".sourceHash"),
        contextHash: hashValue(value.contextHash, location + ".contextHash"),
        summary: nonEmptyString(value.summary, location + ".summary"), deviations, conflicts, resolutions};
}

export function parseForeshadowingMarkdown(content: string, path = "outline/foreshadowing/item.md"): Foreshadowing {
    const {frontmatter, body} = parseMarkdownFrontmatter(content, path);
    if (frontmatter.schema !== OUTLINE_FORESHADOW_SCHEMA && frontmatter.schema !== OUTLINE_FORESHADOW_SCHEMA_V1) {
        fail("UNSUPPORTED_SCHEMA", `不支持的 schema：${String(frontmatter.schema)}`, `${path}.schema`);
    }
    return {
        schema: OUTLINE_FORESHADOW_SCHEMA,
        id: stableId(frontmatter.id, `${path}.id`, "fo"),
        version: positiveInteger(frontmatter.version, `${path}.version`, true),
        status: frontmatter.status === undefined ? "draft" : enumValue(frontmatter.status, ["draft", "adopted"] as const, `${path}.status`),
        title: nonEmptyString(frontmatter.title, `${path}.title`),
        ...parseForeshadowingDesign(frontmatter, path),
        body,
    };
}

/** 分项字段全部可选：缺失即原样缺席，不用空串伪装成已填写。 */
function parseForeshadowingDesign(frontmatter: Record<string, unknown>, path: string): ForeshadowingDesign {
    return {
        ...(frontmatter.surface === undefined || frontmatter.surface === null ? {} : {surface: nonEmptyString(frontmatter.surface, `${path}.surface`)}),
        ...(frontmatter.connection === undefined || frontmatter.connection === null ? {} : {connection: nonEmptyString(frontmatter.connection, `${path}.connection`)}),
        ...(frontmatter.plant === undefined || frontmatter.plant === null ? {} : {plant: parseForeshadowingStage(frontmatter.plant,
            `${path}.plant`, ["situation", "presentation", "subtlety"] as const)}),
        ...(frontmatter.recover === undefined || frontmatter.recover === null ? {} : {recover: parseForeshadowingStage(frontmatter.recover,
            `${path}.recover`, ["condition", "echo", "effect"] as const)}),
    };
}

function parseForeshadowingStage<const T extends readonly string[]>(
    value: unknown, path: string, fields: T,
): Record<T[number], string> {
    assertRecord(value, path);
    for (const key of Object.keys(value)) {
        if (!(fields as readonly string[]).includes(key)) fail("UNKNOWN_FORESHADOW_FIELD", `伏笔分项存在未知字段：${key}`, `${path}.${key}`);
    }
    return Object.fromEntries(fields.map((field) => [field, nonEmptyString(value[field], `${path}.${field}`)])) as Record<T[number], string>;
}

export function serializeForeshadowingMarkdown(item: Foreshadowing): string {
    return `---\n${serializeYaml({id: item.id,
        ...(item.surface === undefined ? {} : {surface: item.surface}),
        ...(item.connection === undefined ? {} : {connection: item.connection}),
        ...(item.plant === undefined ? {} : {plant: item.plant}),
        ...(item.recover === undefined ? {} : {recover: item.recover}),
        schema: item.schema, status: item.status, title: item.title, version: item.version})}---\n${item.body}`;
}

export function parseGraphYaml(content: string, path = "outline/graphs/graph.yaml"): OutlineGraph {
    const value = parseYaml<unknown>(content, path);
    assertRecord(value, path);
    assertExact(value.schema, OUTLINE_GRAPH_SCHEMA, `${path}.schema`);
    const graph: OutlineGraph = {
        schema: OUTLINE_GRAPH_SCHEMA,
        id: stableId(value.id, `${path}.id`, "gr"),
        planId: nonEmptyString(value.planId, `${path}.planId`),
        version: positiveInteger(value.version, `${path}.version`, true),
        nodes: array(value.nodes, `${path}.nodes`).map((node, index) => parseGraphNode(node, `${path}.nodes[${index}]`)),
        edges: array(value.edges, `${path}.edges`).map((edge, index) => parseGraphEdge(edge, `${path}.edges[${index}]`)),
    };
    validateGraph(graph, path);
    return graph;
}

export function serializeGraphYaml(graph: OutlineGraph): string {
    return serializeYaml(graph);
}

export function parseLineYaml(content: string, path = "outline/storylines/line.yaml"): OutlineLine {
    const value = parseYaml<unknown>(content, path);
    assertRecord(value, path);
    assertExact(value.schema, OUTLINE_LINE_SCHEMA, `${path}.schema`);
    const line: OutlineLine = {
        schema: OUTLINE_LINE_SCHEMA,
        id: stableId(value.id, `${path}.id`, "ln"),
        planId: nonEmptyString(value.planId, `${path}.planId`),
        version: positiveInteger(value.version, `${path}.version`, true),
        title: nonEmptyString(value.title, `${path}.title`),
        type: enumValue(value.type, ["main", "branch", "character", "if"] as const, `${path}.type`),
        fixed: booleanValue(value.fixed, `${path}.fixed`),
        nodeIds: array(value.nodeIds, `${path}.nodeIds`).map((id, index) => stableId(id, `${path}.nodeIds[${index}]`, "nd")),
        ...(value.analysis === undefined ? {} : {analysis: parseLineSemanticReport(value.analysis, `${path}.analysis`)}),
    };
    validateLine(line, path);
    return line;
}

function parseLineSemanticReport(input: unknown, location: string): LineSemanticReport {
    assertRecord(input, location);
    const conflicts = array(input.conflicts, location + ".conflicts").map((item, i) => nonEmptyString(item, location + ".conflicts[" + i + "]"));
    const resolutions = array(input.resolutions, location + ".resolutions").map((item, i) => {
        const at = location + ".resolutions[" + i + "]";
        assertRecord(item, at);
        const index = nonNegativeInteger(item.index, at + ".index");
        if (index >= conflicts.length) fail("INVALID_ANALYSIS", "线路冲突处理索引越界", at);
        return {index, decision: enumValue(item.decision, ["resolved", "ignored"] as const, at + ".decision"),
            reason: nonEmptyString(item.reason, at + ".reason")};
    });
    if (new Set(resolutions.map(({index}) => index)).size !== resolutions.length) fail("INVALID_ANALYSIS", "线路冲突处理重复", location);
    const entryHashes = array(input.entryHashes, location + ".entryHashes").map((item, i) => {
        const at = location + ".entryHashes[" + i + "]";
        assertRecord(item, at);
        return {nodeId: stableId(item.nodeId, at + ".nodeId", "nd"),
            entryId: stableId(item.entryId, at + ".entryId", "ol"),
            contentHash: hashValue(item.contentHash, at + ".contentHash")};
    });
    if (new Set(entryHashes.map(({nodeId}) => nodeId)).size !== entryHashes.length) fail("INVALID_ANALYSIS", "线路分析节点重复", location);
    return {reportId: nonEmptyString(input.reportId, location + ".reportId"),
        planId: nonEmptyString(input.planId, location + ".planId"),
        sourceHash: hashValue(input.sourceHash, location + ".sourceHash"),
        contextHash: hashValue(input.contextHash, location + ".contextHash"),
        summary: nonEmptyString(input.summary, location + ".summary"), conflicts, resolutions, entryHashes};
}

export function serializeLineYaml(line: OutlineLine): string {
    return serializeYaml(line);
}

export function parseForeshadowMarkers(
    body: string,
    knownForeshadowIds: ReadonlySet<string>,
    path = "outline/entries/entry.md",
): readonly ForeshadowMarker[] {
    const tokenPattern = /<!--([\s\S]*?)-->/gu;
    const open = new Map<string, {id: OutlineId; action: ForeshadowAction; contentStart: number; startOffset: number}>();
    const result: ForeshadowMarker[] = [];
    const used = new Set<string>();
    let match: RegExpExecArray | null;
    let scannedUntil = 0;
    while ((match = tokenPattern.exec(body)) !== null) {
        if (/<!--\s*\/?nb:foreshadow/iu.test(body.slice(scannedUntil, match.index))) {
            fail("INVALID_MARKER", "伏笔注释未正确闭合", path, scannedUntil);
        }
        scannedUntil = tokenPattern.lastIndex;
        const comment = match[1] ?? "";
        const token = /^\s*(\/?)nb:foreshadow\b([\s\S]*)$/u.exec(comment);
        if (!token) {
            if (/^\s*\/?nb:foreshadow/iu.test(comment)) fail("INVALID_MARKER", "伏笔注释语法损坏", path, match.index);
            continue;
        }
        const closing = token[1] === "/";
        const attributes = parseAttributes(token[2] ?? "", path, match.index);
        const marker = typeof attributes.marker === "string" ? stableId(attributes.marker, `${path} marker`, "fm") : attributes.marker;
        if (typeof marker !== "string" || marker.length === 0) fail("INVALID_MARKER", "伏笔 marker 不能为空", path, match.index);
        if (closing) {
            if (Object.keys(attributes).some((key) => key !== "marker")) fail("INVALID_MARKER_END", "伏笔结束标记只能包含 marker", path, match.index);
            const pending = open.get(marker);
            if (!pending) fail("UNMATCHED_MARKER_END", `伏笔结束标记没有对应开始：${marker}`, path, match.index);
            open.delete(marker);
            result.push({marker, foreshadowId: pending.id, action: pending.action, content: body.slice(pending.contentStart, match.index), startOffset: pending.startOffset, endOffset: tokenPattern.lastIndex});
            continue;
        }
        if (used.has(marker) || open.has(marker)) fail("DUPLICATE_MARKER", `伏笔 marker 在文档内不唯一：${marker}`, path, match.index);
        if (open.size > 0) fail("NESTED_MARKER", "伏笔标记不能嵌套或交叉", path, match.index);
        const foreshadowId = stableId(attributes.foreshadow, `${path} marker ${marker}`, "fo");
        if (!knownForeshadowIds.has(foreshadowId)) fail("UNKNOWN_FORESHADOW", `未知伏笔 ID：${foreshadowId}`, path, match.index);
        const action = enumValue(attributes.action, ["plant", "reinforce", "recover"] as const, `${path} marker ${marker}.action`);
        used.add(marker);
        open.set(marker, {id: foreshadowId, action, contentStart: tokenPattern.lastIndex, startOffset: match.index});
    }
    if (/<!--\s*\/?nb:foreshadow/iu.test(body.slice(scannedUntil))) {
        fail("INVALID_MARKER", "伏笔注释未正确闭合", path, scannedUntil);
    }
    if (open.size > 0) {
        fail("UNMATCHED_MARKER_START", `伏笔开始标记未闭合：${[...open.keys()].join(", ")}`, path);
    }
    return result;
}

/**
 * 写作指导按场景锚定；`scene` 必填，`words` 是该场景的篇幅预算。
 *
 * 与伏笔标记同构：注释语法损坏、未配对、属性重复或未知都 fail-closed，
 * 因为静默丢弃会让细纲看起来少了约束，而作者无法察觉。
 */
export function parseGuidanceAnnotations(body: string, path = "outline/entries/entry.md"): readonly GuidanceAnnotation[] {
    const tokenPattern = /<!--([\s\S]*?)-->/gu;
    const open = new Map<string, {scene: string; words?: number; contentStart: number; startOffset: number}>();
    const result: GuidanceAnnotation[] = [];
    const used = new Set<string>();
    let match: RegExpExecArray | null;
    let scannedUntil = 0;
    while ((match = tokenPattern.exec(body)) !== null) {
        if (/<!--\s*\/?nb:guidance/iu.test(body.slice(scannedUntil, match.index))) {
            fail("INVALID_GUIDANCE", "写作指导注释未正确闭合", path, scannedUntil);
        }
        scannedUntil = tokenPattern.lastIndex;
        const comment = match[1] ?? "";
        const token = /^\s*(\/?)nb:guidance\b([\s\S]*)$/u.exec(comment);
        if (!token) {
            if (/^\s*\/?nb:guidance/iu.test(comment)) fail("INVALID_GUIDANCE", "写作指导注释语法损坏", path, match.index);
            continue;
        }
        const closing = token[1] === "/";
        const attributes = parseAttributes(token[2] ?? "", path, match.index, "写作指导");
        const rawMarker = attributes.marker;
        const marker = typeof rawMarker === "string" ? rawMarker.trim() : "";
        if (!marker) fail("INVALID_GUIDANCE", "写作指导 marker 不能为空", path, match.index);
        for (const key of Object.keys(attributes)) {
            if (key !== "marker" && key !== "scene" && key !== "words") {
                fail("INVALID_GUIDANCE", `写作指导标记存在未知属性：${key}`, path, match.index);
            }
        }
        if (closing) {
            if (Object.keys(attributes).some((key) => key !== "marker")) {
                fail("INVALID_GUIDANCE_END", "写作指导结束标记只能包含 marker", path, match.index);
            }
            const pending = open.get(marker);
            if (!pending) fail("UNMATCHED_MARKER_END", `写作指导结束标记没有对应开始：${marker}`, path, match.index);
            open.delete(marker);
            result.push({marker, scene: pending.scene, ...(pending.words === undefined ? {} : {words: pending.words}),
                text: body.slice(pending.contentStart, match.index), startOffset: pending.startOffset, endOffset: tokenPattern.lastIndex});
            continue;
        }
        if (used.has(marker) || open.has(marker)) fail("DUPLICATE_MARKER", `写作指导 marker 在文档内不唯一：${marker}`, path, match.index);
        if (open.size > 0) fail("NESTED_MARKER", "写作指导标记不能嵌套或交叉", path, match.index);
        const scene = attributes.scene;
        if (typeof scene !== "string" || scene.trim() === "") {
            fail("INVALID_GUIDANCE", "写作指导必须标注场景", path, match.index);
        }
        const words = attributes.words === undefined ? undefined : positiveIntegerFromString(attributes.words, `${path} 写作指导 ${marker}.words`);
        used.add(marker);
        open.set(marker, {scene: scene.trim(), ...(words === undefined ? {} : {words}), contentStart: tokenPattern.lastIndex, startOffset: match.index});
    }
    if (/<!--\s*\/?nb:guidance/iu.test(body.slice(scannedUntil))) {
        fail("INVALID_GUIDANCE", "写作指导注释未正确闭合", path, scannedUntil);
    }
    if (open.size > 0) {
        fail("UNMATCHED_MARKER_START", `写作指导开始标记未闭合：${[...open.keys()].join(", ")}`, path);
    }
    return result;
}

/** 注释属性只有十进制文本形式，缺省或非法都不可猜成正数。 */
function positiveIntegerFromString(value: string, path: string): number {
    if (!/^[1-9][0-9]*$/u.test(value.trim())) fail("INVALID_INTEGER", "必须是正整数", path);
    return Number(value.trim());
}

export function validateManifestAndEntries(manifest: OutlineManifest, entries: readonly OutlineEntry[], path = "outline", knownMissingEntryIds: ReadonlySet<OutlineId> = new Set()): void {
    const totalEntries = entries.filter((entry) => entry.kind === "total");
    if (totalEntries.length > 1) fail("MULTIPLE_TOTAL", "规划范围内只能有一个总纲", path);
    if (manifest.totalId !== null && totalEntries[0]?.id !== manifest.totalId && (totalEntries.length > 0 || !knownMissingEntryIds.has(manifest.totalId))) fail("TOTAL_MISMATCH", "manifest 根总纲与 entry 不一致", path);
    if (manifest.totalId === null && totalEntries.length > 0) fail("TOTAL_NOT_IN_MANIFEST", "总纲必须由 manifest.totalId 指向", path);
    const ids = new Set(entries.map((entry) => entry.id));
    const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
    assertAcyclicParents(new Map(entries.map((entry) => [entry.id, entry.parentId])), path);
    const planIds = new Set<string>();
    for (const plan of manifest.plans) {
        if (manifest.totalId === null || plan.placements.filter((place) => place.entryId === manifest.totalId && place.parentId === null).length !== 1) {
            fail("PLAN_TOTAL_REQUIRED", `方案 ${plan.id} 必须引用唯一全局总纲作为根`, path);
        }
        if (planIds.has(plan.id)) fail("DUPLICATE_PLAN", `方案 ID 重复：${plan.id}`, path);
        planIds.add(plan.id);
        const placementIds = new Set<string>();
        const positions = new Set<number>();
        for (const placement of plan.placements) {
            if (placementIds.has(placement.entryId)) fail("DUPLICATE_PLACEMENT", `方案内条目重复：${placement.entryId}`, path);
            if (positions.has(placement.position)) fail("DUPLICATE_PLACEMENT_POSITION", `方案内位置重复：${placement.position}`, path);
            placementIds.add(placement.entryId);
            positions.add(placement.position);
            if (!ids.has(placement.entryId) && !knownMissingEntryIds.has(placement.entryId)) fail("UNKNOWN_PLACEMENT_ENTRY", `方案引用不存在的大纲条目：${placement.entryId}`, path);
            if (placement.parentId !== null && !ids.has(placement.parentId) && !knownMissingEntryIds.has(placement.parentId)) fail("UNKNOWN_PLACEMENT_PARENT", `方案引用不存在的父级：${placement.parentId}`, path);
            if (placement.entryId !== manifest.totalId && placement.parentId === null) fail("ORPHAN_PLACEMENT", `方案条目缺少父级：${placement.entryId}`, path);
        }
        for (const placement of plan.placements) {
            if (placement.parentId !== null && !placementIds.has(placement.parentId)) {
                fail("FOREIGN_PLAN_PARENT", `方案父级未在同一方案中：${placement.parentId}`, path);
            }
        }
        assertAcyclicParents(new Map(plan.placements.map((placement) => [placement.entryId, placement.parentId])), path);
        for (const placement of plan.placements) {
            if (placement.parentId !== null && ids.has(placement.parentId) && ids.has(placement.entryId)
                && !canParentEntry(entriesById.get(placement.parentId)!.kind, entriesById.get(placement.entryId)!.kind)) {
                fail("INVALID_PLACEMENT_PARENT", `方案条目父级类型不合法：${placement.entryId}`, path);
            }
        }
    }
    for (const entry of entries) {
        if (entry.kind === "detail" && entry.chapterId !== null && !knownMissingEntryIds.has(entry.chapterId)
            && entriesById.get(entry.chapterId)?.kind !== "chapter") {
            fail("INVALID_DETAIL_CHAPTER", `细纲必须关联章节大纲：${entry.id}`, path);
        }
        if (entry.parentId !== null && !ids.has(entry.parentId) && !knownMissingEntryIds.has(entry.parentId)) fail("UNKNOWN_PARENT", `未知父级：${entry.parentId}`, path);
        if (entry.chapterId !== null && !ids.has(entry.chapterId) && !knownMissingEntryIds.has(entry.chapterId)) fail("UNKNOWN_CHAPTER", `未知章节大纲：${entry.chapterId}`, path);
        if (entry.kind === "detail" && entry.chapterId === null) fail("DETAIL_WITHOUT_CHAPTER", `细纲未关联章节：${entry.id}`, path);
        if (entry.kind !== "total" && (entry.parentId === null
            || (ids.has(entry.parentId) && !canParentEntry(entriesById.get(entry.parentId)!.kind, entry.kind)))) {
            fail("INVALID_PARENT_KIND", `条目父级类型不合法：${entry.id}`, path);
        }
        if (entry.kind === "detail" && entry.chapterId !== entry.parentId) {
            fail("DETAIL_CHAPTER_MISMATCH", `细纲章节关联与父级不一致：${entry.id}`, path);
        }
        if (entry.kind !== "detail" && entry.chapterId !== null) fail("INVALID_CHAPTER", `非细纲不能关联章节：${entry.id}`, path);
    }
}

export function canParentEntry(parent: OutlineEntryKind, child: OutlineEntryKind): boolean {
    return (parent === "total" && (child === "volume" || child === "chapter"))
        || (parent === "volume" && child === "chapter")
        || (parent === "chapter" && child === "detail");
}

function assertAcyclicParents(parents: ReadonlyMap<OutlineId, OutlineId | null>, path: string): void {
    const checked = new Set<OutlineId>();
    for (const id of parents.keys()) {
        const chain = new Set<OutlineId>();
        let cursor: OutlineId | null = id;
        while (cursor !== null && !checked.has(cursor)) {
            if (chain.has(cursor)) fail("PARENT_CYCLE", `大纲层级存在循环：${cursor}`, path);
            chain.add(cursor);
            cursor = parents.get(cursor) ?? null;
        }
        for (const visited of chain) checked.add(visited);
    }
}

/** 单个线路图文件的不变量；跨文件的方案归属与条目合法性由 validatePlanningGraphs 负责。 */
export function validateGraph(graph: OutlineGraph, path = "outline/graphs/graph.yaml"): void {
    assertUnique(graph.nodes.map((node) => node.id), `${path}.nodes.id`);
    assertUnique(graph.edges.map((edge) => edge.id), `${path}.edges.id`);
    assertUnique(graph.nodes.map((node) => `${node.column}:${node.row}`), `${path}.nodes 单元格`);
    assertUnique(graph.nodes.flatMap((node) => node.entryId === null ? [] : [node.entryId]), `${path}.nodes.entryId`);
    assertUnique(graph.edges.map((edge) => `${edge.from}>${edge.to}`), `${path}.edges 端点`);
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const edge of graph.edges) {
        const from = nodeById.get(edge.from);
        const to = nodeById.get(edge.to);
        if (!from || !to) fail("UNKNOWN_NODE_REFERENCE", `连线引用不存在的节点：${edge.id}`, path);
        if (from.column >= to.column) fail("REVERSE_EDGE", `连线必须从小格号指向大格号：${edge.id}`, path);
    }
}

/** 单条线路文件的不变量；草稿可以暂时不是合法链，链结构由 resolveLineChain 判定。 */
export function validateLine(line: OutlineLine, path = "outline/storylines/line.yaml"): void {
    assertUnique(line.nodeIds, `${path}.nodeIds`);
    if (line.fixed && !line.analysis) fail("MISSING_ANALYSIS", "固定线路必须带分析报告", path);
    if (line.analysis) {
        const nodes = new Set(line.nodeIds);
        if (line.analysis.planId !== line.planId
            || line.analysis.entryHashes.length !== nodes.size
            || line.analysis.entryHashes.some(({nodeId}) => !nodes.has(nodeId))
            || line.analysis.resolutions.length !== line.analysis.conflicts.length) {
            fail("INVALID_ANALYSIS", "线路分析报告与当前线路节点或所属方案不一致", path);
        }
    }
}

/**
 * 跨文件不变量：每个方案至多一张图，节点条目属于本方案且不是细纲，线路节点属于同方案的图，每个方案至多一条主线。
 * entryKinds 缺少的条目按丢失处理，只核对方案成员资格，由节点状态标红。
 */
export function validatePlanningGraphs(
    graphs: readonly OutlineGraph[], lines: readonly OutlineLine[], plans: OutlineManifest["plans"],
    entryKinds: ReadonlyMap<string, OutlineEntryKind>, path = "outline",
): void {
    const planEntries = new Map(plans.map((plan) => [plan.id, new Set<string>(plan.placements.map(({entryId}) => entryId))]));
    const graphPlans = new Set<string>();
    const nodePlans = new Map<OutlineId, string>();
    for (const graph of graphs) {
        const members = planEntries.get(graph.planId);
        if (!members) fail("UNKNOWN_GRAPH_PLAN", `线路图所属方案不存在：${graph.planId}`, path);
        if (graphPlans.has(graph.planId)) fail("MULTIPLE_GRAPHS", `同一方案只能有一张线路图：${graph.planId}`, path);
        graphPlans.add(graph.planId);
        for (const node of graph.nodes) {
            if (nodePlans.has(node.id)) fail("DUPLICATE_ID", `线路图节点 ID 重复：${node.id}`, path);
            nodePlans.set(node.id, graph.planId);
            if (node.entryId === null) continue;
            if (!members.has(node.entryId)) fail("FOREIGN_PLAN_ENTRY", `线路图节点不属于所属方案：${node.entryId}`, path);
            if (entryKinds.get(node.entryId) === "detail") fail("DETAIL_NODE", `细纲不能独立成为线路节点：${node.entryId}`, path);
        }
    }
    const mainPlans = new Set<string>();
    for (const line of lines) {
        if (!planEntries.has(line.planId)) fail("UNKNOWN_LINE_PLAN", `线路所属方案不存在：${line.planId}`, path);
        if (line.type === "main") {
            if (mainPlans.has(line.planId)) fail("MULTIPLE_MAIN_LINES", `同一方案只能有一条主线：${line.planId}`, path);
            mainPlans.add(line.planId);
        }
        for (const nodeId of line.nodeIds) {
            if (nodePlans.get(nodeId) !== line.planId) fail("FOREIGN_LINE_NODE", `线路节点不在所属方案的线路图中：${nodeId}`, path);
        }
    }
}

export type LineChainProblem = "TOO_SHORT" | "UNKNOWN_NODE" | "SAME_COLUMN" | "MISSING_EDGE";
export type LineChain = Readonly<{
    /** 按格号排列的线路节点，图中不存在的节点已剔除。 */
    nodes: readonly OutlineGraphNode[];
    /** 相邻节点之间已存在的连线。 */
    edges: readonly OutlineGraphEdge[];
    problem: LineChainProblem | null;
}>;

/** 链：按格号排序后格号严格递增、相邻节点之间有连线、至少 2 个节点。 */
export function resolveLineChain(graph: OutlineGraph | undefined, nodeIds: readonly OutlineId[]): LineChain {
    const byId = new Map((graph?.nodes ?? []).map((node) => [node.id, node]));
    const nodes = nodeIds.flatMap((id) => byId.get(id) ?? []).sort((a, b) => a.column - b.column || a.row - b.row);
    const edges: OutlineGraphEdge[] = [];
    let problem: LineChainProblem | null = nodes.length !== nodeIds.length ? "UNKNOWN_NODE" : nodes.length < 2 ? "TOO_SHORT" : null;
    for (let index = 1; index < nodes.length; index += 1) {
        const from = nodes[index - 1]!;
        const to = nodes[index]!;
        if (from.column === to.column) {
            problem ??= "SAME_COLUMN";
            continue;
        }
        const edge = graph?.edges.find((item) => item.from === from.id && item.to === to.id);
        if (edge) edges.push(edge);
        else problem ??= "MISSING_EDGE";
    }
    return {nodes, edges, problem};
}

export function createStableId(prefix: OutlineIdPrefix): OutlineId {
    return `${prefix}-${randomUUID()}` as OutlineId;
}

export function stableId(value: unknown, path: string, expectedPrefix?: OutlineIdPrefix): OutlineId {
    if (typeof value !== "string" || !/^(?:ol|fo|ln|nd|fm|gr|eg)-[a-z0-9][a-z0-9-]*$/u.test(value)) fail("INVALID_STABLE_ID", `稳定 ID 非法：${String(value)}`, path);
    if (expectedPrefix !== undefined && !value.startsWith(`${expectedPrefix}-`)) fail("INVALID_STABLE_ID_PREFIX", `稳定 ID 必须使用 ${expectedPrefix}- 前缀`, path);
    return value as OutlineId;
}

export function slugify(value: string): string {
    const slug = value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
    return slug || "untitled";
}

export function stableFileName(title: string, id: OutlineId, extension: "md" | "yaml"): string {
    return `${slugify(title)}--${id}.${extension}`;
}

export function contentHash(content: string): string {
    return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function parseMarkdownFrontmatter(content: string, path: string): {frontmatter: Record<string, unknown>; body: string} {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u);
    if (!match) fail("MISSING_FRONTMATTER", "Markdown 缺少完整 front matter", path);
    const frontmatter = parseYaml<unknown>(match[1] ?? "", `${path} front matter`);
    assertRecord(frontmatter, `${path} front matter`);
    return {frontmatter, body: match[2] ?? ""};
}

function parsePlan(value: unknown, path: string): OutlineManifest["plans"][number] {
    assertRecord(value, path);
    return {
        id: nonEmptyString(value.id, `${path}.id`),
        title: nonEmptyString(value.title, `${path}.title`),
        placements: array(value.placements, `${path}.placements`).map((item, index) => {
            const placementPath = `${path}.placements[${index}]`;
            assertRecord(item, placementPath);
            return {
                entryId: stableId(item.entryId, `${placementPath}.entryId`, "ol"),
                parentId: nullableStableId(item.parentId, `${placementPath}.parentId`),
                position: nonNegativeInteger(item.position, `${placementPath}.position`),
            };
        }),
    };
}

function parseManifestRefs(value: unknown, path: string, expectedPrefix: "ol" | "fo" | "gr" | "ln"): OutlineManifest["entries"] {
    return array(value, path).map((item, index) => {
        const itemPath = `${path}[${index}]`;
        assertRecord(item, itemPath);
        return {
            id: stableId(item.id, `${itemPath}.id`, expectedPrefix),
            path: nonEmptyString(item.path, `${itemPath}.path`),
            version: positiveInteger(item.version, `${itemPath}.version`, true),
            contentHash: hashValue(item.contentHash, `${itemPath}.contentHash`),
        };
    });
}

function parseGraphNode(value: unknown, path: string): OutlineGraphNode {
    assertRecord(value, path);
    return {
        id: stableId(value.id, `${path}.id`, "nd"),
        entryId: value.entryId === null ? null : stableId(value.entryId, `${path}.entryId`, "ol"),
        column: nonNegativeInteger(value.column, `${path}.column`),
        row: nonNegativeInteger(value.row, `${path}.row`),
    };
}

function parseGraphEdge(value: unknown, path: string): OutlineGraphEdge {
    assertRecord(value, path);
    return {id: stableId(value.id, `${path}.id`, "eg"), from: stableId(value.from, `${path}.from`, "nd"), to: stableId(value.to, `${path}.to`, "nd")};
}

function parseAttributes(raw: string, path: string, offset: number, label = "伏笔标记"): Record<string, string> {
    const attributes: Record<string, string> = {};
    const pattern = /([a-z][a-z0-9-]*)\s*=\s*"([^"\\]*(?:\\.[^"\\]*)*)"/gu;
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(raw)) !== null) {
        if (raw.slice(cursor, match.index).trim() !== "") fail("INVALID_MARKER", `${label}存在无法解析的属性`, path, offset);
        const key = match[1]!;
        if (attributes[key] !== undefined) fail("DUPLICATE_ATTRIBUTE", `${label}属性重复：${key}`, path, offset);
        attributes[key] = match[2]!.replaceAll('\\"', '"');
        cursor = pattern.lastIndex;
    }
    if (raw.slice(cursor).trim() !== "") fail("INVALID_MARKER", `${label}存在无法解析的属性`, path, offset);
    return attributes;
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, any> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) fail("INVALID_OBJECT", "必须是对象", path);
}

function array(value: unknown, path: string): unknown[] {
    if (!Array.isArray(value)) fail("INVALID_ARRAY", "必须是数组", path);
    return value;
}

function parseFileRefs(value: unknown, path: string): string[] {
    const refs = array(value, path).map((item, index) => {
        const ref = nonEmptyString(item, `${path}[${index}]`);
        // 文件引用只是规划元数据；实际读取还必须经过 Workspace containment 和链接检查。
        if (ref !== ref.trim() || ref.startsWith("/") || ref.split("/").some((segment) => !segment || segment === "." || segment === ".."
            || /[\\<>:"|?*\x00-\x1f]/u.test(segment))) {
            fail("INVALID_FILE_REF", "文件引用必须是项目内的相对路径", `${path}[${index}]`);
        }
        return ref;
    });
    assertUnique(refs, path);
    return refs;
}

/** v2 参考文件禁止未知字段和空对象；只写 path 的条目等价于 v1 的历史语义。 */
function parseReferences(value: unknown, path: string): OutlineReference[] {
    const references = array(value, path).map((item, index): OutlineReference => {
        const at = `${path}[${index}]`;
        assertRecord(item, at);
        for (const key of Object.keys(item)) {
            if (key !== "path" && key !== "locator" && key !== "purpose" && key !== "pending") {
                fail("UNKNOWN_REFERENCE_FIELD", `参考文件存在未知字段：${key}`, `${at}.${key}`);
            }
        }
        const reference = {
            ...(item.path === undefined || item.path === null ? {} : {path: parseFileRefs([item.path], `${at}.path`)[0]!}),
            ...(item.locator === undefined || item.locator === null ? {} : {locator: nonEmptyString(item.locator, `${at}.locator`)}),
            ...(item.purpose === undefined || item.purpose === null ? {} : {purpose: nonEmptyString(item.purpose, `${at}.purpose`)}),
            ...(item.pending === undefined || item.pending === null ? {} : {pending: booleanValue(item.pending, `${at}.pending`)}),
        };
        if (reference.path === undefined && reference.pending !== true) fail("MISSING_REFERENCE_PATH", "非待补参考文件必须写明路径", `${at}.path`);
        if (reference.path === undefined && reference.locator === undefined) fail("MISSING_REFERENCE_LOCATOR", "无路径的待补参考文件必须用 locator 说明所需资料", `${at}.locator`);
        return reference;
    });
    assertUnique(references.flatMap(({path: referencePath}) => referencePath === undefined ? [] : [referencePath]), path);
    return references;
}

function stringValue(value: unknown, path: string): string {
    if (typeof value !== "string") fail("INVALID_STRING", "必须是字符串", path);
    return value;
}

function nonEmptyString(value: unknown, path: string): string {
    if (typeof value !== "string" || value.trim() === "") fail("INVALID_STRING", "必须是非空字符串", path);
    return value;
}

function positiveInteger(value: unknown, path: string, allowZero = false): number {
    if (typeof value !== "number" || !Number.isInteger(value) || (allowZero ? value < 0 : value <= 0)) fail("INVALID_INTEGER", "必须是合法整数", path);
    return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
    return positiveInteger(value, path, true);
}

function booleanValue(value: unknown, path: string): boolean {
    if (typeof value !== "boolean") fail("INVALID_BOOLEAN", "必须是布尔值", path);
    return value;
}

function nullableStableId(value: unknown, path: string): OutlineId | null {
    return value === null || value === undefined ? null : stableId(value, path);
}

function hashValue(value: unknown, path: string): string {
    if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) fail("INVALID_HASH", "必须是 sha256 内容 hash", path);
    return value;
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
    if (typeof value !== "string" || !allowed.includes(value)) fail("INVALID_ENUM", `值不在允许范围：${allowed.join(", ")}`, path);
    return value as T[number];
}

function assertExact(value: unknown, expected: string, path: string): void {
    if (value !== expected) fail("UNSUPPORTED_SCHEMA", `不支持的 schema：${String(value)}`, path);
}

function assertUnique(values: readonly string[], path: string): void {
    const seen = new Set<string>();
    for (const value of values) {
        if (seen.has(value)) fail("DUPLICATE_ID", `重复值：${value}`, path);
        seen.add(value);
    }
}

function fail(code: string, message: string, path?: string, offset?: number): never {
    throw new OutlineFormatError(message, [{code, message, path, offset}]);
}


