import {beforeEach, describe, expect, it, vi} from "vitest";

const mocks = vi.hoisted(() => ({
    project: null as Record<string, unknown> | null,
    saveProjectConfig: vi.fn(),
}));

vi.mock("nbook/server/config/config-service", () => ({
    readConfigEditorSnapshot: vi.fn(async () => ({
        project: mocks.project,
        effective: {agent: {profiles: {
            "writing.lead": {model: {modelKey: "p/a", reasoningEffort: "high", temperature: null}},
            "writing.writer": {model: {modelKey: null, reasoningEffort: null, temperature: 0.9}},
        }}},
        modelSettings: {enabledModels: [{key: "p/a", label: "模型甲"}, {key: "p/b", label: "模型乙"}], defaultModelLabel: "模型甲"},
    })),
    saveProjectConfig: mocks.saveProjectConfig,
}));

const {readWritingRoleModels, saveWritingRoleModel} = await import("./role-models");

beforeEach(() => {
    vi.clearAllMocks();
    mocks.project = {agent: {profiles: {
        "writing.lead": {model: {modelKey: "p/a", topK: 40}, settings: {keep: true}},
        "leader.default": {model: {modelKey: "p/b"}},
    }}};
    mocks.saveProjectConfig.mockImplementation(async (input: {agent: {profiles: Record<string, unknown>}}) => {
        mocks.project = {agent: {profiles: input.agent.profiles}};
    });
});

describe("写作角色的模型设置", () => {
    it("三个角色各给出本作品设置与实际生效值，附启用模型列表", async () => {
        const result = await readWritingRoleModels("demo");
        expect(result.roles.map(({role, label, profileKey}) => [role, label, profileKey])).toEqual([
            ["lead", "主创", "writing.lead"], ["assistant", "助手", "writing.assistant"], ["writer", "写手", "writing.writer"]]);
        expect(result.roles[0]).toMatchObject({override: {modelKey: "p/a", reasoningEffort: null, temperature: null},
            effective: {modelKey: "p/a", reasoningEffort: "high", temperature: null}});
        expect(result.roles[2]!.effective.temperature).toBe(0.9);
        expect(result.models).toEqual([{key: "p/a", label: "模型甲"}, {key: "p/b", label: "模型乙"}]);
    });

    it("只改目标角色的三个字段；空值删除该字段，其他字段与其他 Profile 保留", async () => {
        await saveWritingRoleModel("demo", "lead", {modelKey: null, reasoningEffort: "off", temperature: 0.7});
        const saved = mocks.saveProjectConfig.mock.calls[0]![0].agent.profiles;
        expect(saved["writing.lead"]).toEqual({model: {topK: 40, reasoningEffort: "off", temperature: 0.7}, settings: {keep: true}});
        expect(saved["leader.default"]).toEqual({model: {modelKey: "p/b"}});
        expect(mocks.saveProjectConfig.mock.calls[0]![1]).toEqual({workspaceKind: "novel", projectRoot: "demo"});

        await saveWritingRoleModel("demo", "writer", {modelKey: "p/b", reasoningEffort: null, temperature: null});
        expect(mocks.saveProjectConfig.mock.calls[1]![0].agent.profiles["writing.writer"]).toEqual({model: {modelKey: "p/b"}});
    });

    it("未启用的模型拒绝保存", async () => {
        await expect(saveWritingRoleModel("demo", "assistant", {modelKey: "p/x", reasoningEffort: null, temperature: null}))
            .rejects.toMatchObject({code: "MODEL_INVALID"});
        expect(mocks.saveProjectConfig).not.toHaveBeenCalled();
    });
});
