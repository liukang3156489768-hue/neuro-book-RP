// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {effectScope, ref} from "vue";

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
});
