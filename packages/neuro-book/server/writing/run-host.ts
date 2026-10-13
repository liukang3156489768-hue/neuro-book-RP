import type {JsonValue} from "@notnotype/nb-workflow";
import type {NeuroAgentHarness} from "nbook/server/agent/harness/neuro-agent-harness";
import type {ReadyProjectSessionRef} from "nbook/server/workspace-files/project-session-types";
import type {
    WritingChapterSessionDto, WritingChapterSessionItemDto, WritingRunProgressDto, WritingRunSummaryDto, WritingWriterOutputDto,
} from "nbook/shared/dto/writing.dto";
import {readReadyWritingOverview} from "./host";
import {WritingError} from "./prose-binding";
import {askRole} from "./run-progress";
import {trackWritingRun} from "./run-report";
import type {WritingRunSummary} from "./run-service";
import {useWritingRunService} from "./runtime";
import {WRITING_PROFILES, type WritingMode} from "./writing-workflow";

/**
 * 写作视图的运行操作。发起写作和改写只经主创；界面只能停止、续写和应答交给用户的项。
 * 界面推进的运行和主创工具发起的一样，停下时把报告交回这一章的主创会话。
 */

type Host = Readonly<{harness: NeuroAgentHarness; ready: ReadyProjectSessionRef}>;

/** 用户在界面上的决定：场景规划的通过或退回，改写的替换或放弃。 */
export type WritingUserDecision = Readonly<{approved: boolean; comments?: string}> | Readonly<{replace: boolean}>;

async function requireChapterTitle(ready: ReadyProjectSessionRef, chapterEntryId: string): Promise<string> {
    const chapter = (await readReadyWritingOverview(ready)).chapters.find(({entryId}) => entryId === chapterEntryId);
    if (!chapter) throw new WritingError("CHAPTER_NOT_IN_PLAN", `写作方案中没有该章节：${chapterEntryId}`);
    return chapter.title;
}

async function report(host: Host, summary: WritingRunSummary, userAction: string): Promise<void> {
    const sessionId = await findChapterSession(host, summary.chapterEntryId);
    // 运行只能经主创发起，会话缺失只会因为用户归档了它；此时没有可交回报告的会话，进度卡片仍按运行记录显示。
    if (sessionId === null) return;
    trackWritingRun({harness: host.harness, ownerSessionId: sessionId, service: useWritingRunService(host.harness, host.ready), summary,
        chapterTitle: await requireChapterTitle(host.ready, summary.chapterEntryId), userAction});
}

export function listWritingRuns(host: Host, chapterEntryId: string): Promise<WritingRunSummaryDto[]> {
    return useWritingRunService(host.harness, host.ready).chapterRunSummaries(chapterEntryId);
}

export function listActiveWritingRuns(host: Host): Promise<WritingRunSummaryDto[]> {
    return useWritingRunService(host.harness, host.ready).activeRunSummaries();
}

export function readWritingRunProgress(host: Host, runId: string): Promise<WritingRunProgressDto> {
    return useWritingRunService(host.harness, host.ready).progress(runId);
}

/** 完整正文与思考只在用户展开时读取；常规进度轮询不重复读取所有写手会话。 */
export async function readWritingWriterOutput(host: Host, runId: string, sessionId: number): Promise<WritingWriterOutputDto> {
    const progress = await readWritingRunProgress(host, runId);
    const attempts = progress.kind === "chapter" ? progress.scenes.flatMap(scene => scene.attempts) : progress.attempts;
    if (!attempts.some(attempt => attempt.writerSessionId === sessionId)) {
        throw new WritingError("RUN_NOT_FOUND", "该写手会话不属于此写作运行");
    }
    const snapshot = await host.harness.repo.readSession(sessionId);
    if (snapshot.metadata.profileKey !== WRITING_PROFILES.writer
        || snapshot.metadata.currentProjectRoot !== host.ready.workspace.ref.projectRoot) {
        throw new WritingError("RUN_NOT_FOUND", "该写手会话不属于当前作品");
    }
    const thinking: string[] = [];
    const output: string[] = [];
    // 归档不删除会话；只读 active path，避免将分支或用户任务模板误当写手产出。
    for (const entry of host.harness.repo.activePath(snapshot)) {
        if (entry.type !== "message" || entry.message.role !== "assistant") continue;
        for (const block of entry.message.content) {
            if (block.type === "thinking") thinking.push(block.thinking);
            if (block.type === "text") output.push(block.text);
        }
    }
    return {sessionId, thinking: thinking.join("\n\n"), output: output.join("\n\n")};
}

