import {createOutlineRepository} from "./repository";
import {preparePlanningMaterialMutations, validateAdaptationAnchors} from "./adaptation";
import {
    contentHash,
    parseEntryMarkdown,
    parseForeshadowingMarkdown,
    parseForeshadowMarkers,
    parseGraphYaml,
    parseLineYaml,
    parseManifest,
    validateManifestAndEntries,
    validatePlanningGraphs,
    OutlineFormatError,
    type OutlineDiagnostic,
    type ForeshadowMarker,
    type Foreshadowing,
    type OutlineEntry,
    type OutlineGraph,
    type OutlineLine,
    type OutlineManifest,
} from "./format";
import type {OutlineCanonicalFile, OutlineRepositoryOptions} from "./repository";
import {
    hashText,
    publishOutlineFiles,
    OutlineTransactionError,
    type OutlineFileMutation,
    type OutlinePublishReceipt,
} from "./transaction";

export type PlanningSnapshot = Readonly<{
    manifest: OutlineManifest;
    entries: readonly Readonly<{path: string; contentHash: string; value: OutlineEntry; markers: readonly ForeshadowMarker[]}>[];
    foreshadowing: readonly Readonly<{path: string; contentHash: string; value: Foreshadowing}>[];
    graphs: readonly Readonly<{path: string; contentHash: string; value: OutlineGraph}>[];
    lines: readonly Readonly<{path: string; contentHash: string; value: OutlineLine}>[];
}>;

export type PlanningMarkerIssue = Readonly<{entryId: OutlineEntry["id"]; path: string;
    diagnostics: readonly OutlineDiagnostic[]}>;

export type PlanningPublishInput = Readonly<{
    expectedManifestRevision: number;
    mutations: readonly OutlineFileMutation[];
}>;

/** 对外原始发布只接受不绕过正式状态转换的草稿文件改动。 */
export function assertNonDestructivePlanningEdit(snapshot: PlanningSnapshot, input: PlanningPublishInput): void {
    // 正式细纲需要分析结果与输入版本绑定；当前通用文件入口不能证明这一条件。
    for (const mutation of input.mutations) {
        if (mutation.content === null || !mutation.relativePath.startsWith("outline/entries/")) continue;
        const entry = parseEntryMarkdown(mutation.content, mutation.relativePath);
        if (entry.status === "adopted") {
            throw new OutlineTransactionError("PUBLISH_FAILED", entry.kind === "detail"
                ? "细纲正式保存前必须完成偏差与冲突分析"
                : "正式采用必须使用已确认的领域操作");
        }
        throw new OutlineTransactionError("PUBLISH_FAILED", "大纲条目创建、修改与改名必须使用领域操作");
    }
    for (const mutation of input.mutations) {
        if (mutation.content === null || !mutation.relativePath.startsWith("outline/foreshadowing/")) continue;
        const next = parseForeshadowingMarkdown(mutation.content, mutation.relativePath);
        const previous = snapshot.foreshadowing.find((item) => item.value.id === next.id);
        if ((next.status === "adopted" || previous?.value.status === "adopted")
            && previous?.contentHash !== hashText(mutation.content)) {
            throw new OutlineTransactionError("PUBLISH_FAILED", "正式伏笔的确认与修改必须使用领域操作");
        }
    }
    // 线路图的锁定规则（固定线路的格号、条目与相邻连线）和线路固定都依赖领域操作校验，
    // 通用文件入口无法证明这些条件，因此只放行同字节改名。
    for (const mutation of input.mutations) {
        if (mutation.content === null) continue;
        const graph = mutation.relativePath.startsWith("outline/graphs/");
        if (!graph && !mutation.relativePath.startsWith("outline/storylines/")) continue;
        const id = graph ? parseGraphYaml(mutation.content, mutation.relativePath).id
            : parseLineYaml(mutation.content, mutation.relativePath).id;
        const previous = [...snapshot.graphs, ...snapshot.lines].find((item) => item.value.id === id);
        if (previous?.contentHash !== hashText(mutation.content)) {
            throw new OutlineTransactionError("PUBLISH_FAILED", "线路图与线路的创建和修改必须使用领域操作");
        }
    }
    const updated = input.mutations.find((mutation) => mutation.relativePath === "outline/manifest.yaml");
    if (!updated || updated.content === null) {
        if (input.mutations.some((mutation) => mutation.content === null)) {
            throw new OutlineTransactionError("PUBLISH_FAILED", "删除规划对象必须先预览并使用删除命令");
        }
        return;
    }
    const next = parseManifest(updated.content);
    const before = snapshot.manifest;
    const oldRefs = [...before.entries, ...before.foreshadowing, ...before.graphs, ...before.lines];
    const newRefs = [...next.entries, ...next.foreshadowing, ...next.graphs, ...next.lines];
    for (const mutation of input.mutations) {
        if (mutation.content !== null) continue;
        const previous = oldRefs.find((item) => item.path === mutation.relativePath);
        const renamed = previous && newRefs.find((item) => item.id === previous.id);
        const newFile = renamed && input.mutations.find((item) => item.relativePath === renamed.path);
        if (!previous || !renamed || renamed.path === previous.path || renamed.version !== previous.version
            || renamed.contentHash !== previous.contentHash || !newFile || newFile.content === null
            || hashText(newFile.content) !== previous.contentHash) {
            throw new OutlineTransactionError("PUBLISH_FAILED", "删除规划对象必须先预览并使用删除命令");
        }
    }
    if (before.plans.some((plan) => next.plans.find((item) => item.id === plan.id)?.totalId !== plan.totalId)) {
        throw new OutlineTransactionError("PUBLISH_FAILED", "方案总纲的关联、分叉与替换必须使用领域操作");
    }
    for (const key of ["entries", "foreshadowing", "graphs", "lines"] as const) {
        const retained = new Set(next[key].map((item) => item.id));
        if (before[key].some((item) => !retained.has(item.id))) {
            throw new OutlineTransactionError("PUBLISH_FAILED", "移除规划成员必须先预览删除影响");
        }
    }
    for (const plan of before.plans) {
        const updatedPlan = next.plans.find((item) => item.id === plan.id);
        if (!updatedPlan) throw new OutlineTransactionError("PUBLISH_FAILED", "移除方案需要独立确认");
        if (plan.placements.some((placement) => !updatedPlan?.placements.some((item) => item.entryId === placement.entryId))) {
            throw new OutlineTransactionError("PUBLISH_FAILED", "移除方案关系必须先预览并使用关系移除命令");
        }
    }
    if (JSON.stringify(before.plans) !== JSON.stringify(next.plans)) {
        throw new OutlineTransactionError("PUBLISH_FAILED", "方案链创建与关系修改必须使用领域操作");
    }
}

