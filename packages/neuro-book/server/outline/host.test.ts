import fs from "node:fs/promises";
import path from "node:path";
import {collectReleasedSqliteHandles} from "../workspace-files/sqlite-handle-release";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import type {ReadyProjectSessionRef} from "nbook/server/workspace-files/project-session-types";
import {contentHash, createEmptyManifest, parseEntryMarkdown, serializeEntryMarkdown, serializeForeshadowingMarkdown, serializeManifest, serializeGraphYaml, serializeLineYaml, type OutlineEntry, type OutlineGraph, type OutlineLine} from "./format";
import {publishOutlineFiles} from "./transaction";
import {sceneDetail} from "./detail.fixture";
import {publishPlanningFiles, readPlanningSnapshot} from "./index";
import {prepareLibraryAction} from "./library";
import {adaptationRecordPath} from "./adaptation";

const model = vi.hoisted(() => ({complete: vi.fn()}));
vi.mock("./direction-model", () => ({completeDirectionWithModel: model.complete}));

const mocks = vi.hoisted(() => ({
    requireReadyModuleHandle: vi.fn(),
    requireActiveReadyProject: vi.fn(),
    runReadyProjectOperation: vi.fn(),
    recordProjectWrite: vi.fn(async () => undefined),
    recordProjectDelete: vi.fn(async () => undefined),
    recordProjectRename: vi.fn(async () => undefined),
}));

vi.mock("nbook/server/workspace-files/project-session", () => ({
    requireReadyModuleHandle: mocks.requireReadyModuleHandle,
    requireActiveReadyProject: mocks.requireActiveReadyProject,
    runReadyProjectOperation: mocks.runReadyProjectOperation,
}));
vi.mock("nbook/server/workspace-files/project-file-index", () => ({
    PROJECT_FILE_INDEX_MODULE_TOKEN: {name: "file-index"},
}));
vi.mock("nbook/server/workspace-history/project-history", () => ({
    PROJECT_HISTORY_MODULE_TOKEN: {name: "history"},
    recordProjectWrite: mocks.recordProjectWrite,
    recordProjectDelete: mocks.recordProjectDelete,
    recordProjectRename: mocks.recordProjectRename,
}));

const roots: string[] = [];
afterEach(async () => {
    collectReleasedSqliteHandles({force: true});
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});
beforeEach(() => {
    vi.clearAllMocks();
    model.complete.mockReset();
});