/** 停止后本章主创会话里跟踪这次运行的任务会自己交回“已停止”，这里不另发报告。 */
export async function stopWritingRun(host: Host, runId: string): Promise<WritingRunProgressDto> {
    const service = useWritingRunService(host.harness, host.ready);
    await service.stop(runId);
    return service.progress(runId);
}

export async function continueWritingRun(host: Host, input: Readonly<{chapterEntryId: string; mode?: WritingMode}>): Promise<WritingRunProgressDto> {
    const service = useWritingRunService(host.harness, host.ready);
    const summary = await service.continue(input);
    await report(host, summary, "续写了本章");
    return service.progress(summary.runId);
}

export async function answerWritingRun(host: Host, input: Readonly<{runId: string; key: string; decision: WritingUserDecision}>):
    Promise<WritingRunProgressDto> {
    const service = useWritingRunService(host.harness, host.ready);
    const ask = (await service.view(input.runId)).pendingAsks.find(({key}) => key === input.key);
    if (ask === undefined) throw new WritingError("RUN_ANSWER_INVALID", "该运行没有这项待应答");
    const role = askRole(ask.spec.title);
    let answer: JsonValue;
    let action: string;
    if (role === "rewrite-confirm" && "replace" in input.decision) {
        answer = input.decision.replace;
        action = input.decision.replace ? "确认替换改写段落" : "放弃了改写";
    } else if (role === "user-confirm" && "approved" in input.decision) {
        const comments = input.decision.comments?.trim() ?? "";
        if (!input.decision.approved && comments === "") throw new WritingError("RUN_ANSWER_INVALID", "退回场景规划时必须写明意见");
        answer = comments === "" ? {approved: input.decision.approved} : {approved: input.decision.approved, comments};
        action = input.decision.approved ? "通过了场景规划" : `退回了场景规划，意见：${comments}`;
    } else {
        // 主创核对由 service 拒绝用户应答；决定与待应答项不对应时在这里拒绝。
        if (role === "lead-review") throw new WritingError("RUN_ANSWER_INVALID", "场景规划正在等待主创核对，不能由用户应答");
        throw new WritingError("RUN_ANSWER_INVALID", "应答与待应答项不对应");
    }
    const summary = await service.answer(input.runId, {[ask.key]: answer}, "user");
    await report(host, summary, action);
    return service.progress(summary.runId);
}

/*
 * 章节会话：一章可以有多个主创会话，按标签查找。
 * 章节 id 在规划中稳定，标题可能改名，所以按 id 打标签；归档（界面上的“删除”）的会话不再算作这一章的会话。
 * 最近更新的会话是这一章的当前会话：界面默认打开它，界面推进的运行也把报告交回它。
 */

function chapterTag(chapterEntryId: string): string {
    return `writing-chapter:${chapterEntryId}`;
}

/** 按更新时间倒序。 */
export async function listChapterSessions(host: Host, chapterEntryId: string): Promise<WritingChapterSessionItemDto[]> {
    const tag = chapterTag(chapterEntryId);
    const summaries = await host.harness.repo.listSessions({
        profileKey: WRITING_PROFILES.lead, scope: "project", projectRoot: host.ready.workspace.ref.projectRoot,
    });
    const items: WritingChapterSessionItemDto[] = [];
    for (const summary of summaries) {
        if (summary.archived) continue;
        if (!(await host.harness.repo.readSession(summary.sessionId)).metadata.tags?.includes(tag)) continue;
        items.push({sessionId: summary.sessionId, title: summary.title ?? `会话 ${summary.sessionId}`, updatedAt: summary.updatedAt,
            ...(summary.lastMessagePreview === undefined ? {} : {preview: summary.lastMessagePreview})});
    }
    return items.sort((a, b) => b.updatedAt - a.updatedAt || b.sessionId - a.sessionId);
}

