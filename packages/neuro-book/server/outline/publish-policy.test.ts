import {describe, expect, it} from "vitest";
import {contentHash, createEmptyManifest, serializeManifest, serializeEntryMarkdown, serializeForeshadowingMarkdown, serializeGraphYaml, serializeLineYaml, type OutlineGraph, type OutlineLine} from "./format";
import {assertNonDestructivePlanningEdit, type PlanningSnapshot} from "./index";

function snapshot(manifest: PlanningSnapshot["manifest"]): PlanningSnapshot {
    return {manifest, entries: [], foreshadowing: [], graphs: [], lines: []};
}

function edit(manifest: PlanningSnapshot["manifest"]) {
    return {expectedManifestRevision: manifest.revision - 1, mutations: [
        {relativePath: "outline/manifest.yaml", content: serializeManifest(manifest)},
    ]};
}

describe("规划通用发布权限", () => {
    it("原始发布不能创建或改写线路，包括草稿、固定与已有固定线路", () => {
        const draft: OutlineLine = {schema: "nbook.outline-line/v3", id: "ln-main", planId: "plan-a", version: 0, title: "主线",
            type: "main", fixed: false, nodeIds: ["nd-one", "nd-two"]};
        const fixed: OutlineLine = {...draft, fixed: true, analysis: {reportId: "report-1", planId: "plan-a",
            sourceHash: "sha256:" + "1".repeat(64), contextHash: "sha256:" + "2".repeat(64), summary: "无冲突",
            conflicts: [], resolutions: [], entryHashes: [
                {nodeId: "nd-one", entryId: "ol-one", contentHash: "sha256:" + "3".repeat(64)},
                {nodeId: "nd-two", entryId: "ol-two", contentHash: "sha256:" + "4".repeat(64)},
            ]}};
        const linePath = "outline/storylines/main--ln-main.yaml";
        for (const line of [draft, fixed]) {
            expect(() => assertNonDestructivePlanningEdit(snapshot(createEmptyManifest()), {expectedManifestRevision: 0,
                mutations: [{relativePath: linePath, content: serializeLineYaml(line)}],
            })).toThrow(/领域操作/);
        }
        const current: PlanningSnapshot = {...snapshot(createEmptyManifest()), lines: [{path: linePath, value: draft,
            contentHash: contentHash(serializeLineYaml(draft))}]};
        expect(() => assertNonDestructivePlanningEdit(current, {expectedManifestRevision: 0,
            mutations: [{relativePath: linePath, content: serializeLineYaml({...draft, version: 1, title: "草稿改名"})}],
        })).toThrow(/领域操作/);
        expect(() => assertNonDestructivePlanningEdit(current, {expectedManifestRevision: 0,
            mutations: [{relativePath: linePath, content: serializeLineYaml({...fixed, version: 1})}],
        })).toThrow(/领域操作/);
        const alreadyFixed: PlanningSnapshot = {...current, lines: [{path: linePath, value: fixed,
            contentHash: contentHash(serializeLineYaml(fixed))}]};
        expect(() => assertNonDestructivePlanningEdit(alreadyFixed, {expectedManifestRevision: 0,
            mutations: [{relativePath: linePath, content: serializeLineYaml({...fixed, version: 1, title: "绕过审查"})}],
        })).toThrow(/领域操作/);
    });
    it("原始发布不能改写线路图，同字节改名仍可用", () => {
        const graph: OutlineGraph = {schema: "nbook.outline-graph/v1", id: "gr-plan", planId: "plan-a", version: 1,
            nodes: [{id: "nd-one", entryId: "ol-total", column: 0, row: 0}, {id: "nd-two", entryId: "ol-chapter", column: 1, row: 0}],
            edges: [{id: "eg-edge", from: "nd-one", to: "nd-two"}]};
        const graphPath = "outline/graphs/a--gr-plan.yaml";
        const content = serializeGraphYaml(graph);
        const current: PlanningSnapshot = {...snapshot(createEmptyManifest()), graphs: [{path: graphPath, value: graph,
            contentHash: contentHash(content)}]};
        expect(() => assertNonDestructivePlanningEdit(snapshot(createEmptyManifest()), {expectedManifestRevision: 0,
            mutations: [{relativePath: graphPath, content}],
        })).toThrow(/领域操作/);
        const changed = serializeGraphYaml({...graph, version: 2, nodes: graph.nodes.slice(0, 1), edges: []});
        expect(() => assertNonDestructivePlanningEdit(current, {expectedManifestRevision: 0,
            mutations: [{relativePath: graphPath, content: changed}],
        })).toThrow(/领域操作/);
        const moved = serializeGraphYaml({...graph, version: 2, nodes: [graph.nodes[0]!, {...graph.nodes[1]!, row: 3}]});
        expect(() => assertNonDestructivePlanningEdit(current, {expectedManifestRevision: 0,
            mutations: [{relativePath: graphPath, content: moved}],
        })).toThrow(/领域操作/);
        expect(() => assertNonDestructivePlanningEdit(current, {expectedManifestRevision: 0,
            mutations: [{relativePath: "outline/graphs/renamed--gr-plan.yaml", content}],
        })).not.toThrow();
    });
    it("通用发布不允许绕过细纲正式保存前的分析门禁", () => {
        const detail = serializeEntryMarkdown({schema: "nbook.outline-entry/v1", id: "ol-detail", kind: "detail", status: "adopted",
            version: 0, title: "细纲", parentId: "ol-chapter", chapterId: "ol-chapter", body: "正文"});
        expect(() => assertNonDestructivePlanningEdit(snapshot(createEmptyManifest()), {expectedManifestRevision: 0,
            mutations: [
                {relativePath: "outline/entries/detail--ol-detail.md", content: detail},
                {relativePath: "outline/manifest.yaml", content: serializeManifest({...createEmptyManifest(), revision: 1})},
            ],
        })).toThrow(/分析/);
    });
    it("伏笔不能通过原始发布直接确认或修改正式定义", () => {
        const manifest = createEmptyManifest();
        const draft = {schema: "nbook.outline-foreshadowing/v1" as const, id: "fo-clue" as const,
            version: 0, status: "draft" as const, title: "线索", body: "设计"};
        const path = "outline/foreshadowing/clue--fo-clue.md";
        const adopted = serializeForeshadowingMarkdown({...draft, status: "adopted"});
        expect(() => assertNonDestructivePlanningEdit(snapshot(manifest), {
            expectedManifestRevision: 0, mutations: [{relativePath: path, content: adopted}],
        })).toThrow(/正式伏笔/);
        const current: PlanningSnapshot = {...snapshot(manifest), foreshadowing: [{path, value: {...draft, status: "adopted"},
            contentHash: "sha256:" + "0".repeat(64)}]};
        expect(() => assertNonDestructivePlanningEdit(current, {expectedManifestRevision: 0, mutations: [
            {relativePath: path, content: serializeForeshadowingMarkdown({...draft, version: 1})},
        ]})).toThrow(/正式伏笔/);
    });
    it("原始文件发布不能绕过非细纲的正式采用确认", () => {
        const chapter = serializeEntryMarkdown({schema: "nbook.outline-entry/v1", id: "ol-chapter", kind: "chapter", status: "adopted",
            version: 1, title: "章节", parentId: "ol-total", chapterId: null, body: "情节"});
        expect(() => assertNonDestructivePlanningEdit(snapshot(createEmptyManifest()), {expectedManifestRevision: 0,
            mutations: [{relativePath: "outline/entries/chapter--ol-chapter.md", content: chapter}],
        })).toThrow(/正式采用/);
    });
    it("原始发布不能绕过共享条目的写时分叉或方案关系确认", () => {
        const base = createEmptyManifest();
        const total = {id: "ol-root" as const, path: "outline/entries/root--ol-root.md", version: 0,
            contentHash: "sha256:" + "0".repeat(64)};
        const chapter = {id: "ol-chapter" as const, path: "outline/entries/chapter--ol-chapter.md", version: 0,
            contentHash: "sha256:" + "1".repeat(64)};
        const plan = {id: "plan-a", title: "A", placements: [
            {entryId: total.id, parentId: null, position: 0},
            {entryId: chapter.id, parentId: total.id, position: 1},
        ]};
        const current = {...base, totalId: total.id, entries: [total, chapter], plans: [plan, {...plan, id: "plan-b"}]};
        const draft = serializeEntryMarkdown({schema: "nbook.outline-entry/v1", id: chapter.id, kind: "chapter", status: "draft",
            version: 1, title: "修改共享章节", parentId: total.id, chapterId: null, body: "新内容"});
        expect(() => assertNonDestructivePlanningEdit(snapshot(current), {expectedManifestRevision: 0,
            mutations: [{relativePath: chapter.path, content: draft},
                {relativePath: "outline/manifest.yaml", content: serializeManifest({...current, revision: 1})}],
        })).toThrow(/领域操作/);
        expect(() => assertNonDestructivePlanningEdit(snapshot(current), edit({...current, revision: 1, plans: [
            plan, {...plan, id: "plan-b", placements: [{entryId: total.id, parentId: null, position: 0}]},
        ]}))).toThrow(/方案/);
        expect(() => assertNonDestructivePlanningEdit(snapshot(current), edit({...current, revision: 1,
            plans: [...current.plans, {...plan, id: "plan-c"}],
        }))).toThrow(/方案链/);
    });
    it("拒绝通过原始文件改动删除对象或移除方案关系", () => {
        const base = createEmptyManifest();
        expect(() => assertNonDestructivePlanningEdit(snapshot(base), {
            expectedManifestRevision: 0,
            mutations: [{relativePath: "outline/entries/item--ol-1.md", content: null}],
        })).toThrow(/删除规划对象/);
        const placements = [
            {entryId: "ol-root" as const, parentId: null, position: 0},
            {entryId: "ol-child" as const, parentId: "ol-root" as const, position: 1},
        ];
        const entries = placements.map(({entryId}) => ({
            id: entryId, path: "outline/entries/" + entryId + ".md", version: 0,
            contentHash: "sha256:" + "0".repeat(64),
        }));
        const current = {...base, totalId: "ol-root" as const, entries, plans: [{id: "plan-a", title: "A", placements}]};
        expect(() => assertNonDestructivePlanningEdit(snapshot(current), edit({
            ...current, revision: 1, plans: [{...current.plans[0]!, placements: [placements[0]!]}],
        }))).toThrow(/移除方案关系/);
        expect(() => assertNonDestructivePlanningEdit(snapshot(current), edit({
            ...current, revision: 1, totalId: null,
        }))).toThrow(/移除或替换总纲/);
        expect(() => assertNonDestructivePlanningEdit(snapshot(base), edit({
            ...base, revision: 1, plans: [{id: "plan-a", title: "A", placements: []}],
        }))).toThrow(/方案链/);
    });
});
