import {beforeEach, describe, expect, it, vi} from "vitest";
import type {ReadyProjectSessionRef} from "nbook/server/workspace-files/project-session-types";
import {OutlineGenerationError} from "./direction";
import {loadExtractionPromptDefinitions} from "nbook/server/prompt-management/extraction-catalog";
import type {PromptSnapshot} from "nbook/shared/dto/prompt-management.dto";

const mocks = vi.hoisted(() => ({
    loadConfig: vi.fn(), resolveModel: vi.fn(), resolveModels: vi.fn(), complete: vi.fn(),
    capture: vi.fn(),
}));
vi.mock("nbook/server/config/config-service", () => ({loadEffectiveConfigFromTarget: mocks.loadConfig}));
vi.mock("nbook/server/agent/harness/model-resolver", () => ({resolvePiModelFromConfig: mocks.resolveModel}));
vi.mock("nbook/server/agent/harness/pi-runtime-resolver", () => ({resolvePiModelsFromConfig: mocks.resolveModels}));
vi.mock("nbook/server/agent/observability/traced-provider", () => ({tracedCompleteSimple: mocks.complete}));
vi.mock("nbook/server/runtime/installation-paths", () => ({resolveStateWorkspaceRoot: () => "C:/project-workspace"}));
vi.mock("nbook/server/prompt-management/service", () => ({usePromptManagement: () => ({capture: mocks.capture})}));

const ready = {publicId: "ready-direction", workspace: {root: "C:/project-workspace/my-book"}} as ReadyProjectSessionRef;
const config = {models: {providers: {p: {options: {apiKey: "test-only", timeoutMs: 1000, requestOptions: {}}}}}};
const model = {provider: "p", api: "openai-completions", id: "fiction", maxTokens: 6000};

beforeEach(() => {
    vi.resetAllMocks();
    mocks.loadConfig.mockResolvedValue(config);
    mocks.resolveModel.mockReturnValue(model);
    mocks.resolveModels.mockReturnValue({});
    const snapshot: PromptSnapshot = {schemaVersion: 1, id: "a".repeat(64), purposes: Object.fromEntries(
        loadExtractionPromptDefinitions().map(definition => [definition.purposeId,
            {presetId: "builtin", presetRevision: 1, entries: definition.entries}]),
    )};
    mocks.capture.mockResolvedValue(snapshot);
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

    it("细纲审查使用该用途的全局预设及前置消息，保留当前 Project 模型与取消合同", async () => {
        const {completeDirectionWithModel} = await import("./direction-model");
        const signal = new AbortController().signal;
        const snapshot: PromptSnapshot = await mocks.capture();
        snapshot.purposes["outline.detail-analysis"] = {presetId: "custom-review", presetRevision: 3, entries: [
            {id: "rules", name: "审阅要求", role: "system", content: "请审查人物状态和时序冲突，仅返回报告 JSON"},
            {id: "example-user", name: "示例问题", role: "user", content: "示例待审内容"},
            {id: "example-assistant", name: "示例报告", role: "assistant", content: '{"summary":"示例报告","deviations":[],"conflicts":[]}'},
            {id: "context", name: "当前待审内容", role: "user", content: "审查以下内容：{{context}}"},
        ]};
        mocks.capture.mockClear();
        await completeDirectionWithModel(ready, "待审细纲", signal, "outline.detail-analysis");
        expect(mocks.capture).toHaveBeenCalledOnce();
        expect(mocks.complete).toHaveBeenCalledWith(expect.anything(), model,
            expect.objectContaining({systemPrompt: "请审查人物状态和时序冲突，仅返回报告 JSON", tools: [], messages: [
                expect.objectContaining({role: "user", content: [{type: "text", text: "示例待审内容"}]}),
                expect.objectContaining({role: "assistant", content: [{type: "text", text: '{"summary":"示例报告","deviations":[],"conflicts":[]}'}]}),
                expect.objectContaining({role: "user", content: [{type: "text", text: "审查以下内容：待审细纲"}]}),
            ]}),
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
