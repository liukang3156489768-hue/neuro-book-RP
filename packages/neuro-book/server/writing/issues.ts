import YAML from "yaml";
import {z} from "zod";
import type {WriterChapterSummary} from "nbook/server/outline/writer-context";
import type {
    WritingChapterIssuesDto, WritingIssueBasis, WritingIssueCode, WritingIssueDraft, WritingIssueDto, WritingIssueLocation,
    WritingIssueRegistrar, WritingIssueSeverity, WritingIssueStatus,
} from "nbook/shared/dto/writing.dto";
import {WritingError} from "./prose-binding";

export const WRITING_ISSUES_ROOT = "writing/issues";
const ISSUE_FILE_NAME = /^(ol-[a-z0-9][a-z0-9-]*)\.yaml$/u;

export const issueFilePath = (chapterEntryId: string) => `${WRITING_ISSUES_ROOT}/${chapterEntryId}.yaml`;

/** 问题文件名对应的章节 id；不是问题文件时为 null。 */
export function issueFileChapter(fileName: string): string | null {
    return ISSUE_FILE_NAME.exec(fileName)?.[1] ?? null;
}

/** 固定代码的级别；`OTHER` 由助手自填。 */
export const WRITING_ISSUE_SEVERITY: Readonly<Record<Exclude<WritingIssueCode, "OTHER">, WritingIssueSeverity>> = {
    MISSING_SCENE_STRUCTURE: "blocking",
    PLANNING_CHANGED: "blocking",
    SOURCE_UNREADABLE: "blocking",
    GUIDANCE_CONFLICT: "blocking",
    PENDING_REFERENCE: "hint",
    WORD_TARGET_MISMATCH: "hint",
    UNASSIGNED_FORESHADOW: "hint",
    MISSING_PREVIOUS_CHAPTER: "hint",
};

const EntryId = z.string().regex(/^ol-[a-z0-9][a-z0-9-]*$/u, "条目 ID 非法");
const Code = z.enum(["MISSING_SCENE_STRUCTURE", "PLANNING_CHANGED", "SOURCE_UNREADABLE", "GUIDANCE_CONFLICT", "PENDING_REFERENCE",
    "WORD_TARGET_MISMATCH", "UNASSIGNED_FORESHADOW", "MISSING_PREVIOUS_CHAPTER", "OTHER"]);
const Severity = z.enum(["blocking", "hint"]);
const Version = z.number().int().min(0);

const LocationSchema = z.object({
    entryId: EntryId.optional(),
    sceneIndex: z.number().int().min(1).optional(),
    guidanceMarker: z.string().regex(/^[A-Za-z0-9_-]+$/u).optional(),
}).strict();

export const WritingIssueDraftSchema = z.object({
    code: Code,
    severity: Severity,
    message: z.string().trim().min(1).max(2000),
    location: LocationSchema,
}).strict().superRefine((draft, context) => {
    if (draft.code !== "OTHER" && WRITING_ISSUE_SEVERITY[draft.code] !== draft.severity) {
        context.addIssue({code: "custom", path: ["severity"], message: `${draft.code} 的级别必须是 ${WRITING_ISSUE_SEVERITY[draft.code]}`});
    }
});

const BasisSchema = z.object({
    chapterVersion: Version,
    details: z.array(z.object({entryId: EntryId, version: Version}).strict()),
}).strict();

const StoredIssueSchema = z.object({
    id: z.string().regex(/^wi-[a-z0-9]+$/u),
    code: Code,
    severity: Severity,
    message: z.string().min(1),
    location: LocationSchema,
    registrar: z.enum(["assistant", "workflow"]),
    basis: BasisSchema,
    status: z.enum(["open", "resolved", "ignored"]),
    registeredAt: z.string().datetime({offset: true}),
}).strict();

const IssueFileSchema = z.object({
    schema: z.literal("nbook.writing-issues/v1"),
    chapterEntryId: EntryId,
    issues: z.array(StoredIssueSchema),
}).strict();

/**
 * 校验待登记的问题草稿；位置只能指向本章章节大纲或其细纲。
 * 返回全部原因，助手提交的草稿据此退回重填。
 */
