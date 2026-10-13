import {beforeEach, describe, expect, it, vi} from "vitest";
import {WritingError} from "nbook/server/writing/prose-binding";

const mocks = vi.hoisted(() => ({overview: vi.fn(), entry: vi.fn(), styles: vi.fn(), setPlan: vi.fn(), setStyle: vi.fn(), link: vi.fn(), unlink: vi.fn(),
    issues: vi.fn(), ignoreIssue: vi.fn(), runs: vi.fn(), activeRuns: vi.fn(), progress: vi.fn(), stop: vi.fn(), continue: vi.fn(), answer: vi.fn(),
    readSession: vi.fn(), ensureSession: vi.fn(), startSession: vi.fn(), listSessions: vi.fn(), deleteSession: vi.fn(),
    createStyle: vi.fn(), deleteStyle: vi.fn(), roleModels: vi.fn(), saveRoleModel: vi.fn(), writerOutput: vi.fn()}));
vi.mock("h3", async (original) => ({...await original<typeof import("h3")>(), getQuery: (event: {query?: unknown}) => event.query ?? {}}));
vi.mock("nbook/server/agent/http", () => ({useAgentHarness: () => "harness"}));
vi.mock("nbook/server/writing/run-host", () => ({
    listWritingRuns: mocks.runs,
    listActiveWritingRuns: mocks.activeRuns,
    readWritingRunProgress: mocks.progress,
    readWritingWriterOutput: mocks.writerOutput,
    stopWritingRun: mocks.stop,
    continueWritingRun: mocks.continue,
    answerWritingRun: mocks.answer,
    readChapterSession: mocks.readSession,
    ensureChapterSession: mocks.ensureSession,
    startChapterSession: mocks.startSession,
    listChapterSessions: mocks.listSessions,
    deleteChapterSession: mocks.deleteSession,
}));
vi.mock("nbook/server/writing/role-models", () => ({readWritingRoleModels: mocks.roleModels, saveWritingRoleModel: mocks.saveRoleModel}));
vi.mock("nbook/server/api/projects/project-control-plane", () => ({requireProjectRefQuery: () => ({})}));
vi.mock("nbook/server/api/projects/project-http-error", () => ({withProjectHttpError: (action: () => Promise<unknown>) => action()}));
vi.mock("nbook/server/utils/novel-chapter", () => ({validateBody: (event: {body: unknown}, schema: {parse: (body: unknown) => unknown}) => schema.parse(event.body)}));
vi.mock("nbook/server/workspace-files/project-session", () => ({requireActiveReadyProject: () => ({workspace: {root: "unused", ref: {projectRoot: "demo"}}})}));
vi.mock("nbook/server/writing/host", () => ({
    readReadyWritingOverview: mocks.overview,
    readReadyWritingEntry: mocks.entry,
    listReadyWritingStyles: mocks.styles,
    setReadyWritingPlan: mocks.setPlan,
    setReadyWritingStyle: mocks.setStyle,
    linkReadyProse: mocks.link,
    unlinkReadyProse: mocks.unlink,
    readReadyWritingIssues: mocks.issues,
    ignoreReadyWritingIssue: mocks.ignoreIssue,
    createReadyWritingStyle: mocks.createStyle,
    deleteReadyWritingStyle: mocks.deleteStyle,
}));

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("defineEventHandler", (handler: unknown) => handler);
});

async function request(method: string, segments: string, body?: unknown, query?: Record<string, string>) {
    const handler = (await import("./[...segments]")).default;
    return handler({method, context: {params: {segments}}, body, query} as never);
}

const actor = {kind: "user", userId: "local"};

