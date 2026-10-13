import {beforeEach, describe, expect, it, vi} from "vitest";
import type {ReadyProjectSessionRef} from "nbook/server/workspace-files/project-session-types";
import {ExtractionFatalError} from "./errors";

const mocks = vi.hoisted(() => ({
    loadConfig: vi.fn(), resolveModel: vi.fn(), resolveModels: vi.fn(), complete: vi.fn(), logInfo: vi.fn(), logError: vi.fn(),
}));
vi.mock("nbook/server/config/config-service", () => ({loadEffectiveConfigFromTarget: mocks.loadConfig}));
vi.mock("nbook/server/agent/harness/model-resolver", () => ({resolvePiModelFromConfig: mocks.resolveModel}));
vi.mock("nbook/server/agent/harness/pi-runtime-resolver", () => ({resolvePiModelsFromConfig: mocks.resolveModels}));
vi.mock("nbook/server/agent/observability/traced-provider", () => ({tracedCompleteSimple: mocks.complete}));
vi.mock("nbook/server/runtime/installation-paths", () => ({resolveStateWorkspaceRoot: () => "C:/project-workspace"}));
vi.mock("nbook/server/app-logs/logger", () => ({appLogger: {info: mocks.logInfo, error: mocks.logError}}));

const ready = {publicId: "ready-extraction", workspace: {root: "C:/project-workspace/my-book"}} as ReadyProjectSessionRef;
function configWith(timeoutMs: number | undefined, requestOptions: Record<string, unknown> = {}) {
    return {models: {providers: {p: {options: {apiKey: "test-only", timeoutMs, requestOptions}}}}};
}
const model = {provider: "p", api: "openai-completions", id: "fiction", maxTokens: 100_000};

beforeEach(() => {
    vi.resetAllMocks();
    mocks.loadConfig.mockResolvedValue(configWith(30_000));
    mocks.resolveModel.mockReturnValue(model);
    mocks.resolveModels.mockReturnValue({});
    mocks.complete.mockResolvedValue({stopReason: "stop", content: [{type: "text", text: " OK:产出 "}]});
});

