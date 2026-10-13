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

    it("规划上下文默认只给摘要，按 entryIds 返回可作为 edit-entry 基准的正文与元数据", async () => {
        const index = await import("nbook/server/outline/index");
        const entry = (id: string, kind: string, parentId: string | null, body: string, extra: object = {}) => ({
            path: `outline/entries/${id}.md`, contentHash: objectHash, markers: kind === "chapter" ? [{marker: "fm-01"}] : [],
            value: {schema: "nbook.outline-entry/v2", id, kind, version: 2, status: "draft", title: id, parentId,
                chapterId: kind === "detail" ? parentId : null, body, ...extra},
        });
        const read = vi.spyOn(index, "readPlanningSnapshot").mockResolvedValue({
            // 方案 B 使用自己的总纲，条目 ol-chapter 的规范父级仍是创建时的 ol-total。
            manifest: {revision: 5, plans: [
                {id: "plan-a", title: "A", totalId: "ol-total", placements: [{entryId: "ol-total", parentId: null, position: 0}, {entryId: "ol-chapter", parentId: "ol-total", position: 0}]},
                {id: "plan-b", title: "B", totalId: "ol-total-b", placements: [{entryId: "ol-total-b", parentId: null, position: 0}, {entryId: "ol-chapter", parentId: "ol-total-b", position: 0}]},
            ]},
            entries: [
                entry("ol-total", "total", null, "总纲正文"),
                entry("ol-total-b", "total", null, "方案 B 总纲正文"),
                entry("ol-chapter", "chapter", "ol-total", "章节正文"),
                entry("ol-detail", "detail", "ol-chapter", "细纲正文", {targetWords: 3000, analysis: {reportId: "r", planId: "plan-a",
                    sourceHash: objectHash, contextHash: objectHash, summary: "无冲突", deviations: [], conflicts: [], resolutions: []}}),
            ],
            foreshadowing: [], graphs: [], lines: [],
        } as never);
        const tool = byKey("get_planning_context");
        const payloadOf = (output: Awaited<ReturnType<NonNullable<typeof tool.executeWithContext>>>) =>
            JSON.parse(output.content[0]!.type === "text" ? output.content[0]!.text : "{}");
        const summary = payloadOf(await tool.executeWithContext!(context(), "call-summary", {}));
        expect(summary.details).toBeUndefined();
        expect(summary.totalId).toBeUndefined();
        expect(summary.plans.map((plan: {id: string; totalId: string}) => [plan.id, plan.totalId])).toEqual([["plan-a", "ol-total"], ["plan-b", "ol-total-b"]]);
        const chapterSummary = summary.entries.find((item: {id: string}) => item.id === "ol-chapter");
        expect(chapterSummary).toEqual(expect.objectContaining({id: "ol-chapter", parentId: "ol-total"}));
        expect(chapterSummary.body).toBeUndefined();
        const detailed = payloadOf(await tool.executeWithContext!(context(), "call-detail", {entryIds: ["ol-chapter", "ol-detail"]}));
        expect(detailed.details[0]).toEqual(expect.objectContaining({id: "ol-chapter", body: "章节正文", version: 2, contentHash: objectHash,
            planIds: ["plan-a", "plan-b"], markers: [{marker: "fm-01"}]}));
        expect(detailed.details[1]).toEqual(expect.objectContaining({id: "ol-detail", chapterId: "ol-chapter", targetWords: 3000,
            analysis: expect.objectContaining({summary: "无冲突"})}));
        expect(detailed.details[1].markers).toBeUndefined();
        expect(detailed.details[1].schema).toBeUndefined();
        expect(detailed.plans).toBeUndefined();
        expect(detailed.entries).toBeUndefined();
        expect(detailed.graphs).toBeUndefined();
        expect(detailed.details[0].placements).toEqual([
            {planId: "plan-a", totalId: "ol-total", entryId: "ol-chapter", parentId: "ol-total", position: 0},
            {planId: "plan-b", totalId: "ol-total-b", entryId: "ol-chapter", parentId: "ol-total-b", position: 0},
        ]);
        expect(detailed.relatedEntries.map((item: {id: string}) => item.id)).toEqual(["ol-total", "ol-total-b"]);
        expect(detailed.relatedEntries.every((item: {body?: string}) => item.body === undefined)).toBe(true);
        await expect(tool.executeWithContext!(context(), "call-missing", {entryIds: ["ol-missing"]})).rejects.toThrow("规划条目不存在：ol-missing");
        await expect(tool.executeWithContext!(context(), "call-bad", {entryIds: ["fo-clue"]})).rejects.toThrow("get_planning_context 参数无效");
        read.mockRestore();
    });

    it("大量条目默认只读首页，按 revision 分页能读取完整索引而不重复全库正文", async () => {
        const index = await import("nbook/server/outline/index");
        const entries = Array.from({length: 147}, (_, i) => ({path: `outline/entries/ol-${i}.md`, contentHash: objectHash,
            markers: [], value: {schema: "nbook.outline-entry/v2", id: `ol-${i}`, kind: i === 0 ? "total" : "chapter",
                version: 3, status: "draft", title: `第${i}章`, parentId: i === 0 ? null : "ol-0", chapterId: null,
                body: `完整正文${i}`.repeat(1000)}}));
        const snapshot = {manifest: {revision: 8, plans: [{id: "plan-main", title: "主方案", totalId: "ol-0",
            placements: entries.map(({value}, position) => ({entryId: value.id, parentId: value.parentId, position}))}]},
            entries, foreshadowing: [], graphs: [], lines: []};
        const read = vi.spyOn(index, "readPlanningSnapshot").mockResolvedValue(snapshot as never);
        const tool = byKey("get_planning_context");
        const invoke = async (input: object) => {
            const output = await tool.executeWithContext!(context(), "page", input);
            return JSON.parse(output.content[0]!.type === "text" ? output.content[0]!.text : "{}");
        };
        try {
            const overview = await invoke({});
            expect(overview.counts.entries).toBe(147);
            expect(overview.entries).toHaveLength(32);
            expect(overview.page).toEqual({offset: 0, limit: 32, total: 147, nextOffset: 32});
            expect(overview.plans[0].placements).toBeUndefined();
            expect(overview.graphs).toBeUndefined();
            expect(overview.lines).toBeUndefined();
            const ids: string[] = [];
            let offset: number | null = 0;
            do {
                const page = await invoke({mode: "entries", offset, limit: 50, expectedRevision: overview.revision});
                expect(page.plans).toBeUndefined();
                expect(page.entries.every((entry: {body?: string}) => entry.body === undefined)).toBe(true);
                ids.push(...page.entries.map((entry: {id: string}) => entry.id));
                offset = page.page.nextOffset;
            } while (offset !== null);
            expect(ids).toEqual(entries.map(({value}) => value.id));
            const details = await invoke({entryIds: ["ol-146"]});
            expect(details.details[0].body).toBe(entries[146]!.value.body);
            expect(details.details[0]).toMatchObject({version: 3, contentHash: objectHash});
            expect(details.relatedEntries.map((entry: {id: string}) => entry.id)).toEqual(["ol-0"]);
            expect(details.entries).toBeUndefined();
            expect(details.plans).toBeUndefined();
            expect(JSON.stringify(details).length).toBeLessThan(20000);
            const repeated = await invoke({entryIds: ["ol-146"], expectedRevision: 8});
            expect(repeated.contextHash).toBe(details.contextHash);
            expect(details.contextScope).toEqual({mode: "details", entryIds: ["ol-146"]});
            read.mockResolvedValue({...snapshot, manifest: {...snapshot.manifest, revision: 9}} as never);
            await expect(invoke({mode: "entries", offset: 50, expectedRevision: 8})).rejects.toThrow("规划版本已变化");
        } finally {
            read.mockRestore();
        }
    });

    it("方案、图节点与边按需分页，筛选条件不能被静默忽略", async () => {
        const index = await import("nbook/server/outline/index");
        const placement = {entryId: "ol-root", parentId: null, position: 0};
        const read = vi.spyOn(index, "readPlanningSnapshot").mockResolvedValue({manifest: {revision: 6, plans: [
            {id: "plan-a", title: "A", totalId: "ol-root", placements: [placement]},
            {id: "plan-b", title: "B", totalId: "ol-root-b", placements: []},
        ]}, entries: [{path: "outline/entries/root.md", contentHash: objectHash, markers: [],
            value: {id: "ol-root", title: "总纲", parentId: null, kind: "total", status: "draft", version: 0}}],
        foreshadowing: [], lines: [], graphs: [{contentHash: objectHash, value: {id: "gr-a", planId: "plan-a", version: 2,
            nodes: [{id: "nd-a", entryId: "ol-root", column: 0, row: 0}, {id: "nd-b", entryId: null, column: 1, row: 0}],
            edges: [{id: "eg-a", from: "nd-a", to: "nd-b"}]}}]} as never);
        const tool = byKey("get_planning_context");
        const invoke = async (input: object) => {
            const output = await tool.executeWithContext!(context(), "topology", input);
            return JSON.parse(output.content[0]!.type === "text" ? output.content[0]!.text : "{}");
        };
        try {
            const plans = await invoke({mode: "plans", limit: 1, offset: 1});
            expect(plans.plans.map((plan: {id: string}) => plan.id)).toEqual(["plan-b"]);
            expect(plans.page.nextOffset).toBeNull();
            expect((await invoke({mode: "placements", planId: "plan-a"})).placements).toEqual([placement]);
            const graphs = await invoke({mode: "graphs", planId: "plan-a"});
            expect(graphs.graphs[0]).toMatchObject({id: "gr-a", nodeCount: 2, edgeCount: 1, version: 2, contentHash: objectHash});
            expect(graphs.graphs[0].nodes).toBeUndefined();
            const nodes = await invoke({mode: "graph-nodes", graphId: "gr-a", limit: 1});
            expect(nodes.nodes).toEqual([{id: "nd-a", entryId: "ol-root", column: 0, row: 0, title: "总纲"}]);
            expect(nodes.page.nextOffset).toBe(1);
            expect(nodes.graphVersion).toBe(2);
            expect((await invoke({mode: "graph-edges", graphId: "gr-a"})).edges).toEqual([{id: "eg-a", from: "nd-a", to: "nd-b"}]);
            await expect(invoke({mode: "details"})).rejects.toThrow("details 仅支持 entryIds");
            await expect(invoke({entryIds: ["ol-root"], mode: "entries"})).rejects.toThrow("entryIds 仅支持 details");
            await expect(invoke({entryIds: ["ol-root"], offset: 0})).rejects.toThrow("不支持分页");
            await expect(invoke({mode: "entries", graphId: "gr-a"})).rejects.toThrow("graphId 仅支持");
            await expect(invoke({mode: "placements"})).rejects.toThrow("placements 需要 planId");
            await expect(invoke({mode: "graph-nodes"})).rejects.toThrow("graph-nodes 需要 graphId");
            await expect(invoke({mode: "entries", planId: "plan-missing"})).rejects.toThrow("规划方案不存在");
            await expect(invoke({mode: "graph-nodes", graphId: "gr-a", planId: "plan-b"})).rejects.toThrow("规划线路图不存在");
            await expect(invoke({mode: "entries", limit: 101})).rejects.toThrow("参数无效");
        } finally {
            read.mockRestore();
        }
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
