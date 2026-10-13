import {beforeEach, describe, expect, it, vi} from "vitest";
import {LEAD_REVIEW_TITLE, USER_CONFIRM_TITLE} from "./writing-workflow";
import {REWRITE_CONFIRM_TITLE} from "./rewrite";

const mocks = vi.hoisted(() => ({service: {
    view: vi.fn(), answer: vi.fn(), continue: vi.fn(), stop: vi.fn(), progress: vi.fn(), settle: vi.fn(), activeRunSummaries: vi.fn(),
}}));
vi.mock("./runtime", () => ({useWritingRunService: () => mocks.service}));
vi.mock("./host", () => ({readReadyWritingOverview: async () => ({chapters: [{entryId: "ol-ch1", title: "第一章"}]})}));

const {
    answerWritingRun, continueWritingRun, deleteChapterSession, ensureChapterSession, findChapterSession, listChapterSessions, startChapterSession,
    stopWritingRun, readWritingWriterOutput,
} = await import("./run-host");

type Session = {sessionId: number; profileKey: string; currentProjectRoot: string; tags: string[]; updatedAt?: number; archived?: boolean;
    status?: string; title?: string};

function fakeHost(initial: Session[] = []) {
    const sessions = [...initial];
    const spawned: Record<string, unknown>[] = [];
    const harness = {
        repo: {
            activePath: vi.fn(),
            listSessions: vi.fn(async (query: {profileKey: string; projectRoot: string}) => sessions
                .filter((session) => session.profileKey === query.profileKey && session.currentProjectRoot === query.projectRoot)),
            readSession: vi.fn(async (sessionId: number) => ({metadata: {tags: sessions.find((session) => session.sessionId === sessionId)!.tags}})),
        },
        listSessions: vi.fn(async (query: {profileKey: string; projectRoot: string}) => sessions
            .filter((session) => session.profileKey === query.profileKey && session.currentProjectRoot === query.projectRoot)
            .map((session) => ({status: "idle", ...session}))),
        runCommand: vi.fn(async (sessionId: number, body: {command: string}) => {
            if (body.command === "archive") sessions.find((session) => session.sessionId === sessionId)!.archived = true;
            return {};
        }),
        createAgent: vi.fn(async (input: {profileKey: string; tags: string[]; currentProjectRoot: string}) => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            const session = {sessionId: sessions.length + 1, profileKey: input.profileKey, currentProjectRoot: input.currentProjectRoot, tags: input.tags};
            sessions.push(session);
            return {sessionId: session.sessionId, profileKey: input.profileKey};
        }),
        jobs: {spawn: vi.fn((spec: Record<string, unknown>) => {
            spawned.push(spec);
            return {job: {jobId: "job-1"}};
        })},
    };
    const ready = {workspace: {root: "E:/w/demo", ref: {projectRoot: "demo"}}};
    return {host: {harness: harness as never, ready: ready as never}, harness, sessions, spawned};
}

const lead = (sessionId: number, tags: string[], currentProjectRoot = "demo"): Session =>
    ({sessionId, profileKey: "writing.lead", currentProjectRoot, tags});

const summary = {kind: "chapter", runId: "run-1", chapterEntryId: "ol-ch1", status: "running"};

describe("按需读取写手输出", () => {
    it("读取归档写手的完整思考与正文，排除用户任务和非当前分支", async () => {
        const {host, harness} = fakeHost();
        mocks.service.progress.mockResolvedValue({kind: "chapter", scenes: [{attempts: [{writerSessionId: 7}]}]});
        const saved = {metadata: {tags: [], profileKey: "writing.writer", currentProjectRoot: "demo"}};
        harness.repo.readSession.mockResolvedValue(saved);
        const thinking = "完整思考。".repeat(6000);
        const output = "完整正文。".repeat(6000);
        harness.repo.activePath.mockReturnValue([
            {type: "message", message: {role: "user", content: [{type: "text", text: "任务模板"}]}},
            {type: "message", message: {role: "assistant", content: [{type: "thinking", thinking}, {type: "text", text: output}]}},
            {type: "session_archived"},
        ]);
        await expect(readWritingWriterOutput(host, "run-1", 7)).resolves.toEqual({sessionId: 7, thinking, output});
        expect(harness.repo.activePath).toHaveBeenCalledWith(saved);
        expect(harness.createAgent).not.toHaveBeenCalled();
    });

    it("拒绝其他运行、作品或非写手会话；改写也按尝试关联读取", async () => {
        const {host, harness} = fakeHost();
        mocks.service.progress.mockResolvedValue({kind: "rewrite", attempts: [{writerSessionId: 7}]});
        await expect(readWritingWriterOutput(host, "run-1", 8)).rejects.toMatchObject({code: "RUN_NOT_FOUND"});
        expect(harness.repo.readSession).not.toHaveBeenCalled();
        for (const [profileKey, currentProjectRoot] of [["writing.writer", "other"], ["writing.assistant", "demo"]]) {
            const saved = {metadata: {tags: [], profileKey, currentProjectRoot}};
            harness.repo.readSession.mockResolvedValue(saved);
            await expect(readWritingWriterOutput(host, "run-1", 7)).rejects.toMatchObject({code: "RUN_NOT_FOUND"});
        }
        const saved = {metadata: {tags: [], profileKey: "writing.writer", currentProjectRoot: "demo"}};
        harness.repo.readSession.mockResolvedValue(saved);
        harness.repo.activePath.mockReturnValue([]);
        await expect(readWritingWriterOutput(host, "run-1", 7)).resolves.toEqual({sessionId: 7, thinking: "", output: ""});
    });
});

