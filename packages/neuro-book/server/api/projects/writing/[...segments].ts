import {createError, getQuery} from "h3";
import {useAgentHarness} from "nbook/server/agent/http";
import {z} from "zod";
import {requireProjectRefQuery} from "nbook/server/api/projects/project-control-plane";
import {withProjectHttpError} from "nbook/server/api/projects/project-http-error";
import {validateBody} from "nbook/server/utils/novel-chapter";
import {requireActiveReadyProject} from "nbook/server/workspace-files/project-session";
import {
    createReadyWritingStyle, deleteReadyWritingStyle, ignoreReadyWritingIssue, linkReadyProse, listReadyWritingStyles, readReadyWritingEntry, readReadyWritingIssues, readReadyWritingOverview, setReadyWritingPlan, setReadyWritingStyle,
    unlinkReadyProse,
} from "nbook/server/writing/host";
import {WritingError, type WritingErrorCode} from "nbook/server/writing/prose-binding";
import {
    answerWritingRun, continueWritingRun, deleteChapterSession, ensureChapterSession, listActiveWritingRuns, listChapterSessions, listWritingRuns,
    readChapterSession, readWritingRunProgress, readWritingWriterOutput, startChapterSession, stopWritingRun,
} from "nbook/server/writing/run-host";
import {readWritingRoleModels, saveWritingRoleModel} from "nbook/server/writing/role-models";
import {ThinkingLevelSchema} from "nbook/shared/dto/app-settings.dto";

const EntryId = z.string().regex(/^ol-[a-z0-9][a-z0-9-]*$/u);
const ProsePath = z.string().min(1).max(1024);
const SetPlanBody = z.object({planId: z.string().min(1).nullable()}).strict();
const SetStyleBody = z.object({stylePath: z.string().min(1).max(1024).nullable()}).strict();
const CreateStyleBody = z.object({title: z.string().trim().min(1).max(80)}).strict();
const DeleteStyleBody = z.object({stylePath: z.string().min(1).max(1024)}).strict();
const LinkBody = z.object({path: ProsePath, chapterEntryId: EntryId}).strict();
const UnlinkBody = z.object({path: ProsePath}).strict();
const IgnoreIssueBody = z.object({chapterEntryId: EntryId, issueId: z.string().regex(/^wi-[a-z0-9]+$/u)}).strict();
const RunId = z.string().min(1).max(200);
const ChapterQuery = z.object({chapterEntryId: EntryId});
const EntryQuery = z.object({entryId: EntryId});
const RunQuery = z.object({runId: RunId});
const WriterOutputQuery = z.object({runId: RunId, sessionId: z.coerce.number().int().positive()});
const StopBody = z.object({runId: RunId}).strict();
const ContinueBody = z.object({chapterEntryId: EntryId, mode: z.enum(["auto", "discussion"]).optional()}).strict();
const AnswerBody = z.object({
    runId: RunId,
    key: z.string().min(1),
    decision: z.union([
        z.object({approved: z.boolean(), comments: z.string().max(4000).optional()}).strict(),
        z.object({replace: z.boolean()}).strict(),
    ]),
}).strict();
const ChapterSessionBody = z.object({chapterEntryId: EntryId, fresh: z.literal(true).optional()}).strict();
const DeleteSessionBody = z.object({chapterEntryId: EntryId, sessionId: z.number().int().positive()}).strict();
const RoleModelBody = z.object({
    role: z.enum(["lead", "assistant", "writer"]),
    settings: z.object({
        modelKey: z.string().trim().min(1).nullable(),
        reasoningEffort: ThinkingLevelSchema.nullable(),
        temperature: z.number().min(0).max(2).nullable(),
    }).strict(),
}).strict();

const STATUS: Record<WritingErrorCode, number> = {
    PLAN_NOT_FOUND: 404,
    CHAPTER_NOT_IN_PLAN: 404,
    PROSE_NOT_FOUND: 404,
    INVALID_PATH: 400,
    CHAPTER_HAS_PROSE: 409,
    PROSE_LINKED: 409,
    OWNERSHIP_CONFLICT: 409,
    BASIS_CHANGED: 409,
    PLANNING_UNREADABLE: 422,
    CHAPTER_NOT_WRITABLE: 422,
    STYLE_INVALID: 422,
    FRONTMATTER_INVALID: 422,
    ISSUE_INVALID: 400,
    ISSUE_NOT_FOUND: 404,
    ISSUE_NOT_IGNORABLE: 409,
    ISSUES_UNREADABLE: 422,
    RUN_ACTIVE: 409,
    RUN_NOT_FOUND: 404,
    RUN_ANSWER_INVALID: 400,
    MODEL_INVALID: 422,
};

