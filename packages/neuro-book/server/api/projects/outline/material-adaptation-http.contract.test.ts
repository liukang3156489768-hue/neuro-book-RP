import {once} from "node:events";
import fs from "node:fs/promises";
import {createServer, type Server} from "node:http";
import path from "node:path";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import {createApp, defineEventHandler, getRequestURL, toNodeListener} from "h3";
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {absoluteFsPath, type AbsoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {closeAllProjects, openProject, resetProjectSessionsForTest} from "nbook/server/workspace-files/project-session";
import {projectWorkspaceRef} from "nbook/server/workspace-files/project-identity";
import {writeProjectManifest} from "nbook/server/workspace-files/project-workspace";
import type {PlanningSnapshot} from "nbook/server/outline";
import {adaptationRecordPath} from "nbook/server/outline/adaptation";
import type {OutlineAdaptation, OutlineId, OutlineMaterialUpdate} from "nbook/server/outline/format";
import type {LibraryAction} from "nbook/server/outline/library";

describe("素材改编真实 H3 HTTP 合同", () => {
    let root: string;
    let projectRoot: AbsoluteFsPath;
    let server: Server;
    let baseUrl: string;
    let current: PlanningSnapshot;
    let outlineHandler: (event: never) => unknown;
    const ref = projectWorkspaceRef("outline-material-adaptation-http");

    beforeAll(async () => {
        vi.stubGlobal("defineEventHandler", defineEventHandler);
        outlineHandler = (await import("./[...segments]")).default;
    });

    beforeEach(async () => {
        resetProjectSessionsForTest();
        root = await createTestTmpRoot("outline-adaptation-http", "planning-material-sync-http");
        const workspaceRoot = absoluteFsPath(path.join(root, "workspace"));
        await fs.mkdir(workspaceRoot, {recursive: true});
        await writeProjectManifest(workspaceRoot, ref, {kind: "novel", title: "素材改编 HTTP 测试", summary: ""});
        projectRoot = (await openProject(ref, {kind: "job", source: "outline-adaptation-http-test"}, workspaceRoot)).workspace.root;
        const app = createApp();
        app.use("/api/projects/outline", defineEventHandler((event) => {
            event.context.params = {segments: getRequestURL(event).pathname.slice("/api/projects/outline/".length)};
            return outlineHandler(event as never);
        }));
        server = createServer(toNodeListener(app));
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("素材改编 HTTP fixture 未获取监听端口");
        baseUrl = `http://127.0.0.1:${address.port}/api/projects/outline`;
        expect((await post("open", {})).status).toBe(200);
        current = await snapshot();
    });

    afterAll(() => vi.unstubAllGlobals());
    afterEach(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await closeAllProjects();
        resetProjectSessionsForTest();
        await fs.rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
    }, 60_000);

    const endpoint = (segment: string) => `${baseUrl}/${segment}?projectRoot=outline-material-adaptation-http`;
    const post = (segment: string, body: unknown) => fetch(endpoint(segment), {
        method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body),
    });
    const snapshot = async () => await (await fetch(endpoint("snapshot"))).json() as PlanningSnapshot;
    const applyLibrary = async (action: LibraryAction) => {
        const response = await post("library-action", {expectedRevision: current.manifest.revision, action});
        expect(response.status, await response.clone().text()).toBe(200);
        current = await snapshot();
        return await response.json() as {entryId?: OutlineId; planId?: string};
    };
    const chapter = (planId: string, parentId: OutlineId, metadata: {
        adaptation?: OutlineAdaptation; materialUpdates?: readonly OutlineMaterialUpdate[];
    } = {}): LibraryAction => ({kind: "create-entry", planId, parentId, entryKind: "chapter", title: "新增章", body: "新剧情", ...metadata});

    async function setupMaterial() {
        const source = await applyLibrary({kind: "create-plan", title: "原作"});
        const first = await applyLibrary(chapter(source.planId!, source.entryId!));
        const second = await applyLibrary(chapter(source.planId!, source.entryId!));
        const target = await applyLibrary({kind: "create-plan", title: "改编"});
        const bases = ["lorebook/character/主角/index.md", "lorebook/item/钥匙/index.md", "lorebook/location/城门/index.md"];
        for (const base of bases) {
            await fs.mkdir(path.dirname(path.join(projectRoot, base)), {recursive: true});
            await fs.writeFile(path.join(projectRoot, base), "只读基础信息");
        }
        const updates: readonly OutlineMaterialUpdate[] = [
            {materialPath: bases[0]!, kind: "experience", body: "主角准备进城"},
            {materialPath: bases[0]!, kind: "relationship", body: "主角开始信任同伴"},
            {materialPath: bases[1]!, kind: "item", body: "钥匙交给同伴"},
            {materialPath: bases[2]!, kind: "location", body: "城门即将关闭"},
        ];
        const origin: OutlineAdaptation = {kind: "between", sourcePlanId: source.planId!, beforeEntryId: first.entryId!, afterEntryId: second.entryId!};
        return {target, bases, updates, origin};
    }

    it("HTTP 保存稳定来源与四类记录，修改剧情同步替换记录且基础资料不变", async () => {
        const {target, bases, updates, origin} = await setupMaterial();
        const made = await applyLibrary(chapter(target.planId!, target.entryId!, {adaptation: origin, materialUpdates: updates}));
        let entry = current.entries.find(({value}) => value.id === made.entryId)!;
        expect(entry.value).toMatchObject({adaptation: origin, materialUpdates: updates});
        for (const update of updates) {
            const file = adaptationRecordPath(update, target.planId!, made.entryId!);
            expect(await fs.readFile(path.join(projectRoot, file), "utf8")).toContain(update.body);
        }
        const revised = updates.map(update => ({...update, body: `修订：${update.body}`}));
        await applyLibrary({kind: "edit-entry", planId: target.planId!, entryId: made.entryId!,
            expectedVersion: entry.value.version, expectedContentHash: entry.contentHash,
            title: "修订的新章节", body: "修订剧情", materialUpdates: revised});
        entry = current.entries.find(({value}) => value.id === made.entryId)!;
        expect(entry.value).toMatchObject({body: "修订剧情", adaptation: origin, materialUpdates: revised});
        for (const update of revised) {
            const file = adaptationRecordPath(update, target.planId!, made.entryId!);
            const content = await fs.readFile(path.join(projectRoot, file), "utf8");
            expect(content).toContain(update.body);
            expect(content).toContain("尚未发生");
        }
        for (const base of bases) expect(await fs.readFile(path.join(projectRoot, base), "utf8")).toBe("只读基础信息");
    }, 60_000);

    it.each([
        {category: "character", kind: "experience" as const},
        {category: "item", kind: "item" as const},
        {category: "location", kind: "location" as const},
    ])("HTTP 拒绝不存在的 $category 对象，规划和素材均不落盘", async ({category, kind}) => {
        const target = await applyLibrary({kind: "create-plan", title: "改编"});
        const before = current;
        const missingDirectory = `lorebook/${category}/不存在的对象`;
        const response = await post("library-action", {expectedRevision: current.manifest.revision,
            action: chapter(target.planId!, target.entryId!, {materialUpdates: [
                {materialPath: `${missingDirectory}/index.md`, kind, body: "新信息"},
            ]})});
        expect(response.status, await response.clone().text()).toBe(400);
        expect(await response.json()).toMatchObject({data: {code: "INVALID_PATH"}});
        expect(await snapshot()).toEqual(before);
        await expect(fs.stat(path.join(projectRoot, missingDirectory))).rejects.toMatchObject({code: "ENOENT"});
    }, 60_000);

    it("HTTP 拒绝改剧情但省略已有记录的维护，显式 null 可同步撤下记录", async () => {
        const {target, updates} = await setupMaterial();
        const made = await applyLibrary(chapter(target.planId!, target.entryId!, {materialUpdates: [updates[0]!]}));
        const entry = current.entries.find(({value}) => value.id === made.entryId)!;
        const file = adaptationRecordPath(updates[0]!, target.planId!, made.entryId!);
        const oldRecord = await fs.readFile(path.join(projectRoot, file), "utf8");
        const before = current;
        const action: LibraryAction = {kind: "edit-entry", planId: target.planId!, entryId: made.entryId!,
            expectedVersion: entry.value.version, expectedContentHash: entry.contentHash, title: entry.value.title, body: "取消进城"};
        const response = await post("library-action", {expectedRevision: current.manifest.revision, action});
        expect(response.status, await response.clone().text()).toBe(422);
        expect(await response.json()).toMatchObject({data: {code: "INVALID_ACTION"}});
        expect(await snapshot()).toEqual(before);
        expect(await fs.readFile(path.join(projectRoot, file), "utf8")).toBe(oldRecord);
        await applyLibrary({...action, materialUpdates: null});
        expect(current.entries.find(({value}) => value.id === made.entryId)?.value.body).toBe("取消进城");
        await expect(fs.stat(path.join(projectRoot, file))).rejects.toMatchObject({code: "ENOENT"});
    }, 60_000);
});
