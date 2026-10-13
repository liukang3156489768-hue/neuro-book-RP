import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {createRuntimePaths} from "nbook/server/runtime/paths/runtime-paths";
import {absoluteFsPath} from "nbook/server/runtime/paths/file-path";
import type {PromptSnapshot} from "nbook/shared/dto/prompt-management.dto";
import {storedMessageText} from "nbook/server/agent/messages/stored-message-presentation";
import {loadAgentPromptDefinitions} from "./agent-catalog";
import {prepareManagedAgentPrompt} from "./agent-runtime";

const applicationRoot = absoluteFsPath(fileURLToPath(new URL("../../", import.meta.url)));
const paths = createRuntimePaths({applicationRoot, stateRoot: applicationRoot});

describe("Agent 内置提示词目录", () => {
    it("提取实际内置正文和全部规划指南，不把正文藏在运行时占位变量中", async () => {
        const definitions = await loadAgentPromptDefinitions(paths);
        expect(definitions).toHaveLength(21);
        expect(definitions.find(definition => definition.purposeId === "writing.material-review")!.entries[0]!.content).toContain("独立写作资料审核助手");
        const planner = definitions.find(definition => definition.purposeId === "outline.planner")!;
        expect(planner.entries).toHaveLength(5);
        expect(planner.entries[0]!.content).toContain("不新建角色、物品或地点");
        expect(planner.entries[4]!.content).toContain("改编");
        expect(planner.variables).toEqual(expect.arrayContaining(["projectRoot", "scope", "mode", "model", "temperature", "thinking", "creationMode"]));
        expect(definitions.some(definition => definition.purposeId === "writing.writer")).toBe(false);
        expect(definitions.find(definition => definition.purposeId === "writing.assistant.review-scene")!.entries[0]!.content).toContain("严禁提前展开下一场景");
    });

    it("按照本次阶段选择系统规则，按角色保持预输入顺序并保留动态绑定", async () => {
        const definitions = await loadAgentPromptDefinitions(paths);
        const snapshot: PromptSnapshot = {schemaVersion: 1, id: "a".repeat(64), purposes: Object.fromEntries(definitions.map(definition => [definition.purposeId, {presetId: "builtin", presetRevision: 1, entries: definition.entries}]))};
        const scene = prepareManagedAgentPrompt(snapshot, "writing.assistant", {chapterEntryId: "ol-ch1"}, {kind: "plan-scenes"})!;
        const review = prepareManagedAgentPrompt(snapshot, "writing.assistant", {chapterEntryId: "ol-ch1"}, {kind: "review-scene"})!;
        const planner = prepareManagedAgentPrompt(snapshot, "outline.planner", {projectRoot: "demo", scope: {}, mode: "discuss", model: "test", temperature: 0.7, thinking: "off", creationMode: "adaptation"})!;
        const legacyPlanner = prepareManagedAgentPrompt(snapshot, "outline.planner", {projectRoot: "demo", scope: {}, mode: "discuss", model: "test", temperature: 0.7, thinking: "off"})!;
        expect(scene.systemPrompt).toContain("本会话只服务章节 ol-ch1");
        expect(scene.systemPrompt).toContain("场景规划（输入 kind 为 plan-scenes）");
        expect(scene.systemPrompt).not.toContain("审阅（输入 kind 为 review-scene）");
        expect(review.systemPrompt).toContain("审阅（输入 kind 为 review-scene）");
        expect(planner.systemPrompt).toContain("本会话 creationMode 是创建时固定的模式（adaptation）");
        expect(legacyPlanner.systemPrompt).toContain("本会话 creationMode 是创建时固定的模式（original）");
        snapshot.purposes["inspiration.character"]!.entries.push({id: "example-user", name: "示例任务", role: "user", content: "示例用户"}, {id: "example-assistant", name: "示例回答", role: "assistant", content: "示例回答"});
        const character = prepareManagedAgentPrompt(snapshot, "inspiration.character", {fields: ["角色名称", "性格"]})!;
        expect(character.systemPrompt).toContain("内容模板：角色名称、性格。");
        expect(character.messages.map(message => [message.role, storedMessageText(message)])).toEqual([["user", "示例用户"], ["assistant", "示例回答"]]);
    });
});
