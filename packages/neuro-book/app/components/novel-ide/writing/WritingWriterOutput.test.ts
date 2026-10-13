// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {flushPromises, mount, type VueWrapper} from "@vue/test-utils";
import type {AgentSessionRecoveryDto} from "nbook/shared/dto/agent-session.dto";
import type {AgentSessionStreamOptions} from "nbook/app/components/novel-ide/agent/useAgentSessionStream";
import WritingWriterOutput from "./WritingWriterOutput.vue";

const mocks = vi.hoisted(() => ({fetch: vi.fn(), start: vi.fn(), stop: vi.fn(), options: null as AgentSessionStreamOptions | null}));
vi.mock("nbook/app/components/novel-ide/agent/useAgentSessionStream", () => ({
    useAgentSessionStream: (options: AgentSessionStreamOptions) => {
        mocks.options = options;
        return {start: mocks.start, stop: mocks.stop};
    },
}));
const mounted: VueWrapper[] = [];
beforeEach(() => {
    vi.clearAllMocks();
    mocks.options = null;
    vi.stubGlobal("$fetch", mocks.fetch);
    mocks.start.mockResolvedValue(undefined);
});
afterEach(() => {
    mounted.splice(0).forEach(wrapper => wrapper.unmount());
    vi.unstubAllGlobals();
});
function mountOutput(extra: Partial<InstanceType<typeof WritingWriterOutput>["$props"]> = {}) {
    const wrapper = mount(WritingWriterOutput, {props: {
        projectRoot: "demo", runId: "run-1", title: "写手 · 场景1 · 第1次",
        attempt: {writerSessionId: 7, prompt: null, output: "运行记录正文", judgement: {passed: true, problems: []}}, ...extra,
    }, attachTo: document.body});
    mounted.push(wrapper);
    return wrapper;
}
function recovery(running: boolean): AgentSessionRecoveryDto {
    return {
        kind: "recovery", eventCursor: {eventEpoch: "epoch-1", after: 0},
        summary: {sessionId: 7, sessionIdentity: `sha256:${"0".repeat(64)}`, profileKey: "writing.writer", status: running ? "running" : "idle", updatedAt: 1, archived: false},
        activeLeafId: null, activePathRevision: null, history: {entries: [], previousCursor: null}, tree: [],
        linkedAgents: [], linkedByAgents: [], pendingUserInputs: [], steerQueue: {items: [], omittedItems: 0},
        followUpQueue: {status: "ready", items: [], omittedItems: 0},
        activeInvocation: running ? {invocationId: "inv-1", sessionId: 7, status: "running", mode: "prompt", startedAt: 1} : null,
        model: null, thinkingLevel: null, effectiveThinkingLevel: "off", agentMode: "normal",
    };
}

describe("写手折叠输出", () => {
    it("默认折叠且不请求，展开后读取完整内容；未返回思考时明确说明", async () => {
        const output = "长正文。".repeat(6000);
        mocks.fetch.mockResolvedValue({sessionId: 7, thinking: "", output});
        const wrapper = mountOutput();
        expect(wrapper.find(".writer-content").exists()).toBe(false);
        expect(mocks.fetch).not.toHaveBeenCalled();
        await wrapper.get(".writer-toggle").trigger("click");
        await flushPromises();
        expect(wrapper.get(".writer-text").text()).toBe(output);
        expect(wrapper.text()).toContain("模型没有返回思考内容");
        expect(mocks.fetch).toHaveBeenCalledWith("/api/projects/writing/writer-output", {query: {projectRoot: "demo", runId: "run-1", sessionId: "7"}});
        expect(mocks.start).not.toHaveBeenCalled();
    });

    it("展开生成中的写手订阅事件，结束时补齐完整内容，收起时释放流", async () => {
        mocks.fetch.mockImplementation(async (url: string) => url.includes("writer-output")
            ? {sessionId: 7, thinking: "完整思考", output: "完整正文"} : recovery(true));
        const wrapper = mountOutput({active: true, attempt: {writerSessionId: 7, prompt: null, output: null, judgement: null}});
        await wrapper.get(".writer-toggle").trigger("click");
        await flushPromises();
        expect(mocks.start).toHaveBeenCalledWith(7);
        const calls = mocks.fetch.mock.calls.length;
        await wrapper.setProps({attempt: {writerSessionId: 7, prompt: null, output: null, judgement: null}});
        await flushPromises();
        expect(mocks.fetch).toHaveBeenCalledTimes(calls);
        expect(mocks.start).toHaveBeenCalledTimes(1);
        mocks.options!.session.applyRecovery(recovery(false));
        await flushPromises();
        expect(wrapper.get(".writer-thinking").text()).toBe("完整思考");
        expect(wrapper.get('[aria-label="写手正文输出"]').text()).toContain("完整正文");
        const stops = mocks.stop.mock.calls.length;
        await wrapper.get(".writer-toggle").trigger("click");
        expect(mocks.stop.mock.calls.length).toBeGreaterThan(stops);
        expect(wrapper.find(".writer-content").exists()).toBe(false);
    });

    it("切换来源后旧请求不能覆盖新的写手，卸载后也不提交迟到结果", async () => {
        let finish!: (value: unknown) => void;
        mocks.fetch.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
        const wrapper = mountOutput();
        await wrapper.get(".writer-toggle").trigger("click");
        mocks.fetch.mockResolvedValue({sessionId: 8, thinking: "新思考", output: "新正文"});
        await wrapper.setProps({runId: "run-2", attempt: {writerSessionId: 8, prompt: null, output: null, judgement: null}});
        await flushPromises();
        finish({sessionId: 7, thinking: "旧思考", output: "旧正文"});
        await flushPromises();
        expect(wrapper.text()).toContain("新正文");
        expect(wrapper.text()).not.toContain("旧正文");
        wrapper.unmount();
        expect(mocks.options!.activeSessionId.value).toBeNull();
    });

    it("读取失败保留运行记录正文，支持重试；无会话关联仍可查看历史正文", async () => {
        mocks.fetch.mockRejectedValueOnce(new Error("读取失败"));
        const wrapper = mountOutput();
        await wrapper.get(".writer-toggle").trigger("click");
        await flushPromises();
        expect(wrapper.get('[role="alert"]').text()).toContain("读取失败");
        expect(wrapper.text()).toContain("运行记录正文");
        mocks.fetch.mockResolvedValue({sessionId: 7, thinking: "思考", output: "新读取正文"});
        await wrapper.get('[role="alert"] button').trigger("click");
        await flushPromises();
        expect(wrapper.find('[role="alert"]').exists()).toBe(false);
        expect(wrapper.text()).toContain("新读取正文");
        const calls = mocks.fetch.mock.calls.length;
        const legacy = mountOutput({attempt: {prompt: null, output: "历史正文", judgement: null}});
        await legacy.get(".writer-toggle").trigger("click");
        expect(legacy.text()).toContain("历史正文");
        expect(legacy.text()).toContain("没有写手会话关联");
        expect(mocks.fetch.mock.calls).toHaveLength(calls);
    });
});
