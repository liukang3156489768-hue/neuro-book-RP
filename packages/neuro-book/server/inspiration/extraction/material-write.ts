import {randomUUID} from "node:crypto";
import {createHash} from "node:crypto";
import type {OperationActor} from "@notnotype/nb-history";
import {MATERIAL_TEMPLATES, type MaterialParagraphReference} from "nbook/shared/dto/inspiration-material.dto";
import type {ExtractionSourceRef} from "nbook/shared/dto/inspiration-extraction-task.dto";
import {readWorkspaceContentOrigin} from "nbook/server/workspace-files/content-node-schema";
import {withProjectTargetMutation, type ProjectDataPlaneHandles} from "nbook/server/workspace-files/project-open-guard";
import type {WorkspaceFileTarget} from "nbook/server/workspace-files/workspace-file-target";
import {parseMarkdownDocument, readWorkspaceTextFile, renderMarkdownDocument, workspacePathExists} from "nbook/server/workspace-files/workspace-files";
import {USER_LOCAL_ACTOR, createWorkspaceFileTracked, writeWorkspaceTextFileTracked} from "nbook/server/workspace-history/tracked-workspace-files";
import {
    buildExtractedMaterialFrontmatter, parseParagraphReferences, renderMaterialBody, restoreParagraphReferences,
    type MaterialParagraph,
} from "../material-template";
import {prepareInspirationSource} from "../source";
import {ExtractionTaskError} from "./errors";
import {
    CHARACTER_SUBNODE_ROLES, SUBNODE_TEMPLATE_KIND, materialCategorySpec, mergeCitations, toFolderName,
    type MaterialCategorySpec, type MaterialNode, type MaterialNodeRole,
} from "./material-data";
import type {MaterialReview, ReviewItem} from "./material-review";
import type {MaterialNoteIndex} from "./material-note-index";
import {writePublishedNoteIndex} from "./material-note-index-write";

/**
 * 确认写入：把待写入清单里勾选的条目批量写入 `lorebook/`。
 *
 * 写入的约束都在这里集中：
 * - 经项目 mutation gate 与记账写入（用户或 Agent 归因），不绕过工作区文件服务；
 * - 与已有条目同路径但内容不同视为同名冲突，必须有逐条决定（覆盖／另存为／跳过）才会继续；
 * - Agent 确认不能覆盖用户设计的条目（`origin` 缺失或为 `design`）；
 * - 部分失败逐条报告，已成功的节点不回滚也不会再次写入。
 */

export type Confirmer = Readonly<{kind: "user"}> | Readonly<{kind: "agent"; sessionId: string}>;

export type ConflictDecision = Readonly<{
    itemId: string;
    action: "overwrite" | "save-as" | "skip";
    /** 另存为的新名称；缺省时自动生成“名称（提取）”并避开已有条目。 */
    saveAsName?: string;
}>;

/** 一个冲突节点的对照数据，供界面并排展示后让用户选择。 */
export type ConflictComparison = Readonly<{
    itemId: string;
    title: string;
    role: MaterialNodeRole | "state";
    path: string;
    existing: Readonly<{content: string; origin: "design" | "extract"}>;
    incoming: string;
    /** 当前确认者能否覆盖：Agent 不能覆盖用户设计的条目。 */
    overwriteAllowed: boolean;
}>;

export type ItemOutcome = Readonly<{
    itemId: string;
    title: string;
    status: "written" | "skipped" | "failed" | "conflict";
    /** failed 时的原因；其余为 null。 */
    error: string | null;
    /** 本次实际创建或覆盖的文件。 */
    paths: readonly string[];
}>;

export type WriteReport = Readonly<{
    review: MaterialReview;
    outcomes: readonly ItemOutcome[];
    /** 等待决定的冲突；界面据此弹出对照确认，再带着 decisions 重新确认。 */
    conflicts: readonly ConflictComparison[];
    indexPaths: readonly string[];
}>;

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

