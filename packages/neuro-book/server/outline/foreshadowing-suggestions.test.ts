import {describe, expect, it} from "vitest";
import {
    contentHash,
    createEmptyManifest,
    parseForeshadowMarkers,
    serializeEntryMarkdown,
    serializeForeshadowingMarkdown,
    type Foreshadowing,
    type OutlineEntry,
} from "./format";
import {prepareForeshadowingMarkerSuggestion} from "./foreshadowing-suggestions";
import type {PlanningSnapshot} from "./index";

const marker = (id: string, action: "plant" | "reinforce" | "recover") =>
    `<!-- nb:foreshadow marker="fm-${id}" foreshadow="fo-clue" action="${action}" -->${id}<!-- /nb:foreshadow marker="fm-${id}" -->`;

function snapshot(body = marker("plant", "plant")): PlanningSnapshot {
    const entry: OutlineEntry = {
        schema: "nbook.outline-entry/v1",
        id: "ol-chapter",
        version: 3,
        kind: "chapter",
        status: "adopted",
        title: "第一章",
        parentId: "ol-root",
        chapterId: null,
        body,
    };
    const entryPath = "outline/entries/chapter--ol-chapter.md";
    const entryFile = serializeEntryMarkdown(entry);
    const definition: Foreshadowing = {
        schema: "nbook.outline-foreshadowing/v1",
        id: "fo-clue",
        version: 1,
        status: "adopted",
        title: "线索",
        body: "银纹",
    };
    const definitionFile = serializeForeshadowingMarkdown(definition);
    const manifest = {
        ...createEmptyManifest(),
        revision: 4,
        plans: [{id: "plan-main", title: "主方案", placements: [{entryId: entry.id, parentId: "ol-root", position: 0}]}],
        entries: [{id: entry.id, path: entryPath, version: entry.version, contentHash: contentHash(entryFile)}],
        foreshadowing: [{id: definition.id, path: "outline/foreshadowing/clue--fo-clue.md", version: definition.version, contentHash: contentHash(definitionFile)}],
    };
    return {
        manifest,
        entries: [{value: entry, path: entryPath, contentHash: contentHash(entryFile), markers: parseForeshadowMarkers(body, new Set([definition.id]), entryPath)}],
        foreshadowing: [{value: definition, path: "outline/foreshadowing/clue--fo-clue.md", contentHash: contentHash(definitionFile)}],
        lines: [],
    };
}

describe("伏笔标记建议", () => {
    it("把强化建议收口为待审批的章节草稿变更，不直接写入", () => {
        const current = snapshot();
        const body = marker("plant", "plant") + " " + marker("reinforce", "reinforce");
        const prepared = prepareForeshadowingMarkerSuggestion(current, {
            action: "strengthen",
            expectedRevision: 4,
            planId: "plan-main",
            entryId: "ol-chapter",
            foreshadowingId: "fo-clue",
            expectedVersion: 3,
            expectedContentHash: current.entries[0]!.contentHash,
            body,
            rationale: "在冲突升级处再次强化银纹线索。",
        });

        expect(prepared.suggestion).toMatchObject({
            action: "strengthen",
            foreshadowingId: "fo-clue",
            sourceEntryIds: ["ol-chapter"],
        });
        expect(prepared.change).toMatchObject({
            operation: "mutate",
            expectedRevision: 4,
            action: {kind: "edit-entry", planId: "plan-main", entryId: "ol-chapter", body},
        });
        expect(prepared.requiresReadoption).toBe(true);
    });

    it("不接受没有对应动作或已过期版本的建议", () => {
        const current = snapshot();
        const base = {
            action: "resolve" as const,
            expectedRevision: 4,
            planId: "plan-main",
            entryId: "ol-chapter" as const,
            foreshadowingId: "fo-clue" as const,
            expectedVersion: 3,
            expectedContentHash: current.entries[0]!.contentHash,
            body: marker("plant", "plant") + " " + marker("reinforce", "reinforce"),
            rationale: "测试建议",
        };
        expect(() => prepareForeshadowingMarkerSuggestion(current, base)).toThrow(/recover/);
        expect(() => prepareForeshadowingMarkerSuggestion(current, {...base, expectedContentHash: "sha256:" + "0".repeat(64)})).toThrow(/版本/);
    });

    it("repair 建议也必须通过严格 Markdown 解析，并标记已采用章节需要重新采用", () => {
        const current = snapshot();
        const prepared = prepareForeshadowingMarkerSuggestion(current, {
            action: "repair",
            expectedRevision: 4,
            planId: "plan-main",
            entryId: "ol-chapter",
            foreshadowingId: "fo-clue",
            expectedVersion: 3,
            expectedContentHash: current.entries[0]!.contentHash,
            body: "修正后的章节正文 " + marker("plant", "plant"),
            rationale: "修正标记包围范围并保留原线索。",
        }, [{entryId: "ol-chapter", path: "outline/entries/chapter--ol-chapter.md", diagnostics: [{code: "INVALID_MARKER", message: "损坏"}]}]);
        expect(prepared.suggestion.action).toBe("repair");
        expect(prepared.requiresReadoption).toBe(true);
    });
});
