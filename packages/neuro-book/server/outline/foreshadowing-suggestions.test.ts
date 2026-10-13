import {describe, expect, it} from "vitest";
import {
    contentHash,
    createEmptyManifest,
    parseForeshadowMarkers,
    serializeEntryMarkdown,
    serializeForeshadowingMarkdown,
    type Foreshadowing,
    type OutlineEntry,
    type OutlineMaterialUpdate,
    parseEntryMarkdown,
} from "./format";
import {prepareForeshadowingMarkerRepair, prepareForeshadowingMarkerSuggestion} from "./foreshadowing-suggestions";
import type {PlanningSnapshot} from "./index";

const marker = (id: string, action: "plant" | "reinforce" | "recover") =>
    `<!-- nb:foreshadow marker="fm-${id}" foreshadow="fo-clue" action="${action}" -->${id}<!-- /nb:foreshadow marker="fm-${id}" -->`;

function snapshot(body = marker("plant", "plant"), materialUpdates?: readonly OutlineMaterialUpdate[]): PlanningSnapshot {
    const entry: OutlineEntry = {
        schema: "nbook.outline-entry/v2",
        id: "ol-chapter",
        version: 3,
        kind: "chapter",
        status: "adopted",
        title: "第一章",
        parentId: "ol-root",
        chapterId: null,
        body,
        ...(materialUpdates === undefined ? {} : {materialUpdates}),
    };
    const entryPath = "outline/entries/chapter--ol-chapter.md";
    const entryFile = serializeEntryMarkdown(entry);
    const definition: Foreshadowing = {
        schema: "nbook.outline-foreshadowing/v2",
        id: "fo-clue",
        version: 1,
        status: "adopted",
        title: "线索",
        body: "银纹",
    };
    const definitionFile = serializeForeshadowingMarkdown(definition);
    const root: OutlineEntry = {...entry, id: "ol-root", version: 0, kind: "total", parentId: null,
        title: "总纲", body: "故事", materialUpdates: undefined};
    const rootPath = "outline/entries/root--ol-root.md";
    const rootFile = serializeEntryMarkdown(root);
    const manifest = {
        ...createEmptyManifest(),
        revision: 4,
        plans: [{id: "plan-main", title: "主方案", totalId: root.id, placements: [
            {entryId: root.id, parentId: null, position: 0}, {entryId: entry.id, parentId: root.id, position: 1},
        ]}],
        entries: [{id: entry.id, path: entryPath, version: entry.version, contentHash: contentHash(entryFile)},
            {id: root.id, path: rootPath, version: root.version, contentHash: contentHash(rootFile)}],
        foreshadowing: [{id: definition.id, path: "outline/foreshadowing/clue--fo-clue.md", version: definition.version, contentHash: contentHash(definitionFile)}],
    };
    return {
        manifest,
        entries: [{value: entry, path: entryPath, contentHash: contentHash(entryFile), markers: parseForeshadowMarkers(body, new Set([definition.id]), entryPath)},
            {value: root, path: rootPath, contentHash: contentHash(rootFile), markers: []}],
        foreshadowing: [{value: definition, path: "outline/foreshadowing/clue--fo-clue.md", contentHash: contentHash(definitionFile)}],
        lines: [],
        graphs: [],
    };
}

describe("伏笔标记建议", () => {
    it("已有角色计划时建议必须同步维护，审批身份绑定全部新信息", () => {
        const updates: readonly OutlineMaterialUpdate[] = [{kind: "experience", materialPath: "lorebook/character/主角/index.md", body: "看见钥匙"}];
        const current = snapshot(undefined, updates);
        const input = {action: "strengthen" as const, expectedRevision: 4, planId: "plan-main", entryId: "ol-chapter" as const,
            foreshadowingId: "fo-clue" as const, expectedVersion: 3, expectedContentHash: current.entries[0]!.contentHash,
            body: marker("plant", "plant") + " " + marker("reinforce", "reinforce"), rationale: "强化人物注意到线索的安排"};
        expect(() => prepareForeshadowingMarkerSuggestion(current, input)).toThrow(/同步提交 materialUpdates/);
        const supplied = prepareForeshadowingMarkerSuggestion(current, {...input, materialUpdates: updates});
        expect(supplied.change.action).toMatchObject({materialUpdates: updates});
        const changed = prepareForeshadowingMarkerSuggestion(current, {...input, materialUpdates: [{...updates[0]!, body: "理解钥匙用途"}]});
        expect(changed.suggestion.suggestionId).not.toBe(supplied.suggestion.suggestionId);
        const cleared = prepareForeshadowingMarkerSuggestion(current, {...input, materialUpdates: null});
        expect(cleared.change.action).toMatchObject({materialUpdates: null});
        expect(cleared.suggestion.suggestionId).not.toBe(supplied.suggestion.suggestionId);
    });

    it("伏笔修复保留同步维护入口，缺省拒绝，显式更新或清除可准备完整章节变更", () => {
        const updates: readonly OutlineMaterialUpdate[] = [{kind: "relationship", materialPath: "lorebook/character/主角/index.md", body: "怀疑同伴"}];
        const current = snapshot(undefined, updates);
        const issues = [{entryId: "ol-chapter" as const, path: current.entries[0]!.path, diagnostics: [{code: "INVALID_MARKER", message: "损坏"}]}];
        const input = {kind: "repair-foreshadowing-marker" as const, expectedRevision: 4, planId: "plan-main", entryId: "ol-chapter" as const,
            foreshadowingId: "fo-clue" as const, expectedVersion: 3, expectedContentHash: current.entries[0]!.contentHash,
            body: "修正正文 " + marker("plant", "plant")};
        expect(() => prepareForeshadowingMarkerRepair(current, issues, input)).toThrow(/同步提交 materialUpdates/);
        const supplied = prepareForeshadowingMarkerRepair(current, issues, {...input, materialUpdates: updates});
        const file = supplied.publish.mutations.find(({relativePath}) => relativePath === current.entries[0]!.path)!;
        expect(parseEntryMarkdown(file.content!).materialUpdates).toEqual(updates);
        const cleared = prepareForeshadowingMarkerRepair(current, issues, {...input, materialUpdates: null});
        const clearedFile = cleared.publish.mutations.find(({relativePath}) => relativePath === current.entries[0]!.path)!;
        expect(parseEntryMarkdown(clearedFile.content!).materialUpdates).toBeUndefined();
    });
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

    it("没有任何标记的章节可以用 plant 新增第一个埋设标记", () => {
        const current = snapshot("第一章正文");
        expect(current.entries[0]!.markers).toEqual([]);
        const body = "第一章正文" + marker("plant", "plant");
        const input = {
            action: "plant" as const,
            expectedRevision: 4,
            planId: "plan-main",
            entryId: "ol-chapter" as const,
            foreshadowingId: "fo-clue" as const,
            expectedVersion: 3,
            expectedContentHash: current.entries[0]!.contentHash,
            body,
            rationale: "按章节大纲要求在本章埋设线索。",
        };
        const prepared = prepareForeshadowingMarkerSuggestion(current, input);
        expect(prepared.suggestion.action).toBe("plant");
        expect(prepared.change.action).toMatchObject({kind: "edit-entry", entryId: "ol-chapter", body});
        expect(() => prepareForeshadowingMarkerSuggestion(current, {...input, body: "第一章正文" + marker("reinforce", "reinforce")}))
            .toThrow(/plant/);
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
