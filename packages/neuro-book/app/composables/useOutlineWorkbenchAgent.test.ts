// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {effectScope, nextTick, ref} from "vue";
import type {OutlineWorkbenchCreationMode} from "nbook/shared/storage/outline-workbench";
import type {OutlineWorkbenchResolvedState} from "nbook/app/utils/outline/outline-workbench-session";

const calls: string[] = [];
const api = {
    createSession: vi.fn(async (_input: Record<string, unknown>) => { calls.push("create"); return {sessionId: 7}; }),
    runCommand: vi.fn(async (_sessionId: number, command: Record<string, unknown>) => {
        calls.push(`command:${String(command.command)}`);
        return {status: "completed"};
    }),
    getSessionRecovery: vi.fn(async () => ({})),
    invokeSession: vi.fn(async (_sessionId: number, _body: Record<string, unknown>) => { calls.push("invoke"); return {status: "completed"}; }),
    abortSession: vi.fn(),
};

vi.mock("nbook/app/composables/useAgentSessionApi", () => ({useAgentSessionApi: () => api}));
vi.mock("nbook/app/components/novel-ide/agent/useAgentSessionStream", () => ({
    useAgentSessionStream: () => ({start: vi.fn(), ensure: vi.fn(), stop: vi.fn(), refreshRecovery: vi.fn()}),
}));
vi.mock("nbook/app/components/novel-ide/agent/useAgentSession", async () => {
    const {ref: vueRef} = await import("vue");
    return {useAgentSession: () => ({
        messages: vueRef([]), running: vueRef(false), connectionStatus: vueRef("idle"), runPhase: vueRef(null),
        pendingUserInputSessions: vueRef([]), pendingUserInputSession: vueRef(null),
        applyRecovery: vi.fn(), reset: vi.fn(), appendOptimisticUserMessage: vi.fn(), markOptimisticUserMessageUnknown: vi.fn(),
    })};
});

const {useOutlineWorkbenchAgent} = await import("./useOutlineWorkbenchAgent");

const bootstrap = {modelSettings: {
    defaultModelLabel: "deepseek-v4-pro",
    enabledModels: [{key: "deepseek/deepseek-v4-pro", label: "deepseek-v4-pro"}, {key: "deepseek/deepseek-v4-flash", label: "deepseek-v4-flash"}],
}};

beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
    vi.stubGlobal("$fetch", vi.fn(async () => bootstrap));
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe("useOutlineWorkbenchAgent", () => {
    it("首轮调用前把已保存的模型、思考级别与运行模式同步到新会话，而不是沿用全局默认", async () => {
        const scope = effectScope();
        const agent = scope.run(() => useOutlineWorkbenchAgent(ref("novel"), {
            mode: ref("discuss"),
            modelKey: ref("deepseek/deepseek-v4-flash"),
            temperature: ref(0.7),
            thinkingEnabled: ref(false),
        }))!;

        await agent.sendPrompt("规划第一卷");

        expect(api.createSession.mock.calls[0]![0]).toMatchObject({initial: {model: "deepseek/deepseek-v4-flash"}});
        expect(api.runCommand.mock.calls.map(([, command]) => command)).toEqual([
            {command: "mode", mode: "discuss"},
            {command: "model", modelKey: "deepseek/deepseek-v4-flash"},
            {command: "thinking", thinkingLevel: "off"},
        ]);
        expect(calls.indexOf("invoke")).toBeGreaterThan(calls.lastIndexOf("command:thinking"));
        // temperature 不是会话状态，每次 invoke 都必须携带当前设置。
        expect(api.invokeSession.mock.calls[0]![1]).toMatchObject({mode: "prompt", temperature: 0.7});
        scope.stop();
    });

    it("复用会话时只更新目标方案，创作方式在会话内保持不变", async () => {
        const scope = effectScope();
        const planId = ref<string | null>("plan-a");
        const creationMode = ref<OutlineWorkbenchCreationMode>("original");
        const agent = scope.run(() => useOutlineWorkbenchAgent(ref("novel"), {
            mode: ref("discuss"), modelKey: ref(undefined), temperature: ref(0.7), thinkingEnabled: ref(false),
            planId, creationMode,
        }))!;
        try {
            await agent.sendPrompt("先分析角色经历");
            planId.value = "plan-b";
            creationMode.value = "adaptation";
            const userText = "在来源第三、四章之间插入一章\n保留人物动机";
            await agent.sendPrompt(userText);
            expect(api.createSession).toHaveBeenCalledTimes(2);
            const texts = api.invokeSession.mock.calls.map(([, body]) => (body.message as {text: string}).text);
            const contexts = texts.map((text) => JSON.parse(text.split("\n")[1]!));
            expect(contexts).toEqual([
                {creationMode: "original", targetPlanId: "plan-a"},
                {creationMode: "original", targetPlanId: "plan-b"},
            ]);
            expect(texts[1]?.endsWith(userText)).toBe(true);
            expect(agent.session.appendOptimisticUserMessage).toHaveBeenLastCalledWith(expect.any(String), texts[1], [], "prompt");
        } finally {
            scope.stop();
        }
    });

    it("创建会话等待期间切换项目，不把旧消息发送到新项目", async () => {
        const scope = effectScope();
        const root = ref("novel-a");
        let resolveBootstrap!: (value: typeof bootstrap) => void;
        const delayed = new Promise<typeof bootstrap>((resolve) => { resolveBootstrap = resolve; });
        vi.stubGlobal("$fetch", vi.fn().mockReturnValueOnce(delayed).mockResolvedValue(bootstrap));
        const agent = scope.run(() => useOutlineWorkbenchAgent(root, {
            mode: ref("discuss"), modelKey: ref(undefined), temperature: ref(0.7), thinkingEnabled: ref(false),
        }))!;
        try {
            const pending = agent.sendPrompt("只属于旧项目的规划");
            root.value = "novel-b";
            await nextTick();
            resolveBootstrap(bootstrap);
            await pending;
            expect(api.invokeSession).not.toHaveBeenCalled();
            await agent.sendPrompt("新项目规划");
            expect(api.createSession).toHaveBeenCalledTimes(1);
            expect(api.createSession.mock.calls[0]![0]).toMatchObject({currentProjectRoot: "novel-b"});
            expect(api.invokeSession).toHaveBeenCalledTimes(1);
        } finally {
            scope.stop();
        }
    });

    it("已建立会话后切换项目，清除旧内存绑定并为新项目创建会话", async () => {
        const scope = effectScope();
        const root = ref("novel-a");
        const planId = ref<string | null>("plan-a");
        const agent = scope.run(() => useOutlineWorkbenchAgent(root, {
            mode: ref("discuss"), modelKey: ref(undefined), temperature: ref(0.7), thinkingEnabled: ref(false), planId,
        }))!;
        try {
            await agent.sendPrompt("项目 A 规划");
            root.value = "novel-b";
            planId.value = "plan-b";
            await nextTick();
            expect(agent.activeSessionId.value).toBeNull();
            expect(agent.activeProjectRoot.value).toBeNull();
            api.createSession.mockResolvedValueOnce({sessionId: 8});
            await agent.sendPrompt("项目 B 规划");
            expect(api.createSession).toHaveBeenCalledTimes(2);
            expect(api.invokeSession.mock.calls[1]![0]).toBe(8);
            const body = api.invokeSession.mock.calls[1]![1];
            expect(JSON.parse((body.message as {text: string}).text.split("\n")[1]!)).toMatchObject({targetPlanId: "plan-b"});
        } finally {
            scope.stop();
        }
    });

    it("新项目偏好仍在加载时不恢复残留的旧项目会话", async () => {
        const scope = effectScope();
        const loading = ref(true);
        const state = ref<OutlineWorkbenchResolvedState>({
            activeSessionId: 91, sessions: [], agentWidth: null, activeView: "library", thinkingEnabled: false,
            modelKey: null, temperature: 0.7, mode: "discuss", creationMode: "original",
        });
        const agent = scope.run(() => useOutlineWorkbenchAgent(ref("novel-b"), {
            mode: ref("discuss"), modelKey: ref(undefined), temperature: ref(0.7), thinkingEnabled: ref(false),
        }, {workbenchSession: {state, loading, commit: async () => ({status: "unchanged", diagnosis: "测试偏好未变更"})}}))!;
        try {
            await agent.sendPrompt("当前项目规划");
            expect(api.getSessionRecovery).not.toHaveBeenCalled();
            expect(api.createSession).not.toHaveBeenCalled();
            state.value = {...state.value, activeSessionId: null};
            loading.value = false;
            await agent.sendPrompt("当前项目规划");
            expect(api.createSession).toHaveBeenCalledTimes(1);
            expect(api.getSessionRecovery).toHaveBeenCalledWith(7);
            expect(api.getSessionRecovery).not.toHaveBeenCalledWith(91);
        } finally {
            scope.stop();
        }
    });
});
