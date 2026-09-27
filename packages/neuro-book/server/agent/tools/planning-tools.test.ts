import {describe, expect, it, vi} from "vitest";
import {Value} from "typebox/value";
import {OUTLINE_AGENT_TOOL_KEYS, createPlanningTools, planningProposalId} from "nbook/server/agent/tools/planning-tools";
import writerProfileDefinition from "../../../assets/workspace/.nbook/agent/profiles/builtin/writer.profile";

const tools = createPlanningTools();
const byKey = (key: string) => tools.find((tool) => tool.key === key)!;
const objectHash = "sha256:" + "a".repeat(64);

function context(currentProject: unknown = {workspace: {root: "C:/project"}}) {
    return {sessionId: 42, currentProject} as never;
}

describe("规划 Agent 工具边界", () => {
    it("只注册规划 capability，不暴露通用文件写入工具", () => {
        expect(tools.map((tool) => tool.key)).toEqual([...OUTLINE_AGENT_TOOL_KEYS]);
        expect(tools.map((tool) => tool.key)).not.toEqual(expect.arrayContaining(["read", "write", "edit", "apply_patch", "bash"]));
        expect(Object.keys(writerProfileDefinition.tools)).not.toEqual(expect.arrayContaining([
            "getPlanningContext", "previewPlanningChange", "applyPlanningChange", "undoPlanningChange",
        ]));
    });

    it("正式写入与撤销始终要求审批，并标记为 workspace mutation", () => {
        expect(byKey("apply_planning_change")).toMatchObject({approvalRequired: true, mutatesWorkspace: true, executionMode: "sequential"});
        expect(byKey("undo_planning_change")).toMatchObject({approvalRequired: true, mutatesWorkspace: true, executionMode: "sequential"});
        expect(byKey("preview_planning_change")).toMatchObject({mutatesWorkspace: false});
        expect(byKey("get_foreshadowing_context")).toMatchObject({mutatesWorkspace: false, executionMode: "parallel"});
        expect(byKey("suggest_foreshadowing_marker")).toMatchObject({mutatesWorkspace: false, executionMode: "parallel"});
    });

    it("没有 ready Project 时读取工具 fail closed", async () => {
        await expect(byKey("get_planning_context").executeWithContext?.(context(null), "call-1", {})).rejects.toThrow("ready Project");
    });

    it("删除参数没有 confirmed 时不会通过 schema", () => {
        const tool = byKey("apply_planning_change");
        expect(Value.Check(tool.parameters, {
            changes: [{operation: "delete-object", targetId: "ol-root", expectedRevision: 0, expectedObjectHash: objectHash}],
        })).toBe(false);
        expect(Value.Check(tool.parameters, {
            changes: [{operation: "delete-object", targetId: "ol-root", expectedRevision: 0, expectedObjectHash: objectHash, confirmed: true, proposalId: planningProposalId({operation: "delete-object", targetId: "ol-root", expectedRevision: 0, expectedObjectHash: objectHash})}],
        })).toBe(true);
    });

    it("伏笔标记建议必须带 CAS、目标和理由，并且不把建议工具标成写入", () => {
        const tool = byKey("suggest_foreshadowing_marker");
        expect(Value.Check(tool.parameters, {
            action: "strengthen",
            expectedRevision: 7,
            planId: "plan-main",
            entryId: "ol-chapter",
            foreshadowingId: "fo-clue",
            expectedVersion: 3,
            expectedContentHash: objectHash,
            body: "候选章节正文",
            rationale: "在冲突处强化线索",
        })).toBe(true);
        expect(Value.Check(tool.parameters, {
            action: "strengthen",
            expectedRevision: 7,
            planId: "plan-main",
            entryId: "ol-chapter",
            foreshadowingId: "fo-clue",
            expectedVersion: 3,
            expectedContentHash: objectHash,
            body: "候选章节正文",
        })).toBe(false);
        expect(tool.mutatesWorkspace).toBe(false);
        expect(tool.approvalRequired).not.toBe(true);
    });

    it("读取伏笔上下文至少需要一个伏笔或章节筛选条件", async () => {
        const tool = byKey("get_foreshadowing_context");
        expect(Value.Check(tool.parameters, {foreshadowingId: "fo-clue"})).toBe(true);
        expect(Value.Check(tool.parameters, {entryIds: ["ol-chapter"]})).toBe(true);
        expect(Value.Check(tool.parameters, {entryIds: []})).toBe(false);
        await expect(tool.executeWithContext?.(context(), "call-empty", {})).rejects.toThrow("至少指定 foreshadowingId 或 entryIds");
    });
    it("预览参数对外为顶层 object，执行时仍按 operation 严格校验分支字段", async () => {
        const tool = byKey("preview_planning_change");
        expect(Value.Check(tool.parameters, {operation: "delete-object", targetId: "ol-root"})).toBe(true);
        await expect(tool.executeWithContext?.(context(), "call-mixed", {operation: "delete-plan", targetId: "ol-root"}))
            .rejects.toThrow("preview_planning_change 参数无效");
    });
    it("线路动作在公开参数合同中可被预览绑定", () => {
        const tool = byKey("apply_planning_change");
        const bound = (action: object) => ({changes: [{operation: "mutate" as const, expectedRevision: 0, action,
            proposalId: planningProposalId({operation: "mutate", expectedRevision: 0, action})}]});
        const createLine = {kind: "create-line" as const, planId: "plan-main", title: "主线", type: "main" as const,
            nodeIds: ["nd-first", "nd-second"]};
        expect(Value.Check(tool.parameters, bound(createLine))).toBe(true);
        expect(Value.Check(tool.parameters, bound({kind: "add-graph-node", planId: "plan-main", expectedGraphVersion: 0,
            column: 0, row: 0, entryId: null}))).toBe(true);
        const {nodeIds: _nodeIds, ...withoutNodes} = createLine;
        expect(Value.Check(tool.parameters, bound(withoutNodes))).toBe(false);
        expect(Value.Check(tool.parameters, bound({kind: "add-line-node", lineId: "ln-main", expectedVersion: 0,
            expectedContentHash: `sha256:${"0".repeat(64)}`, entryId: "ol-root"}))).toBe(false);
    });
    it("预览绑定只允许原始变更，篡改目标后不会执行", async () => {
        const host = await import("nbook/server/outline/host");
        const remove = vi.spyOn(host, "removeReadyPlanningObject");
        const change = {operation: "delete-object" as const, targetId: "ol-other", expectedRevision: 0,
            expectedObjectHash: objectHash, confirmed: true as const,
            proposalId: planningProposalId({operation: "delete-object", targetId: "ol-root", expectedRevision: 0, expectedObjectHash: objectHash})};
        const output = await byKey("apply_planning_change").executeWithContext?.(context(), "call-stale", {changes: [change]});
        const payload = JSON.parse(output!.content[0]!.type === "text" ? output!.content[0]!.text : "{}");
        expect(payload.results[0]).toEqual(expect.objectContaining({index: 0, status: "failed", error: "规划预览已变化或已过期，请重新预览"}));
        expect(payload.results[0].audit).toMatchObject({phase: "apply", result: "failed", targetIds: ["ol-other"]});
        expect(remove).not.toHaveBeenCalled();
        remove.mockRestore();
    });

    it("批量执行逐项返回失败，不吞掉已经完成的项", async () => {
        const host = await import("nbook/server/outline/host");
        const remove = vi.spyOn(host, "removeReadyPlanningObject")
            .mockResolvedValueOnce({transactionId: "tx-1"} as never)
            .mockRejectedValueOnce(new Error("第二项版本冲突"));
        const result = await byKey("apply_planning_change").executeWithContext?.(context(), "call-2", {
            changes: [
                {operation: "delete-object", targetId: "ol-root", expectedRevision: 0, expectedObjectHash: objectHash, confirmed: true, proposalId: planningProposalId({operation: "delete-object", targetId: "ol-root", expectedRevision: 0, expectedObjectHash: objectHash})},
                {operation: "delete-object", targetId: "ol-other", expectedRevision: 0, expectedObjectHash: objectHash, confirmed: true, proposalId: planningProposalId({operation: "delete-object", targetId: "ol-other", expectedRevision: 0, expectedObjectHash: objectHash})},
            ],
        });
        const payload = JSON.parse(result!.content[0]!.type === "text" ? result!.content[0]!.text : "{}");
        expect(payload.results).toEqual([
            expect.objectContaining({index: 0, status: "applied", transactionId: "tx-1"}),
            expect.objectContaining({index: 1, status: "failed", error: "第二项版本冲突"}),
        ]);
        expect(payload.results[0].audit).toMatchObject({phase: "apply", result: "applied", transactionId: "tx-1", targetIds: ["ol-root"]});
        expect(payload.results[1].audit).toMatchObject({phase: "apply", result: "failed", targetIds: ["ol-other"]});
        expect(payload.partialFailure).toBe(true);
        expect(remove).toHaveBeenNthCalledWith(1, expect.anything(), "ol-root", 0, objectHash, false, {kind: "agent", sessionId: "42"});
        expect(remove).toHaveBeenNthCalledWith(2, expect.anything(), "ol-other", 0, objectHash, false, {kind: "agent", sessionId: "42"});
        remove.mockRestore();
    });
});
