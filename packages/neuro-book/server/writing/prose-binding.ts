import {createHash} from "node:crypto";
import YAML from "yaml";
import {z} from "zod";
import type {WorkspaceFileNode, WorkspaceFrontmatter} from "nbook/server/workspace-files/workspace-files";
import type {OutlineId} from "nbook/server/outline/format";
import {sameWriterChapterBasis, type WriterChapterBasis, type WriterChapterSummary} from "nbook/server/outline/writer-context";
import type {WritingChapterDto, WritingChapterStatus, WritingOverviewDto, WritingPlanStateDto, WritingProseRefDto,
    WritingSettingsDto, WritingUnlinkedProseDto} from "nbook/shared/dto/writing.dto";

/** 写作数据放在项目根的 `writing/` 下：`.nbook/` 不进入文件历史，写作设置需要可撤销。 */
export const WRITING_SETTINGS_PATH = "writing/settings.yaml";
export const MANUSCRIPT_ROOT = "manuscript";

export type WritingErrorCode =
    | "PLAN_NOT_FOUND"
    | "PLANNING_UNREADABLE"
    | "CHAPTER_NOT_IN_PLAN"
    | "CHAPTER_NOT_WRITABLE"
    | "CHAPTER_HAS_PROSE"
    | "PROSE_NOT_FOUND"
    | "PROSE_LINKED"
    | "OWNERSHIP_CONFLICT"
    | "STYLE_INVALID"
    | "BASIS_CHANGED"
    | "FRONTMATTER_INVALID"
    | "INVALID_PATH"
    | "ISSUE_INVALID"
    | "ISSUE_NOT_FOUND"
    | "ISSUE_NOT_IGNORABLE"
    | "ISSUES_UNREADABLE"
    | "RUN_ACTIVE"
    | "RUN_NOT_FOUND"
    | "RUN_ANSWER_INVALID"
    | "MODEL_INVALID";

export class WritingError extends Error {
    constructor(readonly code: WritingErrorCode, message: string) {
        super(message);
        this.name = "WritingError";
    }
}

const EntryId = z.custom<OutlineId>((value) => typeof value === "string" && /^ol-[a-z0-9][a-z0-9-]*$/u.test(value), "条目 ID 非法");
const ContentHash = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const Version = z.number().int().nonnegative();

const WritingSettingsSchema = z.object({
    schema: z.literal("nbook.writing-settings/v1"),
    writingPlanId: z.string().min(1).nullable(),
    stylePath: z.string().min(1).nullable(),
}).strict();

export const WritingBasisSchema = z.object({
    chapterVersion: Version,
    chapterContentHash: ContentHash,
    details: z.array(z.object({entryId: EntryId, version: Version, contentHash: ContentHash}).strict()),
}).strict();

const WritingSourceSchema = WritingBasisSchema.extend({
    planId: z.string().min(1),
    generatedAt: z.string().datetime({offset: true}),
}).strict();

const WritingFieldSchema = z.object({
    schema: z.literal("nbook.writing-source/v1"),
    chapterEntryId: EntryId,
    source: WritingSourceSchema.optional(),
}).strict();

/**
 * 卷目录与卷纲的对应标记。创建正文时据此找回已建的卷目录，
 * 用户改卷名或移动卷目录后仍能对上，不必按目录名猜测。
 */
const WritingVolumeMarkerSchema = z.object({
    schema: z.literal("nbook.writing-volume/v1"),
    volumeEntryId: EntryId,
}).strict();

export type WritingField = z.infer<typeof WritingFieldSchema>;
export type WritingSource = z.infer<typeof WritingSourceSchema>;

export const EMPTY_WRITING_SETTINGS: WritingSettingsDto = {schema: "nbook.writing-settings/v1", writingPlanId: null, stylePath: null};

export function parseWritingSettings(content: string): {settings: WritingSettingsDto; error?: string} {
    try {
        const parsed = WritingSettingsSchema.safeParse(YAML.parse(content));
        if (parsed.success) return {settings: parsed.data};
        return {settings: EMPTY_WRITING_SETTINGS, error: `写作设置格式非法：${parsed.error.issues[0]?.message ?? "未知错误"}`};
    } catch (error) {
        return {settings: EMPTY_WRITING_SETTINGS, error: `写作设置无法解析：${error instanceof Error ? error.message : String(error)}`};
    }
}

export function serializeWritingSettings(settings: WritingSettingsDto): string {
    return YAML.stringify(WritingSettingsSchema.parse(settings));
}

