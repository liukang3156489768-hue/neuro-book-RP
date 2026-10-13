import fs from "node:fs/promises";
import path from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import {absoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {closeAllProjects, closeProject, openProject, requireReadyModuleHandle} from "nbook/server/workspace-files/project-session";
import {projectWorkspaceRef} from "nbook/server/workspace-files/project-identity";
import {PROJECT_HISTORY_MODULE_TOKEN} from "nbook/server/workspace-history/project-history";
import {openProjectPlanning, applyReadyLibraryAction, applyReadyLineAction, inspectReadyLine,
    publishReadyPlanningFiles, repairReadyMissingEntry, undoProjectPlanning} from "./host";
import {publishMissingEntryRepairFiles, publishPlanningFiles, readLineInspectionSnapshot, readPlanningSnapshot,
    type PlanningSnapshot} from "./index";
import {analyzeLine, confirmLine} from "./line-analysis";
import {findPlanGraph, type LineAction} from "./line-planning";
import {prepareMissingEntryRepair} from "./line-repair";
import {recoverOutlineTransactions} from "./transaction";
import {contentHash, type OutlineId} from "./format";

const actor = {kind: "user", userId: "local"} as const;
const roots: string[] = [];
afterEach(async () => {
    await closeAllProjects();
    for (const root of roots.splice(0)) await fs.rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 50});
});

type GraphActionInput<K extends LineAction["kind"]> = Omit<Extract<LineAction, {kind: K}>, "kind" | "planId" | "expectedGraphVersion">;

/** 总纲 → 丢失章节 的草稿主线；另建一个保留章节供其他线路引用，最后删除丢失章节的规范文件。 */
async function fixture() {
    const root = await createTestTmpRoot("outline-line-repair", "missing-entry-repair");
    roots.push(root);
    const workspaceRoot = absoluteFsPath(path.join(root, "workspace"));
    const projectRoot = path.join(workspaceRoot, "novel");
    await fs.mkdir(projectRoot, {recursive: true});
    await fs.writeFile(path.join(projectRoot, "project.yaml"), "kind: novel\ntitle: novel\nsummary: ''\n", "utf8");
    const ref = projectWorkspaceRef("novel");
    const ready = await openProject(ref, {kind: "job", source: "outline-line-repair"}, workspaceRoot);
    let snapshot = await openProjectPlanning(ref);
    const library = async (action: Parameters<typeof applyReadyLibraryAction>[1]) => {
        const result = await applyReadyLibraryAction(ready, action, snapshot.manifest.revision, actor);
        snapshot = await openProjectPlanning(ref);
        return result;
    };
    const created = await library({kind: "create-plan", title: "方案"});
    const plan = created.planId!;
    const total = created.entryId!;
    const lost = (await library({kind: "create-entry", planId: plan, parentId: total,
        entryKind: "chapter", title: "丢失章节", body: "旧内容"})).entryId!;
    const kept = (await library({kind: "create-entry", planId: plan, parentId: total,
        entryKind: "chapter", title: "保留章节", body: "新内容"})).entryId!;
    const lineAction = async (action: LineAction) => {
        const result = await applyReadyLineAction(ready, action, snapshot.manifest.revision, actor);
        snapshot = await openProjectPlanning(ref);
        return result;
    };
    // 测试用例会在 fixture 之外改动规划，图操作每次都从当前规范快照取 revision 与图版本。
    const graph = async <K extends LineAction["kind"]>(kind: K, input: GraphActionInput<K>) => {
        snapshot = await openProjectPlanning(ref);
        return lineAction({kind, planId: plan, expectedGraphVersion: findPlanGraph(snapshot, plan)?.value.version ?? 0,
            ...input} as unknown as LineAction);
    };
    const first = (await graph("add-graph-node", {column: 0, row: 0, entryId: total})).nodeId!;
    const last = (await graph("add-graph-node", {column: 1, row: 0, entryId: lost})).nodeId!;
    await graph("connect-graph-nodes", {from: first, to: last});
    const lineId = (await lineAction({kind: "create-line", planId: plan, title: "章节线", type: "main",
        nodeIds: [first, last]})).lineId!;
    const old = snapshot.entries.find(({value}) => value.id === lost)!;
    const oldBytes = await fs.readFile(path.join(projectRoot, old.path), "utf8");
    await fs.unlink(path.join(projectRoot, old.path));
    const line = snapshot.lines.find(({value}) => value.id === lineId)!;
    const graphSource = findPlanGraph(snapshot, plan)!;
    const input = {missingEntryId: lost, expectedRevision: snapshot.manifest.revision,
        expectedMissingHash: old.contentHash, confirmRepair: true as const};
    return {ref, ready, workspaceRoot, projectRoot, old, oldBytes, snapshot, line, graph: graphSource, input,
        plan, total, first, last, kept, lineAction: graph};
}

