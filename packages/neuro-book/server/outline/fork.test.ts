import fs from "node:fs/promises";
import path from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import {contentHash, createEmptyManifest, serializeEntryMarkdown, serializeManifest, type OutlineManifest} from "./format";
import {prepareLineAction, type LineAction} from "./line-planning";
import {preparePlanningFork} from "./fork";
import {preparePlanningObjectDeletion, preparePlanningPlacementRemoval, previewPlanningObjectDeletion} from "./operations";
import {publishPlanningFiles, readPlanningSnapshot} from "./index";
import {createOutlineRepository} from "./repository";

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

describe("shared entry write-time fork", () => {
    it("changes only the selected plan reference and preserves the source file", async () => {
        const projectRoot = await createTestTmpRoot("outline-fork", "outline-fork-contract");
        roots.push(projectRoot);
        const options = {projectRoot};
        await createOutlineRepository(options).ensureLayout(serializeManifest(createEmptyManifest()));
        const totalPath = "outline/entries/total--ol-total.md";
        const chapterPath = "outline/entries/chapter--ol-chapter.md";
        const total = serializeEntryMarkdown({schema: "nbook.outline-entry/v1", id: "ol-total", kind: "total", version: 0,
            status: "draft", title: "Total", parentId: null, chapterId: null, body: "Total\n"});
        const chapter = serializeEntryMarkdown({schema: "nbook.outline-entry/v1", id: "ol-chapter", kind: "chapter", version: 0,
            status: "adopted", title: "Chapter", parentId: "ol-total", chapterId: null, body: "Chapter\n",
            materialRefs: ["lorebook/人物/阿青.md"], targetWords: 1200});
        const manifest: OutlineManifest = {
            ...createEmptyManifest(), revision: 1, totalId: "ol-total",
            plans: ["a", "b"].map((id) => ({id, title: id, placements: [
                {entryId: "ol-total" as const, parentId: null, position: 0},
                {entryId: "ol-chapter" as const, parentId: "ol-total" as const, position: 1},
            ]})),
            entries: [
                {id: "ol-total", path: totalPath, version: 0, contentHash: contentHash(total)},
                {id: "ol-chapter", path: chapterPath, version: 0, contentHash: contentHash(chapter)},
            ],
        };
        await publishPlanningFiles(options, {expectedManifestRevision: 0, mutations: [
            {relativePath: totalPath, content: total},
            {relativePath: chapterPath, content: chapter},
            {relativePath: "outline/manifest.yaml", content: serializeManifest(manifest)},
        ]});
        await expect(preparePlanningFork(options, {planId: "a", sourceId: "ol-chapter", title: " Chapter ", body: "New\n"}))
            .rejects.toThrow(/不同的名称/);
        const fork = await preparePlanningFork(options, {planId: "a", sourceId: "ol-chapter", title: " Alternative ", body: "New\n",
            targetWords: 2400, references: [{path: "research/背景/雨夜.md"}]});
        await publishPlanningFiles(options, fork.publish);
        const snapshot = await readPlanningSnapshot(options);
        expect(snapshot.manifest.plans[0]?.placements[1]?.entryId).toBe(fork.id);
        expect(snapshot.manifest.plans[1]?.placements[1]?.entryId).toBe("ol-chapter");
        expect(await fs.readFile(path.join(projectRoot, chapterPath), "utf8")).toBe(chapter);
        expect(snapshot.entries.find((item) => item.value.id === fork.id)?.value.body).toBe("New\n");
        expect(snapshot.entries.find((item) => item.value.id === fork.id)?.value.title).toBe("Alternative");
        expect(snapshot.entries.find((item) => item.value.id === fork.id)?.value.status).toBe("draft");
        expect(snapshot.entries.find((item) => item.value.id === fork.id)?.value).toMatchObject({
            materialRefs: ["lorebook/人物/阿青.md"], targetWords: 2400, references: [{path: "research/背景/雨夜.md"}],
        });
        await expect(publishPlanningFiles(options, fork.publish)).rejects.toMatchObject({code: "MANIFEST_REVISION_CONFLICT"});
        const impact = await previewPlanningObjectDeletion(options, "ol-chapter");
        // 被其它方案挂载不阻止删除，但预览必须列出该引用，供删除确认展示影响。
        expect(impact).toMatchObject({canDeleteObject: true, references: [{relation: "placement", sourceId: "b"}]});
        const removal = await preparePlanningPlacementRemoval(options, "b", "ol-chapter");
        expect(removal.impact.objectFileRemains).toBe(true);
        await publishPlanningFiles(options, await preparePlanningObjectDeletion(options, "ol-chapter"));
        await expect(fs.readFile(path.join(projectRoot, chapterPath))).rejects.toMatchObject({code: "ENOENT"});
        const afterDeletion = await readPlanningSnapshot(options);
        expect(afterDeletion.manifest.plans.flatMap((plan) => plan.placements).some((item) => item.entryId === "ol-chapter")).toBe(false);
        expect(afterDeletion.entries.find((item) => item.value.id === fork.id)).toBeDefined();
    });
    it("分叉前目标方案线路图仍有节点关联共享条目时拒绝，改为空节点后才能分叉，不留下悬空节点", async () => {
        const projectRoot = await createTestTmpRoot("outline-fork", "line-references");
        roots.push(projectRoot);
        const options = {projectRoot};
        await createOutlineRepository(options).ensureLayout(serializeManifest(createEmptyManifest()));
        const total = serializeEntryMarkdown({schema: "nbook.outline-entry/v1", id: "ol-total", kind: "total", version: 0,
            status: "draft", title: "总纲", parentId: null, chapterId: null, body: ""});
        const chapter = serializeEntryMarkdown({schema: "nbook.outline-entry/v1", id: "ol-chapter", kind: "chapter", version: 0,
            status: "adopted", title: "共享章节", parentId: "ol-total", chapterId: null, body: "剧情"});
        const files = [
            {id: "ol-total", path: "outline/entries/total--ol-total.md", content: total},
            {id: "ol-chapter", path: "outline/entries/chapter--ol-chapter.md", content: chapter},
        ];
        const manifest: OutlineManifest = {...createEmptyManifest(), revision: 1, totalId: "ol-total",
            plans: ["a", "b"].map((id) => ({id, title: id, placements: [
                {entryId: "ol-total", parentId: null, position: 0},
                {entryId: "ol-chapter", parentId: "ol-total", position: 1},
            ]})),
            entries: files.map(({id, path, content}) => ({id, path, version: 0, contentHash: contentHash(content)})),
        };
        await publishPlanningFiles(options, {expectedManifestRevision: 0, mutations: [
            ...files.map(({path, content}) => ({relativePath: path, content})),
            {relativePath: "outline/manifest.yaml", content: serializeManifest(manifest)},
        ]});
        const graphAction = async (action: LineAction) => {
            const change = prepareLineAction(await readPlanningSnapshot(options), action);
            await publishPlanningFiles(options, change.publish);
            return change;
        };
        // 方案甲的图也引用共享章节；只有目标方案的图会阻止分叉。
        await graphAction({kind: "add-graph-node", planId: "a", expectedGraphVersion: 0, column: 0, row: 0, entryId: "ol-chapter"});
        const nodeId = (await graphAction({kind: "add-graph-node", planId: "b", expectedGraphVersion: 0, column: 0, row: 0,
            entryId: "ol-chapter"})).nodeId!;
        const blocked = await readPlanningSnapshot(options);
        await expect(preparePlanningFork(options, {planId: "b", sourceId: "ol-chapter", title: "另一章", body: "新剧情"}))
            .rejects.toThrow(/本方案线路图仍有节点关联共享条目/);
        expect((await readPlanningSnapshot(options)).manifest).toEqual(blocked.manifest);
        await graphAction({kind: "relink-graph-node", planId: "b", expectedGraphVersion: 1, nodeId, entryId: null});
        const fork = await preparePlanningFork(options, {planId: "b", sourceId: "ol-chapter", title: "另一章", body: "新剧情"});
        await publishPlanningFiles(options, fork.publish);
        const snapshot = await readPlanningSnapshot(options);
        expect(snapshot.manifest.plans[1]?.placements[1]?.entryId).toBe(fork.id);
        expect(snapshot.graphs.find(({value}) => value.planId === "b")?.value.nodes).toEqual([
            {id: nodeId, entryId: null, column: 0, row: 0}]);
        expect(snapshot.graphs.find(({value}) => value.planId === "a")?.value.nodes).toMatchObject([{entryId: "ol-chapter"}]);
    });
    it("forking an analyzed detail drops the old report without editing the source", async () => {
        const projectRoot = await createTestTmpRoot("outline-fork", "outline-detail-report");
        roots.push(projectRoot);
        const options = {projectRoot};
        await createOutlineRepository(options).ensureLayout(serializeManifest(createEmptyManifest()));
        const entries = [
            {id: "ol-total", kind: "total" as const, parentId: null, chapterId: null, title: "总纲"},
            {id: "ol-chapter", kind: "chapter" as const, parentId: "ol-total", chapterId: null, title: "章节"},
            {id: "ol-detail", kind: "detail" as const, parentId: "ol-chapter", chapterId: "ol-chapter", title: "细纲"},
        ].map((value) => ({id: value.id, path: "outline/entries/" + value.id + "--" + value.id + ".md", content: serializeEntryMarkdown({
            ...value, schema: "nbook.outline-entry/v1", version: 0, status: "adopted" as const,
            body: "规划内容", ...(value.kind === "detail" ? {analysis: {
                reportId: "report-a", planId: "a", sourceHash: "sha256:" + "1".repeat(64),
                contextHash: "sha256:" + "2".repeat(64), summary: "已审阅", deviations: [], conflicts: [], resolutions: [],
            }} : {}),
        })}));
        const manifest: OutlineManifest = {...createEmptyManifest(), revision: 1, totalId: "ol-total",
            plans: ["a", "b"].map((id) => ({id, title: id, placements: [
                {entryId: "ol-total" as const, parentId: null, position: 0},
                {entryId: "ol-chapter" as const, parentId: "ol-total" as const, position: 1},
                {entryId: "ol-detail" as const, parentId: "ol-chapter" as const, position: 2},
            ]})),
            entries: entries.map((entry) => ({id: entry.id, path: entry.path, version: 0, contentHash: contentHash(entry.content)})),
        };
        await publishPlanningFiles(options, {expectedManifestRevision: 0, mutations: [
            ...entries.map((entry) => ({relativePath: entry.path, content: entry.content})),
            {relativePath: "outline/manifest.yaml", content: serializeManifest(manifest)},
        ]});
        const fork = await preparePlanningFork(options, {planId: "b", sourceId: "ol-detail", title: "另一版细纲", body: "重新规划"});
        await publishPlanningFiles(options, fork.publish);
        const snapshot = await readPlanningSnapshot(options);
        expect(snapshot.manifest.plans[0]?.placements[2]?.entryId).toBe("ol-detail");
        expect(snapshot.manifest.plans[1]?.placements[2]?.entryId).toBe(fork.id);
        expect(await fs.readFile(path.join(projectRoot, entries[2]!.path), "utf8")).toBe(entries[2]!.content);
        expect(snapshot.entries.find(({value}) => value.id === fork.id)?.value).toMatchObject({
            kind: "detail", status: "draft", version: 0, chapterId: "ol-chapter", parentId: "ol-chapter",
        });
        expect(snapshot.entries.find(({value}) => value.id === fork.id)?.value.analysis).toBeUndefined();
    });
});

