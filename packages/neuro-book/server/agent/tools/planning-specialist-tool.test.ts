import {describe, expect, it, vi} from "vitest";
import {Value} from "typebox/value";
import {createPlanningDelegationTool, createPlanningSpecialistTool} from "nbook/server/agent/tools/planning-specialist-tool";
import {assertPlanningWriteGrant} from "nbook/server/agent/tools/planning-delegation";

const tool = createPlanningSpecialistTool();

type LinkedAgent = {sessionId: number; profileKey: string; currentProjectRoot?: string; status: "idle"};

function harness(options: {linked?: LinkedAgent[]; result?: Record<string, unknown>; model?: {providerConfigId: string; modelId: string} | null} = {}) {
    return {
        getAgent: vi.fn(async () => options.linked ?? []),
        createAgent: vi.fn(async (input: {profileKey: string}) => ({sessionId: 77, profileKey: input.profileKey})),
        getSessionLiveState: vi.fn(async () => ({model: options.model === undefined ? {providerConfigId: "p", modelId: "m"} : options.model})),
        invokeAgent: vi.fn(async (input: {sessionId: number}) => options.result ?? {
            sessionId: input.sessionId,
            status: "completed",
            reportResult: {result: "完成", data: {summary: "摘要", proposals: [], openQuestions: ["待确认"]}},
        }),
    };
}

function context(mockHarness: ReturnType<typeof harness>, overrides: Record<string, unknown> = {}) {
    return {
        harness: mockHarness,
        sessionId: 42,
        profileKey: "outline.planner",
        currentProject: {generation: 3, workspace: {root: "C:/workspace/demo", ref: {projectRoot: "demo"}}},
        ...overrides,
    } as never;
}

async function run(ctx: never, params: unknown = {specialist: "outline", brief: "调整第一卷结构", targetIds: ["ol-root"]}) {
    return tool.executeWithContext!(ctx, "call-1", params);
}

describe("consult_planning_specialist", () => {
    it("参数 schema 限定专家类型和对象 id 形态", () => {
        expect(Value.Check(tool.parameters, {specialist: "detailed", brief: "写细纲"})).toBe(true);
        expect(Value.Check(tool.parameters, {specialist: "writer", brief: "写正文"})).toBe(false);
        expect(Value.Check(tool.parameters, {specialist: "outline", brief: "x", targetIds: ["../outline"]})).toBe(false);
        expect(tool).toMatchObject({mutatesWorkspace: false, executionMode: "sequential"});
    });

    it("只有规划助手可以委派，专家自身和其他 Agent 被拒绝", async () => {
        const mock = harness();
        await expect(run(context(mock, {profileKey: "outline.outline"}))).rejects.toThrow("只能由规划助手调用");
        await expect(run(context(mock, {profileKey: "writer"}))).rejects.toThrow("只能由规划助手调用");
        expect(mock.createAgent).not.toHaveBeenCalled();
        expect(mock.invokeAgent).not.toHaveBeenCalled();
    });

    it("没有 ready Project 时 fail closed", async () => {
        const mock = harness();
        await expect(run(context(mock, {currentProject: null}))).rejects.toThrow("ready Project");
        expect(mock.getAgent).not.toHaveBeenCalled();
    });

    it("没有已关联专家时创建子 Agent，并以规划助手身份同步调用", async () => {
        const mock = harness({linked: [{sessionId: 9, profileKey: "outline.outline", currentProjectRoot: "other", status: "idle"}]});
        const result = await run(context(mock));
        expect(mock.getAgent).toHaveBeenCalledWith(undefined, 42);
        expect(mock.createAgent).toHaveBeenCalledWith({
            profileKey: "outline.outline",
            initial: {projectRoot: "demo", creationMode: "original"},
            parentSessionId: 42,
            currentProjectRoot: "demo",
            title: "outline（大纲专家）（原创）",
        });
        const invocation = mock.invokeAgent.mock.calls[0]![0] as Record<string, any>;
        expect(invocation).toMatchObject({
            sessionId: 77,
            mode: "prompt",
            modelKey: "p/m",
            caller: {kind: "agent", sessionId: 42, profileKey: "outline.planner", toolCallId: "call-1"},
        });
        expect(invocation.message.text).toContain("调整第一卷结构");
        expect(invocation.message.text).toContain("ol-root");
        expect(result.details).toMatchObject({specialist: "outline", sessionId: 77, status: "completed"});
    });

    it("复用同一 profile 且同一 Project 的已关联专家", async () => {
        const mock = harness({model: null, linked: [
            {sessionId: 5, profileKey: "outline.detailed", currentProjectRoot: "demo", status: "idle"},
            {sessionId: 6, profileKey: "outline.foreshadowing", currentProjectRoot: "demo", status: "idle"},
        ]});
        await run(context(mock), {specialist: "foreshadowing", brief: "伏笔回收"});
        expect(mock.createAgent).not.toHaveBeenCalled();
        const invocation = mock.invokeAgent.mock.calls[0]![0] as Record<string, unknown>;
        expect(invocation.sessionId).toBe(6);
        expect(invocation).not.toHaveProperty("modelKey");
    });

    it("复用专家时每次传递最新方案、稳定来源和所选素材，不依赖历史", async () => {
        const mock = harness({linked: [
            {sessionId: 6, profileKey: "outline.outline", currentProjectRoot: "demo", status: "idle"},
        ]});
        const firstTask = {creationMode: "adaptation", targetPlanId: "plan-a", adaptation: {
            kind: "chapter", sourcePlanId: "plan-source", sourceEntryId: "ol-source3",
        }, materialPaths: ["lorebook/character/hero/index.md"]};
        const nextTask = {creationMode: "adaptation", targetPlanId: "plan-b", adaptation: {
            kind: "between", sourcePlanId: "plan-source", beforeEntryId: "ol-source3", afterEntryId: "ol-source4",
        }, materialPaths: ["lorebook/note/写作手法索引.md"]};
        for (const taskContext of [firstTask, nextTask]) {
            const input = {specialist: "outline", brief: "按当前任务规划", taskContext};
            expect(Value.Check(tool.parameters, input)).toBe(true);
            await run(context(mock), input);
        }
        const calls = mock.invokeAgent.mock.calls.map(([input]) => input as unknown as {sessionId: number; message: {text: string}});
        expect(calls.map((call) => call.sessionId)).toEqual([77, 77]);
        expect(calls[0]!.message.text).toContain(JSON.stringify(firstTask));
        expect(calls[1]!.message.text).toContain(JSON.stringify(nextTask));
        expect(calls[1]!.message.text).not.toContain("plan-a");
        expect(mock.createAgent).toHaveBeenCalledTimes(2);
    });

    it("缺少新上下文的旧调用不从子会话历史获得任务位置", async () => {
        const mock = harness();
        await run(context(mock));
        const message = (mock.invokeAgent.mock.calls[0]![0] as unknown as {message: {text: string}}).message.text;
        expect(message).toContain("未提供结构化任务上下文");
        expect(message).toContain("openQuestions");
    });

    it("专家停在 waiting 或调用失败时抛错", async () => {
        await expect(run(context(harness({result: {status: "waiting"}})))).rejects.toThrow("等待状态");
        await expect(run(context(harness({result: {status: "error", error: "provider down"}})))).rejects.toThrow("provider down");
    });

    it("完成后在正文和 details 中返回专家的结构化结果", async () => {
        const result = await run(context(harness()));
        const text = result.content[0]!.type === "text" ? result.content[0]!.text : "";
        expect(text).toContain("完成");
        expect(text).toContain("待确认");
        expect(result.details).toMatchObject({
            finalMessage: "完成",
            data: {summary: "摘要", proposals: [], openQuestions: ["待确认"]},
        });
    });
});