export function checkIssueDrafts(drafts: readonly unknown[], entryIds: ReadonlySet<string>):
    Readonly<{ok: true; drafts: WritingIssueDraft[]}> | Readonly<{ok: false; errors: string[]}> {
    const valid: WritingIssueDraft[] = [];
    const errors: string[] = [];
    for (const [index, draft] of drafts.entries()) {
        const parsed = WritingIssueDraftSchema.safeParse(draft);
        if (!parsed.success) {
            const issue = parsed.error.issues[0];
            errors.push(`第 ${index + 1} 条问题格式非法：${issue ? `${issue.path.join(".") || "问题"} ${issue.message}` : "未知错误"}`);
            continue;
        }
        const entryId = parsed.data.location.entryId;
        if (entryId !== undefined && !entryIds.has(entryId)) {
            errors.push(`第 ${index + 1} 条问题的位置不是本章的章节大纲或细纲：${entryId}`);
            continue;
        }
        valid.push(parsed.data);
    }
    return errors.length > 0 ? {ok: false, errors} : {ok: true, drafts: valid};
}

export type StoredIssue = z.infer<typeof StoredIssueSchema>;
export type StoredIssueStatus = StoredIssue["status"];

export type IssueFileResult = Readonly<{ok: true; issues: readonly StoredIssue[]}> | Readonly<{ok: false; message: string}>;

export function parseIssueFile(content: string, chapterEntryId: string): IssueFileResult {
    let raw: unknown;
    try {
        raw = YAML.parse(content);
    } catch (error) {
        return {ok: false, message: `问题记录无法解析：${error instanceof Error ? error.message : String(error)}`};
    }
    const parsed = IssueFileSchema.safeParse(raw);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {ok: false, message: `问题记录格式非法：${issue ? `${issue.path.join(".") || "文件"} ${issue.message}` : "未知错误"}`};
    }
    if (parsed.data.chapterEntryId !== chapterEntryId) return {ok: false, message: "问题记录的章节 id 与文件名不一致"};
    if (new Set(parsed.data.issues.map(({id}) => id)).size !== parsed.data.issues.length) return {ok: false, message: "问题记录的 id 重复"};
    return {ok: true, issues: parsed.data.issues};
}

export function serializeIssueFile(chapterEntryId: string, issues: readonly StoredIssue[]): string {
    return YAML.stringify(IssueFileSchema.parse({schema: "nbook.writing-issues/v1", chapterEntryId, issues}));
}

export function issueBasisOf(chapter: WriterChapterSummary): WritingIssueBasis {
    return {chapterVersion: chapter.version, details: chapter.details.map(({entryId, version}) => ({entryId, version}))};
}

/** 版本号任一不同或细纲有增减即需复核；细纲顺序调整不影响问题本身，不算变化。 */
export function sameIssueBasis(recorded: WritingIssueBasis, current: WritingIssueBasis): boolean {
    if (recorded.chapterVersion !== current.chapterVersion || recorded.details.length !== current.details.length) return false;
    const versions = new Map(current.details.map(({entryId, version}) => [entryId, version]));
    return recorded.details.every(({entryId, version}) => versions.get(entryId) === version);
}

export function deriveIssueStatus(issue: StoredIssue, current: WritingIssueBasis): WritingIssueStatus {
    if (issue.status !== "open") return issue.status;
    return sameIssueBasis(issue.basis, current) ? "open" : "pending-review";
}

/**
 * 同一问题的判定键。`OTHER` 是助手自由登记的问题，同一位置可能有多条不同问题，
 * 只按代码和位置合并会丢掉其中一条，因此再加上说明。
 */
function issueKey(issue: Readonly<{code: WritingIssueCode; message: string; location: WritingIssueLocation}>): string {
    const {entryId = "", sceneIndex = "", guidanceMarker = ""} = issue.location;
    return JSON.stringify([issue.code, entryId, sceneIndex, guidanceMarker, issue.code === "OTHER" ? issue.message.trim() : ""]);
}

export type RegisterOptions = Readonly<{
    registrar: WritingIssueRegistrar;
    basis: WritingIssueBasis;
    now: string;
    createId: () => string;
}>;

/**
 * 登记后每个问题只保留一条记录：
 * - 仍未处理（含待复核）的，更新登记时间和版本，复核后仍存在的问题由此回到未处理；
 * - 已忽略的问题保持忽略，只更新时间和版本；
 * - 已解决的问题重新打开。
 */