describe("outline ready Project host", () => {
    it("规划关联记录与大纲一起归因、修改和撤销，不把计划当作基础素材", async () => {
        const projectRoot = await createTestTmpRoot("outline-host", "adaptation-history-contract");
        roots.push(projectRoot);
        const {createOutlineRepository} = await import("./repository");
        await createOutlineRepository({projectRoot}).ensureLayout(serializeManifest(createEmptyManifest()));
        const created = prepareLibraryAction(await readPlanningSnapshot({projectRoot}), {kind: "create-plan", title: "新小说"});
        await publishPlanningFiles({projectRoot}, created.publish);
        const materialPath = "lorebook/character/主角/index.md";
        await fs.mkdir(path.join(projectRoot, "lorebook/character/主角"), {recursive: true});
        await fs.writeFile(path.join(projectRoot, materialPath), "原有基础人设");
        const ready = {publicId: "ready-adaptation", workspace: {root: projectRoot}} as ReadyProjectSessionRef;
        const fileIndex = {mutate: vi.fn(async <T>(operation: () => Promise<T>) => operation())};
        mocks.requireReadyModuleHandle.mockImplementation((_ready, token: {name: string}) => token.name === "file-index" ? fileIndex : {});
        mocks.runReadyProjectOperation.mockImplementation(async (_ready, operation) =>
            operation(new AbortController().signal, () => undefined, async () => undefined));
        const {applyReadyLibraryAction, undoReadyPlanningFiles} = await import("./host");
        const actor = {kind: "user" as const, userId: "local"};
        const update = {materialPath, kind: "experience" as const, body: "第一次进城"};
        const action = {kind: "create-entry" as const, planId: created.planId!, parentId: created.entryId!,
            entryKind: "chapter" as const, title: "出发", body: "故事计划", materialUpdates: [update]};
        const expected = prepareLibraryAction(await readPlanningSnapshot({projectRoot}), action, "project:confirmed-proposal");
        const chapter = await applyReadyLibraryAction(ready, action, 1, actor, "project:confirmed-proposal");
        expect(chapter.entryId).toBe(expected.entryId);
        const record = adaptationRecordPath(update, created.planId!, chapter.entryId!);
        expect(mocks.recordProjectWrite).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            relativePath: record, before: null, after: expect.any(Uint8Array), actor,
        }));
        const saved = (await readPlanningSnapshot({projectRoot})).entries.find(({value}) => value.id === chapter.entryId)!;
        const revised = await applyReadyLibraryAction(ready, {kind: "edit-entry", planId: created.planId!, entryId: chapter.entryId!,
            title: "出发", body: "调整计划", expectedVersion: saved.value.version, expectedContentHash: saved.contentHash,
            materialUpdates: [{...update, body: "第二次进城"}]}, 2, actor);
        expect(await fs.readFile(path.join(projectRoot, record), "utf8")).toContain("第二次进城");
        await undoReadyPlanningFiles(ready, revised.transactionId, actor);
        expect(await fs.readFile(path.join(projectRoot, record), "utf8")).toContain("第一次进城");
        await undoReadyPlanningFiles(ready, chapter.transactionId, actor);
        await expect(fs.stat(path.join(projectRoot, record))).rejects.toMatchObject({code: "ENOENT"});
        expect(mocks.recordProjectDelete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({relativePath: record, actor}));
        expect(await fs.readFile(path.join(projectRoot, materialPath), "utf8")).toBe("原有基础人设");
    });
    it("只有同一 ready 会话签发且未过期的报告可采用，事务保存分析结果与历史", async () => {
        const projectRoot = await createTestTmpRoot("outline-host", "detail-analysis-contract");
        roots.push(projectRoot);
        const root: OutlineEntry = {schema: "nbook.outline-entry/v2", id: "ol-root", kind: "total", version: 0,
            status: "adopted", title: "总纲", parentId: null, chapterId: null, body: "故事"};
        const chapter: OutlineEntry = {...root, id: "ol-chapter", kind: "chapter", title: "第一章", parentId: root.id};
        const detail: OutlineEntry = {...chapter, id: "ol-detail", kind: "detail", status: "draft",
            parentId: chapter.id, chapterId: chapter.id, title: "细纲", ...sceneDetail("主角出发")};
        const files = [root, chapter, detail].map((value) => ({
            value, path: `outline/entries/${value.kind}--${value.id}.md`, content: serializeEntryMarkdown(value),
        }));
        const manifest = {...createEmptyManifest(), plans: [{id: "plan-a", title: "主方案", totalId: root.id, placements: [
            {entryId: root.id, parentId: null, position: 0}, {entryId: chapter.id, parentId: root.id, position: 1},
            {entryId: detail.id, parentId: chapter.id, position: 2},
        ]}], entries: files.map(({value, path, content}) => ({id: value.id, path, version: 0, contentHash: contentHash(content)}))};
        await publishOutlineFiles({projectRoot}, [...files.map(({path: relativePath, content}) => ({relativePath, content})),
            {relativePath: "outline/manifest.yaml", content: serializeManifest(manifest)}]);
        const ready = {publicId: "ready-1", workspace: {root: projectRoot}} as ReadyProjectSessionRef;
        const fileIndex = {mutate: vi.fn(async <T>(operation: () => Promise<T>) => operation())};
        mocks.requireReadyModuleHandle.mockImplementation((_ready, token: {name: string}) => token.name === "file-index" ? fileIndex : {});
        mocks.runReadyProjectOperation.mockImplementation(async (_ready, operation) =>
            operation(new AbortController().signal, () => undefined, async () => undefined));
        const {analyzeReadyDetail, adoptReadyDetail, applyReadyLibraryAction, readReadyWriterChapterContext,
            readReadyWriterChapterDirectory, undoReadyPlanningFiles} = await import("./host");
        const input = {planId: "plan-a", entryId: detail.id, expectedRevision: 0, expectedVersion: 0,
            expectedContentHash: contentHash(files[2]!.content)};
        const actor = {kind: "user" as const, userId: "local"};
        await expect(adoptReadyDetail(ready, input, "123e4567-e89b-42d3-a456-426614174000", true, [], actor))
            .rejects.toThrow(/没有当前会话/);
        const modelResult = JSON.stringify({summary: "无冲突", deviations: [], conflicts: []});
        model.complete.mockImplementationOnce(async () => {
            await fs.writeFile(path.join(projectRoot, "outline/manifest.yaml"), serializeManifest({...manifest, revision: 1}));
            return modelResult;
        });
        await expect(analyzeReadyDetail(ready, input)).rejects.toThrow(/重新分析/);
        await fs.writeFile(path.join(projectRoot, "outline/manifest.yaml"), serializeManifest(manifest));
        await expect(adoptReadyDetail(ready, input, "123e4567-e89b-42d3-a456-426614174000", true, [], actor))
            .rejects.toThrow(/没有当前会话/);
        model.complete.mockResolvedValue(modelResult);
        const issued = await analyzeReadyDetail(ready, input);
        const reopened = {publicId: "ready-reopened", workspace: {root: projectRoot}} as ReadyProjectSessionRef;
        await expect(adoptReadyDetail(reopened, input, issued.report.reportId, true, [], actor))
            .rejects.toThrow(/没有当前会话/);
        const reissued = await analyzeReadyDetail(reopened, input);
        expect(reissued.report.reportId).not.toBe(issued.report.reportId);
        await expect(adoptReadyDetail(reopened, input, issued.report.reportId, true, [], actor))
            .rejects.toThrow(/来源无效/);
        expect((await readPlanningSnapshot({projectRoot})).entries.find(({value}) => value.id === detail.id)?.value.status).toBe("draft");
        await expect(adoptReadyDetail(ready, input, "forged-id", true, [], actor)).rejects.toThrow(/来源无效/);
        await adoptReadyDetail(ready, input, issued.report.reportId, true, [], actor);
        const saved = await readPlanningSnapshot({projectRoot});
        expect(saved.entries.find(({value}) => value.id === detail.id)?.value).toMatchObject({status: "adopted",
            analysis: {reportId: issued.report.reportId, summary: "无冲突"}});
        expect(mocks.recordProjectWrite).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            relativePath: files[2]!.path, actor,
        }));
        await expect(adoptReadyDetail(ready, input, issued.report.reportId, true, [], actor)).rejects.toThrow(/没有当前会话/);
        expect((await readReadyWriterChapterDirectory(ready, {planId: "plan-a"})).chapters).toMatchObject([
            {entryId: chapter.id, writable: true, details: [{entryId: detail.id, status: "adopted"}]}]);
        const chapterRequest = {planId: "plan-a", chapterEntryId: chapter.id};
        const writerContext = await readReadyWriterChapterContext(ready, chapterRequest);
        expect(writerContext).toMatchObject({planId: "plan-a", chapter: {entryId: chapter.id, body: chapter.body},
            details: [{entryId: detail.id}]});
        expect(writerContext).not.toHaveProperty("materials");
        await expect(readReadyWriterChapterContext(ready, chapterRequest, ["lorebook/character/secret.md"]))
            .rejects.toThrow(/正式/);
        const chapterBefore = saved.entries.find(({value}) => value.id === chapter.id)!;
        const changed = await applyReadyLibraryAction(ready, {kind: "edit-entry", planId: "plan-a", entryId: chapter.id,
            expectedVersion: chapterBefore.value.version, expectedContentHash: chapterBefore.contentHash,
            title: "更新章节", body: "改写故事"}, saved.manifest.revision, actor);
        const withdrawn = await readPlanningSnapshot({projectRoot});
        expect(withdrawn.entries.find(({value}) => value.id === detail.id)?.value).toMatchObject({status: "draft", version: 2});
        expect(withdrawn.entries.find(({value}) => value.id === detail.id)?.value.analysis).toBeUndefined();
        await expect(readReadyWriterChapterContext(ready, chapterRequest)).rejects.toThrow(/不可写/);
        await expect(undoReadyPlanningFiles(ready, changed.transactionId, actor)).resolves.toMatchObject({kind: "undone"});
        const restored = await readPlanningSnapshot({projectRoot});
        expect(restored.entries.find(({value}) => value.id === detail.id)?.value.analysis?.reportId).toBe(issued.report.reportId);
    });
    it("publishes through the exact generation mutation gate and attributes committed bytes", async () => {
        const projectRoot = await createTestTmpRoot("outline-host", "outline-host-contract");
        roots.push(projectRoot);
        const initial = createEmptyManifest();
        const next = serializeManifest({...initial, revision: 1});
        const previous = serializeManifest(initial);
        await publishOutlineFiles({projectRoot}, [{relativePath: "outline/manifest.yaml", content: previous}]);
        const ready = {publicId: "ready-1", workspace: {root: projectRoot}} as ReadyProjectSessionRef;
        const fileIndex = {mutate: vi.fn(async <T>(operation: () => Promise<T>) => operation())};
        const history = {generation: "ready-1"};
        mocks.requireReadyModuleHandle.mockImplementation((captured, token: {name: string}) => {
            expect(captured).toBe(ready);
            return token.name === "file-index" ? fileIndex : history;
        });
        const revalidate = vi.fn(async () => undefined);
        mocks.runReadyProjectOperation.mockImplementation(async (_ready, operation) => operation(new AbortController().signal, () => undefined, revalidate));
        const {publishReadyPlanningFiles} = await import("./host");
        const actor = {kind: "user" as const, userId: "local"};
        const receipt = await publishReadyPlanningFiles(ready, {
            expectedManifestRevision: 0,
            mutations: [{relativePath: "outline/manifest.yaml", content: next}],
        }, actor);
        expect(receipt.files).toEqual(["outline/manifest.yaml"]);
        expect(fileIndex.mutate).toHaveBeenCalledTimes(1);
        expect(revalidate).toHaveBeenCalled();
        expect(await fs.readFile(path.join(projectRoot, "outline/manifest.yaml"), "utf8")).toBe(next);
        expect(mocks.recordProjectWrite).toHaveBeenCalledWith(history, {
            relativePath: "outline/manifest.yaml",
            actor,
            before: new TextEncoder().encode(previous),
            after: new TextEncoder().encode(next),
        });
    });

    it("rolls back a partially published batch when the ready generation expires", async () => {
        const projectRoot = await createTestTmpRoot("outline-host", "outline-host-mid-batch");
        roots.push(projectRoot);
        const initial = createEmptyManifest();
        const previous = serializeManifest(initial);
        await publishOutlineFiles({projectRoot}, [{relativePath: "outline/manifest.yaml", content: previous}]);
        const ready = {publicId: "ready-1", workspace: {root: projectRoot}} as ReadyProjectSessionRef;
        const fileIndex = {mutate: vi.fn(async <T>(operation: () => Promise<T>) => operation())};
        mocks.requireReadyModuleHandle.mockImplementation((_ready, token: {name: string}) => token.name === "file-index" ? fileIndex : {});
        const entry = "outline/entries/total--ol-001.md";
        const entryContent = serializeEntryMarkdown({
            schema: "nbook.outline-entry/v1", id: "ol-001", kind: "total", version: 0,
            status: "draft", title: "Total", parentId: null, chapterId: null, body: "entry\n",
        });
        const next = serializeManifest({...initial, revision: 1, entries: [
            {id: "ol-001", path: entry, version: 0, contentHash: contentHash(entryContent)},
        ]});
        const revalidate = vi.fn(async () => {
            if (await fs.stat(path.join(projectRoot, entry)).then(() => true, () => false)) {
                throw new Error("Project generation expired");
            }
        });
        mocks.runReadyProjectOperation.mockImplementation(async (_ready, operation) => operation(
            new AbortController().signal, () => undefined, revalidate,
        ));
        const {publishReadyPlanningFiles} = await import("./host");
        await expect(publishReadyPlanningFiles(ready, {
            expectedManifestRevision: 0,
            mutations: [
                {relativePath: entry, content: entryContent},
                {relativePath: "outline/manifest.yaml", content: next},
            ],
        }, {kind: "user", userId: "local"})).rejects.toMatchObject({code: "PUBLISH_FAILED"});
        expect(await fs.readFile(path.join(projectRoot, "outline/manifest.yaml"), "utf8")).toBe(previous);
        await expect(fs.readFile(path.join(projectRoot, entry))).rejects.toMatchObject({code: "ENOENT"});
        expect(mocks.recordProjectWrite).not.toHaveBeenCalled();
    });

    it("rejects an expired Project target before any canonical write or History record", async () => {
        const projectRoot = await createTestTmpRoot("outline-host", "outline-host-stale");
        roots.push(projectRoot);
        const initial = createEmptyManifest();
        const previous = serializeManifest(initial);
        await publishOutlineFiles({projectRoot}, [{relativePath: "outline/manifest.yaml", content: previous}]);
        const ready = {publicId: "expired", workspace: {root: projectRoot}} as ReadyProjectSessionRef;
        const fileIndex = {mutate: vi.fn(async <T>(operation: () => Promise<T>) => operation())};
        mocks.requireReadyModuleHandle.mockImplementation((_ready, token: {name: string}) => token.name === "file-index" ? fileIndex : {});
        mocks.runReadyProjectOperation.mockImplementation(async (_ready, operation) => operation(
            new AbortController().signal,
            () => undefined,
            async () => {throw new Error("Project generation expired");},
        ));
        const {publishReadyPlanningFiles} = await import("./host");
        await expect(publishReadyPlanningFiles(ready, {
            expectedManifestRevision: 0,
            mutations: [{relativePath: "outline/manifest.yaml", content: serializeManifest({...initial, revision: 1})}],
        }, {kind: "user", userId: "local"})).rejects.toThrow("Project generation expired");
        expect(await fs.readFile(path.join(projectRoot, "outline/manifest.yaml"), "utf8")).toBe(previous);
        expect(mocks.recordProjectWrite).not.toHaveBeenCalled();
    });
    it("initializes a ready Project, rebuilds the disposable index, and refuses orphaned objects", async () => {
        const projectRoot = await createTestTmpRoot("outline-host", "outline-open-contract");
        roots.push(projectRoot);
        const ready = {publicId: "ready-open", workspace: {root: projectRoot}} as ReadyProjectSessionRef;
        const fileIndex = {mutate: vi.fn(async <T>(operation: () => Promise<T>) => operation())};
        mocks.requireActiveReadyProject.mockReturnValue(ready);
        mocks.requireReadyModuleHandle.mockReturnValue(fileIndex);
        mocks.runReadyProjectOperation.mockImplementation(async (_ready, operation) => operation(
            new AbortController().signal, () => undefined, async () => undefined,
        ));
        const {openProjectPlanning} = await import("./host");
        expect((await openProjectPlanning({} as Parameters<typeof openProjectPlanning>[0])).manifest.revision).toBe(0);
        expect(await fs.stat(path.join(projectRoot, ".nbook", "outline-index.sqlite"))).toBeDefined();
        expect((await openProjectPlanning({} as Parameters<typeof openProjectPlanning>[0])).entries).toEqual([]);
        await fs.rm(path.join(projectRoot, "outline", "manifest.yaml"));
        await fs.writeFile(path.join(projectRoot, "outline", "entries", "orphan--ol-001.md"), "orphan");
        await expect(openProjectPlanning({} as Parameters<typeof openProjectPlanning>[0])).rejects.toThrow(/manifest 丢失/);
    });

    it("undoes through the ready mutation gate and attributes inverse committed bytes", async () => {
        const projectRoot = await createTestTmpRoot("outline-host", "outline-undo-contract");
        roots.push(projectRoot);
        const original = serializeManifest(createEmptyManifest());
        await publishOutlineFiles({projectRoot}, [{relativePath: "outline/manifest.yaml", content: original}]);
        const next = serializeManifest({...createEmptyManifest(), revision: 1});
        const ready = {publicId: "ready-undo", workspace: {root: projectRoot}} as ReadyProjectSessionRef;
        const fileIndex = {mutate: vi.fn(async <T>(operation: () => Promise<T>) => operation())};
        mocks.requireReadyModuleHandle.mockImplementation((_ready, token: {name: string}) => token.name === "file-index" ? fileIndex : {});
        mocks.runReadyProjectOperation.mockImplementation(async (_ready, operation) => operation(
            new AbortController().signal, () => undefined, async () => undefined,
        ));
        const {publishReadyPlanningFiles, undoReadyPlanningFiles} = await import("./host");
        const actor = {kind: "user", userId: "local"} as const;
        const receipt = await publishReadyPlanningFiles(ready, {
            expectedManifestRevision: 0,
            mutations: [{relativePath: "outline/manifest.yaml", content: next}],
        }, actor);
        await expect(undoReadyPlanningFiles(ready, receipt.transactionId, actor)).resolves.toMatchObject({kind: "undone"});
        expect(await fs.readFile(path.join(projectRoot, "outline/manifest.yaml"), "utf8")).toBe(original);
        expect(mocks.recordProjectWrite).toHaveBeenCalledTimes(2);
        expect(fileIndex.mutate).toHaveBeenCalledTimes(2);
    });
    it("records a byte-preserving rename as History rename and retains the stable ID", async () => {
        const projectRoot = await createTestTmpRoot("outline-host", "outline-host-rename");
        roots.push(projectRoot);
        const base = createEmptyManifest();
        await publishOutlineFiles({projectRoot}, [{relativePath: "outline/manifest.yaml", content: serializeManifest(base)}]);
        const oldPath = "outline/foreshadowing/old--fo-1.md";
        const newPath = "outline/foreshadowing/new--fo-1.md";
        const content = serializeForeshadowingMarkdown({schema: "nbook.outline-foreshadowing/v1", id: "fo-1", version: 0, status: "draft", title: "Old", body: "Text"});
        const ref = {id: "fo-1" as const, path: oldPath, version: 0, contentHash: contentHash(content)};
        await publishPlanningFiles({projectRoot}, {expectedManifestRevision: 0, mutations: [
            {relativePath: oldPath, content},
            {relativePath: "outline/manifest.yaml", content: serializeManifest({...base, revision: 1, foreshadowing: [ref]})},
        ]});
        const ready = {publicId: "ready-rename", workspace: {root: projectRoot}} as ReadyProjectSessionRef;
        const fileIndex = {mutate: vi.fn(async <T>(operation: () => Promise<T>) => operation())};
        mocks.requireReadyModuleHandle.mockImplementation((_ready, token: {name: string}) => token.name === "file-index" ? fileIndex : {});
        mocks.runReadyProjectOperation.mockImplementation(async (_ready, operation) => operation(
            new AbortController().signal, () => undefined, async () => undefined,
        ));
        const {publishReadyPlanningFiles} = await import("./host");
        await publishReadyPlanningFiles(ready, {expectedManifestRevision: 1, mutations: [
            {relativePath: oldPath, content: null},
            {relativePath: newPath, content},
            {relativePath: "outline/manifest.yaml", content: serializeManifest({...base, revision: 2, foreshadowing: [{...ref, path: newPath}]})},
        ]}, {kind: "user", userId: "local"});
        expect(mocks.recordProjectRename).toHaveBeenCalledWith(expect.anything(), {fromPath: oldPath, toPath: newPath, actor: {kind: "user", userId: "local"}});
        expect(mocks.recordProjectDelete).not.toHaveBeenCalled();
        expect((await readPlanningSnapshot({projectRoot})).foreshadowing[0]).toMatchObject({path: newPath, value: {id: "fo-1"}});
    });

    it("ready 原始发布不能绕过线路图与固定线路门禁，拒绝后规范文件字节不变", async () => {
        const projectRoot = await createTestTmpRoot("outline-host", "outline-fixed-policy");
        roots.push(projectRoot);
        const root: OutlineEntry = {schema: "nbook.outline-entry/v2", id: "ol-root", kind: "total", version: 0,
            status: "adopted", title: "总纲", parentId: null, chapterId: null, body: "故事"};
        const chapter: OutlineEntry = {...root, id: "ol-chapter", kind: "chapter", title: "第一章", parentId: root.id};
        const entryFiles = [root, chapter].map((value) => ({
            value, path: `outline/entries/${value.kind}--${value.id}.md`, content: serializeEntryMarkdown(value),
        }));
        const manifestPath = "outline/manifest.yaml";
        const base = {...createEmptyManifest(), plans: [{id: "plan-a", title: "主方案", totalId: root.id, placements: [
            {entryId: root.id, parentId: null, position: 0}, {entryId: chapter.id, parentId: root.id, position: 1},
        ]}], entries: entryFiles.map(({value, path, content}) => ({id: value.id, path, version: 0, contentHash: contentHash(content)}))};
        const original = serializeManifest(base);
        await publishOutlineFiles({projectRoot}, [...entryFiles.map(({path: relativePath, content}) => ({relativePath, content})),
            {relativePath: manifestPath, content: original}]);
        const ready = {publicId: "ready-fixed", workspace: {root: projectRoot}} as ReadyProjectSessionRef;
        const fileIndex = {mutate: vi.fn(async <T>(operation: () => Promise<T>) => operation())};
        mocks.requireReadyModuleHandle.mockImplementation((_ready, token: {name: string}) => token.name === "file-index" ? fileIndex : {});
        mocks.runReadyProjectOperation.mockImplementation(async (_ready, operation) => operation(
            new AbortController().signal, () => undefined, async () => undefined,
        ));
        const {publishReadyPlanningFiles} = await import("./host");
        const actor = {kind: "user", userId: "local"} as const;
        const graph: OutlineGraph = {schema: "nbook.outline-graph/v1", id: "gr-a", planId: "plan-a", version: 1,
            nodes: [{id: "nd-root", entryId: root.id, column: 0, row: 0}, {id: "nd-chapter", entryId: chapter.id, column: 1, row: 0}],
            edges: [{id: "eg-edge", from: "nd-root", to: "nd-chapter"}]};
        const graphPath = "outline/graphs/main--gr-a.yaml";
        const graphBytes = serializeGraphYaml(graph);
        const graphRef = {id: graph.id, path: graphPath, version: 1, contentHash: contentHash(graphBytes)};
        const linePath = "outline/storylines/main--ln-main.yaml";
        const draft: OutlineLine = {schema: "nbook.outline-line/v3", id: "ln-main", planId: "plan-a", version: 0, title: "主线",
            type: "main", fixed: false, nodeIds: ["nd-root", "nd-chapter"]};
        const lineRef = (line: OutlineLine) => ({id: line.id, path: linePath, version: line.version,
            contentHash: contentHash(serializeLineYaml(line))});
        const fixed: OutlineLine = {...draft, fixed: true, version: 1, analysis: {reportId: "report-1", planId: "plan-a",
            sourceHash: "sha256:" + "1".repeat(64), contextHash: "sha256:" + "2".repeat(64), summary: "无冲突",
            conflicts: [], resolutions: [], entryHashes: [
                {nodeId: "nd-root", entryId: root.id, contentHash: base.entries[0]!.contentHash},
                {nodeId: "nd-chapter", entryId: chapter.id, contentHash: base.entries[1]!.contentHash},
            ]}};

        await expect(publishReadyPlanningFiles(ready, {expectedManifestRevision: 0, mutations: [
            {relativePath: graphPath, content: graphBytes},
            {relativePath: linePath, content: serializeLineYaml(draft)},
            {relativePath: manifestPath, content: serializeManifest({...base, revision: 1, graphs: [graphRef], lines: [lineRef(draft)]})},
        ]}, actor)).rejects.toMatchObject({code: "PUBLISH_FAILED"});
        expect(await fs.readFile(path.join(projectRoot, manifestPath), "utf8")).toBe(original);
        await expect(fs.readFile(path.join(projectRoot, graphPath))).rejects.toMatchObject({code: "ENOENT"});
        await expect(fs.readFile(path.join(projectRoot, linePath))).rejects.toMatchObject({code: "ENOENT"});

        const draftBytes = serializeLineYaml(draft);
        const draftManifest = {...base, revision: 1, graphs: [graphRef], lines: [lineRef(draft)]};
        await publishPlanningFiles({projectRoot}, {expectedManifestRevision: 0, mutations: [
            {relativePath: graphPath, content: graphBytes},
            {relativePath: linePath, content: draftBytes},
            {relativePath: manifestPath, content: serializeManifest(draftManifest)},
        ]});
        await expect(publishReadyPlanningFiles(ready, {expectedManifestRevision: 1, mutations: [
            {relativePath: linePath, content: serializeLineYaml(fixed)},
            {relativePath: manifestPath, content: serializeManifest({...draftManifest, revision: 2, lines: [lineRef(fixed)]})},
        ]}, actor)).rejects.toMatchObject({code: "PUBLISH_FAILED"});
        const movedGraph = serializeGraphYaml({...graph, version: 2, nodes: [graph.nodes[0]!, {...graph.nodes[1]!, column: 2}]});
        await expect(publishReadyPlanningFiles(ready, {expectedManifestRevision: 1, mutations: [
            {relativePath: graphPath, content: movedGraph},
            {relativePath: manifestPath, content: serializeManifest({...draftManifest, revision: 2,
                graphs: [{...graphRef, version: 2, contentHash: contentHash(movedGraph)}]})},
        ]}, actor)).rejects.toMatchObject({code: "PUBLISH_FAILED"});
        expect(await fs.readFile(path.join(projectRoot, graphPath), "utf8")).toBe(graphBytes);
        expect(await fs.readFile(path.join(projectRoot, linePath), "utf8")).toBe(draftBytes);
        expect(await fs.readFile(path.join(projectRoot, manifestPath), "utf8")).toBe(serializeManifest(draftManifest));

        const fixedManifest = {...draftManifest, revision: 2, lines: [lineRef(fixed)]};
        const adoptedBytes = serializeLineYaml(fixed);
        await publishPlanningFiles({projectRoot}, {expectedManifestRevision: 1, mutations: [
            {relativePath: linePath, content: adoptedBytes},
            {relativePath: manifestPath, content: serializeManifest(fixedManifest)},
        ]});
        const edited: OutlineLine = {...fixed, version: 2, title: "绕过审查"};
        await expect(publishReadyPlanningFiles(ready, {expectedManifestRevision: 2, mutations: [
            {relativePath: linePath, content: serializeLineYaml(edited)},
            {relativePath: manifestPath, content: serializeManifest({...fixedManifest, revision: 3, lines: [lineRef(edited)]})},
        ]}, actor)).rejects.toMatchObject({code: "PUBLISH_FAILED"});
        expect(await fs.readFile(path.join(projectRoot, linePath), "utf8")).toBe(adoptedBytes);
        expect(await fs.readFile(path.join(projectRoot, manifestPath), "utf8")).toBe(serializeManifest(fixedManifest));
        expect(mocks.recordProjectWrite).not.toHaveBeenCalled();

        const renamedPath = "outline/storylines/renamed--ln-main.yaml";
        const renamedManifest = serializeManifest({...fixedManifest, revision: 3,
            lines: [{...fixedManifest.lines[0]!, path: renamedPath}]});
        await publishReadyPlanningFiles(ready, {expectedManifestRevision: 2, mutations: [
            {relativePath: linePath, content: null},
            {relativePath: renamedPath, content: adoptedBytes},
            {relativePath: manifestPath, content: renamedManifest},
        ]}, actor);
        expect(await fs.readFile(path.join(projectRoot, renamedPath), "utf8")).toBe(adoptedBytes);
        await expect(fs.readFile(path.join(projectRoot, linePath))).rejects.toMatchObject({code: "ENOENT"});
        expect((await readPlanningSnapshot({projectRoot})).lines[0]).toMatchObject({path: renamedPath, value: {fixed: true}});
        expect(mocks.recordProjectRename).toHaveBeenCalledWith(expect.anything(), {fromPath: linePath, toPath: renamedPath, actor});
    });

    it("requires a matching preview hash, then deletes and restores one unreferenced object", async () => {
        const projectRoot = await createTestTmpRoot("outline-host", "outline-host-delete");
        roots.push(projectRoot);
        const base = createEmptyManifest();
        await publishOutlineFiles({projectRoot}, [{relativePath: "outline/manifest.yaml", content: serializeManifest(base)}]);
        const relativePath = "outline/foreshadowing/clue--fo-1.md";
        const content = serializeForeshadowingMarkdown({schema: "nbook.outline-foreshadowing/v1", id: "fo-1", version: 0, status: "draft", title: "Clue", body: "Text"});
        const ref = {id: "fo-1" as const, path: relativePath, version: 0, contentHash: contentHash(content)};
        await publishPlanningFiles({projectRoot}, {expectedManifestRevision: 0, mutations: [
            {relativePath, content},
            {relativePath: "outline/manifest.yaml", content: serializeManifest({...base, revision: 1, foreshadowing: [ref]})},
        ]});
        const ready = {publicId: "ready-delete", workspace: {root: projectRoot}} as ReadyProjectSessionRef;
        const fileIndex = {mutate: vi.fn(async <T>(operation: () => Promise<T>) => operation())};
        mocks.requireReadyModuleHandle.mockImplementation((_ready, token: {name: string}) => token.name === "file-index" ? fileIndex : {});
        mocks.runReadyProjectOperation.mockImplementation(async (_ready, operation) => operation(
            new AbortController().signal, () => undefined, async () => undefined,
        ));
        const {previewReadyPlanningObjectDeletion, removeReadyPlanningObject, undoReadyPlanningFiles} = await import("./host");
        const actor = {kind: "user", userId: "local"} as const;
        const preview = await previewReadyPlanningObjectDeletion(ready, "fo-1");
        expect(preview).toMatchObject({revision: 1, objectHash: ref.contentHash, impact: {canDeleteObject: true}});
        await expect(removeReadyPlanningObject(ready, "fo-1", preview.revision, "sha256:" + "0".repeat(64), false, actor))
            .rejects.toMatchObject({code: "CAS_CONFLICT"});
        const receipt = await removeReadyPlanningObject(ready, "fo-1", preview.revision, ref.contentHash, false, actor);
        expect(mocks.recordProjectDelete).toHaveBeenCalledWith(expect.anything(), {relativePath, actor, before: new TextEncoder().encode(content)});
        await expect(fs.readFile(path.join(projectRoot, relativePath))).rejects.toMatchObject({code: "ENOENT"});
        await expect(undoReadyPlanningFiles(ready, receipt.transactionId, actor)).resolves.toMatchObject({kind: "undone"});
        expect(await fs.readFile(path.join(projectRoot, relativePath), "utf8")).toBe(content);
    });

    it("伏笔创建、确认与编辑在 ready Project 内按版本提交并可撤销", async () => {
        const projectRoot = await createTestTmpRoot("outline-host", "foreshadowing-lifecycle");
        roots.push(projectRoot);
        await publishOutlineFiles({projectRoot}, [{relativePath: "outline/manifest.yaml", content: serializeManifest(createEmptyManifest())}]);
        const ready = {publicId: "ready-foreshadowing", workspace: {root: projectRoot}} as ReadyProjectSessionRef;
        const fileIndex = {mutate: vi.fn(async <T>(operation: () => Promise<T>) => operation())};
        mocks.requireReadyModuleHandle.mockImplementation((_ready, token: {name: string}) => token.name === "file-index" ? fileIndex : {});
        mocks.runReadyProjectOperation.mockImplementation(async (_ready, operation) => operation(
            new AbortController().signal, () => undefined, async () => undefined,
        ));
        const {applyReadyForeshadowingAction, publishReadyPlanningFiles, undoReadyPlanningFiles} = await import("./host");
        const actor = {kind: "user", userId: "local"} as const;
        const created = await applyReadyForeshadowingAction(ready, {kind: "create-foreshadowing", title: "银纹", body: "草稿"}, 0, actor);
        const draft = await readPlanningSnapshot({projectRoot});
        const source = draft.foreshadowing[0]!;
        expect(source.value).toMatchObject({id: created.foreshadowingId, version: 0, status: "draft"});
        await expect(applyReadyForeshadowingAction(ready, {kind: "confirm-foreshadowing", id: source.value.id,
            expectedVersion: 0, expectedContentHash: source.contentHash}, 0, actor)).rejects.toMatchObject({code: "MANIFEST_REVISION_CONFLICT"});
        const confirmed = await applyReadyForeshadowingAction(ready, {kind: "confirm-foreshadowing", id: source.value.id,
            expectedVersion: 0, expectedContentHash: source.contentHash}, 1, actor);
        const after = await readPlanningSnapshot({projectRoot});
        expect(after.foreshadowing[0]!.value).toMatchObject({status: "adopted", version: 1});
        expect(mocks.recordProjectWrite).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            relativePath: source.path, actor,
        }));
        const bytes = await fs.readFile(path.join(projectRoot, source.path), "utf8");
        const changed = serializeForeshadowingMarkdown({...after.foreshadowing[0]!.value, version: 2, status: "draft", body: "绕过确认"});
        await expect(publishReadyPlanningFiles(ready, {expectedManifestRevision: 2, mutations: [
            {relativePath: source.path, content: changed},
            {relativePath: "outline/manifest.yaml", content: serializeManifest({...after.manifest, revision: 3,
                foreshadowing: [{...after.manifest.foreshadowing[0]!, version: 2, contentHash: contentHash(changed)}]})},
        ]}, actor)).rejects.toThrow(/正式伏笔/);
        expect(await fs.readFile(path.join(projectRoot, source.path), "utf8")).toBe(bytes);
        await expect(applyReadyForeshadowingAction(ready, {kind: "edit-foreshadowing", id: source.value.id,
            expectedVersion: 0, expectedContentHash: source.contentHash, title: "银纹", body: "新稿"}, 2, actor))
            .rejects.toMatchObject({code: "CAS_CONFLICT"});
        await applyReadyForeshadowingAction(ready, {kind: "edit-foreshadowing", id: source.value.id,
            expectedVersion: 1, expectedContentHash: after.foreshadowing[0]!.contentHash, title: "银纹", body: "新稿"}, 2, actor);
        expect((await readPlanningSnapshot({projectRoot})).foreshadowing[0]!.value)
            .toMatchObject({status: "draft", version: 2, body: "新稿"});
        await expect(undoReadyPlanningFiles(ready, confirmed.transactionId, actor)).resolves.toMatchObject({kind: "conflict"});
    });

    it("损坏章节只能通过专用修复事务恢复为严格可读快照", async () => {
        const projectRoot = await createTestTmpRoot("outline-host", "foreshadowing-marker-repair");
        roots.push(projectRoot);
        const root: OutlineEntry = {schema: "nbook.outline-entry/v1", id: "ol-total", kind: "total", version: 0,
            status: "adopted", title: "总纲", parentId: null, chapterId: null, body: "作品"};
        const brokenBody = '<!-- nb:foreshadow marker="fm-plant" foreshadow="fo-clue" action="plant" -->银纹';
        const chapter: OutlineEntry = {...root, id: "ol-chapter", kind: "chapter", title: "第一章", parentId: root.id, body: brokenBody};
        const definition = {schema: "nbook.outline-foreshadowing/v1" as const, id: "fo-clue" as const, version: 0,
            status: "adopted" as const, title: "银纹", body: "线索"};
        const rootPath = "outline/entries/total--ol-total.md";
        const chapterPath = "outline/entries/chapter--ol-chapter.md";
        const foreshadowPath = "outline/foreshadowing/clue--fo-clue.md";
        const rootContent = serializeEntryMarkdown(root);
        const chapterContent = serializeEntryMarkdown(chapter);
        const foreshadowContent = serializeForeshadowingMarkdown(definition);
        const manifest = {...createEmptyManifest(),
            plans: [{id: "plan-main", title: "主方案", totalId: root.id, placements: [
                {entryId: root.id, parentId: null, position: 0}, {entryId: chapter.id, parentId: root.id, position: 1},
            ]}],
            entries: [{id: root.id, path: rootPath, version: root.version, contentHash: contentHash(rootContent)},
                {id: chapter.id, path: chapterPath, version: chapter.version, contentHash: contentHash(chapterContent)}],
            foreshadowing: [{id: definition.id, path: foreshadowPath, version: definition.version, contentHash: contentHash(foreshadowContent)}]};
        await publishOutlineFiles({projectRoot}, [
            {relativePath: rootPath, content: rootContent},
            {relativePath: chapterPath, content: chapterContent},
            {relativePath: foreshadowPath, content: foreshadowContent},
            {relativePath: "outline/manifest.yaml", content: serializeManifest(manifest)},
        ]);
        const ready = {publicId: "ready-foreshadow-repair", workspace: {root: projectRoot}} as ReadyProjectSessionRef;
        const fileIndex = {mutate: vi.fn(async <T>(operation: () => Promise<T>) => operation())};
        mocks.requireReadyModuleHandle.mockImplementation((_ready, token: {name: string}) => token.name === "file-index" ? fileIndex : {});
        mocks.runReadyProjectOperation.mockImplementation(async (_ready, operation) => operation(
            new AbortController().signal, () => undefined, async () => undefined,
        ));
        const {repairReadyForeshadowingMarker} = await import("./host");
        const actor = {kind: "user", userId: "local"} as const;
        const before = await fs.readFile(path.join(projectRoot, chapterPath), "utf8");
        const repairedBody = '修复后的正文<!-- nb:foreshadow marker="fm-plant" foreshadow="fo-clue" action="plant" -->银纹<!-- /nb:foreshadow marker="fm-plant" -->';
        const receipt = await repairReadyForeshadowingMarker(ready, {
            kind: "repair-foreshadowing-marker", expectedRevision: 0, planId: "plan-main", entryId: chapter.id,
            foreshadowingId: definition.id, expectedVersion: chapter.version, expectedContentHash: contentHash(chapterContent), body: repairedBody,
        }, actor);
        expect(receipt.entryId).toBe(chapter.id);
        const after = await readPlanningSnapshot({projectRoot});
        expect(after.manifest.revision).toBe(1);
        expect(after.entries.find(({value}) => value.id === chapter.id)?.value).toMatchObject({status: "draft", version: 1, body: repairedBody});
        expect(await fs.readFile(path.join(projectRoot, chapterPath), "utf8")).not.toBe(before);
        await expect(repairReadyForeshadowingMarker(ready, {
            kind: "repair-foreshadowing-marker", expectedRevision: 1, planId: "plan-main", entryId: chapter.id,
            foreshadowingId: definition.id, expectedVersion: 1, expectedContentHash: after.entries.find(({value}) => value.id === chapter.id)!.contentHash,
            body: repairedBody + "再次修改",
        }, actor)).rejects.toThrow(/没有可修复/);
    });

    it("returns committed receipts when post-commit History and disposable SQLite are unavailable", async () => {
        const projectRoot = await createTestTmpRoot("outline-host", "outline-postcommit-errors");
        roots.push(projectRoot);
        const base = createEmptyManifest();
        const before = serializeManifest(base);
        const after = serializeManifest({...base, revision: 1});
        await publishOutlineFiles({projectRoot}, [{relativePath: "outline/manifest.yaml", content: before}]);
        await fs.mkdir(path.join(projectRoot, ".nbook", "outline-index.sqlite"));
        const ready = {publicId: "ready-errors", workspace: {root: projectRoot}} as ReadyProjectSessionRef;
        const fileIndex = {mutate: vi.fn(async <T>(operation: () => Promise<T>) => operation())};
        mocks.requireReadyModuleHandle.mockImplementation((_ready, token: {name: string}) => token.name === "file-index" ? fileIndex : {});
        mocks.runReadyProjectOperation.mockImplementation(async (_ready, operation) => operation(
            new AbortController().signal, () => undefined, async () => undefined,
        ));
        mocks.recordProjectWrite.mockRejectedValueOnce(new Error("history unavailable"));
        const {publishReadyPlanningFiles, undoReadyPlanningFiles, openReadyPlanning, recoverReadyPlanning} = await import("./host");
        const actor = {kind: "user", userId: "local"} as const;
        const receipt = await publishReadyPlanningFiles(ready, {
            expectedManifestRevision: 0, mutations: [{relativePath: "outline/manifest.yaml", content: after}],
        }, actor);
        expect(receipt.files).toEqual(["outline/manifest.yaml"]);
        expect(await fs.readFile(path.join(projectRoot, "outline", "manifest.yaml"), "utf8")).toBe(after);
        expect((await openReadyPlanning(ready)).manifest.revision).toBe(1);
        await expect(undoReadyPlanningFiles(ready, receipt.transactionId, actor)).resolves.toMatchObject({kind: "undone"});
        expect(await fs.readFile(path.join(projectRoot, "outline", "manifest.yaml"), "utf8")).toBe(before);
        await expect(recoverReadyPlanning(ready)).resolves.toHaveProperty("recovered");
    });
});