type RenderedRole = MaterialNodeRole | "state";
type RenderedFile = Readonly<{role: RenderedRole; path: string; content: string}>;

const ROLE_LABEL = {experience: "角色经历", relationship: "人际关系"} as const;

function expandReference(value: string, paragraphs: readonly MaterialParagraph[]): string {
    const {references, errors} = parseParagraphReferences(value);
    if (errors.length) throw new RangeError(`参考片段格式无效：${errors.join("；")}`);
    return restoreParagraphReferences(references, paragraphs)
        .map(fragment => `> ${fragment.label}\n${fragment.text.split(/\r?\n/u).map(line => `> ${line}`).join("\n")}`).join("\n\n");
}

/** 沿用原创设计模板的类别：每个非空字段一个二级标题，“参考片段”展开为原文引用。 */
function renderStandardBody(spec: MaterialCategorySpec, fields: Readonly<Record<string, string>>, paragraphs: readonly MaterialParagraph[]): string {
    return spec.fields.filter(label => fields[label]?.trim()).map(label => {
        const value = label === spec.referenceField ? expandReference(fields[label]!.trim(), paragraphs) : fields[label]!.trim();
        return `## ${label}\n\n${value}`;
    }).join("\n\n");
}

function nodeCitations(item: ReviewItem, node: MaterialNode): MaterialParagraphReference[] {
    const own = mergeCitations(node.citations);
    const citations = own.length ? own : mergeCitations(item.nodes.flatMap(candidate => candidate.citations));
    if (!citations.length) throw new RangeError("条目没有任何 P 引用，无法标注来源");
    if (citations.length > 500) throw new RangeError(`来源引用超过 500 段（${citations.length}），请拆分条目`);
    return citations;
}

function splitList(value: string | undefined): string[] {
    return value ? value.split(/[、,，\n]/u).map(item => item.trim()).filter(Boolean) : [];
}

/** 角色页直接消费 ext.character.profile；正文保留简短摘要，避免只写 Markdown 标题却无法被角色服务读取。 */
function characterProfileFrontmatter(item: ReviewItem, frontmatter: Record<string, unknown>): Record<string, unknown> {
    const fields = item.nodes.find(node => node.role === "main")?.entries[0]?.fields ?? {};
    const ext = typeof frontmatter.ext === "object" && frontmatter.ext !== null && !Array.isArray(frontmatter.ext) ? frontmatter.ext as Record<string, unknown> : {};
    const character = typeof ext.character === "object" && ext.character !== null && !Array.isArray(ext.character) ? ext.character as Record<string, unknown> : {};
    return {
        ...frontmatter,
        id: item.stableId ?? item.directoryName,
        title: item.title,
        aliases: item.aliases,
        tags: splitList(fields["标签"]),
        summary: fields["摘要"] ?? "",
        ext: {
            ...ext,
            character: {
                ...character,
                profile: {
                    identity: fields["基本身份"] ?? "",
                    appearance: fields["外貌"] ?? "",
                    clothing: fields["穿着"] ?? "",
                    family: fields["家庭情况"] ?? "",
                    economy: fields["经济情况"] ?? "",
                    abilities: fields["特殊能力"] ?? "",
                    personality: fields["性格"] ?? "",
                    temperament: fields["性格描述"] ?? "",
                },
            },
        },
    };
}

function emptyCharacterStateFrontmatter(source: ReturnType<typeof buildExtractedMaterialFrontmatter>): Record<string, unknown> {
    return {...source, kind: "state", state: {chapter: "", location: "", items: "", psychology: ""}};
}

