import {mkdir, rm, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {fauxAssistantMessage, fauxText, fauxToolCall} from "@earendil-works/pi-ai";
import {Type} from "typebox";
import {afterEach, describe, expect, it} from "vitest";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import {absoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {closeAllProjects, openProject} from "nbook/server/workspace-files/project-session";
import {projectWorkspaceRef} from "nbook/server/workspace-files/project-identity";
import {JsonlSessionRepository} from "nbook/server/agent/session/session-repo";
import type {StoredToolResultMessage} from "nbook/server/agent/messages/stored-types";
import {NeuroAgentHarness} from "nbook/server/agent/harness/neuro-agent-harness";
import {AgentProfileCatalog} from "nbook/server/agent/profiles/catalog";
import {defineAgentProfile} from "nbook/server/agent/profiles/define-agent-profile";
import {profileToolsFromKeys} from "nbook/server/agent/test/profile-tools";
import {createFauxModels, writeFauxProviderConfig, type FauxModelsFixture} from "nbook/server/agent/test-utils/faux-models";
import {createVariableDefinitionArtifactPathContextResolver} from "nbook/server/agent/variables/definition-artifact";
import {resolveProfileArtifactPathContext} from "nbook/server/agent/profiles/profile-artifact-compiler";
import {createPlanningTools, OUTLINE_AGENT_TOOL_KEYS, planningProposalId} from "nbook/server/agent/tools/planning-tools";
import {openProjectPlanning} from "nbook/server/outline/host";

const PROFILE_KEY = "test.outline-planner-session";

function registerPlanningProfile(harness: NeuroAgentHarness): void {
    for (const tool of createPlanningTools()) harness.tools.register(tool);
    harness.profiles.register(defineAgentProfile({
        manifest: {key: PROFILE_KEY, name: "规划会话回归"},
        initialSchema: Type.Object({
            projectRoot: Type.String({minLength: 1}),
            scope: Type.Object({}, {additionalProperties: false}),
            mode: Type.Union([Type.Literal("discuss"), Type.Literal("auto")]),
            model: Type.String({minLength: 1}),
            temperature: Type.Number(),
            thinking: Type.Union([Type.Literal("off"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
        }),
        tools: profileToolsFromKeys(OUTLINE_AGENT_TOOL_KEYS),
        prepare() {
            return {};
        },
    }), false);
}

describe("outline planner faux Agent Session contract", () => {
    let root: string;
    let faux: FauxModelsFixture;
    let harness: NeuroAgentHarness;

    afterEach(async () => {
        await closeAllProjects();
        if (harness) await harness.dispose();
        if (root) await rm(root, {recursive: true, force: true});
    });


    async function prepareWaitingApply(options: {continuationResponse: boolean}): Promise<{sessionId: number; projectRoot: string}> {
        root = await createTestTmpRoot("outline-planner-session", "faux-agent-session-rejection");
        const projectRoot = join(root, "novel");
        await mkdir(projectRoot, {recursive: true});
        await writeFile(join(projectRoot, "project.yaml"), "kind: novel\ntitle: novel\nsummary: ''\n", "utf8");
        await openProject(projectWorkspaceRef("novel"), {kind: "job", source: "outline-planner-session-test"}, absoluteFsPath(root));
        await openProjectPlanning(projectWorkspaceRef("novel"));

        faux = createFauxModels({models: [{id: "outline-planner-faux", contextWindow: 128_000, maxTokens: 8_000}]});
        await writeFauxProviderConfig(root, faux);
        harness = new NeuroAgentHarness({
            repo: new JsonlSessionRepository(root),
            profiles: new AgentProfileCatalog(
                join(root, "profiles-system"),
                undefined,
                undefined,
                undefined,
                (profileRoot, rootLabel) => resolveProfileArtifactPathContext(profileRoot, rootLabel, root),
                {install: "workspace/.nbook/agent/profiles"},
            ),
            modelResolver: () => faux.getModel(),
            runtimeResolver: () => faux.runtime,
            definitionArtifactPathContextProvider: createVariableDefinitionArtifactPathContextResolver(root),
            enableSessionSummarizer: false,
        });
        registerPlanningProfile(harness);

        const action = {kind: "create-total" as const, title: "总纲", body: "主角必须在第一卷完成第一次选择。"};
        const proposalId = planningProposalId({operation: "mutate", expectedRevision: 0, action});
        faux.setResponses([
            fauxAssistantMessage([fauxToolCall("get_planning_context", {}, {id: "context-1"})], {stopReason: "toolUse"}),
            fauxAssistantMessage([fauxToolCall("preview_planning_change", {operation: "mutate", expectedRevision: 0, action}, {id: "preview-1"})], {stopReason: "toolUse"}),
            fauxAssistantMessage([fauxToolCall("apply_planning_change", {
                changes: [{operation: "mutate", expectedRevision: 0, action, proposalId}],
            }, {id: "apply-1"})], {stopReason: "toolUse"}),
            ...(options.continuationResponse ? [fauxAssistantMessage(fauxText("已按用户决定停止规划变更。"))] : []),
        ]);

        const created = await harness.createAgent({
            profileKey: PROFILE_KEY,
            currentProjectRoot: "novel",
            initial: {
                projectRoot: "novel",
                scope: {},
                mode: "discuss",
                model: "outline-planner-faux",
                temperature: 0.2,
                thinking: "off",
            },
        });
        // 与工作台一致：initial.mode 只进入提示词，审批门禁由 harness 运行模式决定。
        await harness.runCommand(created.sessionId, {command: "mode", mode: "discuss"});
        const waiting = await harness.invokeAgent({
            sessionId: created.sessionId,
            mode: "prompt",
            message: {text: "请创建总纲"},
        });
        expect(waiting.status).toBe("waiting");
        return {sessionId: created.sessionId, projectRoot};
    }

    it("读取、预览和审批执行规划变更，并把流式事件与审计结果落入 Session", async () => {
        root = await createTestTmpRoot("outline-planner-session", "faux-agent-session");
        const projectRoot = join(root, "novel");
        await mkdir(projectRoot, {recursive: true});
        await writeFile(join(projectRoot, "project.yaml"), "kind: novel\ntitle: novel\nsummary: ''\n", "utf8");
        await openProject(projectWorkspaceRef("novel"), {kind: "job", source: "outline-planner-session-test"}, absoluteFsPath(root));
        await openProjectPlanning(projectWorkspaceRef("novel"));

        faux = createFauxModels({models: [{id: "outline-planner-faux", contextWindow: 128_000, maxTokens: 8_000}]});
        await writeFauxProviderConfig(root, faux);
        harness = new NeuroAgentHarness({
            repo: new JsonlSessionRepository(root),
            profiles: new AgentProfileCatalog(
                join(root, "profiles-system"),
                undefined,
                undefined,
                undefined,
                (profileRoot, rootLabel) => resolveProfileArtifactPathContext(profileRoot, rootLabel, root),
                {install: "workspace/.nbook/agent/profiles"},
            ),
            modelResolver: () => faux.getModel(),
            runtimeResolver: () => faux.runtime,
            definitionArtifactPathContextProvider: createVariableDefinitionArtifactPathContextResolver(root),
            enableSessionSummarizer: false,
        });
        registerPlanningProfile(harness);

        const action = {kind: "create-total" as const, title: "总纲", body: "主角必须在第一卷完成第一次选择。"};
        const proposalId = planningProposalId({operation: "mutate", expectedRevision: 0, action});
        faux.setResponses([
            fauxAssistantMessage([fauxToolCall("get_planning_context", {}, {id: "context-1"})], {stopReason: "toolUse"}),
            fauxAssistantMessage([fauxToolCall("preview_planning_change", {operation: "mutate", expectedRevision: 0, action}, {id: "preview-1"})], {stopReason: "toolUse"}),
            fauxAssistantMessage([fauxToolCall("apply_planning_change", {
                changes: [{operation: "mutate", expectedRevision: 0, action, proposalId}],
            }, {id: "apply-1"})], {stopReason: "toolUse"}),
            fauxAssistantMessage(fauxText("已完成规划变更。")),
        ]);

        const created = await harness.createAgent({
            profileKey: PROFILE_KEY,
            currentProjectRoot: "novel",
            initial: {
                projectRoot: "novel",
                scope: {},
                mode: "discuss",
                model: "outline-planner-faux",
                temperature: 0.2,
                thinking: "off",
            },
        });
        await harness.runCommand(created.sessionId, {command: "mode", mode: "discuss"});
        const events: string[] = [];
        const waiting = await harness.invokeAgent({
            sessionId: created.sessionId,
            mode: "prompt",
            message: {text: "请创建总纲"},
            onEvent: (event) => {
                events.push(event.type);
            },
        });
        expect(waiting.status).toBe("waiting");
        const recovery = await harness.getSessionRecovery(created.sessionId);
        expect(recovery.pendingUserInputs).toEqual([expect.objectContaining({toolCallId: "apply-1", toolName: "apply_planning_change"})]);
        expect(events).toContain("message_update");

        const completed = await harness.invokeAgent({
            sessionId: created.sessionId,
            mode: "continue",
            resolution: {
                kind: "tool_approval",
                toolCallId: "apply-1",
                approved: true,
                resultText: "批准规划变更",
            },
            onEvent: (event) => {
                events.push(event.type);
            },
        });

        expect(completed.status).toBe("completed");
        expect(events).toContain("tool_execution_start");
        expect(events).toContain("tool_execution_end");
        const snapshot = await openProjectPlanning(projectWorkspaceRef("novel"));
        expect(snapshot.entries.map((entry) => entry.value.title)).toContain("总纲");
        const context = harness.repo.reduce(await harness.repo.readSession(created.sessionId));
        const toolResults = context.messages.filter((message) => message.role === "toolResult");
        expect(toolResults.map((message) => message.toolName)).toEqual([
            "get_planning_context",
            "preview_planning_change",
            "apply_planning_change",
        ]);
        expect(toolResults[2]?.content.map((part) => part.type === "text" ? part.text : "").join(" ")).toContain("applied");
        const auditEntries = Object.entries(context.customState)
            .filter(([key]) => key.startsWith("outline.audit."))
            .map(([, value]) => value as {phase?: string; result?: string});
        expect(auditEntries).toEqual(expect.arrayContaining([
            expect.objectContaining({phase: "preview", result: "previewed"}),
            expect.objectContaining({phase: "apply", result: "applied"}),
        ]));
    }, 30_000);

    it("拒绝审批后只写入拒绝结果，不执行规划变更", async () => {
        const {sessionId} = await prepareWaitingApply({continuationResponse: true});

        const completed = await harness.invokeAgent({
            sessionId,
            mode: "continue",
            resolution: {
                kind: "tool_approval",
                toolCallId: "apply-1",
                approved: false,
                resultText: "拒绝规划变更",
            },
        });

        expect(completed.status).toBe("completed");
        const snapshot = await openProjectPlanning(projectWorkspaceRef("novel"));
        expect(snapshot.entries).toHaveLength(0);
        const context = harness.repo.reduce(await harness.repo.readSession(sessionId));
        const toolResults = context.messages.filter((message) => message.role === "toolResult");
        expect(toolResults.map((message) => message.toolName)).toEqual([
            "get_planning_context",
            "preview_planning_change",
            "apply_planning_change",
        ]);
        expect(toolResults[2]?.isError).toBe(true);
        expect(toolResults[2]?.content.map((part) => part.type === "text" ? part.text : "").join(" ")).toContain("declined");
        const auditEntries = Object.entries(context.customState)
            .filter(([key]) => key.startsWith("outline.audit."))
            .map(([, value]) => value as {phase?: string; result?: string});
        expect(auditEntries).toEqual(expect.arrayContaining([
            expect.objectContaining({phase: "preview", result: "previewed"}),
        ]));
        expect(auditEntries).not.toEqual(expect.arrayContaining([
            expect.objectContaining({phase: "apply", result: "applied"}),
        ]));
    }, 30_000);

    it("取消等待中的审批后不执行规划变更，且 Session 记录 aborted 终态", async () => {
        const {sessionId} = await prepareWaitingApply({continuationResponse: false});

        await expect(harness.abortInvocation(sessionId, {reason: "用户取消规划变更"}))
            .resolves.toEqual({status: "aborted", sessionId});

        const snapshot = await openProjectPlanning(projectWorkspaceRef("novel"));
        expect(snapshot.entries).toHaveLength(0);
        const stored = await harness.repo.readSession(sessionId);
        const context = harness.repo.reduce(stored);
        const cancelledResult = context.messages.find((message): message is StoredToolResultMessage => message.role === "toolResult" && message.toolName === "apply_planning_change");
        expect(cancelledResult?.isError).toBe(true);
        expect(cancelledResult?.content.map((part) => part.type === "text" ? part.text : "").join(" ")).toContain("Aborted: 用户取消规划变更");
        expect(stored.entries.some((entry) => entry.type === "invocation_lifecycle" && entry.status === "aborted")).toBe(true);
    }, 30_000);

});



