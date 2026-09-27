import {describe, expect, it} from "vitest";
import {Value} from "typebox/value";
import plannerDefinition from "../../../assets/workspace/.nbook/agent/profiles/builtin/outline.planner.profile";
import outlineDefinition from "../../../assets/workspace/.nbook/agent/profiles/builtin/outline.outline.profile";
import detailedDefinition from "../../../assets/workspace/.nbook/agent/profiles/builtin/outline.detailed.profile";
import foreshadowingDefinition from "../../../assets/workspace/.nbook/agent/profiles/builtin/outline.foreshadowing.profile";
import {normalizeAgentProfile} from "nbook/server/agent/profiles/define-agent-profile";
import {PLANNING_SPECIALIST_PROFILE_KEYS} from "nbook/server/agent/tools/planning-specialist-tool";

// 专家的写入只走受委派门禁的 commit/lorebook 工具；通用写工具没有路径范围，不能出现在专家上。
const FORBIDDEN_SPECIALIST_TOOLS = [
    "apply_planning_change", "undo_planning_change", "write", "edit", "apply_patch", "bash",
    "create_agent", "invoke_agent", "consult_planning_specialist", "delegate_planning_task", "request_user_input",
];
const SPECIALIST_WRITE_TOOLS = ["commit_planning_change", "read", "write_lorebook", "edit_lorebook"];

const specialists = [
    {profile: normalizeAgentProfile(outlineDefinition), key: "outline.outline", marker: true},
    {profile: normalizeAgentProfile(detailedDefinition), key: "outline.detailed", marker: false},
    {profile: normalizeAgentProfile(foreshadowingDefinition), key: "outline.foreshadowing", marker: true},
];

describe("规划专家 Profile 合同", () => {
    it("委派工具映射的 profile key 与专家 Profile 一致", () => {
        expect(Object.values(PLANNING_SPECIALIST_PROFILE_KEYS).sort()).toEqual(specialists.map((item) => item.key).sort());
    });

    it.each(specialists)("$key 持有受委派门禁的规划与 lorebook 写入工具，不持有通用写入、协作或交互工具", ({profile, key, marker}) => {
        expect(profile.manifest.key).toBe(key);
        const toolKeys: readonly string[] = profile.rootToolKeys;
        expect(toolKeys).toEqual(expect.arrayContaining(["get_planning_context", "preview_planning_change", "report_result", ...SPECIALIST_WRITE_TOOLS]));
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
            applied: [{kind: "lorebook", target: "lorebook/item/key.md", summary: "新增钥匙设定"}, {kind: "planning", target: "ol-ch1", summary: "细纲", transactionId: "tx-1"}],
        })).toBe(true);
        expect(Value.Check(profile.outputSchema!, {summary: "摘要", proposals: [{title: "x", rationale: "y", basis: "guess"}], openQuestions: []})).toBe(false);
    });

    it("规划助手持有咨询、委派与素材读取工具，但不直接写 lorebook 或任意文件", () => {
        const toolKeys: readonly string[] = normalizeAgentProfile(plannerDefinition).rootToolKeys;
        expect(toolKeys).toEqual(expect.arrayContaining(["consult_planning_specialist", "delegate_planning_task", "read", "apply_planning_change", "undo_planning_change"]));
        for (const forbidden of ["write", "edit", "apply_patch", "bash", "write_lorebook", "edit_lorebook", "commit_planning_change"]) {
            expect(toolKeys).not.toContain(forbidden);
        }
    });
});