describe("Project 写作 API", () => {
    it("写手输出只读接口校验运行和正整数会话 ID", async () => {
        mocks.writerOutput.mockResolvedValue({sessionId: 7, thinking: "思考", output: "正文"});
        await expect(request("GET", "writer-output", undefined, {runId: "run-1", sessionId: "7"}))
            .resolves.toEqual({sessionId: 7, thinking: "思考", output: "正文"});
        expect(mocks.writerOutput).toHaveBeenCalledWith({harness: "harness", ready: expect.anything()}, "run-1", 7);
        for (const sessionId of ["0", "-1", "1.5", "wrong"]) {
            await expect(request("GET", "writer-output", undefined, {runId: "run-1", sessionId})).rejects.toMatchObject({statusCode: 400});
        }
        await expect(request("POST", "writer-output", {runId: "run-1", sessionId: 7})).rejects.toMatchObject({statusCode: 404});
    });
    it("按路由把已校验的请求交给 host", async () => {
        mocks.overview.mockResolvedValue({plan: {state: "unset"}});
        mocks.setPlan.mockResolvedValue("plan");
        mocks.link.mockResolvedValue("linked");
        await expect(request("GET", "overview")).resolves.toEqual({plan: {state: "unset"}});
        mocks.styles.mockResolvedValue([]);
        await expect(request("GET", "styles")).resolves.toEqual([]);
        mocks.entry.mockResolvedValue("entry");
        await expect(request("GET", "entry", undefined, {entryId: "ol-ch1"})).resolves.toBe("entry");
        expect(mocks.entry).toHaveBeenCalledWith(expect.anything(), "ol-ch1");
        await expect(request("GET", "entry", undefined, {entryId: "ch1"})).rejects.toMatchObject({statusCode: 400});
        await expect(request("POST", "set-plan", {planId: null})).resolves.toBe("plan");
        expect(mocks.setPlan).toHaveBeenCalledWith(expect.anything(), null, actor);
        await request("POST", "set-style", {stylePath: "lorebook/instruction/文风/index.md"});
        expect(mocks.setStyle).toHaveBeenCalledWith(expect.anything(), "lorebook/instruction/文风/index.md", actor);
        await expect(request("POST", "link-prose", {path: "manuscript/a/index.md", chapterEntryId: "ol-ch1"})).resolves.toBe("linked");
        expect(mocks.link).toHaveBeenCalledWith(expect.anything(), {path: "manuscript/a/index.md", chapterEntryId: "ol-ch1"}, actor);
        await request("POST", "unlink-prose", {path: "manuscript/a/index.md"});
        expect(mocks.unlink).toHaveBeenCalledWith(expect.anything(), {path: "manuscript/a/index.md"}, actor);
    });

    it("拒绝多余字段、非法条目 ID 与未知路由；创建正文和写入依据不经 HTTP 暴露", async () => {
        await expect(request("POST", "set-plan", {planId: "p", extra: 1})).rejects.toThrow();
        await expect(request("POST", "link-prose", {path: "manuscript/a/index.md", chapterEntryId: "ch1"})).rejects.toThrow();
        await expect(request("POST", "create-prose", {chapterEntryId: "ol-ch1"})).rejects.toMatchObject({statusCode: 404});
        await expect(request("POST", "write-source", {})).rejects.toMatchObject({statusCode: 404});
        await expect(request("POST", "overview")).rejects.toMatchObject({statusCode: 404});
        expect(mocks.setPlan).not.toHaveBeenCalled();
        expect(mocks.link).not.toHaveBeenCalled();
    });

    it("写作错误按合同映射状态码并保留错误码", async () => {
        const cases = [["PLAN_NOT_FOUND", 404], ["INVALID_PATH", 400], ["CHAPTER_HAS_PROSE", 409], ["PROSE_LINKED", 409],
            ["STYLE_INVALID", 422], ["PLANNING_UNREADABLE", 422]] as const;
        for (const [code, statusCode] of cases) {
            mocks.link.mockRejectedValueOnce(new WritingError(code, `失败：${code}`));
            await expect(request("POST", "link-prose", {path: "manuscript/a/index.md", chapterEntryId: "ol-ch1"}))
                .rejects.toMatchObject({statusCode, message: `失败：${code}`, data: {code}});
        }
    });

    it("问题查询与忽略；登记和复核不经 HTTP 暴露", async () => {
        mocks.issues.mockResolvedValue({chapters: [], unreadable: []});
        await expect(request("GET", "issues")).resolves.toEqual({chapters: [], unreadable: []});
        await request("POST", "ignore-issue", {chapterEntryId: "ol-ch1", issueId: "wi-abc123"});
        expect(mocks.ignoreIssue).toHaveBeenCalledWith(expect.anything(), {chapterEntryId: "ol-ch1", issueId: "wi-abc123"}, actor);
        await expect(request("POST", "ignore-issue", {chapterEntryId: "ol-ch1", issueId: "abc"})).rejects.toThrow();
        await expect(request("POST", "register-issues", {})).rejects.toMatchObject({statusCode: 404});
        await expect(request("POST", "resolve-issues", {})).rejects.toMatchObject({statusCode: 404});
        mocks.ignoreIssue.mockRejectedValueOnce(new WritingError("ISSUE_NOT_IGNORABLE", "问题已解决，不需要忽略"));
        await expect(request("POST", "ignore-issue", {chapterEntryId: "ol-ch1", issueId: "wi-abc123"}))
            .rejects.toMatchObject({statusCode: 409, data: {code: "ISSUE_NOT_IGNORABLE"}});
        expect(mocks.ignoreIssue).toHaveBeenCalledTimes(2);
    });

    it("运行接口：按章列出、读取进度、停止、续写、用户应答与章节会话；不开放发起写作和改写", async () => {
        const host = {harness: "harness", ready: expect.anything()};
        mocks.runs.mockResolvedValue([]);
        mocks.progress.mockResolvedValue("progress");
        await expect(request("GET", "runs", undefined, {chapterEntryId: "ol-ch1"})).resolves.toEqual([]);
        expect(mocks.runs).toHaveBeenCalledWith(host, "ol-ch1");
        mocks.activeRuns.mockResolvedValue([]);
        await expect(request("GET", "active-runs")).resolves.toEqual([]);
        expect(mocks.activeRuns).toHaveBeenCalledWith(host);
        await expect(request("GET", "run", undefined, {runId: "run-1"})).resolves.toBe("progress");
        expect(mocks.progress).toHaveBeenCalledWith(host, "run-1");
        await request("POST", "stop", {runId: "run-1"});
        expect(mocks.stop).toHaveBeenCalledWith(host, "run-1");
        await request("POST", "continue", {chapterEntryId: "ol-ch1", mode: "discussion"});
        expect(mocks.continue).toHaveBeenCalledWith(host, {chapterEntryId: "ol-ch1", mode: "discussion"});
        await request("POST", "answer", {runId: "run-1", key: "root#3", decision: {approved: false, comments: "改一下"}});
        expect(mocks.answer).toHaveBeenCalledWith(host, {runId: "run-1", key: "root#3", decision: {approved: false, comments: "改一下"}});
        await request("POST", "answer", {runId: "run-1", key: "root#3", decision: {replace: true}});
        expect(mocks.answer).toHaveBeenLastCalledWith(host, {runId: "run-1", key: "root#3", decision: {replace: true}});
        await request("GET", "chapter-session", undefined, {chapterEntryId: "ol-ch1"});
        expect(mocks.readSession).toHaveBeenCalledWith(host, "ol-ch1");
        await request("POST", "chapter-session", {chapterEntryId: "ol-ch1"});
        expect(mocks.ensureSession).toHaveBeenCalledWith(host, "ol-ch1");

        await expect(request("GET", "runs")).rejects.toMatchObject({statusCode: 400});
        await expect(request("GET", "runs", undefined, {chapterEntryId: "ch1"})).rejects.toMatchObject({statusCode: 400});
        await expect(request("POST", "continue", {chapterEntryId: "ol-ch1", mode: "fast"})).rejects.toThrow();
        await expect(request("POST", "answer", {runId: "run-1", key: "root#3", decision: {approved: true, replace: true}})).rejects.toThrow();
        await expect(request("POST", "answer", {runId: "run-1", key: "root#3", answers: {}})).rejects.toThrow();
        for (const route of ["start", "start-writing", "start-rewrite", "rewrite"]) {
            await expect(request("POST", route, {chapterEntryId: "ol-ch1"})).rejects.toMatchObject({statusCode: 404});
        }
        expect(mocks.continue).toHaveBeenCalledTimes(1);
        expect(mocks.answer).toHaveBeenCalledTimes(2);

        mocks.answer.mockRejectedValueOnce(new WritingError("RUN_ANSWER_INVALID", "场景规划正在等待主创核对，不能由用户应答"));
        await expect(request("POST", "answer", {runId: "run-1", key: "root#3", decision: {approved: true}}))
            .rejects.toMatchObject({statusCode: 400, data: {code: "RUN_ANSWER_INVALID"}});
        mocks.continue.mockRejectedValueOnce(new WritingError("RUN_ACTIVE", "该章已有进行中的写作"));
        await expect(request("POST", "continue", {chapterEntryId: "ol-ch1"})).rejects.toMatchObject({statusCode: 409, data: {code: "RUN_ACTIVE"}});
        mocks.progress.mockRejectedValueOnce(new WritingError("RUN_NOT_FOUND", "写作运行不存在"));
        await expect(request("GET", "run", undefined, {runId: "x"})).rejects.toMatchObject({statusCode: 404, data: {code: "RUN_NOT_FOUND"}});
    });

    it("文风新增与删除：标题去空白后 1 到 80 字；有进行中的运行时拒绝删除", async () => {
        await request("POST", "create-style", {title: "  冷峻  "});
        expect(mocks.createStyle).toHaveBeenCalledWith(expect.anything(), "冷峻", actor);
        await expect(request("POST", "create-style", {title: "   "})).rejects.toThrow();
        await expect(request("POST", "create-style", {title: "x".repeat(81)})).rejects.toThrow();
        mocks.activeRuns.mockResolvedValueOnce([]);
        await request("POST", "delete-style", {stylePath: "lorebook/instruction/writing-style/冷峻/index.md"});
        expect(mocks.deleteStyle).toHaveBeenCalledWith(expect.anything(), "lorebook/instruction/writing-style/冷峻/index.md", actor);
        mocks.activeRuns.mockResolvedValueOnce([{runId: "run-1"}]);
        await expect(request("POST", "delete-style", {stylePath: "lorebook/instruction/a.md"}))
            .rejects.toMatchObject({statusCode: 409, data: {code: "RUN_ACTIVE"}});
        expect(mocks.deleteStyle).toHaveBeenCalledTimes(1);
    });

    it("章节会话列表、新建与删除；角色模型设置的读取与保存", async () => {
        const host = {harness: "harness", ready: expect.anything()};
        await request("GET", "chapter-sessions", undefined, {chapterEntryId: "ol-ch1"});
        expect(mocks.listSessions).toHaveBeenCalledWith(host, "ol-ch1");
        await request("POST", "chapter-session", {chapterEntryId: "ol-ch1", fresh: true});
        expect(mocks.startSession).toHaveBeenCalledWith(host, "ol-ch1");
        expect(mocks.ensureSession).not.toHaveBeenCalled();
        await request("POST", "delete-chapter-session", {chapterEntryId: "ol-ch1", sessionId: 3});
        expect(mocks.deleteSession).toHaveBeenCalledWith(host, {chapterEntryId: "ol-ch1", sessionId: 3});
        await expect(request("POST", "delete-chapter-session", {chapterEntryId: "ol-ch1", sessionId: "3"})).rejects.toThrow();

        await request("GET", "role-models");
        expect(mocks.roleModels).toHaveBeenCalledWith("demo");
        const settings = {modelKey: "p/a", reasoningEffort: "off", temperature: 0.7};
        await request("POST", "role-model", {role: "writer", settings});
        expect(mocks.saveRoleModel).toHaveBeenCalledWith("demo", "writer", settings);
        await expect(request("POST", "role-model", {role: "other", settings})).rejects.toThrow();
        await expect(request("POST", "role-model", {role: "lead", settings: {...settings, temperature: 3}})).rejects.toThrow();
        await expect(request("POST", "role-model", {role: "lead", settings: {...settings, topK: 1}})).rejects.toThrow();
        mocks.saveRoleModel.mockRejectedValueOnce(new WritingError("MODEL_INVALID", "模型未启用"));
        await expect(request("POST", "role-model", {role: "lead", settings})).rejects.toMatchObject({statusCode: 422, data: {code: "MODEL_INVALID"}});
    });
});