function query<T>(event: Parameters<typeof getQuery>[0], schema: z.ZodType<T>): T {
    const parsed = schema.safeParse(getQuery(event));
    if (!parsed.success) throw createError({statusCode: 400, message: "写作 API 查询参数无效", data: {issues: parsed.error.issues}});
    return parsed.data;
}

/**
 * 写作数据面只接受已打开 Project；章节状态每次从规划与正文文件头重新派生。
 * 运行接口不开放发起写作和改写：发起只经主创，界面只能停止、续写和应答交给用户的项。
 */
export default defineEventHandler((event) => withProjectHttpError(async () => {
    try {
        const ready = requireActiveReadyProject(requireProjectRefQuery(event));
        const raw = event.context.params?.segments;
        const segments = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split("/") : [];
        const route = segments.length === 1 ? `${event.method} ${segments[0]}` : "";
        const actor = {kind: "user" as const, userId: "local"};
        if (route === "GET overview") return await readReadyWritingOverview(ready);
        if (route === "GET styles") return await listReadyWritingStyles(ready);
        if (route === "GET entry") return await readReadyWritingEntry(ready, query(event, EntryQuery).entryId);
        if (route === "POST set-plan") {
            const {planId} = await validateBody(event, SetPlanBody);
            return await setReadyWritingPlan(ready, planId, actor);
        }
        if (route === "POST set-style") {
            const {stylePath} = await validateBody(event, SetStyleBody);
            return await setReadyWritingStyle(ready, stylePath, actor);
        }
        if (route === "POST create-style") return await createReadyWritingStyle(ready, (await validateBody(event, CreateStyleBody)).title, actor);
        if (route === "POST link-prose") return await linkReadyProse(ready, await validateBody(event, LinkBody), actor);
        if (route === "POST unlink-prose") return await unlinkReadyProse(ready, await validateBody(event, UnlinkBody), actor);
        if (route === "GET issues") return await readReadyWritingIssues(ready);
        if (route === "POST ignore-issue") return await ignoreReadyWritingIssue(ready, await validateBody(event, IgnoreIssueBody), actor);
        const host = () => ({harness: useAgentHarness(), ready});
        if (route === "POST delete-style") {
            const {stylePath} = await validateBody(event, DeleteStyleBody);
            // 运行只在场景开始前重读文风，删除会让进行中的运行半途停下；先停止运行再删。
            if ((await listActiveWritingRuns(host())).length > 0) throw new WritingError("RUN_ACTIVE", "有写作运行正在进行，停止后再删除文风");
            return await deleteReadyWritingStyle(ready, stylePath, actor);
        }
        if (route === "GET runs") return await listWritingRuns(host(), query(event, ChapterQuery).chapterEntryId);
        if (route === "GET active-runs") return await listActiveWritingRuns(host());
        if (route === "GET run") return await readWritingRunProgress(host(), query(event, RunQuery).runId);
        if (route === "GET writer-output") {
            const {runId, sessionId} = query(event, WriterOutputQuery);
            return await readWritingWriterOutput(host(), runId, sessionId);
        }
        if (route === "POST stop") return await stopWritingRun(host(), (await validateBody(event, StopBody)).runId);
        if (route === "POST continue") return await continueWritingRun(host(), await validateBody(event, ContinueBody));
        if (route === "POST answer") return await answerWritingRun(host(), await validateBody(event, AnswerBody));
        if (route === "GET chapter-session") return await readChapterSession(host(), query(event, ChapterQuery).chapterEntryId);
        if (route === "POST chapter-session") {
            const {chapterEntryId, fresh} = await validateBody(event, ChapterSessionBody);
            return await (fresh ? startChapterSession : ensureChapterSession)(host(), chapterEntryId);
        }
        if (route === "GET chapter-sessions") return await listChapterSessions(host(), query(event, ChapterQuery).chapterEntryId);
        if (route === "POST delete-chapter-session") return await deleteChapterSession(host(), await validateBody(event, DeleteSessionBody));
        if (route === "GET role-models") return await readWritingRoleModels(ready.workspace.ref.projectRoot);
        if (route === "POST role-model") {
            const {role, settings} = await validateBody(event, RoleModelBody);
            return await saveWritingRoleModel(ready.workspace.ref.projectRoot, role, settings);
        }
        throw createError({statusCode: 404, message: "未知 Project 写作 API"});
    } catch (error) {
        if (error instanceof WritingError) {
            throw createError({statusCode: STATUS[error.code], message: error.message, data: {code: error.code}});
        }
        throw error;
    }
}));
