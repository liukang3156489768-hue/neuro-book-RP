import fs from "node:fs/promises";
import path from "node:path";
import {Type, type Static} from "typebox";
import {Value} from "typebox/value";
import {recordContextAccess} from "nbook/server/agent/context-access/profile-context-access";
import {normalizeToolResultDetails} from "nbook/server/agent/messages/message-utils";
import {runReadyProjectOperation} from "nbook/server/workspace-files/project-session";
import {parseMarkdownDocument} from "nbook/server/workspace-files/workspace-files";
import {readPlanningSnapshot} from "nbook/server/outline/index";
import {prepareReadyAdaptationWorkspace} from "nbook/server/outline/host";
import {resolveLorebookFile} from "nbook/server/inspiration/lorebook-path";
import {absoluteFsPath} from "nbook/server/runtime/paths/file-path";
import type {NeuroAgentTool, ToolExecutionContext} from "./types";

const PlanId = Type.String({pattern: "^plan-[a-z0-9][a-z0-9-]*$"});
const ListSchema = Type.Object({
    category: Type.Optional(Type.Union([Type.Literal("character"), Type.Literal("item"), Type.Literal("location"), Type.Literal("note")])),
    query: Type.Optional(Type.String({maxLength: 100})),
    planId: Type.Optional(PlanId),
    offset: Type.Optional(Type.Integer({minimum: 0})),
    limit: Type.Optional(Type.Integer({minimum: 1, maximum: 50})),
}, {additionalProperties: false});
const ReadSchema = Type.Object({
    path: Type.String({minLength: 1}),
    planId: Type.Optional(PlanId),
    offset: Type.Optional(Type.Integer({minimum: 0, description: "正文字符偏移，从0开始；继续读取使用 nextOffset。"})),
    limit: Type.Optional(Type.Integer({minimum: 1, maximum: 24000})),
}, {additionalProperties: false});
const InspectSchema = Type.Object({
    planId: Type.Optional(PlanId),
}, {additionalProperties: false});
const PrepareAdaptationSchema = Type.Object({
    sourcePlanId: PlanId,
    title: Type.Optional(Type.String({minLength: 1, maxLength: 200})),
    source: Type.Optional(Type.Union([
        Type.Object({kind: Type.Literal("chapter"), sourcePlanId: PlanId, sourceEntryId: Type.String({minLength: 1})}, {additionalProperties: false}),
        Type.Object({kind: Type.Literal("between"), sourcePlanId: PlanId, beforeEntryId: Type.String({minLength: 1}), afterEntryId: Type.String({minLength: 1})}, {additionalProperties: false}),
    ])),
}, {additionalProperties: false});
const INDEX_PATHS = ["lorebook/note/写作手法索引.md", "lorebook/note/写作素材索引.md"] as const;
const ADAPTED_DIRECTORIES = ["改编中的新经历", "改编中的新人际关系", "改编中的内容"] as const;