describe("delegate_planning_task", () => {
    const delegate = createPlanningDelegationTool();

    it("声明写入以便讨论模式先审批委派，且同样只允许规划助手调用", async () => {
        expect(delegate).toMatchObject({key: "delegate_planning_task", mutatesWorkspace: true, executionMode: "sequential"});
        const mock = harness();
        await expect(delegate.executeWithContext!(context(mock, {profileKey: "outline.detailed"}), "c", {specialist: "detailed", brief: "写细纲"}))
            .rejects.toThrow("只能由规划助手调用");
        expect(mock.invokeAgent).not.toHaveBeenCalled();
    });

    it("写入授权只在委派调用期间存在，咨询调用不授予", async () => {
        const seen: boolean[] = [];
        const probe = (sessionId: number) => {
            try { assertPlanningWriteGrant(sessionId); seen.push(true); } catch { seen.push(false); }
        };
        const mock = harness();
        mock.invokeAgent.mockImplementation(async (input: {sessionId: number}) => {
            probe(input.sessionId);
            return {sessionId: input.sessionId, status: "completed", reportResult: {result: "ok"}};
        });
        await delegate.executeWithContext!(context(mock), "c1", {specialist: "detailed", brief: "为第一章写细纲"});
        await run(context(mock), {specialist: "detailed", brief: "看看细纲"});
        expect(seen).toEqual([true, false]);
        expect(() => assertPlanningWriteGrant(77)).toThrow("没有规划写入委派");
        const message = (mock.invokeAgent.mock.calls[0]![0] as unknown as {message: {text: string}}).message.text;
        expect(message).toContain("任务类型：产出");
    });

    it("委派调用失败时也撤回写入授权", async () => {
        const mock = harness();
        mock.invokeAgent.mockRejectedValueOnce(new Error("boom"));
        await expect(delegate.executeWithContext!(context(mock), "c2", {specialist: "outline", brief: "拆章"})).rejects.toThrow("boom");
        expect(() => assertPlanningWriteGrant(77)).toThrow("没有规划写入委派");
    });
});