/**
 * 在文件 CAS 之外补上规划域的 manifest revision CAS。
 *
 * revision 校验与文件 staging 必须处于同一个 mutation gate 内，否则两个编辑器
 * 可能同时基于同一 manifest 生成新版本，后写入者会把前一个规划批次静默覆盖。
 */
export async function publishPlanningFiles(
    options: OutlineRepositoryOptions,
    input: PlanningPublishInput,
): Promise<OutlinePublishReceipt> {
    return publishValidatedPlanningFiles(options, input);
}

/** 受限修复只能由领域入口签发；普通发布仍从完整旧快照开始。 */
export function publishMissingEntryRepairFiles(
    options: OutlineRepositoryOptions, input: PlanningPublishInput,
    missing: OutlineManifest["entries"][number],
): Promise<OutlinePublishReceipt> {
    return publishValidatedPlanningFiles(options, input, missing);
}

/**
 * 标记修复允许旧章节正文暂时无法解析，但候选快照必须在发布前恢复为严格可读。
 * manifest/hash、front matter、线路和其它章节仍走完整校验，不扩大损坏豁免范围。
 */
export function publishForeshadowingMarkerRepairFiles(
    options: OutlineRepositoryOptions, input: PlanningPublishInput, entryPath: string,
): Promise<OutlinePublishReceipt> {
    return publishValidatedPlanningFiles(options, input, undefined, entryPath);
}