beforeEach(() => {
    vi.clearAllMocks();
    mocks.service.progress.mockResolvedValue("progress");
    mocks.service.answer.mockResolvedValue(summary);
    mocks.service.continue.mockResolvedValue(summary);
    mocks.service.activeRunSummaries.mockResolvedValue([]);
});

describe("章节会话", () => {
    it("按章节标签在本项目的主创会话里查找，其他项目与其他章节不算", async () => {
        const {host} = fakeHost([lead(1, ["writing-chapter:ol-ch1"], "other"), lead(2, ["writing-chapter:ol-ch2"]), lead(3, ["writing-chapter:ol-ch1"]),
            {sessionId: 4, profileKey: "leader.default", currentProjectRoot: "demo", tags: ["writing-chapter:ol-ch1"]}]);
        await expect(findChapterSession(host, "ol-ch1")).resolves.toBe(3);
        await expect(findChapterSession(host, "ol-ch9")).resolves.toBeNull();
    });

    it("首次创建绑定章节与项目；同一章并发创建只建一个会话", async () => {
        const {host, harness} = fakeHost();
        const [a, b] = await Promise.all([ensureChapterSession(host, "ol-ch1"), ensureChapterSession(host, "ol-ch1")]);
        expect(a).toEqual({chapterEntryId: "ol-ch1", sessionId: 1});
        expect(b).toEqual(a);
        expect(harness.createAgent).toHaveBeenCalledTimes(1);
        expect(harness.createAgent).toHaveBeenCalledWith({profileKey: "writing.lead", initial: {chapterEntryId: "ol-ch1"}, title: "写作 第一章",
            tags: ["writing-chapter:ol-ch1"], currentProjectRoot: "demo"});
        await expect(ensureChapterSession(host, "ol-ch9")).rejects.toMatchObject({code: "CHAPTER_NOT_IN_PLAN"});
    });

    it("一章多个会话按更新时间倒序，最近的是当前会话；归档的不算", async () => {
        const tag = ["writing-chapter:ol-ch1"];
        const {host} = fakeHost([{...lead(1, tag), updatedAt: 100, title: "旧"}, {...lead(2, tag), updatedAt: 300, title: "新"},
            {...lead(3, tag), updatedAt: 500, archived: true}]);
        await expect(listChapterSessions(host, "ol-ch1")).resolves.toEqual([
            {sessionId: 2, title: "新", updatedAt: 300}, {sessionId: 1, title: "旧", updatedAt: 100}]);
        await expect(findChapterSession(host, "ol-ch1")).resolves.toBe(2);
    });

    it("用户新建总是另开会话，旧会话保留", async () => {
        const {host, harness} = fakeHost([lead(1, ["writing-chapter:ol-ch1"])]);
        await expect(startChapterSession(host, "ol-ch1")).resolves.toEqual({chapterEntryId: "ol-ch1", sessionId: 2});
        expect(harness.createAgent).toHaveBeenCalledTimes(1);
        expect((await listChapterSessions(host, "ol-ch1")).map(({sessionId}) => sessionId).sort()).toEqual([1, 2]);
    });

    it("删除即归档；不属于本章、本章有运行、主创回复中或等待回答时拒绝", async () => {
        const tag = ["writing-chapter:ol-ch1"];
        const {host, harness, sessions} = fakeHost([lead(1, tag), lead(2, tag), lead(3, ["writing-chapter:ol-ch2"])]);
        await expect(deleteChapterSession(host, {chapterEntryId: "ol-ch1", sessionId: 3})).rejects.toMatchObject({code: "CHAPTER_NOT_IN_PLAN"});
        mocks.service.activeRunSummaries.mockResolvedValueOnce([{chapterEntryId: "ol-ch1", status: "running"}]);
        await expect(deleteChapterSession(host, {chapterEntryId: "ol-ch1", sessionId: 1})).rejects.toMatchObject({code: "RUN_ACTIVE"});
        sessions[0]!.status = "waiting";
        await expect(deleteChapterSession(host, {chapterEntryId: "ol-ch1", sessionId: 1})).rejects.toMatchObject({code: "RUN_ACTIVE"});
        expect(harness.runCommand).not.toHaveBeenCalled();
        sessions[0]!.status = "idle";
        const rest = await deleteChapterSession(host, {chapterEntryId: "ol-ch1", sessionId: 1});
        expect(harness.runCommand).toHaveBeenCalledWith(1, {command: "archive", reason: "writing.chapter-session.delete"});
        expect(rest.map(({sessionId}) => sessionId)).toEqual([2]);
    });
});

