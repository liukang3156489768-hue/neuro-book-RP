import {randomUUID} from "node:crypto";
import fs from "node:fs/promises";
import type {OperationActor} from "@notnotype/nb-history";
import {requireReadyModuleHandle, runReadyProjectOperation} from "nbook/server/workspace-files/project-session";
import type {ReadyProjectSessionRef} from "nbook/server/workspace-files/project-session-types";
import {PROJECT_FILE_INDEX_MODULE_TOKEN} from "nbook/server/workspace-files/project-file-index";
import type {WorkspaceFileTarget} from "nbook/server/workspace-files/workspace-file-target";
import {createWorkspaceContentFrontmatterDefaults} from "nbook/server/workspace-files/content-node-schema";
import {parseMarkdownDocument, renderMarkdownDocument, resolveWorkspacePath, scanWorkspaceTree} from "nbook/server/workspace-files/workspace-files";
import {PROJECT_HISTORY_MODULE_TOKEN, type ProjectHistoryHandle} from "nbook/server/workspace-history/project-history";
import {createWorkspaceDirectoryTracked, deleteWorkspacePathTracked, writeWorkspaceTextFileTracked} from "nbook/server/workspace-history/tracked-workspace-files";
import {readPlanningSnapshot} from "nbook/server/outline";
import {
    readWriterChapterContext, readWriterChapterDirectory, sameWriterChapterBasis, type WriterChapterBasis, type WriterChapterContext,
    type WriterChapterSummary,
} from "nbook/server/outline/writer-context";
import type {
    WritingChapterIssuesDto, WritingEntryDto, WritingStyleCreatedDto, WritingStyleOptionDto, WritingIssueDraft, WritingIssueRegistrar, WritingIssuesDto, WritingOverviewDto, WritingSettingsDto,
} from "nbook/shared/dto/writing.dto";
import {
    checkIssueDrafts, chapterIssuesDto, ignoreIssue, issueBasisOf, issueFileChapter, issueFilePath, parseIssueFile, registerIssues, resolveIssues,
    serializeIssueFile, staleIssueIds, WRITING_ISSUES_ROOT, type StoredIssue,
} from "./issues";
import {assistantCanRead} from "./assistant-scope";
import {resolveLorebookFile} from "nbook/server/inspiration/lorebook-path";
import {absoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {markdownBlocks} from "nbook/shared/markdown-structure";
import {extractChapterEnding, findPreviousProse, parseWritingStyle, type WritingStyleResult} from "./materials";
import {locateRewrite, replaceRewriteTarget, type ParagraphRange, type RewriteTarget} from "./rewrite";
import {
    appendSceneText, collectProseFiles, collectVolumeDirectories, currentChapterBasis, deriveWritingOverview, EMPTY_WRITING_SETTINGS,
    joinProseDocument, MANUSCRIPT_ROOT, parseWritingSettings, proseBodyHash, renderChapterIndex, renderVolumeIndex, resolveVolumeTarget,
    sanitizeDirectoryName, serializeWritingSettings, setFrontmatterField, splitProseDocument, uniqueDirectoryName, WRITING_SETTINGS_PATH,
    WritingError, writingFieldValue, type ProseFile, type VolumeDirectory, type WritingPlanning,
} from "./prose-binding";

type WritingState = Readonly<{
    settings: WritingSettingsDto;
    settingsError?: string;
    /** 设置文件的原始内容；null 表示文件不存在。 */
    settingsRaw: string | null;
    planning: WritingPlanning;
    proseFiles: readonly ProseFile[];
    volumeDirectories: readonly VolumeDirectory[];
}>;

type MutationContext = Readonly<{
    root: ReadyProjectSessionRef["workspace"]["root"];
    target: WorkspaceFileTarget;
    history: ProjectHistoryHandle;
}>;

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

async function readTextOrNull(root: MutationContext["root"], relativePath: string): Promise<string | null> {
    try {
        return await fs.readFile(resolveWorkspacePath(root, relativePath), "utf-8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

async function readPlanning(root: MutationContext["root"], planId: string | null): Promise<WritingPlanning> {
    try {
        const snapshot = await readPlanningSnapshot({projectRoot: root});
        const plans = snapshot.manifest.plans.map(({id, title}) => ({id, title}));
        const chapters = planId !== null && plans.some(({id}) => id === planId)
            ? readWriterChapterDirectory(snapshot, {planId}).chapters
            : null;
        return {kind: "ready", plans, revision: snapshot.manifest.revision, chapters};
    } catch (error) {
        return {kind: "unreadable", message: `大纲数据不可读：${errorMessage(error)}`};
    }
}

/** 每次直接扫描 `manuscript/`：写入后立即派生状态，不等文件索引的防抖重建。 */
async function readWritingState(root: MutationContext["root"]): Promise<WritingState> {
    const settingsRaw = await readTextOrNull(root, WRITING_SETTINGS_PATH);
    const parsed = settingsRaw === null ? {settings: EMPTY_WRITING_SETTINGS} : parseWritingSettings(settingsRaw);
    const nodes = await scanWorkspaceTree({root, targets: [MANUSCRIPT_ROOT]});
    return {settings: parsed.settings, ...(parsed.error === undefined ? {} : {settingsError: parsed.error}), settingsRaw,
        planning: await readPlanning(root, parsed.settings.writingPlanId),
        proseFiles: collectProseFiles(nodes), volumeDirectories: collectVolumeDirectories(nodes)};
}

const overviewOf = (state: WritingState): WritingOverviewDto => deriveWritingOverview(state);

function withWritingMutation<T>(ready: ReadyProjectSessionRef, operation: (context: MutationContext) => Promise<T>): Promise<T> {
    return runReadyProjectOperation(ready, async (_signal, assertTarget, revalidateTarget) => {
        const fileIndex = requireReadyModuleHandle(ready, PROJECT_FILE_INDEX_MODULE_TOKEN);
        return fileIndex.mutate(async () => {
            await revalidateTarget();
            assertTarget();
            const history = requireReadyModuleHandle(ready, PROJECT_HISTORY_MODULE_TOKEN);
            const target: WorkspaceFileTarget = {kind: "project-workspace", root: ready.workspace.root,
                projectRoot: ready.workspace.ref.projectRoot};
            return operation({root: ready.workspace.root, target, history});
        });
    });
}

export function readReadyWritingOverview(ready: ReadyProjectSessionRef): Promise<WritingOverviewDto> {
    return runReadyProjectOperation(ready, async (_signal, assertTarget, revalidateTarget) => {
        await revalidateTarget();
        assertTarget();
        const overview = overviewOf(await readWritingState(ready.workspace.root));
        await revalidateTarget();
        assertTarget();
        return overview;
    });
}

/** 写作设置的文风候选；只列出能通过 assertStyleFile 的条目，最终仍以设置时的校验为准。 */
export function listReadyWritingStyles(ready: ReadyProjectSessionRef): Promise<WritingStyleOptionDto[]> {
    return runReadyProjectOperation(ready, async (_signal, assertTarget, revalidateTarget) => {
        await revalidateTarget();
        assertTarget();
        const nodes = await scanWorkspaceTree({root: ready.workspace.root, targets: [STYLE_ROOT.slice(0, -1)]});
        // 条目目录与它的 index.md 会各出现一次；同一路径以目录节点为准，它带条目标题。
        const byPath = new Map<string, WritingStyleOptionDto>();
        for (const node of nodes) {
            if (node.frontmatterError !== null || node.frontmatter.type !== "instruction" || node.frontmatter.subtype !== "writing-style") continue;
            const trimmed = node.path.replace(/\/+$/u, "");
            const stylePath = node.isDirectory ? (node.contentNode ? `${trimmed}/index.md` : null) : trimmed;
            if (stylePath === null || !stylePath.startsWith(STYLE_ROOT) || !stylePath.endsWith(".md")) continue;
            const title = node.title || trimmed.split("/").at(-1)!.replace(/\.md$/u, "");
            if (node.isDirectory || !byPath.has(stylePath)) byPath.set(stylePath, {path: stylePath, title});
        }
        const options = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path, "zh-Hans-CN"));
        await revalidateTarget();
        assertTarget();
        return options;
    });
}

/** 大纲视图中间的只读条目；限定在当前写作方案的卷、章与细纲，界面不经大纲工作台读取线路与伏笔。 */
export function readReadyWritingEntry(ready: ReadyProjectSessionRef, entryId: string): Promise<WritingEntryDto> {
    return runReadyProjectOperation(ready, async (_signal, assertTarget, revalidateTarget) => {
        await revalidateTarget();
        assertTarget();
        const settingsRaw = await readTextOrNull(ready.workspace.root, WRITING_SETTINGS_PATH);
        const {settings} = settingsRaw === null ? {settings: EMPTY_WRITING_SETTINGS} : parseWritingSettings(settingsRaw);
        if (settings.writingPlanId === null) throw new WritingError("PLAN_NOT_FOUND", "尚未选择写作方案");
        let snapshot: Awaited<ReturnType<typeof readPlanningSnapshot>>;
        try {
            snapshot = await readPlanningSnapshot({projectRoot: ready.workspace.root});
        } catch (error) {
            throw new WritingError("PLANNING_UNREADABLE", `大纲数据不可读：${errorMessage(error)}`);
        }
        if (!snapshot.manifest.plans.some(({id}) => id === settings.writingPlanId)) {
            throw new WritingError("PLAN_NOT_FOUND", "写作方案在大纲中已不存在，请重新选择");
        }
        const inPlan = readWriterChapterDirectory(snapshot, {planId: settings.writingPlanId}).chapters
            .some((chapter) => chapter.entryId === entryId || chapter.volume?.entryId === entryId
                || chapter.details.some((detail) => detail.entryId === entryId));
        const entry = inPlan ? snapshot.entries.find(({value}) => value.id === entryId)?.value : undefined;
        if (entry === undefined) throw new WritingError("CHAPTER_NOT_IN_PLAN", "条目不在当前写作方案中");
        const {schema: _schema, analysis: _analysis, ...value} = entry;
        await revalidateTarget();
        assertTarget();
        return structuredClone(value) as WritingEntryDto;
    });
}

/** 需要可用写作方案的操作共用：方案为空、已删除或大纲不可读时拒绝，不猜测章节。 */
function requirePlanChapters(state: WritingState): readonly WriterChapterSummary[] {
    if (state.planning.kind === "unreadable") throw new WritingError("PLANNING_UNREADABLE", state.planning.message);
    if (state.settings.writingPlanId === null) throw new WritingError("PLAN_NOT_FOUND", "尚未选择写作方案");
    if (state.planning.chapters === null) throw new WritingError("PLAN_NOT_FOUND", "写作方案在大纲中已不存在，请重新选择");
    return state.planning.chapters;
}

function requireChapter(chapters: readonly WriterChapterSummary[], chapterEntryId: string): WriterChapterSummary {
    const chapter = chapters.find(({entryId}) => entryId === chapterEntryId);
    if (!chapter) throw new WritingError("CHAPTER_NOT_IN_PLAN", "章节不在当前写作方案中");
    return chapter;
}

const proseOf = (state: WritingState, chapterEntryId: string) => state.proseFiles.filter((file) =>
    file.field.kind === "linked" && file.field.value.chapterEntryId === chapterEntryId);

function requireProseFile(state: WritingState, path: string): ProseFile {
    const normalized = path.replace(/\\/gu, "/");
    const file = state.proseFiles.find((item) => item.path === normalized);
    if (!file) throw new WritingError("PROSE_NOT_FOUND", `不是 manuscript/ 下的正文文件：${path}`);
    return file;
}

async function writeSettings(context: MutationContext, state: WritingState, next: WritingSettingsDto, actor: OperationActor): Promise<void> {
    const content = serializeWritingSettings(next);
    if (state.settingsRaw === content) return;
    // 文件不存在时写入空设置没有意义，幂等地视为已是目标状态。
    if (state.settingsRaw === null && next.writingPlanId === null && next.stylePath === null) return;
    await writeWorkspaceTextFileTracked({target: context.target, history: context.history, filePath: WRITING_SETTINGS_PATH,
        content, actor, knownBefore: state.settingsRaw});
}

/** 设置文件格式非法时按空设置覆盖；旧内容仍在文件历史中可恢复。 */
export function setReadyWritingPlan(ready: ReadyProjectSessionRef, planId: string | null, actor: OperationActor): Promise<WritingOverviewDto> {
    return withWritingMutation(ready, async (context) => {
        const state = await readWritingState(context.root);
        if (planId !== null) {
            if (state.planning.kind === "unreadable") throw new WritingError("PLANNING_UNREADABLE", state.planning.message);
            if (!state.planning.plans.some(({id}) => id === planId)) throw new WritingError("PLAN_NOT_FOUND", "写作方案不存在");
        }
        await writeSettings(context, state, {...state.settings, writingPlanId: planId}, actor);
        return overviewOf(await readWritingState(context.root));
    });
}

const STYLE_ROOT = "lorebook/instruction/";

async function assertStyleFile(root: MutationContext["root"], stylePath: string): Promise<void> {
    const segments = stylePath.split("/");
    if (!stylePath.startsWith(STYLE_ROOT) || !stylePath.endsWith(".md")
        || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
        throw new WritingError("INVALID_PATH", `文风文件必须是 ${STYLE_ROOT} 下的 Markdown 文件`);
    }
    const content = await readTextOrNull(root, stylePath);
    if (content === null) throw new WritingError("STYLE_INVALID", `文风文件不存在：${stylePath}`);
    const {frontmatter, error} = parseMarkdownDocument(content);
    if (error !== null) throw new WritingError("STYLE_INVALID", `文风文件的文件头无法解析：${error}`);
    if (frontmatter.type !== "instruction" || frontmatter.subtype !== "writing-style") {
        throw new WritingError("STYLE_INVALID", "文风文件的类型必须是 instruction，子类型必须是 writing-style");
    }
}

export function setReadyWritingStyle(ready: ReadyProjectSessionRef, stylePath: string | null, actor: OperationActor): Promise<WritingOverviewDto> {
    return withWritingMutation(ready, async (context) => {
        const normalized = stylePath === null ? null : stylePath.replace(/\\/gu, "/");
        if (normalized !== null) await assertStyleFile(context.root, normalized);
        const state = await readWritingState(context.root);
        await writeSettings(context, state, {...state.settings, stylePath: normalized}, actor);
        return overviewOf(await readWritingState(context.root));
    });
}

/** 新建文风放在规范建议的目录下；写作模块只在用户从写作设置发起时写这一处 `lorebook/`。 */
const NEW_STYLE_ROOT = `${STYLE_ROOT}writing-style`;

function renderNewStyle(title: string): string {
    const frontmatter = {...createWorkspaceContentFrontmatterDefaults({title, type: "instruction", status: "active"}),
        subtype: "writing-style", tags: ["文风"], retrieval: {enabled: false, trigger: null},
        governance: {source: "manual", review: "reviewed"}};
    return renderMarkdownDocument(frontmatter, `# ${title}

写手只读取下面三个小节：“文风要求”必填，“禁用写法”和“样文”可以留空。

## 文风要求

## 禁用写法

## 样文
`);
}

/** 新文风的“文风要求”为空，写作前需补写；尚未选择文风时顺带选中，已有选择不改。 */
export function createReadyWritingStyle(ready: ReadyProjectSessionRef, title: string, actor: OperationActor): Promise<WritingStyleCreatedDto> {
    return withWritingMutation(ready, async (context) => {
        const trimmed = title.trim();
        const name = uniqueDirectoryName(sanitizeDirectoryName(trimmed), await listNames(context.root, NEW_STYLE_ROOT));
        const dirPath = `${NEW_STYLE_ROOT}/${name}`;
        await createWorkspaceDirectoryTracked({target: context.target, history: context.history, dirPath,
            indexContent: renderNewStyle(trimmed === "" ? name : trimmed), actor});
        const stylePath = `${dirPath}/index.md`;
        const state = await readWritingState(context.root);
        if (state.settings.stylePath === null) await writeSettings(context, state, {...state.settings, stylePath}, actor);
        return {overview: overviewOf(await readWritingState(context.root)), stylePath};
    });
}

/**
 * 只删能通过文风校验的文件，删除进入文件历史可撤销。条目目录里除 index.md 还有别的内容时拒绝，
 * 避免连带删掉用户放在同一目录的资料。删的是当前文风时同一次操作清空选择。
 */
export function deleteReadyWritingStyle(ready: ReadyProjectSessionRef, stylePath: string, actor: OperationActor): Promise<WritingOverviewDto> {
    return withWritingMutation(ready, async (context) => {
        const normalized = stylePath.replace(/\\/gu, "/");
        await assertStyleFile(context.root, normalized);
        const dirPath = normalized.slice(0, -"/index.md".length);
        const isEntryDirectory = normalized.endsWith("/index.md") && dirPath.length >= STYLE_ROOT.length;
        if (isEntryDirectory) {
            const others = (await listNames(context.root, dirPath)).filter((name) => name !== "index.md");
            if (others.length > 0) {
                throw new WritingError("STYLE_INVALID", `文风条目目录里还有其他文件（${others.join("、")}），请在资料库中处理后再删除`);
            }
        }
        await deleteWorkspacePathTracked({target: context.target, history: context.history,
            filePath: isEntryDirectory ? dirPath : normalized, recursive: isEntryDirectory, actor});
        const state = await readWritingState(context.root);
        if (state.settings.stylePath === normalized) await writeSettings(context, state, {...state.settings, stylePath: null}, actor);
        return overviewOf(await readWritingState(context.root));
    });
}

async function rewriteWritingField(context: MutationContext, file: ProseFile, value: unknown | null, actor: OperationActor): Promise<void> {
    const before = await readTextOrNull(context.root, file.path);
    if (before === null) throw new WritingError("PROSE_NOT_FOUND", `正文文件不存在：${file.path}`);
    const after = setFrontmatterField(before, "writing", value);
    if (after === before) return;
    await writeWorkspaceTextFileTracked({target: context.target, history: context.history, filePath: file.path,
        content: after, actor, knownBefore: before});
}

/** 手动关联只写归属不写依据：用户关联的正文不是按当前规划生成的。 */
export function linkReadyProse(
    ready: ReadyProjectSessionRef, input: Readonly<{path: string; chapterEntryId: string}>, actor: OperationActor,
): Promise<WritingOverviewDto> {
    return withWritingMutation(ready, async (context) => {
        const state = await readWritingState(context.root);
        const chapters = requirePlanChapters(state);
        const chapter = requireChapter(chapters, input.chapterEntryId);
        const file = requireProseFile(state, input.path);
        const current = file.field.kind === "linked" ? file.field.value.chapterEntryId : null;
        if (current === input.chapterEntryId) return overviewOf(state);
        // 归属不在方案中的正文属于未关联正文，可以直接改挂；已归属方案内另一章则须先解除，避免静默抢走正文。
        if (current !== null && chapters.some(({entryId}) => entryId === current)) {
            throw new WritingError("PROSE_LINKED", "该正文已归属当前写作方案中的另一章，请先解除关联");
        }
        if (proseOf(state, input.chapterEntryId).length > 0) throw new WritingError("CHAPTER_HAS_PROSE", "该章已有正文，请先解除原有关联");
        await rewriteWritingField(context, file, writingFieldValue(chapter.entryId), actor);
        return overviewOf(await readWritingState(context.root));
    });
}

/** 解除时整个移除 writing 字段，包括格式非法的字段；文件本身保留。 */
export function unlinkReadyProse(ready: ReadyProjectSessionRef, input: Readonly<{path: string}>, actor: OperationActor): Promise<WritingOverviewDto> {
    return withWritingMutation(ready, async (context) => {
        const state = await readWritingState(context.root);
        const file = requireProseFile(state, input.path);
        if (file.field.kind === "none") return overviewOf(state);
        await rewriteWritingField(context, file, null, actor);
        return overviewOf(await readWritingState(context.root));
    });
}

async function listNames(root: MutationContext["root"], dirPath: string): Promise<string[]> {
    try {
        return await fs.readdir(resolveWorkspacePath(root, dirPath));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
}

/** 撤掉本次写出却未完成记账的章节文件；只删与本次写入内容相同的文件，不碰用户文件。 */
async function discardPartialChapter(root: MutationContext["root"], dirPath: string, indexContent: string): Promise<void> {
    const indexPath = `${dirPath}/index.md`;
    if (await readTextOrNull(root, indexPath).catch(() => null) === indexContent) {
        await fs.rm(resolveWorkspacePath(root, indexPath), {force: true}).catch(() => undefined);
    }
    await fs.rmdir(resolveWorkspacePath(root, dirPath)).catch(() => undefined);
}

export type ProseFileCreated = Readonly<{path: string; volumeDirectoryCreated: string | null}>;

/**
 * 写作工作流在第一个场景前调用。卷目录按需一并创建；章节创建失败时撤回本次新建的卷目录，
 * 保证工作流停止时不留下半成品。目录名只在创建时取自标题，之后改标题不移动文件。
 */
export function createReadyProseFile(
    ready: ReadyProjectSessionRef, input: Readonly<{chapterEntryId: string}>, actor: OperationActor,
): Promise<ProseFileCreated> {
    return withWritingMutation(ready, async (context) => createProseFile(context, await readWritingState(context.root),
        input.chapterEntryId, actor));
}

async function createProseFile(context: MutationContext, state: WritingState, chapterEntryId: string, actor: OperationActor):
    Promise<ProseFileCreated> {
    const chapters = requirePlanChapters(state);
    const chapter = requireChapter(chapters, chapterEntryId);
    if (proseOf(state, chapter.entryId).length > 0) throw new WritingError("CHAPTER_HAS_PROSE", "该章已有正文文件");
    if (!chapter.writable) throw new WritingError("CHAPTER_NOT_WRITABLE", `章节不可写：${chapter.block?.message ?? "规划未就绪"}`);
    const volumeTarget = resolveVolumeTarget({chapter, chapters, volumeDirectories: state.volumeDirectories,
        proseFiles: state.proseFiles});
    let parent: string = MANUSCRIPT_ROOT;
    let createdVolume: string | null = null;
    if (volumeTarget.kind === "existing") parent = volumeTarget.dirPath;
    if (volumeTarget.kind === "create" && chapter.volume !== null) {
        const name = uniqueDirectoryName(sanitizeDirectoryName(chapter.volume.title), await listNames(context.root, MANUSCRIPT_ROOT));
        createdVolume = `${MANUSCRIPT_ROOT}/${name}`;
        await createWorkspaceDirectoryTracked({target: context.target, history: context.history, dirPath: createdVolume,
            indexContent: renderVolumeIndex(chapter.volume.title, chapter.volume.entryId), actor});
        parent = createdVolume;
    }
    const dirPath = `${parent}/${uniqueDirectoryName(sanitizeDirectoryName(chapter.title), await listNames(context.root, parent))}`;
    const indexContent = renderChapterIndex(chapter.title, chapter.entryId);
    try {
        await createWorkspaceDirectoryTracked({target: context.target, history: context.history, dirPath, indexContent, actor});
    } catch (error) {
        await discardPartialChapter(context.root, dirPath, indexContent);
        if (createdVolume !== null) {
            await deleteWorkspacePathTracked({target: context.target, history: context.history, filePath: createdVolume,
                recursive: true, actor});
        }
        throw error;
    }
    return {path: `${dirPath}/index.md`, volumeDirectoryCreated: createdVolume};
}

/**
 * 完整生成的全部场景通过后写入依据。依据必须与当前交接一致：
 * 生成期间规划若已变化，写入旧依据会把过期正文显示为“已写”。
 */
export function writeReadyProseSource(
    ready: ReadyProjectSessionRef,
    input: Readonly<{planId: string; chapterEntryId: string; basis: WriterChapterBasis; generatedAt?: string}>,
    actor: OperationActor,
): Promise<WritingOverviewDto> {
    return withWritingMutation(ready, async (context) => {
        const state = await readWritingState(context.root);
        const chapters = requirePlanChapters(state);
        if (state.settings.writingPlanId !== input.planId) throw new WritingError("BASIS_CHANGED", "写作方案已切换");
        const chapter = requireChapter(chapters, input.chapterEntryId);
        if (chapter.block !== undefined) throw new WritingError("CHAPTER_NOT_WRITABLE", `章节不可写：${chapter.block.message}`);
        if (!sameWriterChapterBasis(input.basis, currentChapterBasis(chapter))) {
            throw new WritingError("BASIS_CHANGED", "章节大纲或细纲在写作期间已变化");
        }
        const prose = proseOf(state, chapter.entryId);
        if (prose.length === 0) throw new WritingError("PROSE_NOT_FOUND", "该章没有正文文件");
        if (prose.length > 1) throw new WritingError("OWNERSHIP_CONFLICT", "该章有多份正文文件，请先解除多余的关联");
        const basis = currentChapterBasis(chapter);
        const source = {planId: input.planId, ...basis, details: [...basis.details], generatedAt: input.generatedAt ?? new Date().toISOString()};
        await rewriteWritingField(context, prose[0]!, writingFieldValue(chapter.entryId, source), actor);
        return overviewOf(await readWritingState(context.root));
    });
}

/**
 * 列出当前方案的章节问题，包含尚未创建正文的章节，让准备阶段的问题也可以由用户忽略。
 * 其他方案的记录保留在磁盘上，切回后恢复显示。
 */
export function readReadyWritingIssues(ready: ReadyProjectSessionRef): Promise<WritingIssuesDto> {
    return runReadyProjectOperation(ready, async (_signal, assertTarget, revalidateTarget) => {
        await revalidateTarget();
        assertTarget();
        const state = await readWritingState(ready.workspace.root);
        const chapters = state.planning.kind === "ready" && state.settings.writingPlanId !== null ? state.planning.chapters ?? [] : [];
        const inPlan = new Map<string, WriterChapterSummary>(chapters.map((chapter) => [chapter.entryId, chapter]));
        const result: WritingIssuesDto = {chapters: [], unreadable: []};
        for (const name of (await listNames(ready.workspace.root, WRITING_ISSUES_ROOT)).sort()) {
            const chapterEntryId = issueFileChapter(name);
            const chapter = chapterEntryId === null ? undefined : inPlan.get(chapterEntryId);
            if (chapter === undefined) continue;
            const file = await readIssueFile(ready.workspace.root, chapter.entryId);
            if (!file.ok) {
                result.unreadable.push({chapterEntryId: chapter.entryId, message: file.message});
                continue;
            }
            if (file.issues.length > 0) result.chapters.push(chapterIssuesDto(chapter.entryId, file.issues, issueBasisOf(chapter)));
        }
        await revalidateTarget();
        assertTarget();
        return result;
    });
}

type IssueFileRead = Readonly<{ok: true; raw: string | null; issues: readonly StoredIssue[]}> | Readonly<{ok: false; message: string}>;

async function readIssueFile(root: MutationContext["root"], chapterEntryId: string): Promise<IssueFileRead> {
    let raw: string | null;
    try {
        raw = await readTextOrNull(root, issueFilePath(chapterEntryId));
    } catch (error) {
        return {ok: false, message: `问题记录读取失败：${errorMessage(error)}`};
    }
    if (raw === null) return {ok: true, raw, issues: []};
    const parsed = parseIssueFile(raw, chapterEntryId);
    return parsed.ok ? {ok: true, raw, issues: parsed.issues} : parsed;
}

/**
 * 按章改写问题文件。文件损坏时拒绝写入：问题文件不像设置那样可以整体重建，
 * 覆盖会丢掉其中仍有效的记录。
 */
function updateChapterIssues(
    ready: ReadyProjectSessionRef,
    chapterEntryId: string,
    actor: OperationActor,
    update: (issues: readonly StoredIssue[], chapter: WriterChapterSummary) => StoredIssue[],
): Promise<WritingChapterIssuesDto> {
    return withWritingMutation(ready, async (context) => {
        const chapter = requireChapter(requirePlanChapters(await readWritingState(context.root)), chapterEntryId);
        const file = await readIssueFile(context.root, chapter.entryId);
        if (!file.ok) throw new WritingError("ISSUES_UNREADABLE", file.message);
        const next = update(file.issues, chapter);
        const content = serializeIssueFile(chapter.entryId, next);
        if (content !== file.raw && !(file.raw === null && next.length === 0)) {
            await writeWorkspaceTextFileTracked({target: context.target, history: context.history,
                filePath: issueFilePath(chapter.entryId), content, actor, knownBefore: file.raw});
        }
        return chapterIssuesDto(chapter.entryId, next, issueBasisOf(chapter));
    });
}

function validateDrafts(drafts: readonly unknown[], chapter: WriterChapterSummary): WritingIssueDraft[] {
    const checked = checkIssueDrafts(drafts, new Set([chapter.entryId, ...chapter.details.map(({entryId}) => entryId)]));
    if (!checked.ok) throw new WritingError("ISSUE_INVALID", checked.errors[0]!);
    return checked.drafts;
}

const createIssueId = () => `wi-${randomUUID().replaceAll("-", "").slice(0, 12)}`;

/** 写作工作流与助手登记问题；版本取登记当时的规划，供之后派生“待复核”。 */
export function registerReadyWritingIssues(
    ready: ReadyProjectSessionRef,
    input: Readonly<{chapterEntryId: string; drafts: readonly unknown[]; registrar: WritingIssueRegistrar; now?: string}>,
    actor: OperationActor,
): Promise<WritingChapterIssuesDto> {
    return updateChapterIssues(ready, input.chapterEntryId, actor, (issues, chapter) => registerIssues(issues,
        validateDrafts(input.drafts, chapter),
        {registrar: input.registrar, basis: issueBasisOf(chapter), now: input.now ?? new Date().toISOString(), createId: createIssueId}));
}

/** 复核后已不存在的问题标为已解决。 */
export function resolveReadyWritingIssues(
    ready: ReadyProjectSessionRef, input: Readonly<{chapterEntryId: string; issueIds: readonly string[]}>, actor: OperationActor,
): Promise<WritingChapterIssuesDto> {
    return updateChapterIssues(ready, input.chapterEntryId, actor, (issues) => resolveIssues(issues, input.issueIds));
}

export function ignoreReadyWritingIssue(
    ready: ReadyProjectSessionRef, input: Readonly<{chapterEntryId: string; issueId: string}>, actor: OperationActor,
): Promise<WritingChapterIssuesDto> {
    return updateChapterIssues(ready, input.chapterEntryId, actor, (issues) => ignoreIssue(issues, input.issueId));
}

export type WritingRunFacts = Readonly<{
    planId: string;
    chapter: WriterChapterSummary;
    /** 章节不可写时为 null。 */
    context: WriterChapterContext | null;
    /** 未设置文风时为 null。 */
    style: Readonly<{path: string; result: WritingStyleResult}> | null;
    /** 尚无正文文件时为 null；body 与 hash 的口径见 splitProseDocument。 */
    prose: Readonly<{path: string; body: string; hash: string}> | null;
    previous: Readonly<{entryId: string; title: string; ending: string}> | null;
    /** 方案中本章之前还有章节；首章没有上一章，不算“上一章尚无正文”。 */
    hasEarlierChapter: boolean;
}>;

async function readStyle(root: MutationContext["root"], stylePath: string): Promise<WritingStyleResult> {
    const content = await readTextOrNull(root, stylePath).catch(() => null);
    if (content === null) return {ok: false, message: `文风文件不存在或不可读：${stylePath}`};
    const {frontmatter, error} = parseMarkdownDocument(content);
    if (error !== null) return {ok: false, message: `文风文件的文件头无法解析：${error}`};
    if (frontmatter.type !== "instruction" || frontmatter.subtype !== "writing-style") {
        return {ok: false, message: "文风文件的类型必须是 instruction，子类型必须是 writing-style"};
    }
    return parseWritingStyle(content);
}

/**
 * 写作工作流每一步开始前读取的事实。章节摘要与交接取自同一份规划快照，
 * 否则两次读取之间的规划修改会让资格判断和依据版本对不上。
 */
export function readReadyWritingRunFacts(ready: ReadyProjectSessionRef, input: Readonly<{chapterEntryId: string}>): Promise<WritingRunFacts> {
    return runReadyProjectOperation(ready, async (_signal, assertTarget, revalidateTarget) => {
        await revalidateTarget();
        assertTarget();
        const root = ready.workspace.root;
        const state = await readWritingState(root);
        requirePlanChapters(state);
        const planId = state.settings.writingPlanId!;
        let snapshot: Awaited<ReturnType<typeof readPlanningSnapshot>>;
        try {
            snapshot = await readPlanningSnapshot({projectRoot: root});
        } catch (error) {
            throw new WritingError("PLANNING_UNREADABLE", `大纲数据不可读：${errorMessage(error)}`);
        }
        if (!snapshot.manifest.plans.some(({id}) => id === planId)) throw new WritingError("PLAN_NOT_FOUND", "写作方案在大纲中已不存在，请重新选择");
        const chapter = requireChapter(readWriterChapterDirectory(snapshot, {planId}).chapters, input.chapterEntryId);
        const context = chapter.writable ? readWriterChapterContext(snapshot, {planId, chapterEntryId: chapter.entryId}) : null;
        const stylePath = state.settings.stylePath;
        const style = stylePath === null ? null : {path: stylePath, result: await readStyle(root, stylePath)};
        const files = proseOf(state, chapter.entryId);
        if (files.length > 1) throw new WritingError("OWNERSHIP_CONFLICT", "该章有多份正文文件，请先解除多余的关联");
        let prose: WritingRunFacts["prose"] = null;
        if (files[0] !== undefined) {
            const content = await readTextOrNull(root, files[0].path);
            if (content === null) throw new WritingError("PROSE_NOT_FOUND", `正文文件不存在：${files[0].path}`);
            const {body} = splitProseDocument(content);
            prose = {path: files[0].path, body, hash: proseBodyHash(body)};
        }
        const order = overviewOf(state).chapters;
        const found = findPreviousProse(order, chapter.entryId);
        const previousContent = found === null ? null : await readTextOrNull(root, found.path);
        const previous = found === null || previousContent === null ? null
            : {entryId: found.entryId, title: found.title, ending: extractChapterEnding(previousContent)};
        await revalidateTarget();
        assertTarget();
        const hasEarlierChapter = order.findIndex(({entryId}) => entryId === chapter.entryId) > 0;
        return {planId, chapter, context, style, prose, previous, hasEarlierChapter};
    });
}

/**
 * 按助手的可读范围读取文件；范围外、不存在或不可读的路径不出现在结果中，
 * 由调用方按“不可读”处理。
 */
export function readReadyAssistantFiles(
    ready: ReadyProjectSessionRef, input: Readonly<{paths: readonly string[]; referencePaths: readonly string[]}>,
): Promise<Map<string, string>> {
    return runReadyProjectOperation(ready, async (_signal, assertTarget, revalidateTarget) => {
        await revalidateTarget();
        assertTarget();
        const files = new Map<string, string>();
        for (const path of new Set(input.paths)) {
            if (!assistantCanRead(path, input.referencePaths)) continue;
            let canonical = path;
            let content: string | null;
            if (path.startsWith("lorebook/")) {
                // lorebook 的目录、标题和稳定 ID 都必须先解析到真实 index.md；
                // 解析失败时不能回退到请求路径，否则会绕过名称歧义和路径约束。
                const resolved = await resolveLorebookFile(absoluteFsPath(ready.workspace.root), path).catch(() => null);
                if (resolved === null) continue;
                canonical = resolved.canonicalPath;
                content = await readTextOrNull(ready.workspace.root, canonical).catch(() => null);
            } else {
                content = await readTextOrNull(ready.workspace.root, path).catch(() => null);
            }
            if (content !== null) {
                files.set(path, content);
                if (canonical !== path) files.set(canonical, content);
            }
        }
        await revalidateTarget();
        assertTarget();
        return files;
    });
}

export type AssistantFileListing = Readonly<{
    /** `lorebook/` 下的全部 Markdown 文件。 */
    lorebook: readonly string[];
    /** 本章交接列出的参考路径；范围外（伏笔定义）或不是可读文件的标为不可读。 */
    references: readonly Readonly<{path: string; readable: boolean}>[];
}>;

/** 助手可读范围内的文件清单，供助手选择要读的资料。 */
export function listReadyAssistantFiles(
    ready: ReadyProjectSessionRef, input: Readonly<{referencePaths: readonly string[]}>,
): Promise<AssistantFileListing> {
    return runReadyProjectOperation(ready, async (_signal, assertTarget, revalidateTarget) => {
        await revalidateTarget();
        assertTarget();
        const root = ready.workspace.root;
        let entries: string[] = [];
        try {
            entries = await fs.readdir(resolveWorkspacePath(root, "lorebook"), {recursive: true});
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const lorebook = entries.map((entry) => `lorebook/${entry.replace(/\\/gu, "/")}`).filter((path) => path.endsWith(".md"))
            .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
        const references = await Promise.all(input.referencePaths.map(async (path) => {
            if (!assistantCanRead(path, input.referencePaths)) return {path, readable: false};
            if (path.startsWith("lorebook/")) {
                const resolved = await resolveLorebookFile(absoluteFsPath(root), path).catch(() => null);
                return {path, readable: resolved !== null};
            }
            const stat = await fs.stat(resolveWorkspacePath(root, path)).catch(() => null);
            return {path, readable: stat?.isFile() ?? false};
        }));
        await revalidateTarget();
        assertTarget();
        return {lorebook, references};
    });
}

export type ProseBodyWrite = Readonly<{status: "written" | "unchanged" | "conflict"; path: string | null; hash: string}>;

/**
 * 写作工作流写入场景正文。正文与 baseHash 一致才写入，否则说明期间有别的改动，返回 conflict，
 * 不覆盖用户的修改；没有正文文件时 baseHash 对应空正文，并先创建文件。
 * 进程可能在写入后、运行记录保存前中断，重做这一步时本次改动已在文件中，返回 unchanged 而不再追加。
 * 正文一经改动，旧依据即不再对应当前正文，因此同时移除 source，由全部场景通过后重新写入。
 */
export function writeReadyProseBody(
    ready: ReadyProjectSessionRef,
    input: Readonly<{chapterEntryId: string; mode: "append" | "replace"; baseHash: string; text: string}>,
    actor: OperationActor,
): Promise<ProseBodyWrite> {
    return withWritingMutation(ready, async (context) => {
        const state = await readWritingState(context.root);
        const chapter = requireChapter(requirePlanChapters(state), input.chapterEntryId);
        const files = proseOf(state, chapter.entryId);
        if (files.length > 1) throw new WritingError("OWNERSHIP_CONFLICT", "该章有多份正文文件，请先解除多余的关联");
        const text = input.text.trim();
        if (files[0] === undefined && input.baseHash !== proseBodyHash("")) return {status: "conflict", path: null, hash: proseBodyHash("")};
        const path = files[0]?.path ?? (await createProseFile(context, state, chapter.entryId, actor)).path;
        const before = await readTextOrNull(context.root, path);
        if (before === null) throw new WritingError("PROSE_NOT_FOUND", `正文文件不存在：${path}`);
        const {head, body} = splitProseDocument(before);
        const current = proseBodyHash(body);
        if (current !== input.baseHash) {
            const applied = input.mode === "replace" ? body === text
                : body.endsWith(text) && proseBodyHash(body.slice(0, body.length - text.length).trimEnd()) === input.baseHash;
            return {status: applied ? "unchanged" : "conflict", path, hash: current};
        }
        const next = input.mode === "replace" ? text : appendSceneText(body, text);
        const after = setFrontmatterField(joinProseDocument(head, next), "writing", writingFieldValue(chapter.entryId));
        await writeWorkspaceTextFileTracked({target: context.target, history: context.history, filePath: path, content: after, actor,
            knownBefore: before});
        return {status: "written", path, hash: proseBodyHash(next)};
    });
}

export type ProseParagraphsReplace =
    | Readonly<{status: "replaced" | "unchanged"; path: string; hash: string}>
    | Readonly<{status: "target-changed"; message: string}>;

/** 用户明确要求的正文删改；全文版本校验与写入同处项目变更边界，不能覆盖读取后的改动。 */
export function editReadyProseBody(
    ready: ReadyProjectSessionRef,
    input: Readonly<{chapterEntryId: string; baseHash: string; target?: RewriteTarget; replacement: string}>,
    actor: OperationActor,
): Promise<ProseBodyWrite> {
    return withWritingMutation(ready, async (context) => {
        const state = await readWritingState(context.root);
        const chapter = requireChapter(requirePlanChapters(state), input.chapterEntryId);
        const files = proseOf(state, chapter.entryId);
        if (files.length > 1) throw new WritingError("OWNERSHIP_CONFLICT", "该章有多份正文文件，请先解除多余的关联");
        const path = files[0]?.path;
        if (path === undefined) throw new WritingError("PROSE_NOT_FOUND", "该章没有正文文件");
        const before = await readTextOrNull(context.root, path);
        if (before === null) throw new WritingError("PROSE_NOT_FOUND", `正文文件不存在：${path}`);
        const {head, body} = splitProseDocument(before);
        const hash = proseBodyHash(body);
        if (hash !== input.baseHash) return {status: "conflict", path, hash};
        let next = input.replacement.trim();
        if (input.target !== undefined) {
            const located = locateRewrite(body, input.target);
            if (!located.ok) throw new WritingError("RUN_ANSWER_INVALID", located.message);
            const blocks = markdownBlocks(body);
            const {from, to} = located.value.range;
            next = `${body.slice(0, blocks[from - 1]!.start)}${next}${body.slice(blocks[to - 1]!.end)}`.trim();
        }
        if (next === body) return {status: "unchanged", path, hash};
        // 手动删改后旧生成依据不再证明当前正文；章节归属与作者的其他元数据保留。
        const after = setFrontmatterField(joinProseDocument(head, next), "writing", writingFieldValue(chapter.entryId));
        await writeWorkspaceTextFileTracked({target: context.target, history: context.history, filePath: path,
            content: after, actor, knownBefore: before});
        return {status: "written", path, hash: proseBodyHash(next)};
    });
}

/**
 * 改写确认后替换目标段落。局部改写不代表整章按当前依据重写，所以文件头原样保留，不更新 `source`。
 * 目标已不在正文中、但改写结果已在时视为此前已替换（运行记录重放这一步时），返回 unchanged。
 */
export function replaceReadyProseParagraphs(
    ready: ReadyProjectSessionRef,
    input: Readonly<{chapterEntryId: string; range: ParagraphRange; target: string; replacement: string}>,
    actor: OperationActor,
): Promise<ProseParagraphsReplace> {
    return withWritingMutation(ready, async (context) => {
        const state = await readWritingState(context.root);
        const chapter = requireChapter(requirePlanChapters(state), input.chapterEntryId);
        const files = proseOf(state, chapter.entryId);
        if (files.length > 1) throw new WritingError("OWNERSHIP_CONFLICT", "该章有多份正文文件，请先解除多余的关联");
        if (files[0] === undefined) return {status: "target-changed", message: "该章已没有正文文件，未替换"};
        const path = files[0].path;
        const before = await readTextOrNull(context.root, path);
        if (before === null) throw new WritingError("PROSE_NOT_FOUND", `正文文件不存在：${path}`);
        const {head, body} = splitProseDocument(before);
        const replaced = replaceRewriteTarget(body, input);
        if (!replaced.ok) {
            const replacement = input.replacement.trim();
            if (replacement !== "" && body.includes(replacement)) return {status: "unchanged", path, hash: proseBodyHash(body)};
            return {status: "target-changed", message: replaced.message};
        }
        await writeWorkspaceTextFileTracked({target: context.target, history: context.history, filePath: path,
            content: joinProseDocument(head, replaced.body), actor, knownBefore: before});
        return {status: "replaced", path, hash: proseBodyHash(replaced.body)};
    });
}

/** 一次写作完成规划后复核本章旧问题，规则见 staleIssueIds。 */
export function recheckReadyWritingIssues(
    ready: ReadyProjectSessionRef, input: Readonly<{chapterEntryId: string; since: string}>, actor: OperationActor,
): Promise<WritingChapterIssuesDto> {
    return updateChapterIssues(ready, input.chapterEntryId, actor, (issues, chapter) =>
        resolveIssues(issues, staleIssueIds(issues, issueBasisOf(chapter), input.since)));
}
