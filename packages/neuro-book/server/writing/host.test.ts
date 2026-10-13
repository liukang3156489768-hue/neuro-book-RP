import {afterEach, describe, expect, it} from "vitest";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createTestReadyProject} from "./host.test-support";
import {
    createReadyProseFile, createReadyWritingStyle, deleteReadyWritingStyle, linkReadyProse,
    listReadyAssistantFiles, listReadyWritingStyles, readReadyAssistantFiles, readReadyWritingOverview, setReadyWritingPlan, setReadyWritingStyle, unlinkReadyProse,
} from "./host";
import {closeProject} from "../workspace-files/project-session";
import {PlanningFixture} from "../outline/line-graph.fixture";
import {sceneDetail} from "../outline/detail.fixture";

const openProjects: {ref: {projectRoot: string}}[] = [];

afterEach(async () => {
    for (const ready of openProjects.splice(0)) {
        await closeProject(ready.ref, "shutdown").catch(() => {});
    }
});

describe("文风管理", () => {
    it("新增文风时建空模板到规范目录，未选文风时顺带选中", async () => {
        const ready = await createTestReadyProject();
        openProjects.push(ready.workspace);

        const before = await listReadyWritingStyles(ready);
        expect(before).toEqual([]);

        const result = await createReadyWritingStyle(ready, "  测试文风  ", {kind: "user", userId: "test"});
        expect(result.stylePath).toMatch(/^lorebook\/instruction\/writing-style\/.+\/index\.md$/u);
        expect(result.overview.settings.stylePath).toBe(result.stylePath);

        const content = await readFile(join(ready.workspace.root, result.stylePath), "utf-8");
        expect(content).toContain("# 测试文风");
        expect(content).toContain("## 文风要求");
        expect(content).toContain("## 禁用写法");
        expect(content).toContain("## 样文");

        const styles = await listReadyWritingStyles(ready);
        expect(styles).toEqual([{path: result.stylePath, title: "测试文风"}]);

        const overview = await readReadyWritingOverview(ready);
        expect(overview.settings.stylePath).toBe(result.stylePath);
    });

    it("已选文风时新增不改选择", async () => {
        const ready = await createTestReadyProject();
        openProjects.push(ready.workspace);

        const first = await createReadyWritingStyle(ready, "第一个", {kind: "user", userId: "test"});
        const second = await createReadyWritingStyle(ready, "第二个", {kind: "user", userId: "test"});
        expect(second.overview.settings.stylePath).toBe(first.stylePath);
    });

    it("删除文风时记入历史，删的是当前文风时清空选择", async () => {
        const ready = await createTestReadyProject();
        openProjects.push(ready.workspace);

        const {stylePath} = await createReadyWritingStyle(ready, "要删的", {kind: "user", userId: "test"});
        const overview = await deleteReadyWritingStyle(ready, stylePath, {kind: "user", userId: "test"});
        expect(overview.settings.stylePath).toBeNull();
        expect(await listReadyWritingStyles(ready)).toEqual([]);
    });

    it("目录里有其他文件时拒绝删除", async () => {
        const ready = await createTestReadyProject();
        openProjects.push(ready.workspace);

        const {stylePath} = await createReadyWritingStyle(ready, "有其他文件", {kind: "user", userId: "test"});
        const extraPath = stylePath.replace(/index\.md$/, "extra.md");
        await writeFile(join(ready.workspace.root, extraPath), "额外文件");
        await expect(deleteReadyWritingStyle(ready, stylePath, {kind: "user", userId: "test"})).rejects.toThrow(/还有其他文件/u);
    });
});

