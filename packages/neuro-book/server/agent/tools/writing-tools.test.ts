import {beforeEach, describe, expect, it, vi} from "vitest";
import {AgentJobCancelledError} from "nbook/server/agent/jobs/agent-job-manager";
import {createWritingAssistantTools, createWritingLeadTools} from "nbook/server/agent/tools/writing-tools";
import type {NeuroToolResult, ToolExecutionContext} from "nbook/server/agent/tools/types";
import type {ChapterRunSummary, RewriteRunSummary} from "nbook/server/writing/run-service";

const mocks = vi.hoisted(() => ({
    readReadyWritingOverview: vi.fn(),
    readReadyWritingIssues: vi.fn(),
    readReadyWritingRunFacts: vi.fn(),
    listReadyAssistantFiles: vi.fn(),
    readReadyAssistantFiles: vi.fn(),
    service: {
        start: vi.fn(), startRewrite: vi.fn(), continue: vi.fn(), stop: vi.fn(), answer: vi.fn(), view: vi.fn(), settle: vi.fn(), listChapterRuns: vi.fn(),
        editProse: vi.fn(),
    },
}));

vi.mock("nbook/server/writing/host", () => ({
    readReadyWritingOverview: mocks.readReadyWritingOverview,
    readReadyWritingIssues: mocks.readReadyWritingIssues,
    readReadyWritingRunFacts: mocks.readReadyWritingRunFacts,
    listReadyAssistantFiles: mocks.listReadyAssistantFiles,
    readReadyAssistantFiles: mocks.readReadyAssistantFiles,
}));
vi.mock("nbook/server/writing/runtime", () => ({useWritingRunService: () => mocks.service}));

const lead = createWritingLeadTools();
const assistant = createWritingAssistantTools();
const project = {publicId: "p1", workspace: {root: "C:/project"}};

function summary(overrides: Partial<ChapterRunSummary> = {}): ChapterRunSummary {
    return {kind: "chapter", runId: "run-1", chapterEntryId: "ol-ch1", task: "new", mode: "auto", status: "running", interrupted: false,
        progress: null, result: null, error: null, createdAt: "2026-09-29T00:00:00.000Z", ...overrides};
}

function rewriteSummary(overrides: Partial<RewriteRunSummary> = {}): RewriteRunSummary {
    return {kind: "rewrite", runId: "run-2", chapterEntryId: "ol-ch1", target: {paragraphs: {from: 2}}, requirement: "改得更紧张",
        status: "running", interrupted: false, result: null, error: null, createdAt: "2026-09-29T00:00:00.000Z", ...overrides};
}

function context(initial: unknown = {chapterEntryId: "ol-ch1"}) {
    const spawn = vi.fn((_input: {run: (ctx: {signal: AbortSignal}) => Promise<unknown>}) => ({job: {jobId: "job-1"}}));
    const readSession = vi.fn(async () => ({metadata: {initial}}));
    const value = {sessionId: 7, currentProject: project, harness: {jobs: {spawn}, repo: {readSession}}} as unknown as ToolExecutionContext;
    return {value, spawn, readSession};
}

const text = (result: NeuroToolResult) => result.content.map((part) => part.type === "text" ? part.text : "").join("");

beforeEach(() => {
    vi.clearAllMocks();
    mocks.readReadyWritingOverview.mockResolvedValue({chapters: [{entryId: "ol-ch1", title: "第一章"}]});
    mocks.readReadyWritingRunFacts.mockResolvedValue({chapter: {title: "第一章"}, prose: null, context: null});
});

