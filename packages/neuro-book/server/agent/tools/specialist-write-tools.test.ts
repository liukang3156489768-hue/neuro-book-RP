import {randomUUID} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {testHostPath} from "@notnotype/neuro-book-test-support/test-path";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {Value} from "typebox/value";
import {absoluteFsPath, type AbsoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {closeAllProjects, openProject, resetProjectSessionsForTest} from "nbook/server/workspace-files/project-session";
import {projectWorkspaceRef} from "nbook/server/workspace-files/project-identity";
import {writeProjectManifest} from "nbook/server/workspace-files/project-workspace";
import type {ReadyProjectSessionRef} from "nbook/server/workspace-files/project-session-types";
import {createSpecialistPlanningTools, planningProposalId} from "nbook/server/agent/tools/planning-tools";
import {createLorebookFileTools} from "nbook/server/agent/tools/lorebook-file-tools";
import {withPlanningWriteGrant} from "nbook/server/agent/tools/planning-delegation";

const hash = "sha256:" + "a".repeat(64);
const [commit] = createSpecialistPlanningTools();
const [writeLorebook, editLorebook] = createLorebookFileTools();

function mutation(action: Record<string, unknown>) {
    const change = {operation: "mutate", expectedRevision: 0, action};
    return {...change, proposalId: planningProposalId(change)};
}

describe("commit_planning_change", () => {
    const ctx = (profileKey: string) => ({sessionId: 501, profileKey, currentProject: {workspace: {root: "C:/p"}}}) as never;

    it("只接受带 proposalId 的变更，schema 不接受删除", () => {
        expect(commit).toMatchObject({key: "commit_planning_change", mutatesWorkspace: true, executionMode: "sequential"});
        expect(Value.Check(commit!.parameters, {changes: [mutation({kind: "create-plan", title: "方案"})]})).toBe(true);
        expect(Value.Check(commit!.parameters, {changes: [{operation: "delete-plan", planId: "plan-a", expectedRevision: 0, confirmed: true, proposalId: "x"}]})).toBe(false);
    });

    it("非专家 Profile 与未获委派的专家均被拒绝", async () => {
        const input = {changes: [mutation({kind: "create-plan", title: "方案"})]};
        await expect(commit!.executeWithContext!(ctx("outline.planner"), "c", input)).rejects.toThrow("只供规划专家使用");
        await expect(commit!.executeWithContext!(ctx("outline.detailed"), "c", input)).rejects.toThrow("没有规划写入委派");
    });

    it("委派期间仍拒绝线路操作，交回规划助手", async () => {
        const input = {changes: [mutation({kind: "remove-graph-node", planId: "plan-a", expectedGraphVersion: 0,
            nodeId: "nd-a", expectedImpactHash: hash, confirmDeletion: true})]};
        await withPlanningWriteGrant(501, async () => {
            await expect(commit!.executeWithContext!(ctx("outline.outline"), "c", input)).rejects.toThrow("交回规划助手审核");
        });
    });
});

describe("write_lorebook / edit_lorebook", () => {
    let root: string;
    let workspaceRoot: AbsoluteFsPath;
    let ready: ReadyProjectSessionRef;
    const ref = projectWorkspaceRef("lorebook-scope");
    const ctx = () => ({sessionId: 601, profileKey: "outline.foreshadowing", workspaceRoot, currentProject: ready}) as never;

    beforeEach(async () => {
        resetProjectSessionsForTest();
        root = testHostPath(`neuro-book-lorebook-tools-${randomUUID()}`);
        workspaceRoot = absoluteFsPath(path.join(root, "workspace"));
        await fs.mkdir(workspaceRoot, {recursive: true});
        await writeProjectManifest(workspaceRoot, ref, {kind: "novel", title: "素材写入", summary: ""});
        ready = await openProject(ref, {kind: "job", source: "lorebook-tool-test"}, workspaceRoot);
        await fs.mkdir(path.join(ready.workspace.root, "outline"), {recursive: true});
        await fs.writeFile(path.join(ready.workspace.root, "outline", "manifest.yaml"), "original", "utf8");
    });

    afterEach(async () => {
        await closeAllProjects();
        resetProjectSessionsForTest();
        await fs.rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
    });

    it("未获委派时拒绝写入 lorebook", async () => {
        await expect(writeLorebook!.executeWithContext!(ctx(), "w", {path: "lorebook/item/key.md", content: "钥匙"}))
            .rejects.toThrow("没有规划写入委派");
        await expect(fs.stat(path.join(ready.workspace.root, "lorebook/item/key.md"))).rejects.toThrow();
    });

    it("委派期间可写入和编辑 lorebook Markdown，但不能写规划规范文件、正文或其他扩展名", async () => {
        await withPlanningWriteGrant(601, async () => {
            await writeLorebook!.executeWithContext!(ctx(), "w1", {path: "lorebook/item/key.md", content: "银色钥匙"});
            await editLorebook!.executeWithContext!(ctx(), "e1", {path: "lorebook/item/key.md", edits: [{oldText: "银色", newText: "铜色"}]});
            for (const target of ["outline/manifest.yaml", "manuscript/001/index.md", "lorebook/item/key.yaml", "../escape.md"]) {
                await expect(writeLorebook!.executeWithContext!(ctx(), "w2", {path: target, content: "x"})).rejects.toThrow();
            }
        });
        await expect(fs.readFile(path.join(ready.workspace.root, "lorebook/item/key.md"), "utf8")).resolves.toBe("铜色钥匙");
        await expect(fs.readFile(path.join(ready.workspace.root, "outline/manifest.yaml"), "utf8")).resolves.toBe("original");
        await expect(fs.stat(path.join(ready.workspace.root, "manuscript"))).rejects.toThrow();
    });
});
