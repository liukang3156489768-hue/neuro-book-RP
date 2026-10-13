import {describe, expect, it} from "vitest";
import {contentHash, createEmptyManifest, serializeEntryMarkdown, serializeForeshadowingMarkdown, serializeGraphYaml, serializeLineYaml, serializeManifest} from "./format";
import {parsePlanningFiles, type PlanningPublishInput, type PlanningSnapshot} from "./index";
import {prepareLibraryAction} from "./library";
import {prepareForeshadowingAction} from "./foreshadowing";
import {prepareLineAction} from "./line-planning";

function empty(): PlanningSnapshot {
    const content = serializeManifest(createEmptyManifest());
    return parsePlanningFiles([{relativePath: "outline/manifest.yaml", content, contentHash: contentHash(content)}]);
}

function overlay(snapshot: PlanningSnapshot, publish: PlanningPublishInput): PlanningSnapshot {
    const canonical = [{path: "outline/manifest.yaml", content: serializeManifest(snapshot.manifest)},
        ...snapshot.entries.map(({path, value}) => ({path, content: serializeEntryMarkdown(value)})),
        ...snapshot.foreshadowing.map(({path, value}) => ({path, content: serializeForeshadowingMarkdown(value)})),
        ...snapshot.graphs.map(({path, value}) => ({path, content: serializeGraphYaml(value)})),
        ...snapshot.lines.map(({path, value}) => ({path, content: serializeLineYaml(value)}))];
    const files = new Map(canonical.map(({path: relativePath, content}) => [relativePath, {relativePath, content, contentHash: contentHash(content)}]));
    for (const {relativePath, content} of publish.mutations) {
        if (content === null) files.delete(relativePath);
        else files.set(relativePath, {relativePath, content, contentHash: contentHash(content)});
    }
    return parsePlanningFiles([...files.values()]);
}

function plan() {
    const created = prepareLibraryAction(empty(), {kind: "create-plan", title: "新小说"}, "project:proposal-plan");
    return {created, snapshot: overlay(empty(), created.publish)};
}

describe("规划预览创建身份", () => {
    it("方案与总纲预览重复计算保持完整字节一致，不同提案与无种子调用产生不同身份", () => {
        const action = {kind: "create-plan" as const, title: "新小说"};
        const a = prepareLibraryAction(empty(), action, "project:proposal-a");
        expect(prepareLibraryAction(empty(), action, "project:proposal-a")).toEqual(a);
        const b = prepareLibraryAction(empty(), action, "project:proposal-b");
        expect(b.entryId).not.toBe(a.entryId);
        expect(b.planId).not.toBe(a.planId);
        expect(a.planId?.slice(5)).not.toBe(a.entryId?.slice(3));
        expect(prepareLibraryAction(empty(), action).entryId).not.toBe(prepareLibraryAction(empty(), action).entryId);
    });

    it("章节与伏笔的预览和确认共用种子可生成相同路径、内容和哈希", () => {
        const {created, snapshot} = plan();
        const chapter = {kind: "create-entry" as const, planId: created.planId!, parentId: created.entryId!, entryKind: "chapter" as const, title: "第一章", body: "剧情"};
        const a = prepareLibraryAction(snapshot, chapter, "project:chapter-a");
        expect(prepareLibraryAction(snapshot, chapter, "project:chapter-a")).toEqual(a);
        expect(prepareLibraryAction(snapshot, chapter, "project:chapter-b").entryId).not.toBe(a.entryId);
        const clue = {kind: "create-foreshadowing" as const, title: "旧钥匙", body: "线索"};
        const c = prepareForeshadowingAction(snapshot, clue, "project:clue-a");
        expect(prepareForeshadowingAction(snapshot, clue, "project:clue-a")).toEqual(c);
        expect(prepareForeshadowingAction(snapshot, clue, "project:clue-b").id).not.toBe(c.id);
    });

    it("首次图与节点、连线和线路的创建身份确定且不同前缀不会碰撞", () => {
        const {created, snapshot} = plan();
        const firstAction = {kind: "add-graph-node" as const, planId: created.planId!, expectedGraphVersion: 0, column: 0, row: 0};
        const first = prepareLineAction(snapshot, firstAction, "project:node-a");
        expect(prepareLineAction(snapshot, firstAction, "project:node-a")).toEqual(first);
        expect(prepareLineAction(snapshot, firstAction, "project:node-b").nodeId).not.toBe(first.nodeId);
        expect(first.graphId?.slice(3)).not.toBe(first.nodeId?.slice(3));
        const one = overlay(snapshot, first.publish);
        const second = prepareLineAction(one, {...firstAction, expectedGraphVersion: 1, column: 1}, "project:node-b");
        const two = overlay(one, second.publish);
        const edgeAction = {kind: "connect-graph-nodes" as const, planId: created.planId!, expectedGraphVersion: 2, from: first.nodeId!, to: second.nodeId!};
        const edge = prepareLineAction(two, edgeAction, "project:edge-a");
        expect(prepareLineAction(two, edgeAction, "project:edge-a")).toEqual(edge);
        expect(prepareLineAction(two, edgeAction, "project:edge-b").edgeId).not.toBe(edge.edgeId);
        const lineAction = {kind: "create-line" as const, planId: created.planId!, title: "主线", type: "main" as const, nodeIds: [first.nodeId!, second.nodeId!]};
        const line = prepareLineAction(two, lineAction, "project:line-a");
        expect(prepareLineAction(two, lineAction, "project:line-a")).toEqual(line);
        expect(prepareLineAction(two, lineAction, "project:line-b").lineId).not.toBe(line.lineId);
    });

    it("解除共用总纲的预览分叉身份保持稳定", () => {
        const {created, snapshot} = plan();
        const other = prepareLibraryAction(snapshot, {kind: "create-plan", title: "另一个方案"}, "project:other-plan");
        const both = overlay(snapshot, other.publish);
        const shared = overlay(both, prepareLibraryAction(both, {kind: "associate-total", planId: other.planId!, totalId: created.entryId!}).publish);
        const action = {kind: "unshare-total" as const, planId: other.planId!};
        const a = prepareLibraryAction(shared, action, "project:unshare-a");
        expect(prepareLibraryAction(shared, action, "project:unshare-a")).toEqual(a);
        expect(prepareLibraryAction(shared, action, "project:unshare-b").entryId).not.toBe(a.entryId);
    });
});