describe("写作助手工具", () => {
    it("章节取自会话初始值，路径超出 lorebook/ 与本章参考时拒绝且不读取", async () => {
        const {value, readSession} = context();
        for (const path of ["outline/foreshadowing/fs-1.md", "../secret.md", "lorebook/../outline/foreshadowing/fs-1.md", "outline/entries/ol-ch1.md"]) {
            await expect(assistant.readWritingMaterial.executeWithContext!(value, "call", {path})).rejects.toThrow("不在可读范围内");
        }
        expect(readSession).toHaveBeenCalledWith(7);
        expect(mocks.readReadyWritingRunFacts).toHaveBeenCalledWith(project, {chapterEntryId: "ol-ch1"});
        expect(mocks.readReadyAssistantFiles).not.toHaveBeenCalled();
    });

    it("读取资料时去掉文件头，并按段落编号供摘录引用", async () => {
        mocks.readReadyAssistantFiles.mockResolvedValue(new Map([["lorebook/world.md", "---\ntitle: 世界\n---\n# 城市\n\n雾城常年起雾。\n\n港口在东边。\n"]]));
        const result = await assistant.readWritingMaterial.executeWithContext!(context().value, "call", {path: "lorebook/world.md"});
        expect(text(result)).toBe("lorebook/world.md\n\n[1] # 城市\n\n[2] 雾城常年起雾。\n\n[3] 港口在东边。");
        expect(mocks.readReadyAssistantFiles).toHaveBeenCalledWith(project, {paths: ["lorebook/world.md"], referencePaths: []});
    });

    it("角色读取保留基础人设与方案 records/state，正文摘录段号保持原口径", async () => {
        const profilePath = "lorebook/character/顾言/index.md";
        const statePath = "lorebook/character/char-1/plans/plan-1/state.md";
        const knowledgePath = "lorebook/character/char-1/plans/plan-1/knowledge/index.md";
        mocks.readReadyAssistantFiles.mockResolvedValue(new Map([
            [profilePath, "---\nid: char-1\ntitle: 顾言\naliases: [小顾]\next:\n  character:\n    profile:\n      identity: 学生\n      temperament: 先观察再行动\n---\n# 顾言\n\n简短摘要\n"],
            [statePath, "---\nstate:\n  chapter: 第三章\n  location: 教室\n  items: 笔记本\n  psychology: 警惕\n---\n# 正文状态追踪\n"],
            [knowledgePath, "---\nrecords:\n  - id: record-1\n    title: 密道\n    content: 知道旧楼有入口\n    unknown: 不知道入口已封闭\n    misunderstanding: 误以为同伴仍在旧楼\n---\n# 角色知识\n\n## 密道\n\n知道旧楼有入口\n"],
        ]));
        const profile = text(await assistant.readWritingMaterial.executeWithContext!(context().value, "call", {path: profilePath}));
        expect(profile).toContain('"id": "char-1"');
        expect(profile).toContain('"aliases": [');
        expect(profile).toContain('"temperament": "先观察再行动"');
        expect(profile).toContain("[1] # 顾言\n\n[2] 简短摘要");
        const state = text(await assistant.readWritingMaterial.executeWithContext!(context().value, "call", {path: statePath}));
        expect(state).toContain('"location": "教室"');
        expect(state).toContain('"chapter": "第三章"');
        const knowledge = text(await assistant.readWritingMaterial.executeWithContext!(context().value, "call", {path: knowledgePath}));
        expect(knowledge).toContain('"unknown": "不知道入口已封闭"');
        expect(knowledge).toContain('"misunderstanding": "误以为同伴仍在旧楼"');
        expect(knowledge).toContain("[1] # 角色知识\n\n[2] ## 密道\n\n[3] 知道旧楼有入口");
    });

    it("角色文件头不是对象时明确拒绝读取，不静默忽略基础字段", async () => {
        const path = "lorebook/character/char-1/index.md";
        mocks.readReadyAssistantFiles.mockResolvedValue(new Map([[path, "---\n- 非对象文件头\n---\n正文\n"]]));
        await expect(assistant.readWritingMaterial.executeWithContext!(context().value, "call", {path})).rejects.toThrow("角色资料文件头无效");
    });

    it("会话没有绑定章节时拒绝，不回退到调用参数", async () => {
        await expect(assistant.listWritingMaterials.executeWithContext!(context({}).value, "call", {})).rejects.toThrow("没有绑定章节");
        expect(mocks.listReadyAssistantFiles).not.toHaveBeenCalled();
    });
});

