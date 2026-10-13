import {describe, expect, it} from "vitest";
import {Value} from "typebox/value";
import plannerDefinition from "../../../assets/workspace/.nbook/agent/profiles/builtin/outline.planner.profile";
import outlineDefinition from "../../../assets/workspace/.nbook/agent/profiles/builtin/outline.outline.profile";
import detailedDefinition from "../../../assets/workspace/.nbook/agent/profiles/builtin/outline.detailed.profile";
import foreshadowingDefinition from "../../../assets/workspace/.nbook/agent/profiles/builtin/outline.foreshadowing.profile";
import {normalizeAgentProfile} from "nbook/server/agent/profiles/define-agent-profile";
import {PLANNING_SPECIALIST_PROFILE_KEYS} from "nbook/server/agent/tools/planning-specialist-tool";
import {messageText} from "nbook/server/agent/messages/message-utils";
import {createTestRuntimeSession} from "nbook/server/agent/profiles/test/runtime-session";
import {createTestVariableAccessor} from "nbook/server/agent/variables/test-utils";
import type {AgentProfile} from "nbook/server/agent/profiles/types";

// 规划与改编记录共用受委派门禁的提交；通用素材读写会绕过目录和方案边界。
const FORBIDDEN_SPECIALIST_TOOLS = [
    "apply_planning_change", "undo_planning_change", "write", "edit", "apply_patch", "bash",
    "create_agent", "invoke_agent", "consult_planning_specialist", "delegate_planning_task", "request_user_input",
    "read", "write_lorebook", "edit_lorebook",
];
const SPECIALIST_TOOLS = ["commit_planning_change", "list_planning_materials", "read_planning_material"];

const specialists = [
    {profile: normalizeAgentProfile(outlineDefinition), key: "outline.outline", marker: true},
    {profile: normalizeAgentProfile(detailedDefinition), key: "outline.detailed", marker: false},
    {profile: normalizeAgentProfile(foreshadowingDefinition), key: "outline.foreshadowing", marker: true},
];

describe("规划专家 Profile 合同", () => {
    it("委派工具映射的 profile key 与专家 Profile 一致", () => {
        expect(Object.values(PLANNING_SPECIALIST_PROFILE_KEYS).sort()).toEqual(specialists.map((item) => item.key).sort());
    });

    it.each(specialists)("$key 持有规划提交和受控素材读取工具，不持有通用素材写入、协作或交互工具", ({profile, key, marker}) => {
        expect(profile.manifest.key).toBe(key);
        const toolKeys: readonly string[] = profile.rootToolKeys;
        expect(toolKeys).toEqual(expect.arrayContaining(["get_planning_context", "preview_planning_change", "report_result", ...SPECIALIST_TOOLS]));
        for (const forbidden of FORBIDDEN_SPECIALIST_TOOLS) expect(toolKeys).not.toContain(forbidden);
        const markerTools = ["get_foreshadowing_context", "suggest_foreshadowing_marker"];
        if (marker) expect(toolKeys).toEqual(expect.arrayContaining(markerTools));
        else for (const tool of markerTools) expect(toolKeys).not.toContain(tool);
    });

    it.each(specialists)("$key 的 InitialSchema 只接受 projectRoot，OutputSchema 为结构化建议报告", ({profile}) => {
        expect(Value.Check(profile.initialSchema!, {projectRoot: "demo"})).toBe(true);
        expect(Value.Check(profile.initialSchema!, {projectRoot: ""})).toBe(false);
        expect(Value.Check(profile.initialSchema!, {projectRoot: "demo", mode: "auto"})).toBe(false);
        expect(Value.Check(profile.outputSchema!, {
            summary: "摘要",
            proposals: [{title: "回收", rationale: "埋设已完成", basis: "suggestion", change: {operation: "mutate", proposalId: "outline:x"}}],
            openQuestions: ["是否提前揭示"],
        })).toBe(true);
        expect(Value.Check(profile.outputSchema!, {
            summary: "已写入", proposals: [], openQuestions: [],
            applied: [{kind: "lorebook", target: "lorebook/item/key/改编中的内容/plan-a/ol-ch1.md", summary: "同步钥匙的改编用途", transactionId: "tx-1"}, {kind: "planning", target: "ol-ch1", summary: "细纲", transactionId: "tx-1"}],
        })).toBe(true);
        expect(Value.Check(profile.outputSchema!, {summary: "摘要", proposals: [{title: "x", rationale: "y", basis: "guess"}], openQuestions: []})).toBe(false);
    });

    it("规划助手持有咨询、委派与素材读取工具，但不直接写 lorebook 或任意文件", () => {
        const toolKeys: readonly string[] = normalizeAgentProfile(plannerDefinition).rootToolKeys;
        expect(toolKeys).toEqual(expect.arrayContaining(["consult_planning_specialist", "delegate_planning_task", "list_planning_materials", "read_planning_material", "apply_planning_change", "undo_planning_change"]));
        for (const forbidden of ["read", "write", "edit", "apply_patch", "bash", "write_lorebook", "edit_lorebook", "commit_planning_change"]) {
            expect(toolKeys).not.toContain(forbidden);
        }
    });

    // Import 缺失时静默渲染为空，路径写错不会报错，只能在这里核对操作合同确实进入上下文。
    it.each([
        // 参考资料不在 Project 内，Profile 必须直接载入，不能让素材工具读取安装资产。
        {profile: normalizeAgentProfile(plannerDefinition), initial: {projectRoot: "demo", scope: {}, mode: "discuss", model: "m", temperature: 0.7, thinking: "off"}, imports: ["SKILL.md", "outline-templates.md", "material-adaptation.md"]},
        {profile: normalizeAgentProfile(outlineDefinition), initial: {projectRoot: "demo"}, imports: ["SKILL.md", "outline-templates.md", "material-adaptation.md"]},
        {profile: normalizeAgentProfile(detailedDefinition), initial: {projectRoot: "demo"}, imports: ["SKILL.md", "outline-templates.md", "material-adaptation.md"]},
        {profile: normalizeAgentProfile(foreshadowingDefinition), initial: {projectRoot: "demo"}, imports: ["SKILL.md", "outline-templates.md", "material-adaptation.md"]},
    ])("$profile.manifest.key 的上下文载入大纲规划操作合同", async ({profile, initial, imports}) => {
        const history = await renderHistory(profile, initial);
        const headings: Record<string, string> = {
            "SKILL.md": "# 大纲规划操作合同",
            "outline-templates.md": "# 各级大纲正文模板",
            "detail-annotations.md": "# 细纲标注：写作指导与段落参考",
            "material-adaptation.md": "# 素材运用与改编指南",
        };
        for (const [file, heading] of Object.entries(headings)) {
            if (imports.includes(file)) expect(history).toContain(heading);
            else expect(history).not.toContain(heading);
        }
    });
});

async function renderHistory(profile: AgentProfile<any>, initial: object): Promise<string> {
    const plan = await profile.prepare!({
        session: createTestRuntimeSession({profileKey: profile.manifest.key, currentProjectRoot: "demo"}),
        initial,
        vars: createTestVariableAccessor(),
        catalog: {profiles: [], issues: []},
        skills: [],
        settings: {},
    });
    return (plan.historyInitMessages ?? []).map((message) => messageText(message as never)).join("\n");
}
