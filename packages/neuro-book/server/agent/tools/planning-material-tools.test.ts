import fs from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {createPlanningMaterialTools} from "./planning-material-tools";
import {absoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {testHostPath} from "@notnotype/neuro-book-test-support/test-path";
import {projectWorkspaceRef} from "nbook/server/workspace-files/project-identity";
import {writeProjectManifest} from "nbook/server/workspace-files/project-workspace";
import {closeAllProjects, openProject, resetProjectSessionsForTest} from "nbook/server/workspace-files/project-session";
import {applyReadyLibraryAction, openReadyPlanning} from "nbook/server/outline/host";
import type {ReadyProjectSessionRef} from "nbook/server/workspace-files/project-session-types";
import type {ToolExecutionContext} from "./types";

const tools = new Map(createPlanningMaterialTools().map(tool => [tool.key, tool]));
const list = tools.get("list_planning_materials")!;
const read = tools.get("read_planning_material")!;
const inspect = tools.get("inspect_planning_material_requirements")!;

describe("规划素材发现与分页读取", () => {
    let root: string;
    let ready: ReadyProjectSessionRef;
    let context: ToolExecutionContext;
    let planId: string;

    async function write(file: string, content: string) {
        const target = path.join(ready.workspace.root, file);
        await fs.mkdir(path.dirname(target), {recursive: true});
        await fs.writeFile(target, content);
    }

    beforeEach(async () => {
        resetProjectSessionsForTest();
        root = testHostPath(`neuro-book-planning-material-${randomUUID()}`);
        const workspaceRoot = absoluteFsPath(path.join(root, "workspace"));
        await fs.mkdir(workspaceRoot, {recursive: true});
        const ref = projectWorkspaceRef("material-plan");
        await writeProjectManifest(workspaceRoot, ref, {kind: "novel", title: "素材规划", summary: ""});
        ready = await openProject(ref, {kind: "job", source: "planning-material-test"}, workspaceRoot);
        await openReadyPlanning(ready);
        planId = (await applyReadyLibraryAction(ready, {kind: "create-plan", title: "改编方案"}, 0, {kind: "user", userId: "local"})).planId!;
        context = {sessionId: 801, profileKey: "outline.planner", workspaceRoot, currentProject: ready, agentMode: "discuss"} as ToolExecutionContext;
        await write("lorebook/character/甲/index.md", "---\ntitle: 甲\norigin: extract\n---\n基础人设正文");
        await write("lorebook/character/乙/index.md", "另一个角色正文");
        await write("lorebook/character/甲/original/experience.md", "原作经历正文");
        await write("lorebook/character/甲/original/relationships.md", "原作关系正文");
        await write(`lorebook/character/甲/plans/${planId}/experience.md`, "方案新经历");
        await write("lorebook/note/写作手法索引.md", "---\ntitle: 写作手法索引\n---\n[信息差](./写作手法/信息差/index.md)");
        await write("lorebook/note/写作手法/信息差/index.md", "信息差正文应按选择读取");
    });

    afterEach(async () => {
        await closeAllProjects();
        resetProjectSessionsForTest();
        await fs.rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
    });

    it("概览分页只暴露对象和索引路径，相关原作与当前方案记录不加载正文", async () => {
        const first = await list.executeWithContext!(context, "list", {category: "character", planId, limit: 1});
        const page = JSON.parse(first.content[0]!.type === "text" ? first.content[0]!.text : "{}");
        expect(page.items).toHaveLength(1);
        expect(page.total).toBe(2);
        expect(page.nextOffset).toBe(1);
        expect(page.items[0].related).toHaveLength(page.items[0].name === "甲" ? 3 : 0);
        expect(JSON.stringify(page)).not.toContain("正文");
        expect(page.indexes).toEqual(["lorebook/note/写作手法索引.md"]);
        expect(page.missingIndexes).toContain("lorebook/note/写作素材索引.md");
        const notes = await list.executeWithContext!(context, "notes", {category: "note"});
        expect(JSON.stringify(notes)).not.toContain("信息差正文");
    });

    it("按索引选择正文，字符分页可完整恢复长行且不重复返回frontmatter", async () => {
        const index = await read.executeWithContext!(context, "index", {path: "lorebook/note/写作手法索引.md"});
        expect(JSON.stringify(index)).toContain("信息差/index.md");
        const file = "lorebook/note/写作手法/信息差/index.md";
        const body = "长行内容".repeat(7000);
        await write(file, `---\ntitle: 信息差\n---\n${body}`);
        let offset = 0;
        let collected = "";
        do {
            const output = await read.executeWithContext!(context, "read", {path: file, offset, limit: 12000});
            const page = JSON.parse(output.content[0]!.type === "text" ? output.content[0]!.text : "{}");
            expect(page.body.length).toBeLessThanOrEqual(12000);
            collected += page.body;
            if (page.nextOffset === null) break;
            expect(page.complete).toBe(false);
            offset = page.nextOffset;
        } while (true);
        expect(collected.trim()).toBe(body);
    });

    it("拒绝跨方案读取和越界，改编记录必须带真实存在的方案", async () => {
        const file = `lorebook/character/甲/plans/${planId}/experience.md`;
        await expect(read.executeWithContext!(context, "read", {path: file})).rejects.toThrow("planId");
        await expect(read.executeWithContext!(context, "read", {path: file, planId: "plan-other"})).rejects.toThrow("planId");
        await expect(list.executeWithContext!(context, "list", {planId: "plan-other"})).rejects.toThrow("不存在");
        await expect(read.executeWithContext!(context, "read", {path: "lorebook/note/../../../outside.md"})).rejects.toThrow("路径无效");
        await expect(read.executeWithContext!(context, "read", {path: "outline/manifest.yaml"})).rejects.toThrow("lorebook");
        expect(JSON.stringify(await read.executeWithContext!(context, "read", {path: file, planId}))).toContain("方案新经历");
    });

    it("只返回素材类别存在性，不读取正文", async () => {
        const output = await inspect.executeWithContext!(context, "inspect", {});
        const result = JSON.parse(output.content[0]!.type === "text" ? output.content[0]!.text : "{}");
        expect(result.materials.character.exists).toBe(true);
        expect(result.materials.item.exists).toBe(false);
        expect(result.materials.location.exists).toBe(false);
        expect(result.extractionPlans).toEqual([]);
        expect(JSON.stringify(result)).not.toContain("基础人设正文");
    });
});
