import {beforeEach, describe, expect, it, vi} from "vitest";
import type {ReadyProjectSessionRef} from "nbook/server/workspace-files/project-session-types";
import {OutlineGenerationError} from "./direction";

const mocks = vi.hoisted(() => ({
    loadConfig: vi.fn(), resolveModel: vi.fn(), resolveModels: vi.fn(), complete: vi.fn(),
}));
vi.mock("nbook/server/config/config-service", () => ({loadEffectiveConfigFromTarget: mocks.loadConfig}));
vi.mock("nbook/server/agent/harness/model-resolver", () => ({resolvePiModelFromConfig: mocks.resolveModel}));
vi.mock("nbook/server/agent/harness/pi-runtime-resolver", () => ({resolvePiModelsFromConfig: mocks.resolveModels}));
vi.mock("nbook/server/agent/observability/traced-provider", () => ({tracedCompleteSimple: mocks.complete}));
vi.mock("nbook/server/runtime/installation-paths", () => ({resolveStateWorkspaceRoot: () => "C:/project-workspace"}));

const ready = {publicId: "ready-direction", workspace: {root: "C:/project-workspace/my-book"}} as ReadyProjectSessionRef;
const config = {models: {providers: {p: {options: {apiKey: "test-only", timeoutMs: 1000, requestOptions: {}}}}}};
const model = {provider: "p", api: "openai-completions", id: "fiction", maxTokens: 6000};

beforeEach(() => {
    vi.resetAllMocks();
    mocks.loadConfig.mockResolvedValue(config);
    mocks.resolveModel.mockReturnValue(model);
    mocks.resolveModels.mockReturnValue({});
    mocks.complete.mockResolvedValue({stopReason: "stop", content: [{type: "text", text: "{\"title\":\"草案\",\"body\":\"情节\"}"}]});
});

describe("大纲方向模型调用", () => {
    it("绑定 ready Project 配置与取消信号，不传写入工具", async () => {
        const {completeDirectionWithModel} = await import("./direction-model");
        const signal = new AbortController().signal;
        await expect(completeDirectionWithModel(ready, "从旧城出发", signal)).resolves.toContain("草案");
        expect(mocks.loadConfig).toHaveBeenCalledWith({scope: "project", workspaceRoot: expect.any(String), project: ready});
        expect(mocks.resolveModel).toHaveBeenCalledWith(config, "outline");
        expect(mocks.complete).toHaveBeenCalledWith(expect.anything(), model, expect.objectContaining({tools: [],
            messages: [expect.objectContaining({role: "user"})]}), expect.objectContaining({signal, timeoutMs: 1000,
            maxTokens: 4096, apiKey: "test-only"}));
    });

    it("细纲审查沿用当前 Project 模型与取消合同，但强制使用审阅而非草案提示", async () => {
        const {completeDirectionWithModel} = await import("./direction-model");
        const signal = new AbortController().signal;
        await completeDirectionWithModel(ready, "待审细纲", signal, "请审查冲突，仅返回报告 JSON");
        expect(mocks.complete).toHaveBeenCalledWith(expect.anything(), model,
            expect.objectContaining({systemPrompt: "请审查冲突，仅返回报告 JSON", tools: []}),
            expect.objectContaining({signal, timeoutMs: 1000}));
    });

    it("配置缺失、被取消或截断输出不能当作成功草案", async () => {
        const {completeDirectionWithModel} = await import("./direction-model");
        mocks.resolveModel.mockImplementationOnce(() => { throw new Error("missing model"); });
        await expect(completeDirectionWithModel(ready, "方向", new AbortController().signal))
            .rejects.toMatchObject({code: "MODEL_UNAVAILABLE"} satisfies Partial<OutlineGenerationError>);
        expect(mocks.complete).not.toHaveBeenCalled();
        mocks.complete.mockResolvedValueOnce({stopReason: "length", content: [{type: "text", text: "{}"}]});
        await expect(completeDirectionWithModel(ready, "方向", new AbortController().signal)).rejects.toMatchObject({code: "MODEL_FAILED"});
        const cancelled = new AbortController();
        cancelled.abort();
        await expect(completeDirectionWithModel(ready, "方向", cancelled.signal)).rejects.toMatchObject({name: "AbortError"});
    });
});