/** 目录用于发现对象，笔记只暴露索引入口；正文必须由模型明确选择后分页读取。 */
export function createPlanningMaterialTools(): NeuroAgentTool[] {
    return [
        {
            key: "prepare_adaptation_workspace", name: "prepare_adaptation_workspace", label: "创建改编方案起点",
            description: "校验提取来源并一次创建改编方案、总纲、第一卷和第一章；基础素材不覆盖，后续变化写入当前方案改编记录。",
            parameters: PrepareAdaptationSchema, executionMode: "sequential", mutatesWorkspace: true, approvalConditional: true,
            requiresApproval: ({agentMode}) => agentMode !== "normal",
            async executeWithContext(context, _id, raw) {
                const input = parse(PrepareAdaptationSchema, raw);
                const project = requireProject(context);
                const result = await prepareReadyAdaptationWorkspace(project, input as never, {kind: "agent", sessionId: String(context.sessionId)});
                return {content: [{type: "text" as const, text: JSON.stringify(result)}], details: result};
            },
        },
        {
            key: "inspect_planning_material_requirements", name: "inspect_planning_material_requirements", label: "检查规划素材类别",
            description: "只检查当前 Project lorebook 中各类素材是否有文件，不读取正文；同时返回可作为改编来源的提取方案。原创与改编开始前都应先使用。",
            parameters: InspectSchema, executionMode: "parallel", mutatesWorkspace: false,
            async executeWithContext(context, _id, raw) {
                const input = parse(InspectSchema, raw ?? {});
                return withProject(context, async (root) => {
                    await assertPlan(root, input.planId);
                    const categories = ["character", "item", "faction", "world", "location", "system", "instruction", "note"] as const;
                    const materials = Object.fromEntries(await Promise.all(categories.map(async (category) => {
                        const entries = await directoryEntries(root, `lorebook/${category}`);
                        const files = entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".md"));
                        const directories = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
                        return [category, {exists: files.length > 0 || directories.length > 0, fileCount: files.length, objectCount: directories.length}] as const;
                    })));
                    const snapshot = await readPlanningSnapshot({projectRoot: root});
                    const extractionPlans = snapshot.manifest.plans
                        .filter((plan) => snapshot.manifest.entries.some((ref) => {
                            const entry = snapshot.entries.find((item) => item.value.id === ref.id)?.value;
                            return entry?.basis?.kind === "source-extraction" && plan.placements.some((place) => place.entryId === entry.id);
                        }))
                        .map((plan) => ({id: plan.id, title: plan.title}));
                    return {categories, materials, extractionPlans, requestedPlanId: input.planId ?? null};
                });
            },
        },
        {
            key: "list_planning_materials", name: "list_planning_materials", label: "查找规划素材",
            description: "分页列出已有角色、物品、地点的主文件及相关文件路径，不加载正文。两类笔记只列索引入口：先读取索引再选具体文档。指定 planId 时仅列该方案的改编记录；query 按对象目录或文件名称筛选。大纲来源方案用 get_planning_context 查找。",
            parameters: ListSchema, executionMode: "parallel", mutatesWorkspace: false,
            async executeWithContext(context, _id, raw) {
                const input = parse(ListSchema, raw ?? {});
                return withProject(context, async (root) => {
                    await assertPlan(root, input.planId);
                    const indexes: string[] = [];
                    for (const index of INDEX_PATHS) if (await existingFile(root, index)) indexes.push(index);
                    const candidates: string[] = [];
                    for (const category of input.category === "note" ? [] : input.category ? [input.category] : ["character", "item", "location"]) {
                        const directory = `lorebook/${category}`;
                        const entries = await directoryEntries(root, directory);
                        for (const entry of entries) {
                            if (entry.isSymbolicLink()) continue;
                            const requested = `${directory}/${entry.name}`;
                            if (!entry.isDirectory() && !entry.name.endsWith(".md")) continue;
                            const resolved = await resolveLorebookFile(absoluteFsPath(root), requested).catch(() => null);
                            if (resolved === null) continue;
                            if (input.query && !entry.name.toLocaleLowerCase().includes(input.query.toLocaleLowerCase())) continue;
                            candidates.push(resolved.canonicalPath);
                        }
                    }
                    candidates.sort((a, b) => a.localeCompare(b, "zh-CN"));
                    const offset = input.offset ?? 0;
                    const selected = candidates.slice(offset, offset + (input.limit ?? 20));
                    const items = [];
                    for (const file of selected) {
                        const resolved = await resolveLorebookFile(absoluteFsPath(root), file);
                        const related: string[] = [];
                        if (file.endsWith("/index.md")) {
                            const base = file.slice(0, -"/index.md".length);
                            if (file.startsWith("lorebook/character/")) {
                                for (const child of ["original/experience.md", "original/relationships.md", "original/state.md"]) {
                                    const relatedPath = `${base}/${child}`;
                                    if (await existingFile(root, relatedPath)) related.push(relatedPath);
                                }
                                if (input.planId) {
                                    const folder = `${base}/plans/${input.planId}`;
                                    for (const entry of await directoryEntries(root, folder)) {
                                        if (entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".md")) related.push(`${folder}/${entry.name}`);
                                    }
                                }
                            }
                            if (input.planId && !file.startsWith("lorebook/character/")) for (const directory of ADAPTED_DIRECTORIES) {
                                const folder = `${base}/${directory}/${input.planId}`;
                                for (const entry of await directoryEntries(root, folder)) {
                                    if (entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".md")) related.push(`${folder}/${entry.name}`);
                                }
                            }
                        }
                        const metadata = file.endsWith("/index.md")
                            ? parseMarkdownDocument(await fs.readFile(resolved.absolutePath, "utf8")).frontmatter
                            : undefined;
                        const displayName = typeof metadata?.title === "string" && metadata.title.trim()
                            ? metadata.title.trim()
                            : path.posix.basename(file.endsWith("/index.md") ? path.posix.dirname(file) : file, ".md");
                        items.push({path: file, name: displayName, related});
                    }
                    return {items, indexes, missingIndexes: INDEX_PATHS.filter(index => !indexes.includes(index)), total: candidates.length,
                        nextOffset: offset + selected.length < candidates.length ? offset + selected.length : null};
                });
            },
        },
        {
            key: "read_planning_material", name: "read_planning_material", label: "读取所选规划素材",
            description: "读取一份当前项目 lorebook 素材的正文，默认最多12000字符，使用 nextOffset 继续。不读 outline 原始文件。两类笔记先读索引，再按索引真实路径读所需正文；角色按需读基础、经历和关系。改编目录必须指定匹配的 planId，不能混入其他方案。",
            parameters: ReadSchema, executionMode: "parallel", mutatesWorkspace: false,
            async executeWithContext(context, _id, raw) {
                const input = parse(ReadSchema, raw);
                return withProject(context, async (root) => {
                    assertMaterialPath(input.path, input.planId);
                    await assertPlan(root, input.planId);
                    const resolved = await resolveLorebookFile(absoluteFsPath(root), input.path);
                    const document = parseMarkdownDocument(await fs.readFile(resolved.absolutePath, "utf8"));
                    const offset = input.offset ?? 0;
                    if (offset > document.body.length) throw new Error("正文偏移超出范围，请重新读取");
                    const end = Math.min(document.body.length, offset + (input.limit ?? 12000));
                    try {
                        await recordContextAccess({project: requireProject(context), profileKey: context.profileKey,
                            sessionId: String(context.sessionId), filePath: resolved.canonicalPath});
                    } catch {
                        // 访问推荐是辅助状态，不能使已经读取的素材无法返回。
                    }
                    return {path: resolved.canonicalPath, requestedPath: input.path, title: document.frontmatter.title ?? null, origin: document.frontmatter.origin ?? null,
                        offset, nextOffset: end < document.body.length ? end : null, complete: offset === 0 && end === document.body.length,
                        totalCharacters: document.body.length, body: document.body.slice(offset, end)};
                });
            },
        },
    ];
}