function characterFacetRecords(kind: "experience" | "relationship", entries: readonly Readonly<Record<string, string>>[], filePath: string): Array<Record<string, string>> {
    return entries.map((fields, index) => {
        const title = fields[kind === "relationship" ? "关联角色" : "阶段名称"] ?? `第 ${index + 1} 条`;
        const content = fields[kind === "relationship" ? "关系描述" : "经历描述"] ?? "";
        const source = fields["参考片段"] ?? "";
        const id = createHash("sha256").update(`${filePath}\n${index}\n${title}\n${content}`, "utf8").digest("hex").slice(0, 24);
        return {id, title, content, source, targetId: kind === "relationship" ? fields["关联角色"] ?? "" : "", unknown: "", misunderstanding: ""};
    });
}

function renderNode(item: ReviewItem, spec: MaterialCategorySpec, node: MaterialNode, title: string, dirName: string, source: ExtractionSourceRef, paragraphs: readonly MaterialParagraph[]): RenderedFile {
    const base = `${spec.directory}${dirName}`;
    const citations = nodeCitations(item, node);
    const extraction = {sourcePath: source.path, sha256: source.sha256, citations};
    if (node.role === "main") {
        const kind = spec.templateKind;
        const body = kind
            ? renderMaterialBody(kind, node.entries.map(entry => entry.fields), paragraphs)
            : renderStandardBody(spec, node.entries[0]!.fields, paragraphs);
        const metadata = kind ? MATERIAL_TEMPLATES[kind].node : {type: spec.key, subtype: undefined};
        let frontmatter = buildExtractedMaterialFrontmatter({title, type: metadata.type, subtype: metadata.subtype, source: extraction});
        frontmatter.aliases = item.aliases;
        if (spec.key === "character") frontmatter = characterProfileFrontmatter(item, frontmatter);
        return {role: "main", path: `${base}/index.md`, content: renderMarkdownDocument(frontmatter, body)};
    }
    const kind = SUBNODE_TEMPLATE_KIND[node.role];
    const metadata = MATERIAL_TEMPLATES[kind].node;
    const renderedPath = spec.key === "character"
        ? `${base}/original/${node.role === "relationship" ? "relationships" : "experience"}.md`
        : `${base}/${node.role}/index.md`;
    const frontmatter = {
        ...buildExtractedMaterialFrontmatter({title: `${title}的${ROLE_LABEL[node.role]}`, type: metadata.type, subtype: metadata.subtype, source: extraction}),
        ...(spec.key === "character" ? {records: characterFacetRecords(node.role, node.entries.map(entry => entry.fields), renderedPath)} : {}),
    };
    return {role: node.role, path: renderedPath, content: renderMarkdownDocument(frontmatter, renderMaterialBody(kind, node.entries.map(entry => entry.fields), paragraphs))};
}

/** 主文件在前、子节点在后；渲染失败（引用缺失等）抛带条目名的错误，由调用方转成该条目失败。 */
function renderItem(item: ReviewItem, title: string, dirName: string, source: ExtractionSourceRef, paragraphs: readonly MaterialParagraph[]): RenderedFile[] {
    const spec = materialCategorySpec(item.category);
    const order: MaterialNodeRole[] = ["main", ...CHARACTER_SUBNODE_ROLES];
    const files = order.flatMap(role => item.nodes.filter(node => node.role === role)).map(node => {
        try {
            return renderNode(item, spec, node, title, dirName, source, paragraphs);
        } catch (error) {
            throw new Error(`“${title}”的${node.role === "main" ? spec.label : ROLE_LABEL[node.role]}无法生成：${error instanceof Error ? error.message : String(error)}`);
        }
    });
    if (spec.key === "character") {
        const stateSource = buildExtractedMaterialFrontmatter({title: `${title}的正文状态`, type: "character", subtype: "state", source: {sourcePath: source.path, sha256: source.sha256, citations: mergeCitations(item.nodes.flatMap(node => node.citations))}});
        files.push({role: "state", path: `${spec.directory}${dirName}/original/state.md`, content: renderMarkdownDocument(emptyCharacterStateFrontmatter(stateSource), "# 正文状态追踪\n\n")});
    }
    return files;
}