describe("缺失条目红色节点修复", () => {
    it("修复后引用节点变为空节点且严格读取、重开保持；原文件缺失时撤销冲突，按原 hash 恢复才允许撤销", async () => {
        const {ref, ready, workspaceRoot, projectRoot, old, oldBytes, snapshot, line, graph, input, last} = await fixture();
        await expect(readPlanningSnapshot({projectRoot})).rejects.toThrow(/manifest 引用文件不存在/);
        expect((await inspectReadyLine(ready, line.value.id)).nodes.find(({nodeId}) => nodeId === last)?.status).toBe("red");
        const receipt = await repairReadyMissingEntry(ready, input, actor);
        let current = await openProjectPlanning(ref);
        expect(current.manifest.entries.some(({id}) => id === input.missingEntryId)).toBe(false);
        expect(current.manifest.plans.some(({placements}) => placements.some(({entryId}) => entryId === input.missingEntryId)))
            .toBe(false);
        const updatedGraph = current.graphs.find(({value}) => value.id === graph.value.id)!;
        expect(updatedGraph.value).toMatchObject({version: graph.value.version + 1, edges: graph.value.edges});
        expect(updatedGraph.value.nodes).toEqual(graph.value.nodes.map((node) => node.id === last ? {...node, entryId: null} : node));
        // 草稿线路没有可失效的分析，节点改为空节点后线路文件保持原样。
        expect(current.lines.find(({value}) => value.id === line.value.id)?.contentHash).toBe(line.contentHash);
        expect((await inspectReadyLine(ready, line.value.id)).nodes.find(({nodeId}) => nodeId === last)?.status).toBe("empty");
        const history = await requireReadyModuleHandle(ready, PROJECT_HISTORY_MODULE_TOKEN).history;
        expect((await history!.timeline(graph.path)).at(-1)?.entry.actor).toEqual(actor);
        await closeProject(ref, "shutdown");
        await openProject(ref, {kind: "job", source: "outline-repair-reopen"}, workspaceRoot);
        current = await openProjectPlanning(ref);
        expect(current.manifest.revision).toBe(snapshot.manifest.revision + 1);
        await expect(undoProjectPlanning(ref, receipt.transactionId, actor)).rejects.toMatchObject({code: "CAS_CONFLICT"});
        expect((await openProjectPlanning(ref)).manifest.revision).toBe(current.manifest.revision);
        await fs.writeFile(path.join(projectRoot, old.path), "not the original", "utf8");
        await expect(undoProjectPlanning(ref, receipt.transactionId, actor)).rejects.toMatchObject({code: "CAS_CONFLICT"});
        await fs.writeFile(path.join(projectRoot, old.path), oldBytes, "utf8");
        expect(await undoProjectPlanning(ref, receipt.transactionId, actor)).toMatchObject({kind: "undone"});
        const restored = await openProjectPlanning(ref);
        expect(restored.manifest.revision).toBe(snapshot.manifest.revision);
        expect(restored.graphs.find(({value}) => value.id === graph.value.id)?.value.nodes.find(({id}) => id === last)?.entryId)
            .toBe(input.missingEntryId);
        expect(contentHash(oldBytes)).toBe(old.contentHash);
    }, 30_000);

    it("缺失条目修复同时撤回所属方案的全部固定线路及其旧报告，包括不引用丢失条目的线路", async () => {
        const {ref, ready, projectRoot, old, oldBytes, input, line, plan, total, first, last, kept, lineAction} = await fixture();
        await fs.writeFile(path.join(projectRoot, old.path), oldBytes, "utf8");
        let snapshot: PlanningSnapshot = await openProjectPlanning(ref);
        const adopt = async (entryId: OutlineId) => {
            const entry = snapshot.entries.find(({value}) => value.id === entryId)!;
            await applyReadyLibraryAction(ready, {kind: "adopt-entry", planId: plan, entryId: entry.value.id,
                expectedVersion: entry.value.version, expectedContentHash: entry.contentHash}, snapshot.manifest.revision, actor);
            snapshot = await openProjectPlanning(ref);
        };
        for (const entryId of [total, input.missingEntryId, kept]) await adopt(entryId);
        const keptNode = (await lineAction("add-graph-node", {column: 1, row: 1, entryId: kept})).nodeId!;
        await lineAction("connect-graph-nodes", {from: first, to: keptNode});
        snapshot = await openProjectPlanning(ref);
        const second = await applyReadyLineAction(ready, {kind: "create-line", planId: plan, title: "不引用丢失章节的支线",
            type: "branch", nodeIds: [first, keptNode]}, snapshot.manifest.revision, actor);
        snapshot = await openProjectPlanning(ref);
        const fix = async (lineId: OutlineId) => {
            const source = snapshot.lines.find(({value}) => value.id === lineId)!;
            const request = {lineId: source.value.id, expectedRevision: snapshot.manifest.revision,
                expectedVersion: source.value.version, expectedContentHash: source.contentHash};
            const report = await analyzeLine(snapshot, request, async () => JSON.stringify({summary: "审阅通过", conflicts: []}));
            await publishPlanningFiles({projectRoot}, confirmLine(snapshot, request, report, report.report.reportId, []));
            snapshot = await openProjectPlanning(ref);
        };
        await fix(line.value.id);
        await fix(second.lineId!);
        const fixed = snapshot.lines.find(({value}) => value.id === line.value.id)!;
        const otherFixed = snapshot.lines.find(({value}) => value.id === second.lineId)!;
        expect(fixed.value.fixed).toBe(true);
        expect(otherFixed.value.fixed).toBe(true);
        await fs.unlink(path.join(projectRoot, old.path));
        await repairReadyMissingEntry(ready, {...input, expectedRevision: snapshot.manifest.revision,
            expectedMissingHash: snapshot.entries.find(({value}) => value.id === input.missingEntryId)!.contentHash}, actor);
        const updated = await openProjectPlanning(ref);
        const firstLine = updated.lines.find(({value}) => value.id === fixed.value.id)!;
        const other = updated.lines.find(({value}) => value.id === otherFixed.value.id)!;
        expect(firstLine.value).toMatchObject({fixed: false, version: fixed.value.version + 1, nodeIds: fixed.value.nodeIds});
        expect(other.value).toMatchObject({fixed: false, version: otherFixed.value.version + 1, nodeIds: otherFixed.value.nodeIds});
        expect(firstLine.value.analysis).toBeUndefined();
        expect(other.value.analysis).toBeUndefined();
        expect(findPlanGraph(updated, plan)?.value.nodes.find(({id}) => id === last)?.entryId).toBeNull();
    }, 45_000);

    it("发布过程中原缺失文件被外部恢复时回滚全部修复，并保留外部恢复的文件", async () => {
        const {projectRoot, old, oldBytes, input, snapshot, graph} = await fixture();
        const options = {projectRoot, beforePublishFile: async (relativePath: string) => {
            if (relativePath === "outline/manifest.yaml") await fs.writeFile(path.join(projectRoot, old.path), oldBytes, "utf8");
        }};
        const diagnostic = await readLineInspectionSnapshot({projectRoot});
        const publish = prepareMissingEntryRepair(diagnostic, input);
        expect(publish.mutations.map(({relativePath}) => relativePath)).toContain(graph.path);
        const manifestBytes = await fs.readFile(path.join(projectRoot, "outline/manifest.yaml"), "utf8");
        const graphBytes = await fs.readFile(path.join(projectRoot, graph.path), "utf8");
        await expect(publishMissingEntryRepairFiles(options, publish, snapshot.manifest.entries.find(({id}) => id === input.missingEntryId)!))
            .rejects.toMatchObject({code: "CAS_CONFLICT"});
        expect(await fs.readFile(path.join(projectRoot, old.path), "utf8")).toBe(oldBytes);
        expect(await fs.readFile(path.join(projectRoot, "outline/manifest.yaml"), "utf8")).toBe(manifestBytes);
        expect(await fs.readFile(path.join(projectRoot, graph.path), "utf8")).toBe(graphBytes);
        await recoverOutlineTransactions(projectRoot);
        expect((await readPlanningSnapshot({projectRoot})).manifest.revision).toBe(snapshot.manifest.revision);
    }, 30_000);

    it("过期版本、未确认和普通发布均不能绕过缺失引用", async () => {
        const {ref, ready, projectRoot, snapshot, graph, input, old, oldBytes} = await fixture();
        const manifestPath = path.join(projectRoot, "outline/manifest.yaml");
        const originalManifest = await fs.readFile(manifestPath, "utf8");
        await expect(publishReadyPlanningFiles(ready, {expectedManifestRevision: snapshot.manifest.revision,
            mutations: [{relativePath: "outline/manifest.yaml", content: originalManifest}]}, actor)).rejects.toThrow(/不存在/);
        await expect(repairReadyMissingEntry(ready, {...input, confirmRepair: false as never}, actor)).rejects.toThrow(/确认/);
        await expect(repairReadyMissingEntry(ready, {...input, expectedRevision: input.expectedRevision - 1}, actor))
            .rejects.toMatchObject({code: "CAS_CONFLICT"});
        await expect(repairReadyMissingEntry(ready, {...input, expectedMissingHash: contentHash("wrong")}, actor))
            .rejects.toMatchObject({code: "CAS_CONFLICT"});
        expect(await fs.readFile(manifestPath, "utf8")).toBe(originalManifest);
        expect(await fs.readFile(path.join(projectRoot, graph.path), "utf8")).toContain(input.missingEntryId);
        await fs.writeFile(path.join(projectRoot, old.path), oldBytes, "utf8");
        await expect(repairReadyMissingEntry(ready, input, actor)).rejects.toMatchObject({code: "CAS_CONFLICT"});
        expect((await openProjectPlanning(ref)).manifest.revision).toBe(snapshot.manifest.revision);
    }, 30_000);
});