async function publishValidatedPlanningFiles(
    options: OutlineRepositoryOptions, input: PlanningPublishInput,
    missing?: OutlineManifest["entries"][number], markerRepairPath?: string,
): Promise<OutlinePublishReceipt> {
    if (!Number.isInteger(input.expectedManifestRevision) || input.expectedManifestRevision < 0) {
        throw new Error("expectedManifestRevision 必须是非负整数");
    }
    const run = async (): Promise<OutlinePublishReceipt> => {
        const repository = createOutlineRepository({...options, mutationGate: undefined});
        const files = await repository.readCanonicalFiles();
        const manifestFile = files.find((file) => file.relativePath === "outline/manifest.yaml");
        if (!manifestFile) throw new Error("缺少规划 manifest：outline/manifest.yaml");
        const current = parseManifest(manifestFile.content);
        if (current.revision !== input.expectedManifestRevision) {
            throw new OutlineTransactionError(
                "MANIFEST_REVISION_CONFLICT",
                `manifest revision 已变化：期望 ${input.expectedManifestRevision}，实际 ${current.revision}`,
            );
        }
        if (missing) {
            const actual = current.entries.filter(({path}) => !files.some((file) => file.relativePath === path));
            if (actual.length !== 1 || actual[0]?.id !== missing.id
                || actual[0]?.path !== missing.path || actual[0]?.contentHash !== missing.contentHash
                || input.mutations.some(({relativePath}) => relativePath === missing.path)) {
                throw new OutlineTransactionError("CAS_CONFLICT", "丢失条目的当前文件状态或引用已变化，请重新预览");
            }
        }
        const paths = new Set<string>();
        for (const mutation of input.mutations) {
            if (!/^outline\/(?:manifest\.yaml|entries\/[a-z0-9-]+\.md|foreshadowing\/[a-z0-9-]+\.md|graphs\/[a-z0-9-]+\.yaml|storylines\/[a-z0-9-]+\.yaml)$/u.test(mutation.relativePath)
                || paths.has(mutation.relativePath)) {
                throw new OutlineTransactionError("INVALID_PATH", `规划文件路径无效或重复：${mutation.relativePath}`);
            }
            paths.add(mutation.relativePath);
        }
        const manifestMutation = input.mutations.find((mutation) => mutation.relativePath === "outline/manifest.yaml");
        if (!manifestMutation) {
            throw new OutlineTransactionError("PUBLISH_FAILED", "规划 revision CAS 必须包含 manifest.yaml 更新");
        }
        if (manifestMutation.content === null) throw new OutlineTransactionError("PUBLISH_FAILED", "规划 manifest 不能删除");
        const next = parseManifest(manifestMutation.content, "outline/manifest.yaml");
        if (next.revision !== current.revision + 1) {
            throw new OutlineTransactionError(
                "MANIFEST_REVISION_CONFLICT",
                `新 manifest revision 必须为 ${current.revision + 1}，实际 ${next.revision}`,
            );
        }
        if (missing && next.entries.some(({id}) => id === missing.id)) {
            throw new OutlineTransactionError("PUBLISH_FAILED", "修复后 manifest 不能继续引用缺失条目");
        }
        const byPath = new Map(files.map((file) => [file.relativePath, file]));
        const mutations = input.mutations.map((mutation) => {
            const relativePath = mutation.relativePath;
            const previous = byPath.get(relativePath);
            const expectedHash = previous?.contentHash ?? null;
            if (mutation.expectedHash !== undefined && mutation.expectedHash !== expectedHash) {
                throw new OutlineTransactionError("CAS_CONFLICT", `规划文件版本已变化：${relativePath}`);
            }
            if (mutation.content === null) byPath.delete(relativePath);
            else byPath.set(relativePath, {relativePath, content: mutation.content, contentHash: hashText(mutation.content)});
            return {...mutation, expectedHash};
        });
        const candidate = parsePlanningSnapshot([...byPath.values()]);
        const previousMarkerIssues: PlanningMarkerIssue[] = [];
        const previous = parsePlanningSnapshot(files, markerRepairPath ? previousMarkerIssues : undefined,
            missing ? new Set([missing.path]) : undefined);
        if (markerRepairPath && (previousMarkerIssues.length !== 1 || previousMarkerIssues[0]?.path !== markerRepairPath)) {
            throw new OutlineTransactionError("PUBLISH_FAILED", "标记修复只允许针对预览确认的单个损坏章节");
        }
        for (const [before, after] of [
            [previous.entries, candidate.entries],
            [previous.foreshadowing, candidate.foreshadowing],
            [previous.graphs, candidate.graphs],
            [previous.lines, candidate.lines],
        ] as const) {
            const oldById = new Map(before.map((item) => [item.value.id, item]));
            for (const item of after) {
                const old = oldById.get(item.value.id);
                if (!old) continue;
                if (item.value.version < old.value.version
                    || (item.contentHash !== old.contentHash && item.value.version !== old.value.version + 1)
                    || (item.contentHash === old.contentHash && item.value.version !== old.value.version)) {
                    throw new OutlineTransactionError("CAS_CONFLICT", `规划对象版本不连续：${item.value.id}`);
                }
            }
        }
        const materialMutations = await preparePlanningMaterialMutations(options.projectRoot, previous, candidate);
        return publishOutlineFiles({...options, mutationGate: undefined,
            assertAbsentPaths: missing ? [missing.path] : undefined}, [...mutations, ...materialMutations]);
    };
    return options.mutationGate ? options.mutationGate(run) : run();
}