function parse<T extends import("typebox").TSchema>(schema: T, value: unknown): Static<T> {
    if (!Value.Check(schema, value)) throw new Error("规划素材工具参数无效");
    return value as Static<T>;
}

function requireProject(context: ToolExecutionContext) {
    if (!context.currentProject) throw new Error("规划素材工具必须绑定当前 ready Project");
    return context.currentProject;
}

async function withProject(context: ToolExecutionContext, operation: (root: string) => Promise<unknown>) {
    const project = requireProject(context);
    return runReadyProjectOperation(project, async (_signal, assertTarget, revalidateTarget) => {
        await revalidateTarget();
        assertTarget();
        const data = await operation(project.workspace.root);
        await revalidateTarget();
        assertTarget();
        const details = normalizeToolResultDetails(data);
        return {content: [{type: "text" as const, text: JSON.stringify(details)}], details};
    });
}

async function assertPlan(root: string, planId?: string) {
    if (planId && !(await readPlanningSnapshot({projectRoot: root})).manifest.plans.some(plan => plan.id === planId)) {
        throw new Error("目标大纲方案不存在");
    }
}

function assertMaterialPath(file: string, planId?: string) {
    if (!/^lorebook\/(?:character|item|location|note|faction|system|instruction|world)\/.+$/u.test(file)) {
        throw new Error("只能读取当前项目 lorebook 下的素材 Markdown");
    }
    const segments = file.split("/");
    const adaptedIndex = segments.findIndex(segment => (ADAPTED_DIRECTORIES as readonly string[]).includes(segment));
    if (adaptedIndex >= 0 && (!planId || segments[adaptedIndex + 1] !== planId)) throw new Error("读取改编记录必须指定对应的 planId");
    const plansIndex = segments.indexOf("plans");
    if (plansIndex >= 0 && (!planId || segments[plansIndex + 1] !== planId)) throw new Error("读取改编记录必须指定对应的 planId");
}

async function safePath(root: string, relative: string) {
    if (relative.includes("\\") || relative.split("/").some(segment => !segment || segment === "." || segment === ".." || segment.includes(":"))) {
        throw new Error("素材路径无效");
    }
    let current = root;
    for (const segment of relative.split("/")) {
        current = path.join(current, segment);
        const metadata = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
        });
        if (metadata?.isSymbolicLink()) throw new Error("素材路径不能经过符号链接");
    }
    return current;
}

async function existingFile(root: string, relative: string) {
    const target = await safePath(root, relative);
    return fs.stat(target).then(metadata => metadata.isFile(), (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
    });
}

async function directoryEntries(root: string, relative: string) {
    return fs.readdir(await safePath(root, relative), {withFileTypes: true}).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
    });
}