describe("ready Project 线路报告签发与固定", () => {
    it("同一 ready 会话的审阅确认才可固定，持久化报告并记录 History", async () => {
        const projectRoot = await createTestTmpRoot("outline-host", "fixed-line-contract");
        roots.push(projectRoot);
        const root: OutlineEntry = {schema: "nbook.outline-entry/v1", id: "ol-total", kind: "total", version: 0,
            status: "adopted", title: "总纲", parentId: null, chapterId: null, body: "开局"};
        const chapter: OutlineEntry = {...root, id: "ol-chapter", kind: "chapter", title: "章节",
            parentId: root.id, materialRefs: ["lorebook/character/hero.md"]};
        const entries = [root, chapter].map((value) => ({id: value.id,
            path: "outline/entries/" + value.id + ".md", version: value.version,
            content: serializeEntryMarkdown(value)}));
        const graph: OutlineGraph = {schema: "nbook.outline-graph/v1", id: "gr-main", planId: "plan-a", version: 1,
            nodes: [{id: "nd-root", entryId: root.id, column: 0, row: 0}, {id: "nd-chapter", entryId: chapter.id, column: 1, row: 0}],
            edges: [{id: "eg-edge", from: "nd-root", to: "nd-chapter"}]};
        const graphPath = "outline/graphs/main--gr-main.yaml";
        const graphContent = serializeGraphYaml(graph);
        const line: OutlineLine = {schema: "nbook.outline-line/v3", id: "ln-main", planId: "plan-a", version: 0,
            title: "主线", type: "main", fixed: false, nodeIds: ["nd-root", "nd-chapter"]};
        const linePath = "outline/storylines/main--ln-main.yaml";
        const lineContent = serializeLineYaml(line);
        const manifest = {...createEmptyManifest(),
            plans: [{id: "plan-a", title: "主方案", totalId: root.id, placements: [{entryId: root.id, parentId: null, position: 0},
                {entryId: chapter.id, parentId: root.id, position: 1}]}],
            entries: entries.map(({id, path, version, content}) => ({id, path, version, contentHash: contentHash(content)})),
            graphs: [{id: graph.id, path: graphPath, version: 1, contentHash: contentHash(graphContent)}],
            lines: [{id: line.id, path: linePath, version: 0, contentHash: contentHash(lineContent)}]};
        await publishOutlineFiles({projectRoot}, [...entries.map(({path: relativePath, content}) => ({relativePath, content})),
            {relativePath: graphPath, content: graphContent},
            {relativePath: linePath, content: lineContent},
            {relativePath: "outline/manifest.yaml", content: serializeManifest(manifest)}]);
        const ready = {publicId: "ready-one", workspace: {root: projectRoot}} as ReadyProjectSessionRef;
        const reopened = {publicId: "ready-two", workspace: {root: projectRoot}} as ReadyProjectSessionRef;
        const fileIndex = {mutate: vi.fn(async <T>(operation: () => Promise<T>) => operation())};
        mocks.requireReadyModuleHandle.mockImplementation((_ready, token: {name: string}) => token.name === "file-index" ? fileIndex : {});
        mocks.runReadyProjectOperation.mockImplementation(async (_ready, operation) =>
            operation(new AbortController().signal, () => undefined, async () => undefined));
        const {analyzeReadyLine, fixReadyLine} = await import("./host");
        const input = {lineId: line.id, expectedRevision: 0, expectedVersion: 0, expectedContentHash: contentHash(lineContent)};
        const actor = {kind: "user" as const, userId: "local"};
        model.complete.mockResolvedValue(JSON.stringify({summary: "有待核对", conflicts: ["动机待确认"]}));
        model.complete.mockImplementationOnce(async () => {
            await fs.writeFile(path.join(projectRoot, "outline/manifest.yaml"), serializeManifest({...manifest, revision: 1}));
            return JSON.stringify({summary: "旧上下文", conflicts: []});
        });
        await expect(analyzeReadyLine(ready, input)).rejects.toMatchObject({code: "CAS_CONFLICT"});
        await fs.writeFile(path.join(projectRoot, "outline/manifest.yaml"), serializeManifest(manifest));
        await expect(fixReadyLine(ready, input, "123e4567-e89b-42d3-a456-426614174000", [], actor))
            .rejects.toThrow(/当前会话/);
        const issued = await analyzeReadyLine(ready, input);
        await expect(fixReadyLine(reopened, input, issued.report.reportId,
            [{index: 0, decision: "resolved", reason: "人物设定已经核对"}], actor)).rejects.toThrow(/当前会话/);
        await expect(fixReadyLine(ready, input, issued.report.reportId, [], actor)).rejects.toThrow(/未处理/);
        expect((await readPlanningSnapshot({projectRoot})).lines[0]?.value.fixed).toBe(false);
        const receipt = await fixReadyLine(ready, input, issued.report.reportId,
            [{index: 0, decision: "resolved", reason: "人物设定已经核对"}], actor);
        expect(receipt.lineId).toBe(line.id);
        const saved = (await readPlanningSnapshot({projectRoot})).lines[0]!.value;
        expect(saved).toMatchObject({fixed: true, version: 1, analysis: {reportId: issued.report.reportId,
            planId: "plan-a", resolutions: [{index: 0, decision: "resolved"}], entryHashes: [{nodeId: "nd-root"},
                {nodeId: "nd-chapter"}]}});
        expect(mocks.recordProjectWrite).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({relativePath: linePath, actor}));
        await expect(fixReadyLine(ready, input, issued.report.reportId,
            [{index: 0, decision: "resolved", reason: "重复提交"}], actor)).rejects.toThrow(/当前会话/);
        const {applyReadyLineAction, inspectReadyLine, readReadyFixedLineNodes} = await import("./host");
        const fixedSnapshot = await readPlanningSnapshot({projectRoot});
        const fixedRequest = {lineId: line.id, expectedRevision: fixedSnapshot.manifest.revision,
            expectedVersion: saved.version, expectedContentHash: fixedSnapshot.lines[0]!.contentHash};
        expect((await inspectReadyLine(ready, line.id)).nodes.map(({status}) => status)).toEqual(["valid", "valid"]);
        expect((await readReadyFixedLineNodes(ready, fixedRequest)).nodes.map(({entryId}) => entryId))
            .toEqual([root.id, chapter.id]);
        await expect(readReadyFixedLineNodes(ready, {...fixedRequest, expectedVersion: 0}))
            .rejects.toMatchObject({code: "CAS_CONFLICT"});
        const reopen = {kind: "reopen-fixed-line" as const, lineId: line.id, expectedVersion: saved.version,
            expectedContentHash: fixedRequest.expectedContentHash, confirmReopen: true as const};
        await expect(applyReadyLineAction(ready, reopen, 0, actor)).rejects.toThrow(/已变化/);
        const beforeReopen = await fs.readFile(path.join(projectRoot, linePath), "utf8");
        expect(beforeReopen).toBe(serializeLineYaml(saved));
        await applyReadyLineAction(ready, reopen, fixedRequest.expectedRevision, actor);
        const draftSnapshot = await readPlanningSnapshot({projectRoot});
        const draft = draftSnapshot.lines[0]!.value;
        expect(draft).toMatchObject({fixed: false, version: 2});
        expect(draft.analysis).toBeUndefined();
        await expect(readReadyFixedLineNodes(ready, {lineId: line.id, expectedRevision: draftSnapshot.manifest.revision,
            expectedVersion: draft.version, expectedContentHash: draftSnapshot.lines[0]!.contentHash})).rejects.toThrow(/失效/);
        model.complete.mockResolvedValue(JSON.stringify({summary: "重新分析通过", conflicts: []}));
        const freshRequest = {lineId: line.id, expectedRevision: draftSnapshot.manifest.revision,
            expectedVersion: draft.version, expectedContentHash: draftSnapshot.lines[0]!.contentHash};
        const fresh = await analyzeReadyLine(ready, freshRequest);
        await fixReadyLine(ready, freshRequest, fresh.report.reportId, [], actor);
        const refixed = await readPlanningSnapshot({projectRoot});
        expect(refixed.lines[0]!.value).toMatchObject({fixed: true, version: 3,
            analysis: {reportId: fresh.report.reportId}});
        expect((await readReadyFixedLineNodes(ready, {lineId: line.id, expectedRevision: refixed.manifest.revision,
            expectedVersion: 3, expectedContentHash: refixed.lines[0]!.contentHash})).nodes).toHaveLength(2);
        // 外部删除留下 manifest 和固定线路的引用；严格写入拒绝，但只读检查仍须标红。
        await fs.unlink(path.join(projectRoot, entries[1]!.path));
        await expect(readPlanningSnapshot({projectRoot})).rejects.toThrow(/manifest 引用文件不存在/);
        expect((await inspectReadyLine(ready, line.id)).nodes.map(({status}) => status)).toEqual(["yellow", "red"]);
        // 丢失条目仅豁免该引用；无关的方案结构错误不能被诊断视图掩盖。
        await fs.writeFile(path.join(projectRoot, "outline/manifest.yaml"), serializeManifest({...refixed.manifest,
            plans: [...refixed.manifest.plans, refixed.manifest.plans[0]!]}));
        await expect(inspectReadyLine(ready, line.id)).rejects.toThrow(/方案 ID 重复/);
        await fs.writeFile(path.join(projectRoot, "outline/manifest.yaml"), serializeManifest(refixed.manifest));
        await expect(readReadyFixedLineNodes(ready, {lineId: line.id, expectedRevision: refixed.manifest.revision,
            expectedVersion: 3, expectedContentHash: refixed.lines[0]!.contentHash})).rejects.toThrow(/不存在/);
        await fs.writeFile(path.join(projectRoot, linePath), "invalid: [");
        await expect(inspectReadyLine(ready, line.id)).rejects.toThrow();
        await fs.writeFile(path.join(projectRoot, linePath), serializeLineYaml(refixed.lines[0]!.value));
        await fs.writeFile(path.join(projectRoot, entries[0]!.path), "external edit without manifest update");
        await expect(inspectReadyLine(ready, line.id)).rejects.toThrow(/hash 与 manifest 不一致/);
    });
});