export type WritingFieldState =
    | {kind: "none"}
    | {kind: "linked"; value: WritingField}
    | {kind: "invalid"; message: string};

export function readWritingField(frontmatter: WorkspaceFrontmatter, frontmatterError: string | null): WritingFieldState {
    if (frontmatterError !== null) return {kind: "invalid", message: `文件头无法解析：${frontmatterError}`};
    if (!Object.hasOwn(frontmatter, "writing")) return {kind: "none"};
    const parsed = WritingFieldSchema.safeParse(frontmatter.writing);
    if (parsed.success) return {kind: "linked", value: parsed.data};
    const issue = parsed.error.issues[0];
    return {kind: "invalid", message: `writing 字段格式非法：${issue ? `${issue.path.join(".") || "writing"} ${issue.message}` : "未知错误"}`};
}

export function readVolumeMarker(frontmatter: WorkspaceFrontmatter): string | null {
    const parsed = WritingVolumeMarkerSchema.safeParse(frontmatter.writing);
    return parsed.success ? parsed.data.volumeEntryId : null;
}

export const FRONTMATTER_PATTERN = /^---(\r?\n)([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
/** 贴近常见手写格式：不给流式集合加内侧空格，不折行长字符串。 */
const PRESERVING_STRINGIFY = {flowCollectionPadding: false, lineWidth: 0} as const;

/**
 * 只改写文件头中的一个顶层字段，保留其他字段、注释和正文原样。
 * 用 YAML Document 原地编辑而不是解析后重新序列化，避免用户手写的文件头被整体重排。
 */
export function setFrontmatterField(markdown: string, key: string, value: unknown | null): string {
    const match = markdown.match(FRONTMATTER_PATTERN);
    if (!match) {
        if (value === null) return markdown;
        const doc = new YAML.Document({[key]: value});
        return `---\n${doc.toString(PRESERVING_STRINGIFY)}---\n\n${markdown}`;
    }
    const eol = match[1]!;
    const doc = YAML.parseDocument(match[2]!);
    if (doc.errors.length > 0) throw new WritingError("FRONTMATTER_INVALID", `文件头无法解析：${doc.errors[0]!.message}`);
    if (doc.contents !== null && !YAML.isMap(doc.contents)) throw new WritingError("FRONTMATTER_INVALID", "文件头必须是对象");
    const rest = markdown.slice(match[0].length);
    if (value === null) {
        if (!doc.has(key)) return markdown;
        doc.delete(key);
    } else {
        doc.set(key, doc.createNode(value));
    }
    const yaml = doc.toString(PRESERVING_STRINGIFY).replace(/\r?\n/gu, eol);
    // 删掉最后一个字段后文档只剩 `{}`，保留空文件头比写出花括号更接近用户原来的格式。
    const text = yaml.trim() === "{}" ? "" : yaml;
    return `---${eol}${text}---${eol}${rest}`;
}

/** 正文文件拆成文件头与正文；正文去掉首尾空白，写作追加与哈希比较都以它为准。 */
export function splitProseDocument(markdown: string): Readonly<{head: string; body: string}> {
    const match = markdown.match(FRONTMATTER_PATTERN);
    const head = match ? match[0] : "";
    return {head, body: markdown.slice(head.length).trim()};
}

export function joinProseDocument(head: string, body: string): string {
    if (head === "") return body === "" ? "" : `${body}\n`;
    const eol = head.includes("\r\n") ? "\r\n" : "\n";
    const normalizedHead = /\r?\n$/u.test(head) ? head : `${head}${eol}`;
    return body === "" ? `${normalizedHead}${eol}` : `${normalizedHead}${eol}${body}${eol}`;
}

/** 场景之间以段落分隔；正文为空时直接作为开头。 */
export function appendSceneText(body: string, text: string): string {
    return body === "" ? text : `${body}\n\n${text}`;
}

export function proseBodyHash(body: string): string {
    return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}

export function writingFieldValue(chapterEntryId: OutlineId, source?: WritingSource): WritingField {
    return {schema: "nbook.writing-source/v1", chapterEntryId, ...(source === undefined ? {} : {source})};
}

/** 正文文件：`manuscript/` 下类型为 chapter 的内容节点目录，正文在其 `index.md`。 */
export type ProseFile = Readonly<{
    /** `index.md` 的工作区相对路径。 */
    path: string;
    /** 内容节点目录，不带末尾斜杠。 */
    dirPath: string;
    title: string;
    empty: boolean;
    field: WritingFieldState;
}>;

export type VolumeDirectory = Readonly<{dirPath: string; volumeEntryId: string | null}>;

const trimSlash = (value: string) => value.replace(/\/+$/u, "");
const inManuscript = (value: string) => value.startsWith(`${MANUSCRIPT_ROOT}/`);

export function collectProseFiles(nodes: readonly WorkspaceFileNode[]): ProseFile[] {
    return nodes
        .filter((node) => node.isDirectory && node.contentNode && node.entryType === "chapter" && inManuscript(node.path))
        .map((node) => {
            const dirPath = trimSlash(node.path);
            return {path: `${dirPath}/index.md`, dirPath, title: node.title || dirPath.split("/").at(-1)!,
                empty: node.words === 0, field: readWritingField(node.frontmatter, node.frontmatterError)};
        })
        .sort((a, b) => a.path.localeCompare(b.path, "zh-Hans-CN"));
}

export function collectVolumeDirectories(nodes: readonly WorkspaceFileNode[]): VolumeDirectory[] {
    return nodes
        .filter((node) => node.isDirectory && node.contentNode && node.entryType === "volume" && inManuscript(node.path))
        .map((node) => ({dirPath: trimSlash(node.path), volumeEntryId: node.frontmatterError === null ? readVolumeMarker(node.frontmatter) : null}))
        .sort((a, b) => a.dirPath.localeCompare(b.dirPath, "zh-Hans-CN"));
}

export function currentChapterBasis(chapter: WriterChapterSummary): WriterChapterBasis {
    return {chapterVersion: chapter.version, chapterContentHash: chapter.contentHash,
        details: chapter.details.map(({entryId, version, contentHash}) => ({entryId, version, contentHash}))};
}

export type WritingPlanning =
    | {kind: "ready"; plans: readonly {id: string; title: string}[]; revision: number; chapters: readonly WriterChapterSummary[] | null}
    | {kind: "unreadable"; message: string};

const proseRef = (file: ProseFile): WritingProseRefDto => ({path: file.path, title: file.title, empty: file.empty,
    hasSource: file.field.kind === "linked" && file.field.value.source !== undefined});

function chapterStatus(chapter: WriterChapterSummary, prose: readonly ProseFile[]): WritingChapterStatus {
    if (prose.length > 1) return "ownership-conflict";
    if (chapter.block?.code === "OUTLINE_NOT_ADOPTED") return "outline-not-adopted";
    if (chapter.block?.code === "DETAIL_NOT_REVIEWED") return "detail-not-reviewed";
    const file = prose[0];
    if (file === undefined || file.empty) return "unwritten";
    const source = file.field.kind === "linked" ? file.field.value.source : undefined;
    // source 的 planId 只作审计：同一章在两个方案中的细纲相同，就不算依据过期。
    if (source === undefined || sameWriterChapterBasis(source, currentChapterBasis(chapter))) return "written";
    return "source-stale";
}

/**
 * 章节状态每次重新派生：规划决定章节范围与可写性，正文文件头只提供归属和依据。
 * 规划不可读或方案为空时不列章节，全部正文进入未关联正文，保证仍可打开编辑。
 */
export function deriveWritingOverview(input: Readonly<{
    settings: WritingSettingsDto;
    settingsError?: string;
    planning: WritingPlanning;
    proseFiles: readonly ProseFile[];
}>): WritingOverviewDto {
    const {settings, planning, proseFiles} = input;
    const planId = settings.writingPlanId;
    let plan: WritingPlanStateDto;
    let chapters: readonly WriterChapterSummary[] = [];
    if (planId === null) {
        plan = {state: "unset"};
    } else if (planning.kind === "unreadable") {
        plan = {state: "unreadable", planId, message: planning.message};
    } else if (planning.chapters === null) {
        plan = {state: "missing", planId, message: "写作方案在大纲中已不存在，请重新选择"};
    } else {
        const title = planning.plans.find(({id}) => id === planId)?.title ?? planId;
        plan = {state: "ready", planId, title, revision: planning.revision};
        chapters = planning.chapters;
    }
    const chapterIds = new Set(chapters.map(({entryId}) => entryId));
    const byChapter = new Map<string, ProseFile[]>();
    const unlinkedProse: WritingUnlinkedProseDto[] = [];
    for (const file of proseFiles) {
        const base = {path: file.path, title: file.title};
        if (file.field.kind === "none") {
            unlinkedProse.push({...base, reason: "no-link"});
        } else if (file.field.kind === "invalid") {
            unlinkedProse.push({...base, reason: "invalid-link", message: file.field.message});
        } else if (plan.state !== "ready") {
            unlinkedProse.push({...base, reason: "plan-unavailable", chapterEntryId: file.field.value.chapterEntryId});
        } else if (!chapterIds.has(file.field.value.chapterEntryId)) {
            unlinkedProse.push({...base, reason: "not-in-plan", chapterEntryId: file.field.value.chapterEntryId});
        } else {
            const list = byChapter.get(file.field.value.chapterEntryId) ?? [];
            list.push(file);
            byChapter.set(file.field.value.chapterEntryId, list);
        }
    }
    const chapterDtos = chapters.map((chapter): WritingChapterDto => {
        const prose = byChapter.get(chapter.entryId) ?? [];
        const status = chapterStatus(chapter, prose);
        return {entryId: chapter.entryId, title: chapter.title, version: chapter.version, contentHash: chapter.contentHash,
            volume: chapter.volume === null ? null : {...chapter.volume},
            details: chapter.details.map(({entryId, title, version, contentHash}) => ({entryId, title, version, contentHash})),
            status, writable: chapter.writable && status !== "ownership-conflict",
            ...(chapter.block === undefined ? {} : {block: {...chapter.block}}),
            prose: prose.map(proseRef)};
    });
    return {settings, ...(input.settingsError === undefined ? {} : {settingsError: input.settingsError}),
        plans: planning.kind === "ready" ? planning.plans.map(({id, title}) => ({id, title})) : [],
        plan, chapters: chapterDtos, unlinkedProse};
}

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu;
const MAX_NAME_LENGTH = 80;

/** 标题转目录名：去掉 Windows 与 POSIX 都不接受的字符，避免同一作品在不同系统上无法打开。 */
export function sanitizeDirectoryName(title: string): string {
    let name = title
        .replace(/[\\/:*?"<>|\p{Cc}]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
        .replace(/^\.+/u, "")
        .replace(/[. ]+$/u, "");
    name = [...name].slice(0, MAX_NAME_LENGTH).join("").replace(/[. ]+$/u, "");
    if (name === "") return "未命名";
    return WINDOWS_DEVICE_NAME.test(name) ? `_${name}` : name;
}

/** 同名追加 `-2`、`-3`；按不区分大小写比较，因为 Windows 与 macOS 默认文件系统如此。 */
export function uniqueDirectoryName(base: string, existingNames: Iterable<string>): string {
    const taken = new Set([...existingNames].map((name) => name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let index = 2; ; index++) {
        const candidate = `${base}-${index}`;
        if (!taken.has(candidate.toLowerCase())) return candidate;
    }
}

const parentDir = (dirPath: string) => dirPath.slice(0, dirPath.lastIndexOf("/"));

export type VolumeTarget = {kind: "root"} | {kind: "existing"; dirPath: string} | {kind: "create"};

/**
 * 找章节正文应放入的卷目录：先认卷目录上的对应标记，
 * 再认同卷其他章节已有正文共同所在的卷目录（兼容手动关联的旧卷目录），都没有才新建。
 */
export function resolveVolumeTarget(input: Readonly<{
    chapter: WriterChapterSummary;
    chapters: readonly WriterChapterSummary[];
    volumeDirectories: readonly VolumeDirectory[];
    proseFiles: readonly ProseFile[];
}>): VolumeTarget {
    const volume = input.chapter.volume;
    if (volume === null) return {kind: "root"};
    const marked = input.volumeDirectories.find(({volumeEntryId}) => volumeEntryId === volume.entryId);
    if (marked) return {kind: "existing", dirPath: marked.dirPath};
    const siblings = new Set(input.chapters.filter((item) => item.volume?.entryId === volume.entryId).map(({entryId}) => entryId));
    const volumeDirs = new Set(input.volumeDirectories.map(({dirPath}) => dirPath));
    const parents = new Set(input.proseFiles
        .filter((file) => file.field.kind === "linked" && siblings.has(file.field.value.chapterEntryId))
        .map((file) => parentDir(file.dirPath)));
    if (parents.size === 1) {
        const [only] = parents;
        if (volumeDirs.has(only!)) return {kind: "existing", dirPath: only!};
    }
    return {kind: "create"};
}

export function renderChapterIndex(title: string, chapterEntryId: OutlineId): string {
    return `---\n${YAML.stringify({title, type: "chapter", status: "draft", writing: writingFieldValue(chapterEntryId)})}---\n\n`;
}

export function renderVolumeIndex(title: string, volumeEntryId: string): string {
    const writing = {schema: "nbook.writing-volume/v1", volumeEntryId};
    return `---\n${YAML.stringify({title, type: "volume", status: "draft", writing})}---\n\n`;
}
