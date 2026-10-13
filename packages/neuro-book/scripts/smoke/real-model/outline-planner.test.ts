/**
 * 真实模型大纲规划 smoke：内置 outline.planner Profile + 全部内置工具定义 + 真实 provider。
 *
 * 覆盖两类只有真实 provider 才会暴露的问题：函数参数 schema 被 provider 拒绝（每轮 400），
 * 以及 discuss 模式下写入必须停在审批而不是直接执行。
 * 缺 `DEEPSEEK_API_KEY` 时整组 skip（证据中记为「未验证」，不得写成通过）。
 * 运行入口：`bun run test:real-model`。
 */

import {mkdir, rm, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import {createAgentSmokeHarness, resolveAgentSmokeModelSetup, type AgentSmokeHarness} from "nbook/scripts/smoke/agent";
import {absoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {closeAllProjects, openProject} from "nbook/server/workspace-files/project-session";
import {projectWorkspaceRef} from "nbook/server/workspace-files/project-identity";
import {openProjectPlanning} from "nbook/server/outline/host";
import type {StoredToolResultMessage} from "nbook/server/agent/messages/stored-types";
import outlinePlannerProfile from "nbook/assets/workspace/.nbook/agent/profiles/builtin/outline.planner.profile";
import {normalizeAgentProfile} from "nbook/server/agent/profiles/define-agent-profile";
import {resolveRealModelCredentials, writeRealModelGlobalConfig} from "./support";

const credentials = resolveRealModelCredentials();

describe.skipIf(!credentials)("真实模型：大纲规划 Agent", () => {
    let root: string;
    let harness: AgentSmokeHarness | undefined;

    beforeAll(async () => {
        await writeRealModelGlobalConfig(credentials!);
        root = await createTestTmpRoot("real-model", "outline-planner");
        await mkdir(join(root, "novel"), {recursive: true});
        await writeFile(join(root, "novel", "project.yaml"), "kind: novel\ntitle: novel\nsummary: ''\n", "utf8");
        await openProject(projectWorkspaceRef("novel"), {kind: "job", source: "real-model-outline-planner"}, absoluteFsPath(root));
        await openProjectPlanning(projectWorkspaceRef("novel"));
        harness = await createAgentSmokeHarness(root, resolveAgentSmokeModelSetup());
        // 隔离 workspace 没有投影编译好的 system Profile；直接注册源码定义，保证验证的是当前提示词与工具集。
        harness.profiles.register(normalizeAgentProfile(outlinePlannerProfile));
    });

    afterAll(async () => {
        await closeAllProjects();
        await harness?.dispose();
        if (root) await rm(root, {recursive: true, force: true});
    });

    it("discuss 模式下读取、预览后停在审批，批准后创建方案及其总纲", async () => {
        const setup = resolveAgentSmokeModelSetup();
        const created = await harness!.createAgent({
            profileKey: "outline.planner",
            currentProjectRoot: "novel",
            initial: {
                projectRoot: "novel",
                scope: {includeAnalysis: true},
                mode: "discuss",
                model: `${setup.model.provider}/${setup.model.id}`,
                temperature: 0.2,
                thinking: "off",
            },
        });
        await harness!.runCommand(created.sessionId, {command: "mode", mode: "discuss"});

        const waiting = await harness!.invokeAgent({
            sessionId: created.sessionId,
            mode: "prompt",
            message: {text: [
                "这是一次自动化验收，请严格按顺序调用工具，不要追问：",
                "1. 调用 get_planning_context 读取当前规划；",
                "2. 调用 get_foreshadowing_context，参数 {\"foreshadowingId\":\"fo-smoke\"}（伏笔不存在时报错也继续）；",
                "3. 调用 preview_planning_change 预览创建方案：operation 为 mutate，expectedRevision 用第 1 步读到的 revision，action 为 create-plan，标题“主方案”（创建方案会同时创建该方案的空总纲）；",
                "4. 调用 apply_planning_change 应用第 3 步的预览（带上 proposalId）。",
            ].join("\n")},
        });
        expect(waiting.error ?? null).toBeNull();
        expect(waiting.status).toBe("waiting");

        const recovery = await harness!.getSessionRecovery(created.sessionId);
        const pending = recovery.pendingUserInputs.find((input) => input.toolName === "apply_planning_change");
        expect(pending).toBeDefined();
        expect((await openProjectPlanning(projectWorkspaceRef("novel"))).entries).toHaveLength(0);

        const completed = await harness!.invokeAgent({
            sessionId: created.sessionId,
            mode: "continue",
            resolution: {kind: "tool_approval", toolCallId: pending!.toolCallId, approved: true, resultText: "批准规划变更"},
        });
        expect(completed.error ?? null).toBeNull();
        expect(completed.status).toBe("completed");

        const context = harness!.repo.reduce(await harness!.repo.readSession(created.sessionId));
        const toolNames = context.messages
            .filter((message): message is StoredToolResultMessage => message.role === "toolResult")
            .map((message) => message.toolName);
        expect(toolNames).toEqual(expect.arrayContaining([
            "get_planning_context",
            "get_foreshadowing_context",
            "preview_planning_change",
            "apply_planning_change",
        ]));
        const snapshot = await openProjectPlanning(projectWorkspaceRef("novel"));
        expect(snapshot.manifest.plans.map((plan) => plan.title)).toEqual(["主方案"]);
        expect(snapshot.entries.map((entry) => entry.value.title)).toContain("主方案·总纲");
    }, 300_000);
});
