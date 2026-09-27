import {randomUUID} from "node:crypto";
import {once} from "node:events";
import fs from "node:fs/promises";
import {createServer, type Server} from "node:http";
import path from "node:path";
import {testHostPath} from "@notnotype/neuro-book-test-support/test-path";
import {createApp, defineEventHandler, getRequestURL, toNodeListener} from "h3";
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {absoluteFsPath, type AbsoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {closeAllProjects, openProject, resetProjectSessionsForTest} from "nbook/server/workspace-files/project-session";
import {projectWorkspaceRef} from "nbook/server/workspace-files/project-identity";
import {writeProjectManifest} from "nbook/server/workspace-files/project-workspace";
import type {PlanningSnapshot} from "nbook/server/outline";
import {contentHash, parseEntryMarkdown, parseManifest, serializeEntryMarkdown, serializeManifest} from "nbook/server/outline/format";

/** 真实 H3/TCP 验证损坏标记的诊断、专用预览、CAS 提交和严格快照恢复。 */
describe("Project 伏笔标记修复真实 H3 HTTP 合同", () => {
    let root: string;
    let workspaceRoot: AbsoluteFsPath;
    let projectRoot: AbsoluteFsPath;
    let server: Server;
    let baseUrl: string;
    let outlineHandler: (event: never) => unknown;
    const ref = projectWorkspaceRef("outline-foreshadow-repair-http");

    beforeAll(async () => {
        vi.stubGlobal("defineEventHandler", defineEventHandler);
        outlineHandler = (await import("./[...segments]")).default;
    });

    beforeEach(async () => {
        resetProjectSessionsForTest();
        root = testHostPath(`neuro-book-outline-foreshadow-repair-http-${randomUUID()}`);
        workspaceRoot = absoluteFsPath(path.join(root, "workspace"));
        await fs.mkdir(workspaceRoot, {recursive: true});
        await writeProjectManifest(workspaceRoot, ref, {kind: "novel", title: "伏笔修复 HTTP 测试", summary: ""});
        projectRoot = (await openProject(ref, {kind: "job", source: "outline-foreshadow-repair-http-test"}, workspaceRoot)).workspace.root;

        const app = createApp();
        app.use("/api/projects/outline", defineEventHandler((event) => {
            event.context.params = {segments: getRequestURL(event).pathname.slice("/api/projects/outline/".length)};
            return outlineHandler(event as never);
        }));
        server = createServer(toNodeListener(app));
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("伏笔修复 HTTP fixture 未获取监听端口");
        baseUrl = `http://127.0.0.1:${address.port}/api/projects/outline`;
    });

    afterAll(() => vi.unstubAllGlobals());

    afterEach(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await closeAllProjects();
        resetProjectSessionsForTest();
        await fs.rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
    }, 60_000);

    const endpoint = (segment: string) => `${baseUrl}/${segment}?projectRoot=outline-foreshadow-repair-http`;
    const post = (segment: string, body: unknown) => fetch(endpoint(segment), {
        method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body),
    });
    const snapshot = async () => await (await fetch(endpoint("snapshot"))).json() as PlanningSnapshot;

    it("保留损坏原文，修复候选经预览和 CAS 提交后恢复严格读取", async () => {
        expect((await post("open", {})).status).toBe(200);
        let current = await snapshot();
        const applyLibrary = async (action: unknown) => {
            const response = await post("library-action", {expectedRevision: current.manifest.revision, action});
            expect(response.status, await response.clone().text()).toBe(200);
            current = await snapshot();
            return await response.json() as {entryId?: string; planId?: string};
        };
        const totalId = (await applyLibrary({kind: "create-total", title: "总纲", body: "作品"})).entryId!;
        const planId = (await applyLibrary({kind: "create-plan", title: "主方案"})).planId!;
        const chapterId = (await applyLibrary({kind: "create-entry", planId, parentId: totalId,
            entryKind: "chapter", title: "第一章", body: "初稿"})).entryId!;
        const chapterBeforeAdopt = current.entries.find(({value}) => value.id === chapterId)!;
        await applyLibrary({kind: "adopt-entry", planId, entryId: chapterId,
            expectedVersion: chapterBeforeAdopt.value.version, expectedContentHash: chapterBeforeAdopt.contentHash});
        const createdForeshadowing = await post("foreshadowing-action", {expectedRevision: current.manifest.revision,
            action: {kind: "create-foreshadowing", title: "银纹", body: "线索"}});
        expect(createdForeshadowing.status, await createdForeshadowing.clone().text()).toBe(200);
        const {foreshadowingId} = await createdForeshadowing.json() as {foreshadowingId: string};
        current = await snapshot();
        const foreshadowing = current.foreshadowing.find(({value}) => value.id === foreshadowingId)!;
        const confirmed = await post("foreshadowing-action", {expectedRevision: current.manifest.revision,
            action: {kind: "confirm-foreshadowing", id: foreshadowingId,
                expectedVersion: foreshadowing.value.version, expectedContentHash: foreshadowing.contentHash}});
        expect(confirmed.status, await confirmed.clone().text()).toBe(200);
        current = await snapshot();

        const chapter = current.entries.find(({value}) => value.id === chapterId)!;
        const chapterAbsolutePath = path.join(projectRoot, chapter.path);
        const parsedChapter = parseEntryMarkdown(await fs.readFile(chapterAbsolutePath, "utf8"), chapter.path);
        const brokenBody = `<!-- nb:foreshadow marker="fm-plant" foreshadow="${foreshadowingId}" action="plant" -->银纹`;
        const brokenContent = serializeEntryMarkdown({...parsedChapter, body: brokenBody});
        const manifestPath = path.join(projectRoot, "outline/manifest.yaml");
        const manifest = parseManifest(await fs.readFile(manifestPath, "utf8"));
        const nextManifest = {...manifest, revision: manifest.revision + 1,
            entries: manifest.entries.map((item) => item.id === chapterId
                ? {...item, contentHash: contentHash(brokenContent)} : item)};
        await fs.writeFile(chapterAbsolutePath, brokenContent, "utf8");
        await fs.writeFile(manifestPath, serializeManifest(nextManifest), "utf8");

        const diagnosticResponse = await fetch(endpoint("foreshadowing-states"));
        expect(diagnosticResponse.status, await diagnosticResponse.clone().text()).toBe(200);
        expect((await diagnosticResponse.json()).markerIssues).toEqual(expect.arrayContaining([
            expect.objectContaining({entryId: chapterId, path: chapter.path}),
        ]));
        const repairedBody = `修复后的正文<!-- nb:foreshadow marker="fm-plant" foreshadow="${foreshadowingId}" action="plant" -->银纹<!-- /nb:foreshadow marker="fm-plant" -->`;
        const repairInput = {expectedRevision: nextManifest.revision, planId, entryId: chapterId,
            foreshadowingId, expectedVersion: parsedChapter.version, expectedContentHash: contentHash(brokenContent), body: repairedBody};
        const preview = await post("preview-foreshadowing-marker-repair", repairInput);
        expect(preview.status, await preview.clone().text()).toBe(200);
        expect((await preview.json()).files).toEqual(expect.arrayContaining([
            expect.objectContaining({relativePath: chapter.path}),
        ]));
        const applied = await post("repair-foreshadowing-marker", repairInput);
        expect(applied.status, await applied.clone().text()).toBe(200);
        expect((await applied.json()).entryId).toBe(chapterId);
        current = await snapshot();
        expect(current.entries.find(({value}) => value.id === chapterId)?.value).toMatchObject({status: "draft", body: repairedBody});
        expect((await (await fetch(endpoint("foreshadowing-states"))).json()).markerIssues).toEqual([]);
        const stale = await post("repair-foreshadowing-marker", repairInput);
        expect(stale.status).toBe(409);
        expect(await fs.readFile(chapterAbsolutePath, "utf8")).toBe(serializeEntryMarkdown(current.entries.find(({value}) => value.id === chapterId)!.value));
    }, 60_000);
});
