import {describe, expect, it, vi} from "vitest";
import {contentHash, serializeEntryMarkdown, serializeForeshadowingMarkdown, type OutlineEntry, type Foreshadowing} from "nbook/server/outline/format";
import type {PlanningSnapshot} from "nbook/server/outline";
import * as outlineHost from "nbook/server/outline/index";
import * as foreshadowing from "nbook/server/outline/foreshadowing";
import {createPlanningTools} from "nbook/server/agent/tools/planning-tools";

const entry: OutlineEntry = {
    schema: "nbook.outline-entry/v2",
    id: "ol-chapter",
    version: 3,
    kind: "chapter",
    status: "adopted",
    title: "第一章",
    parentId: "ol-root",
    chapterId: null,
    body: "旧章节正文",
};
const entryPath = "outline/entries/chapter--ol-chapter.md";
const definition: Foreshadowing = {
    schema: "nbook.outline-foreshadowing/v2",
    id: "fo-clue",
    version: 1,
    status: "adopted",
    title: "线索",
    body: "银纹",
};
const snapshot = {
    manifest: {
        schema: "nbook.outline/v3",
        revision: 7,
        plans: [{id: "plan-main", title: "主方案", totalId: "ol-root", placements: [{entryId: entry.id, parentId: "ol-root", position: 0}]}],
        entries: [{id: entry.id, path: entryPath, version: entry.version, contentHash: contentHash(serializeEntryMarkdown(entry))}],
        foreshadowing: [{id: definition.id, path: "outline/foreshadowing/clue--fo-clue.md", version: definition.version, contentHash: contentHash(serializeForeshadowingMarkdown(definition))}],
        lines: [],
    },
    entries: [{value: entry, path: entryPath, contentHash: contentHash(serializeEntryMarkdown(entry)), markers: []}],
    foreshadowing: [{value: definition, path: "outline/foreshadowing/clue--fo-clue.md", contentHash: contentHash(serializeForeshadowingMarkdown(definition))}],
    lines: [],
} as unknown as PlanningSnapshot;

function context() {
    return {
        sessionId: 42,
        profileKey: "outline.planner",
        currentProject: {generation: 3, workspace: {root: "C:/project"}},
    } as never;
}

function tool(key: string) {
    const found = createPlanningTools().find((candidate) => candidate.key === key);
    if (!found) throw new Error(`missing tool ${key}`);
    return found;
}

describe("规划 Agent 伏笔上下文与建议工具", () => {
    it("只返回指定章节的正文、结构化标记和伏笔状态，不读取原始路径", async () => {
        const read = vi.spyOn(outlineHost, "readForeshadowingSnapshot").mockResolvedValue({snapshot, markerIssues: []});
        const derive = vi.spyOn(foreshadowing, "deriveForeshadowingStates").mockReturnValue([{
            id: "fo-clue", status: "pending", sources: [], issues: [],
        }]);
        const result = await tool("get_foreshadowing_context").executeWithContext?.(context(), "context", {entryIds: ["ol-chapter"]});
        const payload = JSON.parse(result!.content[0]!.type === "text" ? result!.content[0]!.text : "{}");
        expect(payload.manifestRevision).toBe(7);
        expect(payload.entries).toHaveLength(1);
        expect(payload.entries[0]).toMatchObject({id: "ol-chapter", body: "旧章节正文"});
        expect(payload.definitions).toMatchObject([{id: "fo-clue", title: "线索"}]);
        expect(payload.states).toEqual([{id: "fo-clue", status: "pending", sources: [], issues: []}]);
        expect(read).toHaveBeenCalledWith({projectRoot: "C:/project"});
        derive.mockRestore();
        read.mockRestore();
    });

    it("建议工具只生成带 proposalId 的待审批变更，并提示正式章节需要重新采用", async () => {
        const read = vi.spyOn(outlineHost, "readPlanningSnapshot").mockResolvedValue(snapshot);
        const input = {
            action: "strengthen",
            expectedRevision: 7,
            planId: "plan-main",
            entryId: "ol-chapter",
            foreshadowingId: "fo-clue",
            expectedVersion: 3,
            expectedContentHash: snapshot.entries[0]!.contentHash,
            body: '新正文<!-- nb:foreshadow marker="fm-reinforce" foreshadow="fo-clue" action="reinforce" -->银纹<!-- /nb:foreshadow marker="fm-reinforce" -->',
            rationale: "在冲突处强化线索。",
        };
        const result = await tool("suggest_foreshadowing_marker").executeWithContext?.(context(), "suggestion", input);
        const payload = JSON.parse(result!.content[0]!.type === "text" ? result!.content[0]!.text : "{}");
        expect(payload.suggestion).toMatchObject({action: "strengthen", foreshadowingId: "fo-clue", sourceEntryIds: ["ol-chapter"]});
        expect(payload.change).toMatchObject({operation: "mutate", proposalId: expect.stringMatching(/^outline:/u), action: {kind: "edit-entry"}});
        expect(payload.requiresReadoption).toBe(true);
        read.mockRestore();
    });

    it("损坏标记修复使用容错上下文和专用 apply action", async () => {
        const read = vi.spyOn(outlineHost, "readForeshadowingSnapshot").mockResolvedValue({snapshot, markerIssues: [
            {entryId: "ol-chapter", path: entryPath, diagnostics: [{code: "INVALID_MARKER", message: "损坏"}]},
        ]});
        const input = {
            action: "repair",
            expectedRevision: 7,
            planId: "plan-main",
            entryId: "ol-chapter",
            foreshadowingId: "fo-clue",
            expectedVersion: 3,
            expectedContentHash: snapshot.entries[0]!.contentHash,
            body: '修复正文<!-- nb:foreshadow marker="fm-plant" foreshadow="fo-clue" action="plant" -->银纹<!-- /nb:foreshadow marker="fm-plant" -->',
            rationale: "修复损坏的伏笔标记。",
        };
        const result = await tool("suggest_foreshadowing_marker").executeWithContext?.(context(), "repair", input);
        const payload = JSON.parse(result!.content[0]!.type === "text" ? result!.content[0]!.text : "{}");
        expect(payload.change.action).toMatchObject({kind: "repair-foreshadowing-marker", expectedRevision: 7});
        expect(payload.change.proposalId).toMatch(/^outline:/u);
        read.mockRestore();
    });
});