// ---------------------------------------------------------------------------
// 来源与现状
// ---------------------------------------------------------------------------

/** 写入时重新读取来源并核对哈希：还原的原文必须是提取时依据的那份。 */
async function loadParagraphs(target: WorkspaceFileTarget, source: ExtractionSourceRef): Promise<MaterialParagraph[]> {
    const prepared = await prepareInspirationSource(target.root, source.path);
    if (prepared.source.sha256 !== source.sha256) {
        throw new ExtractionTaskError("SOURCE_CHANGED", `作品「${source.path}」的内容已变化，无法还原参考片段，不写入`);
    }
    return prepared.paragraphs.map(paragraph => ({id: paragraph.id, text: paragraph.text}));
}

type FileState =
    | {kind: "absent"}
    | {kind: "same"}
    | {kind: "different"; content: string; origin: "design" | "extract"};

async function inspectFile(target: WorkspaceFileTarget, file: RenderedFile): Promise<FileState> {
    if (!await workspacePathExists(target.root, file.path)) return {kind: "absent"};
    const content = await readWorkspaceTextFile(target.root, file.path);
    // 内容逐字相同说明是上一次写入已成功而台账没来得及保存，按已写入处理，不重复写。
    if (content === file.content) return {kind: "same"};
    return {kind: "different", content, origin: readWorkspaceContentOrigin(parseMarkdownDocument(content).frontmatter as Record<string, unknown>)};
}

/** 同目录内已被清单其他条目占用的目录名（不区分大小写）。 */
function takenDirectoryNames(review: MaterialReview, spec: MaterialCategorySpec, exceptId: string): Set<string> {
    return new Set(review.items.filter(item => item.id !== exceptId && materialCategorySpec(item.category).directory === spec.directory).map(item => item.directoryName.toLowerCase()));
}

async function pickSaveAsName(target: WorkspaceFileTarget, review: MaterialReview, item: ReviewItem, requested: string | undefined): Promise<{title: string; dirName: string; stableId?: string}> {
    const spec = materialCategorySpec(item.category);
    const taken = takenDirectoryNames(review, spec, item.id);
    const free = async (dirName: string) => !taken.has(dirName.toLowerCase()) && !await workspacePathExists(target.root, `${spec.directory}${dirName}/index.md`);
    if (requested !== undefined) {
        const title = requested.trim();
        const dirName = toFolderName(title);
        if (!dirName) throw new Error(`另存为的名称“${requested}”不能用作目录名`);
        if (item.category !== "character") {
            if (!await free(dirName)) throw new Error(`另存为的名称“${title}”已被占用，请换一个名称`);
            return {title, dirName};
        }
        let stableId = randomUUID();
        while (!await free(stableId)) stableId = randomUUID();
        return {title, dirName: stableId, stableId};
    }
    for (let attempt = 1; attempt < 1000; attempt += 1) {
        const title = `${item.title}（提取${attempt === 1 ? "" : attempt}）`;
        const dirName = toFolderName(title);
        if (dirName && item.category !== "character" && await free(dirName)) return {title, dirName};
        if (item.category === "character") {
            let stableId = randomUUID();
            while (!await free(stableId)) stableId = randomUUID();
            return {title, dirName: stableId, stableId};
        }
    }
    throw new Error(`无法为“${item.title}”生成可用的另存为名称`);
}

// ---------------------------------------------------------------------------
// 冲突预览
// ---------------------------------------------------------------------------

function canOverwrite(confirmer: Confirmer, origin: "design" | "extract"): boolean {
    return confirmer.kind === "user" || origin === "extract";
}