export async function findChapterSession(host: Host, chapterEntryId: string): Promise<number | null> {
    return (await listChapterSessions(host, chapterEntryId))[0]?.sessionId ?? null;
}

export async function readChapterSession(host: Host, chapterEntryId: string): Promise<WritingChapterSessionDto> {
    return {chapterEntryId, sessionId: await findChapterSession(host, chapterEntryId)};
}

async function createChapterSession(host: Host, chapterEntryId: string): Promise<WritingChapterSessionDto> {
    const title = await requireChapterTitle(host.ready, chapterEntryId);
    const created = await host.harness.createAgent({
        profileKey: WRITING_PROFILES.lead,
        initial: {chapterEntryId},
        title: `写作 ${title}`,
        tags: [chapterTag(chapterEntryId)],
        currentProjectRoot: host.ready.workspace.ref.projectRoot,
    });
    return {chapterEntryId, sessionId: created.sessionId};
}

/** 用户主动新建：总是新开一个会话，旧会话保留在列表里。 */
export function startChapterSession(host: Host, chapterEntryId: string): Promise<WritingChapterSessionDto> {
    return serialized(host, chapterEntryId, () => createChapterSession(host, chapterEntryId));
}

/**
 * 删除即归档，会话文件保留，可在全局会话列表中恢复。
 * 有进行中的写作运行时拒绝：运行停下时要把报告交回本章会话，删掉正在对话的会话会让用户看不到结果。
 */
export async function deleteChapterSession(host: Host, input: Readonly<{chapterEntryId: string; sessionId: number}>):
    Promise<WritingChapterSessionItemDto[]> {
    if (!(await listChapterSessions(host, input.chapterEntryId)).some(({sessionId}) => sessionId === input.sessionId)) {
        throw new WritingError("CHAPTER_NOT_IN_PLAN", "该会话不属于这一章");
    }
    const running = (await listActiveWritingRuns(host)).some(({chapterEntryId}) => chapterEntryId === input.chapterEntryId);
    if (running) throw new WritingError("RUN_ACTIVE", "这一章有写作运行正在进行，停止后再删除会话");
    // 仓储摘要不含运行中的实时状态，回复中与等待回答要看 harness 的运行态投影。
    const summary = (await host.harness.listSessions({profileKey: WRITING_PROFILES.lead, scope: "project",
        projectRoot: host.ready.workspace.ref.projectRoot})).find(({sessionId}) => sessionId === input.sessionId);
    if (summary && summary.status !== "idle" && summary.status !== "interrupted") {
        throw new WritingError("RUN_ACTIVE", "主创正在回复或等待回答，结束后再删除会话");
    }
    await host.harness.runCommand(input.sessionId, {command: "archive", reason: "writing.chapter-session.delete"});
    return listChapterSessions(host, input.chapterEntryId);
}

/** 同一章的并发创建串行执行，第二次拿到第一次创建的会话；键含项目根，不同项目互不等待。 */
const creating = new Map<string, Promise<unknown>>();

export function ensureChapterSession(host: Host, chapterEntryId: string): Promise<WritingChapterSessionDto> {
    return serialized(host, chapterEntryId, async () => {
        const existing = await findChapterSession(host, chapterEntryId);
        return existing !== null ? {chapterEntryId, sessionId: existing} : createChapterSession(host, chapterEntryId);
    });
}

function serialized<T>(host: Host, chapterEntryId: string, operation: () => Promise<T>): Promise<T> {
    const key = `${host.ready.workspace.root}\u0000${chapterEntryId}`;
    const next = (creating.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
    creating.set(key, next);
    void next.finally(() => {
        if (creating.get(key) === next) creating.delete(key);
    }).catch(() => undefined);
    return next;
}