describe("提取模型适配器", () => {
    it("OpenAI 实际 payload 与 Anthropic 上下文均保留原文、模板、目标和修复尾部", async () => {
        const {createProjectExtractionModel} = await import("./model-adapter");
        const orderedMessages = [
            {role: "system" as const, content: "系统"}, {role: "user" as const, content: "原文\n\n模板"},
            {role: "assistant" as const, content: "示例"}, {role: "user" as const, content: "角色目标"},
            {role: "user" as const, content: "修复要求"},
        ];
        const request = {system: "系统", prompt: "不应重复发送的备用文本", orderedMessages, signal: new AbortController().signal};
        await createProjectExtractionModel(ready).complete(request);
        const [, , context, options] = mocks.complete.mock.calls[0]!;
        expect(context.messages).toEqual([]);
        expect(await options.onPayload({messages: []}, model)).toEqual({messages: orderedMessages});
        mocks.resolveModel.mockReturnValue({...model, api: "anthropic-messages"});
        await createProjectExtractionModel(ready).complete(request);
        const anthropic = mocks.complete.mock.calls[1]![2];
        expect(anthropic.systemPrompt).toBe("系统");
        expect(anthropic.messages.map((message: {role: string}) => message.role)).toEqual(["user", "assistant", "user", "user"]);
        expect(anthropic.messages.map((message: {content: Array<{text?: string}>}) => message.content.map(block => block.text).join(""))).toEqual(["原文\n\n模板", "示例", "角色目标", "修复要求"]);
    });
    it("日志关联任务与角色组，usage 缺失时保留 null，错误也带相同身份", async () => {
        const {createProjectExtractionModel} = await import("./model-adapter");
        const metadata = {taskId: "task", unitId: "unit", block: 2, characterKeys: ["甲", "乙"], tier: "secondary", prefixHash: "a".repeat(64)};
        const request = {prompt: "不进入日志的正文", signal: new AbortController().signal, metadata};
        mocks.complete.mockResolvedValueOnce({stopReason: "stop", content: [], usage: {input: 300, output: 20, cacheRead: 250, cacheWrite: 30, totalTokens: 350}});
        await createProjectExtractionModel(ready).complete(request);
        expect(mocks.logInfo).toHaveBeenLastCalledWith("inspiration.extraction.modelResponse", expect.objectContaining({
            ...metadata, inputCount: 300, outputCount: 20, cacheReadCount: 250, cacheWriteCount: 30, maxOutputCount: 64_000,
        }));
        expect(JSON.stringify(mocks.logInfo.mock.calls)).not.toContain(request.prompt);
        expect(JSON.stringify(mocks.logInfo.mock.calls)).not.toContain("test-only");
        await createProjectExtractionModel(ready).complete(request);
        expect(mocks.logInfo).toHaveBeenLastCalledWith("inspiration.extraction.modelResponse", expect.objectContaining({inputCount: null, cacheReadCount: null, cacheWriteCount: null}));
        const error = new Error("网络错误");
        mocks.complete.mockRejectedValueOnce(error);
        await expect(createProjectExtractionModel(ready).complete(request)).rejects.toBe(error);
        expect(mocks.logError).toHaveBeenCalledWith("inspiration.extraction.modelError", expect.objectContaining(metadata), error);
    });
    it("无工具、关闭思考、使用 Inspiration Profile，绑定 ready Project 配置与取消信号", async () => {
        const {createProjectExtractionModel} = await import("./model-adapter");
        const signal = new AbortController().signal;
        await expect(createProjectExtractionModel(ready).complete({system: "系统", prompt: "原文", signal})).resolves.toBe("OK:产出");
        expect(mocks.loadConfig).toHaveBeenCalledWith({scope: "project", workspaceRoot: expect.any(String), project: ready});
        expect(mocks.resolveModel).toHaveBeenCalledWith(expect.anything(), "inspiration", undefined);
        const [, , context, options] = mocks.complete.mock.calls[0]!;
        expect(context).toMatchObject({systemPrompt: "系统", tools: [], messages: [expect.objectContaining({role: "user"})]});
        expect(options).toMatchObject({signal, apiKey: "test-only"});
        expect(options).toHaveProperty("reasoning", undefined);
    });

    it("modelKey 覆盖默认模型", async () => {
        const {createProjectExtractionModel} = await import("./model-adapter");
        await createProjectExtractionModel(ready).complete({prompt: "原文", signal: new AbortController().signal, modelKey: "p/other"});
        expect(mocks.resolveModel).toHaveBeenCalledWith(expect.anything(), "inspiration", {modelKey: "p/other"});
    });

    it("超时取 Provider 配置与十分钟下限中较大者，输出上限不超过 64000 与模型上限", async () => {
        const {createProjectExtractionModel, EXTRACTION_MIN_TIMEOUT_MS, EXTRACTION_MAX_OUTPUT_TOKENS} = await import("./model-adapter");
        expect(EXTRACTION_MAX_OUTPUT_TOKENS).toBe(64_000);
        const signal = new AbortController().signal;
        await createProjectExtractionModel(ready).complete({prompt: "原文", signal});
        expect(mocks.complete.mock.calls[0]![3]).toMatchObject({timeoutMs: EXTRACTION_MIN_TIMEOUT_MS, maxTokens: EXTRACTION_MAX_OUTPUT_TOKENS});

        mocks.loadConfig.mockResolvedValue(configWith(EXTRACTION_MIN_TIMEOUT_MS * 2));
        mocks.resolveModel.mockReturnValue({...model, maxTokens: 4096});
        await createProjectExtractionModel(ready).complete({prompt: "原文", signal});
        expect(mocks.complete.mock.calls[1]![3]).toMatchObject({timeoutMs: EXTRACTION_MIN_TIMEOUT_MS * 2, maxTokens: 4096});
    });

    it("没有可用模型是任务级致命错误，且不发请求", async () => {
        mocks.resolveModel.mockImplementationOnce(() => { throw new Error("missing model"); });
        const {createProjectExtractionModel} = await import("./model-adapter");
        const failure = await createProjectExtractionModel(ready).complete({prompt: "原文", signal: new AbortController().signal}).catch(error => error);
        expect(failure).toBeInstanceOf(ExtractionFatalError);
        expect(failure.reason).toBe("model-unavailable");
        expect(mocks.complete).not.toHaveBeenCalled();
    });

    it("被截断的产出不当作成功；已取消的信号不发请求", async () => {
        const {createProjectExtractionModel} = await import("./model-adapter");
        mocks.complete.mockResolvedValueOnce({stopReason: "length", content: [{type: "text", text: "半截"}]});
        await expect(createProjectExtractionModel(ready).complete({prompt: "原文", signal: new AbortController().signal})).rejects.toThrow("未完整返回");
        mocks.complete.mockClear();
        const cancelled = new AbortController();
        cancelled.abort(new Error("取消"));
        await expect(createProjectExtractionModel(ready).complete({prompt: "原文", signal: cancelled.signal})).rejects.toThrow("取消");
        expect(mocks.complete).not.toHaveBeenCalled();
    });
});