describe("写作主创工具", () => {
    it("删改正文须确认，并传递读取版本和目标，冲突时明确未修改", async () => {
        const params = {chapterEntryId: "ol-ch1", baseHash: `sha256:${"a".repeat(64)}`, replacement: "", target: {paragraphs: {from: 2}}};
        const {value} = context();
        await expect(lead.editChapterProse.executeWithContext!(value, "call", {...params, confirmed: false}))
            .rejects.toThrow("明确确认");
        expect(mocks.service.editProse).not.toHaveBeenCalled();
        mocks.service.editProse.mockResolvedValue({status: "conflict", path: "manuscript/第一章/index.md", hash: params.baseHash});
        const result = await lead.editChapterProse.executeWithContext!(value, "call", {...params, confirmed: true});
        expect(mocks.service.editProse).toHaveBeenCalledWith(params);
        expect(result.content).toEqual([expect.objectContaining({text: expect.stringContaining("没有修改")})]);
        expect(lead.editChapterProse.mutatesWorkspace).toBe(true);
    });

    it("发起、续写与应答标记为工作区变更，查询与停止不是", () => {
        expect(lead.startWriting.mutatesWorkspace).toBe(true);
        expect(lead.continueWriting.mutatesWorkspace).toBe(true);
        expect(lead.answerScenePlan.mutatesWorkspace).toBe(true);
        expect(lead.getWritingStatus.mutatesWorkspace).toBeFalsy();
        expect(lead.stopWriting.mutatesWorkspace).toBeFalsy();
    });

    it("停止时该章没有进行中的运行则报错", async () => {
        mocks.service.listChapterRuns.mockResolvedValue([summary({status: "completed"})]);
        await expect(lead.stopWriting.executeWithContext!(context().value, "call", {chapterEntryId: "ol-ch1"})).rejects.toThrow("没有正在进行");
        expect(mocks.service.stop).not.toHaveBeenCalled();
    });

    it("应答要求恰有一个待应答项，退回必须写明意见", async () => {
        mocks.service.view.mockResolvedValue({pendingAsks: []});
        await expect(lead.answerScenePlan.executeWithContext!(context().value, "call", {runId: "run-1", approved: true})).rejects.toThrow("没有等待应答");
        mocks.service.view.mockResolvedValue({pendingAsks: [{key: "ask-1", spec: {kind: "approve", title: "核对场景规划（第 1 轮）"}}]});
        await expect(lead.answerScenePlan.executeWithContext!(context().value, "call", {runId: "run-1", approved: false, comments: "  "}))
            .rejects.toThrow("必须写明意见");
        expect(mocks.service.answer).not.toHaveBeenCalled();
    });

    it("应答后在后台跟踪运行，ref 不占用演示工作流的 runId 字段", async () => {
        mocks.service.view.mockResolvedValue({pendingAsks: [{key: "ask-1", spec: {kind: "approve", title: "核对场景规划（第 1 轮）"}}]});
        mocks.service.answer.mockResolvedValue(summary());
        const {value, spawn} = context();
        await lead.answerScenePlan.executeWithContext!(value, "call-9", {runId: "run-1", approved: false, comments: "场景 2 漏了码头"});
        expect(mocks.service.answer).toHaveBeenCalledWith("run-1", {"ask-1": {approved: false, comments: "场景 2 漏了码头"}});
        expect(spawn.mock.calls[0]![0]).toMatchObject({originToolCallId: "call-9", ownerSessionId: 7,
            ref: {writingRunId: "run-1", chapterEntryId: "ol-ch1"}});
    });

    it("后台任务在运行停下时交回报告，已停止的运行按取消结束", async () => {
        mocks.service.start.mockResolvedValue(summary());
        const {value, spawn} = context();
        await lead.startWriting.executeWithContext!(value, "call", {chapterEntryId: "ol-ch1", task: "new", mode: "discussion"});
        const run = spawn.mock.calls[0]![0].run;
        const signal = new AbortController().signal;

        mocks.service.settle.mockResolvedValueOnce(summary({status: "waiting"}));
        mocks.service.view.mockResolvedValueOnce({pendingAsks: [{key: "ask-2", spec: {kind: "approve", title: "确认场景规划（第 1 轮）", description: "规划摘要"}}]});
        const waiting = await run({signal}) as {message: string};
        expect(waiting.message).toMatch(/^\[写作运行报告\]\n第一章 写作运行 run-1：等待应答/u);
        expect(waiting.message).toContain("不要替用户决定");

        mocks.service.settle.mockResolvedValueOnce(summary({status: "cancelled"}));
        await expect(run({signal})).rejects.toBeInstanceOf(AgentJobCancelledError);
    });

    it("改写确认只能用 answer_rewrite 应答，场景规划应答拒绝改写确认", async () => {
        const confirm = {pendingAsks: [{key: "ask-3", spec: {kind: "approve", title: "确认替换改写段落", description: "对照"}}]};
        mocks.service.view.mockResolvedValue(confirm);
        await expect(lead.answerScenePlan.executeWithContext!(context().value, "call", {runId: "run-2", approved: true})).rejects.toThrow("没有等待应答");
        mocks.service.answer.mockResolvedValue(rewriteSummary());
        await lead.answerRewrite.executeWithContext!(context().value, "call", {runId: "run-2", replace: false});
        expect(mocks.service.answer).toHaveBeenCalledWith("run-2", {"ask-3": false});

        mocks.service.answer.mockClear();
        mocks.service.view.mockResolvedValue({pendingAsks: [{key: "ask-1", spec: {kind: "approve", title: "核对场景规划（第 1 轮）"}}]});
        await expect(lead.answerRewrite.executeWithContext!(context().value, "call", {runId: "run-1", replace: true})).rejects.toThrow("没有等待确认的改写");
        expect(mocks.service.answer).not.toHaveBeenCalled();
    });

    it("发起改写时整理修改要求，报告交回新旧对照与结果", async () => {
        await expect(lead.startRewrite.executeWithContext!(context().value, "call", {chapterEntryId: "ol-ch1", target: {quote: "雾"}, requirement: "  "}))
            .rejects.toThrow("写明修改要求");
        mocks.service.startRewrite.mockResolvedValue(rewriteSummary());
        const {value, spawn} = context();
        await lead.startRewrite.executeWithContext!(value, "call", {chapterEntryId: "ol-ch1", target: {quote: "雾"}, requirement: " 改得更紧张 "});
        expect(lead.startRewrite.mutatesWorkspace).toBe(true);
        expect(mocks.service.startRewrite).toHaveBeenCalledWith({chapterEntryId: "ol-ch1", ownerSessionId: value.sessionId, target: {quote: "雾"}, requirement: "改得更紧张"});
        const run = spawn.mock.calls[0]![0].run;
        const signal = new AbortController().signal;

        mocks.service.settle.mockResolvedValueOnce(rewriteSummary({status: "waiting"}));
        mocks.service.view.mockResolvedValueOnce({pendingAsks: [{key: "ask-3", spec: {kind: "approve", title: "确认替换改写段落", description: "### 原文（第 2 段）"}}]});
        const waiting = await run({signal}) as {message: string};
        expect(waiting.message).toContain("第一章 改写运行 run-2");
        expect(waiting.message).toContain("### 原文（第 2 段）");
        expect(waiting.message).toContain("answer_rewrite");

        mocks.service.settle.mockResolvedValueOnce(rewriteSummary({status: "completed", result: {outcome: "replaced", reason: null,
            message: "已替换第 2 段", range: {from: 2, to: 2}, original: "旧", replacement: "新", problems: [], notes: []}}));
        const done = await run({signal}) as {message: string};
        expect(done.message).toContain("改写完成：已替换第 2 段");
    });
});