/** 验证撤销候选字节，而非先撤销再发现旧 manifest 引用的外部缺失文件。 */
export function assertPlanningUndoCandidate(files: readonly OutlineCanonicalFile[]): void {
    parsePlanningSnapshot(files);
}

/** 对内存中的规范文件执行与磁盘读取相同的完整校验，供领域测试与离线检查使用。 */
export function parsePlanningFiles(files: readonly OutlineCanonicalFile[]): PlanningSnapshot {
    return parsePlanningSnapshot(files);
}

/** 读取并完整校验磁盘规范文件；外部编辑不可由索引快照掩盖。 */
export async function readPlanningSnapshot(options: OutlineRepositoryOptions): Promise<PlanningSnapshot> {
    const repository = createOutlineRepository(options);
    const files = await repository.readCanonicalFiles();
    return parsePlanningSnapshot(files);
}

/** 仅用于线路失效展示：允许 manifest 中的条目文件缺失，其他文件和引用仍须通过校验。 */
export async function readLineInspectionSnapshot(options: OutlineRepositoryOptions): Promise<PlanningSnapshot> {
    const files = await createOutlineRepository(options).readCanonicalFiles();
    const manifestFile = files.find(({relativePath}) => relativePath === "outline/manifest.yaml");
    if (!manifestFile) throw new Error("缺少规划 manifest：outline/manifest.yaml");
    const manifest = parseManifest(manifestFile.content);
    const paths = new Set(files.map(({relativePath}) => relativePath));
    const missing = manifest.entries.filter(({path}) => !paths.has(path));
    if (missing.length === 0) return parsePlanningSnapshot(files);
    for (const {path} of missing) {
        if (!/^outline\/entries\/[a-z0-9][a-z0-9._-]*\.md$/iu.test(path)) {
            throw new Error(`manifest 引用文件路径不合法：${path}`);
        }
    }
    return parsePlanningSnapshot(files, undefined, new Set(missing.map(({path}) => path)));
}

/** 只读视图可以隔离单章标记损坏，领域写入仍使用严格快照并整体拒绝。 */
export async function readForeshadowingSnapshot(options: OutlineRepositoryOptions): Promise<Readonly<{
    snapshot: PlanningSnapshot; markerIssues: readonly PlanningMarkerIssue[];
}>> {
    const issues: PlanningMarkerIssue[] = [];
    const snapshot = parsePlanningSnapshot(await createOutlineRepository(options).readCanonicalFiles(), issues);
    return {snapshot, markerIssues: issues};
}

