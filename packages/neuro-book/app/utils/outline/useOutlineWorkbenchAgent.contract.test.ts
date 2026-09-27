import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {describe, expect, it} from "vitest";

const agentPath = resolve(process.cwd(), "app/composables/useOutlineWorkbenchAgent.ts");
const panePath = resolve(process.cwd(), "app/components/novel-ide/outline/OutlineWorkbenchAgentPane.vue");

describe("Outline workbench planner agent contract", () => {
    it("binds the planner session to the current Project and checks generation before publishing", async () => {
        const source = await readFile(agentPath, "utf8");
        expect(source).toContain('profileKey: "outline.planner"');
        expect(source).toContain("currentProjectRoot: root");
        expect(source).toContain("getSessionRecovery(created.sessionId)");
        // 新会话 harness 默认 normal；不同步时 discuss 模式下写入不会进入审批。
        expect(source).toContain("api.runCommand(created.sessionId, {command: \"mode\"");
        // initial.model/thinking 同样只进入提示词；不同步时实际调用全局默认模型。
        expect(source).toContain("api.runCommand(created.sessionId, {command: \"model\", modelKey: model})");
        expect(source).toContain("api.runCommand(created.sessionId, {command: \"thinking\"");
        expect(source).toContain("generation.value");
        expect(source).toContain("isCurrent(root, currentGeneration)");
        expect(source).toContain("activeProjectRoot.value === null || activeProjectRoot.value === root");
        expect(source).toContain("stream.stop()");
        expect(source).toContain("session.reset()");
    });

    it("keeps cancellation, pending resolution and runtime controls in the dedicated pane", async () => {
        const [agent, pane] = await Promise.all([readFile(agentPath, "utf8"), readFile(panePath, "utf8")]);
        expect(agent).toContain("abortSession");
        expect(agent).toContain("submitPending");
        expect(agent).toContain("updateRuntime");
        expect(pane).toContain("pendingUserInputSession");
        expect(pane).toContain("submitPending");
        expect(pane).toContain("updateRuntime");
        expect(pane).toContain("watch(() => props.mode");
        expect(pane).toContain("command: \"thinking\"");
        expect(pane).toContain("abort");
    });
});