/** 勾选条目中与现有内容冲突的节点，附带对照数据。不写入任何文件。 */
export async function previewConflicts(input: Readonly<{target: WorkspaceFileTarget; review: MaterialReview; source: ExtractionSourceRef; confirmer: Confirmer}>): Promise<ConflictComparison[]> {
    const paragraphs = await loadParagraphs(input.target, input.source);
    const conflicts: ConflictComparison[] = [];
    for (const item of input.review.items) {
        if (!item.selected || item.write.status === "written") continue;
        let files: RenderedFile[];
        try {
            files = renderItem(item, item.title, item.directoryName, input.source, paragraphs);
        } catch {
            continue; // 无法渲染的条目在确认写入时报告失败原因，预览只关心冲突。
        }
        for (const file of files) {
            if (item.write.writtenRoles.includes(file.role)) continue;
            const state = await inspectFile(input.target, file);
            if (state.kind === "different") {
                conflicts.push({
                    itemId: item.id, title: item.title, role: file.role, path: file.path, incoming: file.content,
                    existing: {content: state.content, origin: state.origin}, overwriteAllowed: canOverwrite(input.confirmer, state.origin),
                });
            }
        }
    }
    return conflicts;
}

// ---------------------------------------------------------------------------
// 确认写入
// ---------------------------------------------------------------------------