describe("写作正文与关联", () => {
    async function setupPlanningFixture(ready: {workspace: {root: string}}) {
        const fixture = new PlanningFixture();
        const actor = {kind: "user" as const, userId: "test"};
        const {planId, entryId: rootId} = fixture.library({kind: "create-plan", title: "方案"}) as {planId: string; entryId: string};
        const adoptEntry = (entryId: string) => {
            const source = fixture.entry(entryId);
            fixture.library({kind: "adopt-entry", planId, entryId, expectedVersion: source.value.version, expectedContentHash: source.contentHash});
        };
        adoptEntry(rootId);
        const volumeId = fixture.library({kind: "create-entry", planId, parentId: rootId, entryKind: "volume", title: "卷一", body: "卷"}).entryId!;
        adoptEntry(volumeId);
        const chapterId = fixture.library({kind: "create-entry", planId, parentId: volumeId, entryKind: "chapter", title: "第一章", body: "章节大纲"}).entryId!;
        adoptEntry(chapterId);

        await mkdir(join(ready.workspace.root, "outline"), {recursive: true});
        for (const [relativePath, content] of fixture.files) {
            const fullPath = join(ready.workspace.root, relativePath);
            await mkdir(join(fullPath, ".."), {recursive: true});
            await writeFile(fullPath, content, "utf8");
        }
        return {fixture, planId, volumeId, chapterId, actor};
    }

    it("创建正文前检查章节已有正文和不可写状态", async () => {
        const ready = await createTestReadyProject();
        openProjects.push(ready.workspace);
        const {fixture, planId, chapterId, actor} = await setupPlanningFixture(ready);

        // 细纲未审阅的章节不可写；手动关联一份正文后，“已有正文”先于“不可写”报出。
        fixture.library({kind: "create-entry", planId, parentId: chapterId, entryKind: "detail", title: "细纲", ...sceneDetail("入城")});
        await mkdir(join(ready.workspace.root, "outline"), {recursive: true});
        for (const [relativePath, content] of fixture.files) {
            const fullPath = join(ready.workspace.root, relativePath);
            await mkdir(join(fullPath, ".."), {recursive: true});
            await writeFile(fullPath, content, "utf8");
        }

        await setReadyWritingPlan(ready, planId, actor);
        await expect(createReadyProseFile(ready, {chapterEntryId: chapterId}, actor)).rejects.toMatchObject({code: "CHAPTER_NOT_WRITABLE"});
        await mkdir(join(ready.workspace.root, "manuscript/卷/手写"), {recursive: true});
        await writeFile(join(ready.workspace.root, "manuscript/卷/手写/index.md"), "---\ntitle: 手写\n---\n\n正文", "utf8");
        await linkReadyProse(ready, {path: "manuscript/卷/手写/index.md", chapterEntryId: chapterId}, actor);
        await expect(createReadyProseFile(ready, {chapterEntryId: chapterId}, actor)).rejects.toMatchObject({code: "CHAPTER_HAS_PROSE"});
    });

    it("手动关联更新 writing 字段，解除移除字段", async () => {
        const ready = await createTestReadyProject();
        openProjects.push(ready.workspace);
        const {planId, volumeId, chapterId, actor} = await setupPlanningFixture(ready);

        await setReadyWritingPlan(ready, planId, actor);
        const prosePath = `manuscript/${volumeId}/第一章/index.md`;
        await mkdir(join(ready.workspace.root, `manuscript/${volumeId}/第一章`), {recursive: true});
        await writeFile(join(ready.workspace.root, prosePath), "---\ntitle: 第一章\n---\n\n正文", "utf8");

        await linkReadyProse(ready, {path: prosePath, chapterEntryId: chapterId}, actor);
        const linked = await readFile(join(ready.workspace.root, prosePath), "utf8");
        expect(linked).toContain(`chapterEntryId: ${chapterId}`);

        await unlinkReadyProse(ready, {path: prosePath}, actor);
        const unlinked = await readFile(join(ready.workspace.root, prosePath), "utf8");
        expect(unlinked).not.toContain("writing:");
    });

    it("文风路径校验拒绝非法路径和未标记文件", async () => {
        const ready = await createTestReadyProject();
        openProjects.push(ready.workspace);
        const actor = {kind: "user" as const, userId: "test"};

        await expect(setReadyWritingStyle(ready, "../outside.md", actor)).rejects.toThrow(/lorebook\/instruction/u);
        await mkdir(join(ready.workspace.root, "lorebook/instruction"), {recursive: true});
        await writeFile(join(ready.workspace.root, "lorebook/instruction/plain.md"), "---\ntype: note\n---\n\n非文风", "utf8");
        await expect(setReadyWritingStyle(ready, "lorebook/instruction/plain.md", actor)).rejects.toThrow(/类型必须是 instruction.*子类型必须是 writing-style/u);
    });

    it("设置非法时概览返回 settingsError 并按空设置处理", async () => {
        const ready = await createTestReadyProject();
        openProjects.push(ready.workspace);

        await mkdir(join(ready.workspace.root, "writing"), {recursive: true});
        await writeFile(join(ready.workspace.root, "writing/settings.yaml"), "invalid yaml: [", "utf8");
        const overview = await readReadyWritingOverview(ready);
        expect(overview.settingsError).toBeTruthy();
        expect(overview.settings.writingPlanId).toBeNull();
        expect(overview.settings.stylePath).toBeNull();
    });
});

describe("写作助手素材路径兼容", () => {
    it("目录、稳定 ID 和标题引用读取同一份角色素材，解析失败不会回退到原始路径", async () => {
        const ready = await createTestReadyProject();
        openProjects.push(ready.workspace);
        await mkdir(join(ready.workspace.root, "lorebook/character/inspiration-938a0ab4-219c-404a-84ff-5414543edb2f"), {recursive: true});
        await writeFile(join(ready.workspace.root, "lorebook/character/inspiration-938a0ab4-219c-404a-84ff-5414543edb2f/index.md"),
            "---\ntitle: 程杰\next:\n  inspiration:\n    artifactId: 938a0ab4-219c-404a-84ff-5414543edb2f\n---\n\n角色正文", "utf8");
        const referencePaths = ["lorebook/character/程杰/"];
        const byDirectory = await readReadyAssistantFiles(ready, {paths: ["lorebook/character/inspiration-938a0ab4-219c-404a-84ff-5414543edb2f/"], referencePaths});
        const byTitle = await readReadyAssistantFiles(ready, {paths: ["lorebook/character/程杰/"], referencePaths});
        expect(byDirectory.get("lorebook/character/inspiration-938a0ab4-219c-404a-84ff-5414543edb2f/")).toContain("角色正文");
        expect(byTitle.get("lorebook/character/程杰/")).toBe("---\ntitle: 程杰\next:\n  inspiration:\n    artifactId: 938a0ab4-219c-404a-84ff-5414543edb2f\n---\n\n角色正文");
        const missing = await readReadyAssistantFiles(ready, {paths: ["lorebook/character/不存在/"], referencePaths: ["lorebook/character/不存在/"]});
        expect(missing).toHaveLength(0);
        const listing = await listReadyAssistantFiles(ready, {referencePaths});
        expect(listing.references).toEqual([{path: referencePaths[0], readable: true}]);
    });
});
