import {rm} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it, vi} from "vitest";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import {absoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {createRuntimePaths} from "nbook/server/runtime/paths/runtime-paths";
import {NeuroAgentHarness} from "nbook/server/agent/harness/neuro-agent-harness";
import type {ReadyProjectSessionRef} from "nbook/server/workspace-files/project-session-types";
import {AGENT_PROMPT_SNAPSHOT_KEY, WRITER_COMPILED_PROMPT_KEY, prepareManagedAgentPrompt} from "nbook/server/prompt-management/agent-runtime";
import {usePromptManagement} from "nbook/server/prompt-management/service";
import type {WritingRunServiceOptions} from "./run-service";
import {useWritingRunService} from "./runtime";

const captured = vi.hoisted(() => ({options: null as WritingRunServiceOptions | null}));
vi.mock("./run-service", () => ({WritingRunService: class {constructor(options: WritingRunServiceOptions) {captured.options = options;}}}));
const roots: string[] = [];
const harnesses: NeuroAgentHarness[] = [];
afterEach(async () => {for (const harness of harnesses.splice(0)) await harness.dispose(); await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));});

describe("写作运行的提示词宿主适配", () => {
    it("酒馆审阅拒绝缺失的当次编译记录，落盘后复用原消息而不重新展开变量", async () => {
        const root = await createTestTmpRoot("writing-prompt-runtime", "frozen-tavern"); roots.push(root);
        const paths = createRuntimePaths({applicationRoot: absoluteFsPath(fileURLToPath(new URL("../../", import.meta.url))), stateRoot: absoluteFsPath(join(root, "state"))});
        const harness = new NeuroAgentHarness({runtimePaths: paths, enableSessionSummarizer: false}); harnesses.push(harness);
        const management = usePromptManagement(paths);
        const catalog = await management.catalog();
        const purpose = catalog.purposes.find(item => item.purposeId === "writing.writer.rewrite")!;
        const bindings = {user: "委托方", char: "叙述者", slots: {chatHistory: [{role: "user" as const, content: purpose.variables.map(key => `{{${key}}}`).join("\n")}]}};
        const sourceJson = JSON.stringify({prompts: [{identifier: "rule", role: "system", content: "{{setvar::mode::frozen}}{{user}}"}, {identifier: "chatHistory", marker: true}],
            prompt_order: [{character_id: 100001, order: ["rule", "chatHistory"].map(identifier => ({identifier, enabled: true}))}], new_chat_prompt: ""});
        await management.mutate({action: "import-tavern", purposeId: purpose.purposeId, expectedRevision: catalog.revision, name: "酒馆审阅",
            tavern: {sourceJson, bindings, macroEngine: "legacy", extensionPolicy: "prompt-only"}});
        const snapshot = await management.capture();
        const variables = Object.fromEntries(purpose.variables.map(key => [key, "实际输入"]));
        const initial = {managedPurposeId: purpose.purposeId, managedVariables: variables};
        const writer = await harness.repo.createSession({profileKey: "writing.writer", initial});
        await harness.repo.appendEntry(writer.metadata.sessionId, {type: "custom", origin: "projection", key: AGENT_PROMPT_SNAPSHOT_KEY, value: snapshot.id});
        const ready = {publicId: "frozen-tavern", workspace: {root, ref: {projectRoot: "p"}}} as unknown as ReadyProjectSessionRef;
        useWritingRunService(harness, ready);
        const fallback = {system: "过时模板", user: "过时输入", managed: {purposeId: purpose.purposeId, variables: Object.fromEntries(purpose.variables.map(key => [key, "后来输入"]))}};
        await expect(captured.options!.resolveWriterPrompt!(writer.metadata.sessionId, fallback)).rejects.toThrow("当次酒馆编译结果");
        const compiled = prepareManagedAgentPrompt(snapshot, "writing.writer", initial)!.writerCompilation!;
        await harness.repo.appendEntry(writer.metadata.sessionId, {type: "custom", origin: "projection", key: WRITER_COMPILED_PROMPT_KEY, value: JSON.parse(JSON.stringify(compiled))});
        const review = await captured.options!.resolveWriterPrompt!(writer.metadata.sessionId, fallback);
        expect(review.orderedMessages).toEqual(compiled.orderedMessages);
        expect(review.user).toContain("实际输入");
        expect(review.user).not.toContain("后来输入");
        expect((await harness.compiledWriterPromptForSession(writer.metadata.sessionId))!.tavernState).toEqual({local: {mode: "frozen"}, global: {}});
    });
    it("旧助手下的每个写手获取当前配置，已开始写手和审阅保持该次版本", async () => {
        const root = await createTestTmpRoot("writing-prompt-runtime", "live-writer-switch"); roots.push(root);
        const paths = createRuntimePaths({applicationRoot: absoluteFsPath(fileURLToPath(new URL("../../", import.meta.url))), stateRoot: absoluteFsPath(join(root, "state"))});
        const harness = new NeuroAgentHarness({runtimePaths: paths, enableSessionSummarizer: false}); harnesses.push(harness);
        const management = usePromptManagement(paths);
        const original = await management.capture();
        const owner = await harness.repo.createSession({profileKey: "writing.assistant", initial: {}});
        await harness.repo.appendEntry(owner.metadata.sessionId, {type: "custom", origin: "projection", key: AGENT_PROMPT_SNAPSHOT_KEY, value: original.id});
        const catalog = await management.catalog();
        const purpose = catalog.purposes.find(item => item.purposeId === "writing.writer.rewrite")!;
        const saved = await management.mutate({action: "save", purposeId: purpose.purposeId, expectedRevision: catalog.revision, name: "即时写手",
            entries: [...purpose.entries, {id: "style", name: "备用文风", role: "system", content: "LIVE_WRITER_STYLE"}]});
        vi.spyOn(harness, "createAgent").mockImplementation(async input => {
            const session = await harness.repo.createSession({profileKey: input.profileKey, initial: input.initial ?? {}});
            const versionId = input.promptSnapshotId ?? original.id;
            await harness.repo.appendEntry(session.metadata.sessionId, {type: "custom", origin: "projection", key: AGENT_PROMPT_SNAPSHOT_KEY, value: versionId});
            return {sessionId: session.metadata.sessionId, profileKey: input.profileKey};
        });
        const ready = {publicId: "live-writer", workspace: {root, ref: {projectRoot: "p"}}} as unknown as ReadyProjectSessionRef;
        useWritingRunService(harness, ready);
        const options = captured.options!;
        const createWriter = () => options.sessions.createSession({profileKey: "writing.writer", parentSessionId: owner.metadata.sessionId, kind: "system", tags: [],
            initial: {system: "旧模板", managedPurposeId: purpose.purposeId, managedVariables: {}}});
        const first = await createWriter();
        const variables = Object.fromEntries(purpose.variables.map(key => [key, "动态资料"]));
        const fallback = {system: "旧模板", user: "旧任务", managed: {purposeId: purpose.purposeId, variables}};
        expect((await options.resolveWriterPrompt!(first.sessionId, fallback)).system).toContain("LIVE_WRITER_STYLE");
        await management.mutate({action: "toggle", purposeId: purpose.purposeId, presetId: saved.purposes.find(item => item.purposeId === purpose.purposeId)!.selectedPresetId,
            expectedRevision: saved.revision, entryId: "style", enabled: false});
        const second = await createWriter();
        expect((await options.resolveWriterPrompt!(second.sessionId, fallback)).system).not.toContain("LIVE_WRITER_STYLE");
        expect((await options.resolveWriterPrompt!(first.sessionId, fallback)).system).toContain("LIVE_WRITER_STYLE");
        expect((await harness.promptSnapshotForSession(owner.metadata.sessionId))!.id).toBe(original.id);
        const legacy = await options.sessions.createSession({profileKey: "writing.writer", kind: "system", tags: [], initial: {system: "历史模板"}});
        expect((await harness.promptSnapshotForSession(legacy.sessionId))!.id).toBe(original.id);
    });
    it("归档主创后新助手继承原快照，审阅读取写手相同版本和消息序列", async () => {
        const root = await createTestTmpRoot("writing-prompt-runtime", "archived-owner"); roots.push(root);
        const paths = createRuntimePaths({applicationRoot: absoluteFsPath(fileURLToPath(new URL("../../", import.meta.url))), stateRoot: absoluteFsPath(join(root, "state"))});
        const harness = new NeuroAgentHarness({runtimePaths: paths, enableSessionSummarizer: false}); harnesses.push(harness);
        const snapshot = await usePromptManagement(paths).capture();
        const owner = await harness.repo.createSession({profileKey: "writing.lead", initial: {}});
        await harness.repo.appendEntry(owner.metadata.sessionId, {type: "custom", origin: "projection", key: AGENT_PROMPT_SNAPSHOT_KEY, value: snapshot.id});
        await harness.repo.appendEntry(owner.metadata.sessionId, {type: "session_archived", reason: "用户新建聊天"});
        const create = vi.spyOn(harness, "createAgent").mockImplementation(async input => {
            const session = await harness.repo.createSession({profileKey: input.profileKey, initial: input.initial ?? {}});
            await harness.repo.appendEntry(session.metadata.sessionId, {type: "custom", origin: "projection", key: AGENT_PROMPT_SNAPSHOT_KEY, value: input.promptSnapshotId ?? snapshot.id});
            return {sessionId: session.metadata.sessionId, profileKey: input.profileKey};
        });
        const ready = {publicId: "prompt-runtime", workspace: {root, ref: {projectRoot: "p"}}} as unknown as ReadyProjectSessionRef;
        useWritingRunService(harness, ready);
        const options = captured.options!;
        const assistant = await options.sessions.createSession({profileKey: "writing.assistant", parentSessionId: owner.metadata.sessionId, kind: "system", tags: [], initial: {chapterEntryId: "ol-ch1"}});
        expect(create.mock.calls[0]![0]).toMatchObject({promptSnapshotId: snapshot.id});
        expect(create.mock.calls[0]![0].parentSessionId).toBeUndefined();
        expect((await harness.promptSnapshotForSession(assistant.sessionId))!.id).toBe(snapshot.id);
        const assistantInitial = (await harness.repo.readSession(assistant.sessionId)).metadata.initial;
        const ownerKey = owner.metadata.sessionIdentity ?? `${owner.metadata.sessionId}:${owner.metadata.createdAt}`;
        expect(assistantInitial).toMatchObject({tavernOwnerKey: ownerKey});
        const writer = await options.sessions.createSession({profileKey: "writing.writer", parentSessionId: assistant.sessionId, kind: "system", tags: [],
            initial: {system: "旧模板", managedPurposeId: "writing.writer.rewrite", managedVariables: {}}});
        expect((await harness.repo.readSession(writer.sessionId)).metadata.initial).toMatchObject({tavernOwnerKey: ownerKey});
        const purpose = snapshot.purposes["writing.writer.rewrite"]!;
        const variables = Object.fromEntries([...purpose.entries.map(entry => entry.content).join("\n").matchAll(/\{\{(\w+)\}\}/gu)].map(match => [match[1]!, "实际资料"]));
        const actual = await options.resolveWriterPrompt!(assistant.sessionId, {system: "过时系统", user: "过时任务", managed: {purposeId: "writing.writer.rewrite", variables}});
        expect(actual.system).toContain("实际资料");
        expect(actual.user).toContain("## 目标段落");
        expect(actual.preMessages?.length).toBeGreaterThan(1);
        expect(new Set(actual.preMessages?.map(message => message.role))).toEqual(new Set(["user"]));
        expect(actual.system).not.toContain("过时系统");
    });
});