function parsePlanningSnapshot(files: readonly OutlineCanonicalFile[], markerIssues?: PlanningMarkerIssue[],
    missingEntryPaths: ReadonlySet<string> = new Set()): PlanningSnapshot {
    const manifestFile = files.find((file) => file.relativePath === "outline/manifest.yaml");
    if (!manifestFile) {
        throw new Error("缺少规划 manifest：outline/manifest.yaml");
    }
    const manifest = parseManifest(manifestFile.content);
    // 只读诊断不伪造已丢失的条目；严格快照仍对所有 manifest 引用执行完整校验。
    const readableManifest = missingEntryPaths.size === 0 ? manifest : {...manifest,
        entries: manifest.entries.filter(({path}) => !missingEntryPaths.has(path))};
    assertManifestFileHashes(readableManifest, files);
    const knownForeshadowIds = new Set(manifest.foreshadowing.map((item) => item.id));
    const entries = files
        .filter((file) => file.relativePath.startsWith("outline/entries/") && file.relativePath.endsWith(".md"))
        .map((file) => {
            const value = parseEntryMarkdown(file.content, file.relativePath);
            let markers: readonly ForeshadowMarker[];
            try {
                markers = parseForeshadowMarkers(value.body, knownForeshadowIds, file.relativePath);
            } catch (error) {
                if (!(error instanceof OutlineFormatError) || !markerIssues) throw error;
                markerIssues.push({entryId: value.id, path: file.relativePath, diagnostics: error.diagnostics});
                markers = [];
            }
            return {path: file.relativePath, contentHash: file.contentHash, value, markers};
        });
    const foreshadowing = files
        .filter((file) => file.relativePath.startsWith("outline/foreshadowing/") && file.relativePath.endsWith(".md"))
        .map((file) => ({path: file.relativePath, contentHash: file.contentHash, value: parseForeshadowingMarkdown(file.content, file.relativePath)}));
    const graphs = files
        .filter((file) => file.relativePath.startsWith("outline/graphs/") && file.relativePath.endsWith(".yaml"))
        .map((file) => ({path: file.relativePath, contentHash: file.contentHash, value: parseGraphYaml(file.content, file.relativePath)}));
    const lines = files
        .filter((file) => file.relativePath.startsWith("outline/storylines/") && file.relativePath.endsWith(".yaml"))
        .map((file) => ({path: file.relativePath, contentHash: file.contentHash, value: parseLineYaml(file.content, file.relativePath)}));

    const allIds = [entries, foreshadowing, graphs, lines].flatMap((group) => group.map((item) => item.value.id));
    if (new Set(allIds).size !== allIds.length) {
        throw new Error("规划文件中存在重复稳定 ID");
    }
    const missingEntryIds = new Set(manifest.entries.filter(({path}) => missingEntryPaths.has(path)).map(({id}) => id));
    // 只豁免诊断读取时已确定丢失的对象；方案树与现存条目仍须通过完整校验。
    validateManifestAndEntries(manifest, entries.map((item) => item.value), "outline", missingEntryIds);
    validateAdaptationAnchors(manifest, entries.map((item) => item.value));
    validatePlanningGraphs(graphs.map((item) => item.value), lines.map((item) => item.value), manifest.plans,
        new Map(entries.map((item) => [item.value.id, item.value.kind])));
    for (const entry of entries) {
        if (entry.markers.length > 0 && entry.value.kind !== "chapter") throw new Error(`伏笔正式标记只能属于章节大纲：${entry.value.id}`);
    }
    assertManifestMembers(readableManifest, entries, foreshadowing, graphs, lines);
    return {manifest, entries, foreshadowing, graphs, lines};
}

function assertManifestFileHashes(manifest: OutlineManifest, files: readonly Readonly<{relativePath: string; contentHash: string}>[]): void {
    const byPath = new Map(files.map((file) => [file.relativePath, file]));
    for (const reference of [...manifest.entries, ...manifest.foreshadowing, ...manifest.graphs, ...manifest.lines]) {
        const file = byPath.get(reference.path);
        if (!file) throw new Error(`manifest 引用文件不存在：${reference.path}`);
        if (file.contentHash !== reference.contentHash) throw new Error(`规划文件 hash 与 manifest 不一致：${reference.path}`);
    }
}

function assertManifestMembers(
    manifest: OutlineManifest,
    entries: readonly Readonly<{path: string; contentHash: string; value: OutlineEntry}>[],
    foreshadowing: readonly Readonly<{path: string; contentHash: string; value: Foreshadowing}>[],
    graphs: readonly Readonly<{path: string; contentHash: string; value: OutlineGraph}>[],
    lines: readonly Readonly<{path: string; contentHash: string; value: OutlineLine}>[],
): void {
    const groups = [
        [manifest.entries, entries],
        [manifest.foreshadowing, foreshadowing],
        [manifest.graphs, graphs],
        [manifest.lines, lines],
    ] as const;
    for (const [references, actual] of groups) {
        if (references.length !== actual.length) throw new Error("manifest 与规范文件数量不一致");
        const actualById = new Map(actual.map((item) => [item.value.id, item]));
        for (const reference of references) {
            const item = actualById.get(reference.id);
            if (!item || item.path !== reference.path || item.value.version !== reference.version) {
                throw new Error(`manifest 与规范文件元数据不一致：${reference.id}`);
            }
        }
    }
}

export {createOutlineRepository} from "./repository";
export {
    OutlineFormatError,
    contentHash,
    createStableId,
    parseEntryMarkdown,
    parseForeshadowMarkers,
    parseForeshadowingMarkdown,
    parseGraphYaml,
    parseLineYaml,
    parseManifest,
    resolveLineChain,
    serializeEntryMarkdown,
    serializeForeshadowingMarkdown,
    serializeGraphYaml,
    serializeLineYaml,
    serializeYaml,
    slugify,
    stableFileName,
    stableId,
    validateGraph,
    validateLine,
    validateManifestAndEntries,
    validatePlanningGraphs,
} from "./format";
export {
    hashText,
    publishOutlineFiles,
    recoverOutlineTransactions,
    readOutlineTransactionJournal,
    undoOutlineTransaction,
    OutlineTransactionError,
} from "./transaction";