function actorOf(confirmer: Confirmer): OperationActor {
    return confirmer.kind === "user" ? USER_LOCAL_ACTOR : {kind: "agent", sessionId: confirmer.sessionId};
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function writeOneItem(
    input: Readonly<{target: WorkspaceFileTarget; handles: ProjectDataPlaneHandles | undefined; source: ExtractionSourceRef; paragraphs: readonly MaterialParagraph[]; confirmer: Confirmer}>,
    review: MaterialReview,
    item: ReviewItem,
    decision: ConflictDecision | undefined,
): Promise<{item: ReviewItem; outcome: ItemOutcome; conflicts: ConflictComparison[]}> {
    const result = (next: ReviewItem, status: ItemOutcome["status"], error: string | null, paths: readonly string[] = [], conflicts: ConflictComparison[] = []) => ({
        item: next, outcome: {itemId: item.id, title: next.title, status, error, paths}, conflicts,
    });
    let current = item;
    let files: RenderedFile[];
    try {
        files = renderItem(current, current.title, current.directoryName, input.source, input.paragraphs);
    } catch (error) {
        return result({...current, write: {...current.write, status: "failed", error: messageOf(error)}}, "failed", messageOf(error));
    }

    // 先看现状：哪些节点还没写、哪些与现有内容冲突。
    const pending = files.filter(file => !current.write.writtenRoles.includes(file.role));
    const states = new Map<RenderedFile, FileState>();
    for (const file of pending) states.set(file, await inspectFile(input.target, file));
    const conflicting = pending.filter(file => states.get(file)!.kind === "different");

    if (conflicting.length) {
        const comparisons = conflicting.map((file): ConflictComparison => {
            const state = states.get(file) as Extract<FileState, {kind: "different"}>;
            return {
                itemId: item.id, title: current.title, role: file.role, path: file.path, incoming: file.content,
                existing: {content: state.content, origin: state.origin}, overwriteAllowed: canOverwrite(input.confirmer, state.origin),
            };
        });
        if (!decision) return result(current, "conflict", null, [], comparisons);
        if (decision.action === "skip") return result({...current, write: {...current.write, status: "skipped", error: null}}, "skipped", null);
        if (decision.action === "overwrite") {
            const forbidden = comparisons.find(comparison => !comparison.overwriteAllowed);
            if (forbidden) {
                const error = `“${current.title}”与用户设计的条目同名（${forbidden.path}），Agent 不能覆盖，请改用另存为或跳过`;
                return result({...current, write: {...current.write, status: "failed", error}}, "failed", error);
            }
        } else {
            // 另存为：换一个名称整体重新渲染，原条目保持不动。
            try {
                const renamed = await pickSaveAsName(input.target, review, current, decision.saveAsName);
                current = {
                    ...current,
                    title: renamed.title,
                    directoryName: renamed.dirName,
                    ...(renamed.stableId ? {stableId: renamed.stableId} : {}),
                    write: {...current.write, savedAs: renamed.title, writtenRoles: []},
                };
                files = renderItem(current, current.title, current.directoryName, input.source, input.paragraphs);
                for (const file of files) states.set(file, await inspectFile(input.target, file));
            } catch (error) {
                return result({...current, write: {...current.write, status: "failed", error: messageOf(error)}}, "failed", messageOf(error));
            }
        }
    }

    const writtenRoles = [...current.write.writtenRoles];
    const paths: string[] = [];
    const actor = actorOf(input.confirmer);
    for (const file of files) {
        if (writtenRoles.includes(file.role)) continue;
        const state = states.get(file) ?? await inspectFile(input.target, file);
        try {
            if (state.kind === "absent") {
                await createWorkspaceFileTracked({target: input.target, history: input.handles?.history, filePath: file.path, content: file.content, actor});
                paths.push(file.path);
            } else if (state.kind === "different") {
                await writeWorkspaceTextFileTracked({target: input.target, history: input.handles?.history, filePath: file.path, content: file.content, actor, knownBefore: state.content});
                paths.push(file.path);
            }
            writtenRoles.push(file.role);
        } catch (error) {
            // 已成功的节点保留并记入台账，下次确认只补写这一个及其后的节点。
            const message = `写入 ${file.path} 失败：${messageOf(error)}`;
            return result({...current, write: {...current.write, status: "failed", error: message, writtenRoles}}, "failed", message, paths);
        }
    }
    return result({...current, write: {...current.write, status: "written", error: null, writtenRoles}}, "written", null, paths);
}

/**
 * 写入勾选且尚未写入的条目。冲突没有决定的条目保持待写入，随报告返回对照数据。
 * 台账（`review` 的逐条 `write`）随返回值交给调用方持久化；写入中途进程中断时，
 * 已写入的文件在下次确认时因内容逐字相同被识别为已写入，不会重复写。
 */
export async function writeReviewItems(input: Readonly<{
    target: WorkspaceFileTarget;
    review: MaterialReview;
    source: ExtractionSourceRef;
    confirmer: Confirmer;
    decisions?: readonly ConflictDecision[];
    indexes?: readonly MaterialNoteIndex[];
}>): Promise<WriteReport> {
    const paragraphs = await loadParagraphs(input.target, input.source);
    const decisions = new Map((input.decisions ?? []).map(decision => [decision.itemId, decision]));
    for (const itemId of decisions.keys()) {
        if (!input.review.items.some(item => item.id === itemId)) throw new ExtractionTaskError("INVALID_INPUT", `冲突决定指向不存在的条目 ${itemId}`);
    }
    const outcomes: ItemOutcome[] = [];
    const conflicts: ConflictComparison[] = [];
    const indexPaths: string[] = [];
    let review = input.review;
    await withProjectTargetMutation(input.target, async handles => {
        for (const item of input.review.items) {
            if (!item.selected || item.write.status === "written") continue;
            const settled = await writeOneItem({target: input.target, handles, source: input.source, paragraphs, confirmer: input.confirmer}, review, item, decisions.get(item.id));
            outcomes.push(settled.outcome);
            conflicts.push(...settled.conflicts);
            review = {...review, items: review.items.map(candidate => candidate.id === item.id ? settled.item : candidate)};
        }
        for (const index of input.indexes ?? []) {
            try {
                const filePath = await writePublishedNoteIndex({target: input.target, handles, before: input.review, review, index, sourcePath: input.source.path, actor: actorOf(input.confirmer)});
                if (filePath) indexPaths.push(filePath);
            } catch (error) {
                outcomes.push({itemId: `index:${index.category}`, title: `${index.category === "writing-technique" ? "写作手法" : "写作素材"}索引`, status: "failed", error: messageOf(error), paths: []});
            }
        }
    });
    return {review, outcomes, conflicts, indexPaths};
}