describe("界面上的运行操作", () => {
    it("用户确认场景规划：按待应答项转成工作流应答，报告交回本章主创并写明用户的操作", async () => {
        const {host, spawned} = fakeHost([lead(7, ["writing-chapter:ol-ch1"])]);
        mocks.service.view.mockResolvedValue({pendingAsks: [{key: "root#5", spec: {title: `${USER_CONFIRM_TITLE}（第 1 轮）`}}]});
        await expect(answerWritingRun(host, {runId: "run-1", key: "root#5", decision: {approved: false, comments: " 场景二太短 "}})).resolves.toBe("progress");
        expect(mocks.service.answer).toHaveBeenCalledWith("run-1", {"root#5": {approved: false, comments: "场景二太短"}}, "user");
        expect(spawned).toHaveLength(1);
        expect(spawned[0]).toMatchObject({kind: "workflow", ownerSessionId: 7, ref: {writingRunId: "run-1", chapterEntryId: "ol-ch1"}});
        expect(spawned[0]).not.toHaveProperty("originToolCallId");
        mocks.service.settle.mockResolvedValue({...summary, status: "completed", interrupted: false, progress: null, result: null, error: null});
        const outcome = await (spawned[0]!.run as (ctx: {signal: AbortSignal}) => Promise<{message: string}>)({signal: new AbortController().signal});
        expect(outcome.message).toMatch(/^\[写作运行报告\]\n用户在写作视图中退回了场景规划，意见：场景二太短。\n第一章 写作运行 run-1：已结束/u);
    });

    it("改写确认转成布尔应答；决定与待应答项不对应、退回无意见、主创核对都拒绝", async () => {
        const {host} = fakeHost([lead(7, ["writing-chapter:ol-ch1"])]);
        mocks.service.view.mockResolvedValue({pendingAsks: [{key: "root#9", spec: {title: REWRITE_CONFIRM_TITLE}}]});
        await answerWritingRun(host, {runId: "run-1", key: "root#9", decision: {replace: false}});
        expect(mocks.service.answer).toHaveBeenCalledWith("run-1", {"root#9": false}, "user");
        await expect(answerWritingRun(host, {runId: "run-1", key: "root#9", decision: {approved: true}})).rejects.toMatchObject({code: "RUN_ANSWER_INVALID"});
        await expect(answerWritingRun(host, {runId: "run-1", key: "root#1", decision: {replace: true}})).rejects.toMatchObject({code: "RUN_ANSWER_INVALID"});

        mocks.service.view.mockResolvedValue({pendingAsks: [{key: "root#5", spec: {title: `${USER_CONFIRM_TITLE}（第 2 轮）`}}]});
        await expect(answerWritingRun(host, {runId: "run-1", key: "root#5", decision: {approved: false, comments: "  "}}))
            .rejects.toMatchObject({code: "RUN_ANSWER_INVALID"});
        mocks.service.view.mockResolvedValue({pendingAsks: [{key: "root#4", spec: {title: `${LEAD_REVIEW_TITLE}（第 1 轮）`}}]});
        await expect(answerWritingRun(host, {runId: "run-1", key: "root#4", decision: {approved: true}}))
            .rejects.toMatchObject({code: "RUN_ANSWER_INVALID", message: "场景规划正在等待主创核对，不能由用户应答"});
        expect(mocks.service.answer).toHaveBeenCalledTimes(1);
    });

    it("续写交回报告；本章没有主创会话时照常续写、不发报告；停止不另发报告", async () => {
        const withLead = fakeHost([lead(7, ["writing-chapter:ol-ch1"])]);
        await continueWritingRun(withLead.host, {chapterEntryId: "ol-ch1"});
        expect(mocks.service.continue).toHaveBeenCalledWith({chapterEntryId: "ol-ch1"});
        expect(withLead.spawned).toHaveLength(1);
        expect(withLead.spawned[0]).toMatchObject({ownerSessionId: 7});

        const noLead = fakeHost();
        await expect(continueWritingRun(noLead.host, {chapterEntryId: "ol-ch1", mode: "auto"})).resolves.toBe("progress");
        expect(noLead.spawned).toHaveLength(0);

        await expect(stopWritingRun(withLead.host, "run-1")).resolves.toBe("progress");
        expect(mocks.service.stop).toHaveBeenCalledWith("run-1");
        expect(withLead.spawned).toHaveLength(1);
    });
});