export function registerIssues(issues: readonly StoredIssue[], drafts: readonly WritingIssueDraft[], options: RegisterOptions): StoredIssue[] {
    const next = [...issues];
    const index = new Map(next.map((issue, position) => [issueKey(issue), position]));
    const usedIds = new Set(next.map(({id}) => id));
    for (const draft of drafts) {
        const key = issueKey(draft);
        const position = index.get(key);
        const refreshed = {basis: options.basis, registeredAt: options.now};
        if (position === undefined) {
            let id = options.createId();
            while (usedIds.has(id)) id = options.createId();
            usedIds.add(id);
            index.set(key, next.length);
            next.push({id, ...draft, message: draft.message.trim(), registrar: options.registrar, status: "open", ...refreshed});
            continue;
        }
        const existing = next[position]!;
        if (existing.status === "ignored") {
            next[position] = {...existing, ...refreshed};
        } else {
            next[position] = {...existing, severity: draft.severity, message: draft.message.trim(), registrar: options.registrar,
                status: "open", ...refreshed};
        }
    }
    return next;
}

function requireIssue(issues: readonly StoredIssue[], id: string): number {
    const position = issues.findIndex((issue) => issue.id === id);
    if (position < 0) throw new WritingError("ISSUE_NOT_FOUND", `问题不存在：${id}`);
    return position;
}

/** 复核后已不存在的问题；已解决或已忽略的问题保持原状。 */
export function resolveIssues(issues: readonly StoredIssue[], ids: readonly string[]): StoredIssue[] {
    const next = [...issues];
    for (const id of ids) {
        const position = requireIssue(next, id);
        if (next[position]!.status === "open") next[position] = {...next[position]!, status: "resolved"};
    }
    return next;
}

/**
 * 一次写作完成规划后，本次没有再登记的旧问题视为已不存在：
 * - 写作工作流的问题每次都由程序重新检查，没再登记就是已消失。`PLANNING_CHANGED` 这类问题登记时
 *   记的已是变化后的版本，永远不会派生为待复核，只能这样关闭；
 * - 助手的问题只在待复核时才算经过了本次复核，版本未变的仍保持未处理。
 * `since` 必须早于本次所有登记的时间。
 */
export function staleIssueIds(issues: readonly StoredIssue[], current: WritingIssueBasis, since: string): string[] {
    return issues.filter((issue) => issue.status === "open" && issue.registeredAt < since
        && (issue.registrar === "workflow" || deriveIssueStatus(issue, current) === "pending-review")).map(({id}) => id);
}

export function ignoreIssue(issues: readonly StoredIssue[], id: string): StoredIssue[] {
    const next = [...issues];
    const position = requireIssue(next, id);
    const issue = next[position]!;
    if (issue.status === "ignored") return next;
    if (issue.status !== "open") throw new WritingError("ISSUE_NOT_IGNORABLE", "问题已解决，不需要忽略");
    next[position] = {...issue, status: "ignored"};
    return next;
}

/** 只判断本次提交中仍有效的阻断问题，历史或已忽略的记录不能再次阻断。 */
export function hasActiveBlockingDrafts(drafts: readonly WritingIssueDraft[], issues: readonly WritingIssueDto[]): boolean {
    const keys = new Set(drafts.filter(({severity}) => severity === "blocking").map(issueKey));
    return issues.some((issue) => issue.severity === "blocking" && keys.has(issueKey(issue))
        && (issue.status === "open" || issue.status === "pending-review"));
}

export function chapterIssuesDto(chapterEntryId: string, issues: readonly StoredIssue[], current: WritingIssueBasis): WritingChapterIssuesDto {
    const dtos = issues.map((issue): WritingIssueDto => ({...issue, location: {...issue.location}, chapterEntryId,
        basis: {chapterVersion: issue.basis.chapterVersion, details: issue.basis.details.map((detail) => ({...detail}))},
        status: deriveIssueStatus(issue, current)}));
    const active = dtos.filter(({status}) => status === "open" || status === "pending-review");
    return {chapterEntryId, issues: dtos,
        blocking: active.filter(({severity}) => severity === "blocking").length,
        hint: active.filter(({severity}) => severity === "hint").length};
}
