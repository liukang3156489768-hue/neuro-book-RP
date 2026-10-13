import {readFile, rm} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {once} from "node:events";
import {createServer} from "node:http";
import {afterEach, describe, expect, it} from "vitest";
import {Type} from "typebox";
import {createModels, createProvider, envApiKeyAuth, lazyApi, fauxAssistantMessage, type Context, type Model} from "@earendil-works/pi-ai";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import {absoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {createRuntimePaths} from "nbook/server/runtime/paths/runtime-paths";
import {createFauxModels, writeFauxProviderConfig} from "nbook/server/agent/test-utils/faux-models";
import {createStoredUserMessage, messageText} from "nbook/server/agent/messages/message-utils";
import {defineAgentProfile} from "nbook/server/agent/profiles/define-agent-profile";
import {toolset} from "nbook/server/agent/profiles/profile-tools";
import {usePromptManagement} from "nbook/server/prompt-management/service";
import {renderManagedPrompt} from "nbook/server/prompt-management/render";
import {prepareTavernBudget} from "nbook/server/prompt-management/tavern-budget";
import type {TavernBindings} from "nbook/shared/dto/tavern-preset.dto";
import {createDefaultWriterMappings, writerMappingSections} from "nbook/shared/prompt-management/tavern-writer-mapping";
import {NeuroAgentHarness} from "./neuro-agent-harness";
import {HarnessAgentPort} from "nbook/server/agent/workflow/workflow-agent-port";
import {createTavernWriterAgentPort, FrozenTavernWriterOutputSchema, TAVERN_WRITER_OUTPUT_KEY} from "nbook/server/writing/tavern-agent-port";

const applicationRoot = absoluteFsPath(fileURLToPath(new URL("../../../", import.meta.url)));
const roots: string[] = [];
const harnesses: NeuroAgentHarness[] = [];
afterEach(async () => {
    for (const harness of harnesses.splice(0)) await harness.dispose();
    for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true});
});

describe("统一提示词的实际 Agent 请求", () => {
    it.skipIf(!process.env.NBOOK_TAVERN_SAMPLE).each([["none", "legacy", false, false], ["strict", "legacy", false, false], ["merge", "native", false, false], ["strict", "native", true, false], ["strict", "native", true, true]] as const)("图灵预设经 %s/%s、映射%s、直接条目%s、完整写手 Harness 和真实 SDK，冻结消息与变量供审阅", async (requestPostProcessing, macroEngine, mapped, direct) => {
        const requests: Array<{messages: unknown[]; temperature?: number; top_p?: number; max_tokens?: number; reasoning_effort?: string}> = [];
        const server = createServer(async (request, response) => {
            request.setEncoding("utf8");
            let body = "";
            for await (const part of request) body += part;
            requests.push(JSON.parse(body));
            response.writeHead(200, {"content-type": "text/event-stream"});
            response.write(`data: ${JSON.stringify({id: "tavern", object: "chat.completion.chunk", created: 1, model: "test", choices: [{index: 0, delta: {role: "assistant", content: "分析说明\n<content>测试正文</content>"}, finish_reason: null}]})}\n\n`);
            response.write(`data: ${JSON.stringify({id: "tavern", object: "chat.completion.chunk", created: 1, model: "test", choices: [{index: 0, delta: {}, finish_reason: "stop"}]})}\n\n`);
            response.end("data: [DONE]\n\n");
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        let harness: NeuroAgentHarness | undefined;
        try {
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("无法取得请求捕获端口");
            const root = await createTestTmpRoot("tavern-writer", "sample-native-request"); roots.push(root);
            const paths = createRuntimePaths({applicationRoot, stateRoot: absoluteFsPath(join(root, "state"))});
            const faux = createFauxModels();
            await writeFauxProviderConfig(paths.workspaceRoot, faux);
            const model: Model<"openai-completions"> = {...faux.getModel(), api: "openai-completions", maxTokens: 64_000, contextWindow: 200_000,
                baseUrl: `http://127.0.0.1:${address.port}/v1`};
            const models = createModels();
            models.setProvider(createProvider({id: model.provider, name: "写手请求捕获", baseUrl: model.baseUrl, models: [model],
                auth: {apiKey: envApiKeyAuth("test", [])}, api: lazyApi(() => import("@earendil-works/pi-ai/api/openai-completions"))}));
            harness = new NeuroAgentHarness({runtimePaths: paths, modelResolver: () => model, runtimeResolver: () => models, enableSessionSummarizer: false});
            harness.profiles.register(defineAgentProfile({manifest: {key: "writing.writer", name: "写手酒馆验收"},
                initialSchema: Type.Object({system: Type.String(), managedPurposeId: Type.String(), managedVariables: Type.Record(Type.String(), Type.String())}),
                tools: toolset(), prepare: () => ({systemPrompt: "不得追加的旧规则"})}), false);
            const management = usePromptManagement(paths);
            const catalog = await management.catalog();
            const purpose = catalog.purposes.find(purpose => purpose.purposeId === "writing.writer.scene")!;
            const slots: TavernBindings["slots"] = Object.fromEntries(["worldInfoBefore", "worldInfoAfter", "charDescription", "charPersonality", "scenario", "personaDescription",
                "dialogueExamples", "chatHistory", "agentTask", "agentSystemPrompt", "agentResults"].map(id => [id, []]));
            slots.personaDescription = [{role: "system", content: "小说用户角色资料"}];
            slots.dialogueExamples = [{role: "system", name: "example_user", content: "示例请求"}, {role: "system", name: "example_assistant", content: "示例正文"}];
            slots.chatHistory = [{role: "assistant", content: "<content>前文</content><build>构建</build><锐评>评语</锐评>"},
                {role: "user", content: purpose.requiredVariables!.map(key => `{{${key}}}`).join("\n")}];
            if (macroEngine === "native") slots.chatHistory.unshift({role: "assistant", content: "archived ".repeat(60_000)});
            let sourceJson = await readFile(process.env.NBOOK_TAVERN_SAMPLE!, "utf8");
            const writerMappings = mapped ? createDefaultWriterMappings(purpose.purposeId, sourceJson) : undefined;
            if (direct) {
                const source = JSON.parse(sourceJson);
                const section = writerMappingSections(purpose.purposeId).find(section => section.id === "overview")!;
                source.prompts.push({identifier: "direct-overview", role: "user", content: section.content});
                source.prompt_order.find((order: {character_id: number}) => order.character_id === 100001).order.unshift({identifier: "direct-overview", enabled: true});
                sourceJson = JSON.stringify(source);
                writerMappings!.overview = {kind: "prompt", name: "direct-overview"};
            }
            if (mapped) slots.chatHistory = slots.chatHistory.filter(message => message.role === "assistant");
            await management.mutate({action: "import-tavern", purposeId: purpose.purposeId, expectedRevision: catalog.revision, name: "图灵样本",
                tavern: {sourceJson, ...(writerMappings ? {writerMappings} : {}), bindings: {user: "小说用户角色", char: "叙事者", slots, requestPostProcessing,
                    ...(macroEngine === "native" ? {nativeContext: {now: "2026-10-11T00:00:00.000Z", randomSeed: "sdk-test"}, contextBudget: {tokenizer: "claude" as const, contextTokens: 100_000}} : {})},
                    generationOverride: {reasoningEffort: "none"}, outputPolicy: {mode: "tag", tag: "content"}, macroEngine, extensionPolicy: "prompt-only"}});
            const variables = Object.fromEntries(purpose.variables.map(key => [key, `已审核事实-${key}`]));
            const agent = await harness.createAgent({profileKey: "writing.writer", initial: {system: "旧模板", managedPurposeId: purpose.purposeId, managedVariables: variables}});
            const snapshot = await harness.promptSnapshotForSession(agent.sessionId);
            const expected = renderManagedPrompt(snapshot!, purpose.purposeId, variables, undefined, await prepareTavernBudget(snapshot!.purposes[purpose.purposeId]!.tavern!));
            const port = createTavernWriterAgentPort(harness, new HarnessAgentPort(harness));
            const result = await port.invoke(agent.sessionId, null, {message: "不得追加的调用通知"});
            expect(result.status).toBe("completed");
            expect(result.message).toBe("测试正文");
            expect(requests).toHaveLength(1);
            expect(requests[0]!.messages).toEqual(expected.orderedMessages);
            expect(requests[0]).toMatchObject({temperature: 1, top_p: 0, max_tokens: 50_000, reasoning_effort: "none"});
            const frozen = await harness.compiledWriterPromptForSession(agent.sessionId);
            expect(frozen).toMatchObject({snapshotId: snapshot!.id, orderedMessages: requests[0]!.messages, tavernState: expected.tavernState});
            if (macroEngine === "legacy") expect(Object.keys(frozen!.tavernState!.local)).toHaveLength(50);
            else expect(frozen!.budgetReport).toMatchObject({tokenizer: "claude", contextTokens: 100_000, responseTokens: 50_000, droppedHistory: 1});
            expect(await harness.compiledWriterPromptForSession(agent.sessionId)).toEqual(frozen);
            const session = await harness.repo.readSession(agent.sessionId);
            const output = FrozenTavernWriterOutputSchema.parse(harness.repo.reduce(session).customState[TAVERN_WRITER_OUTPUT_KEY]);
            expect(output.output).toMatchObject({raw: "分析说明\n<content>测试正文</content>", prose: "测试正文", extractionError: null});
            expect(output.output.quality).toHaveLength(1);
            expect(result.newLeaf).toBe(session.leafId);
            await expect(port.invoke(agent.sessionId, null, {message: "不得追加的调用通知"})).resolves.toMatchObject({message: "测试正文"});
            expect(requests).toHaveLength(1);
        } finally {
            await harness?.dispose();
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });
    it("完整 Harness 经真实 SDK 保持交错 system 与两类示例，续聊不重复注入", async () => {
        const captured: Array<{messages: Array<{role: string; content: unknown}>}> = [];
        const server = createServer(async (request, response) => {
            request.setEncoding("utf8");
            let body = "";
            for await (const part of request) body += part;
            captured.push(JSON.parse(body));
            response.writeHead(200, {"content-type": "text/event-stream"});
            for (const choice of [{index: 0, delta: {role: "assistant", content: "完成"}, finish_reason: null}, {index: 0, delta: {}, finish_reason: "stop"}]) {
                response.write(`data: ${JSON.stringify({id: "order", object: "chat.completion.chunk", created: 1, model: "order", choices: [choice]})}\n\n`);
            }
            response.end("data: [DONE]\n\n");
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        let harness: NeuroAgentHarness | undefined;
        try {
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("无法取得模拟模型端口");
            const root = await createTestTmpRoot("agent-prompt-order", "native-request"); roots.push(root);
            const paths = createRuntimePaths({applicationRoot, stateRoot: absoluteFsPath(join(root, "state"))});
            const faux = createFauxModels();
            await writeFauxProviderConfig(paths.workspaceRoot, faux);
            const source = faux.getModel();
            const model: Model<"openai-completions"> = {...source, api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`};
            const models = createModels();
            models.setProvider(createProvider({id: model.provider, name: "本地请求验收", baseUrl: model.baseUrl, models: [model],
                auth: {apiKey: envApiKeyAuth("test", [])}, api: lazyApi(() => import("@earendil-works/pi-ai/api/openai-completions"))}));
            harness = new NeuroAgentHarness({runtimePaths: paths, modelResolver: () => model, runtimeResolver: () => models, enableSessionSummarizer: false});
            harness.profiles.register(defineAgentProfile({manifest: {key: "inspiration", name: "顺序验收"}, initialSchema: Type.Object({}), tools: toolset(),
                prepare: () => ({systemPrompt: "不应追加的默认规则"})}), false);
            const management = usePromptManagement(paths);
            const catalog = await management.catalog();
            const entries = [
                {id: "s1", name: "规则1", role: "system" as const, content: "第一条系统规则"},
                {id: "u1", name: "用户", role: "user" as const, content: "示例提问"},
                {id: "s2", name: "规则2", role: "system" as const, content: "第二条系统规则"},
                {id: "a1", name: "模型", role: "assistant" as const, content: "示例回复"},
                {id: "off", name: "停用", role: "system" as const, content: "不能发送", enabled: false},
            ];
            await management.mutate({action: "save", purposeId: "inspiration", expectedRevision: catalog.revision, name: "交错预设", entries});
            const agent = await harness.createAgent({profileKey: "inspiration"});
            for (const text of ["首次需求", "继续交流"]) {
                const result = await harness.invokeAgent({sessionId: agent.sessionId, mode: "prompt", message: {text}});
                expect(result.status, result.error).toBe("completed");
            }
            const prefix = entries.filter(entry => entry.enabled !== false).map(({role, content}) => ({role, content}));
            expect(captured).toHaveLength(2);
            for (const request of captured) {
                expect(request.messages.slice(0, prefix.length)).toEqual(prefix);
                expect(request.messages.filter(message => message.role === "system")).toHaveLength(2);
            }
            expect(captured[1]!.messages.at(-1)).toMatchObject({role: "user"});
            harness.profiles.register(defineAgentProfile({manifest: {key: "writing.writer", name: "写手顺序验收"},
                initialSchema: Type.Object({system: Type.String(), managedPurposeId: Type.String(), managedVariables: Type.Record(Type.String(), Type.String())}),
                tools: toolset(), prepare: () => ({systemPrompt: "旧写手规则"})}), false);
            const writerPurpose = (await management.catalog()).purposes.find(purpose => purpose.purposeId === "writing.writer.rewrite")!;
            const writerEntries = [
                {id: "w1", name: "写手规则", role: "system" as const, content: "只处理正文"},
                {id: "w2", name: "助手细纲", role: "user" as const, content: writerPurpose.requiredVariables!.map(key => `{{${key}}}`).join("\n")},
                {id: "w3", name: "最后要求", role: "system" as const, content: "不要解释剧情"},
                {id: "w4", name: "正文示例", role: "assistant" as const, content: "示例正文"},
            ];
            await management.mutate({action: "save", purposeId: writerPurpose.purposeId, expectedRevision: (await management.catalog()).revision, name: "写手序列", entries: writerEntries});
            const writer = await harness.createAgent({profileKey: "writing.writer", initial: {system: "过时规则", managedPurposeId: writerPurpose.purposeId,
                managedVariables: Object.fromEntries(writerPurpose.variables.map(key => [key, "细纲资料"]))}});
            const result = await harness.invokeAgent({sessionId: writer.sessionId, mode: "prompt", message: {text: "不应重复追加的旧模板"}});
            expect(result.status, result.error).toBe("completed");
            expect(captured[2]!.messages).toEqual(writerEntries.map(entry => ({role: entry.role, content: entry.id === "w2"
                ? writerPurpose.requiredVariables!.map(() => "细纲资料").join("\n") : entry.content})));
        } finally {
            await harness?.dispose();
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });
    it("新根读取新预设、子会话与 fork 继承源版本、legacy只读内置，并在真实任务前保留role顺序", async () => {
        const root = await createTestTmpRoot("agent-prompt-management", "request-snapshot-inheritance");
        roots.push(root);
        const paths = createRuntimePaths({applicationRoot, stateRoot: absoluteFsPath(join(root, "state"))});
        const faux = createFauxModels();
        await writeFauxProviderConfig(paths.workspaceRoot, faux);
        const harness = new NeuroAgentHarness({runtimePaths: paths, modelResolver: () => faux.getModel(), runtimeResolver: () => faux.runtime, enableSessionSummarizer: false});
        harnesses.push(harness);
        harness.profiles.register(defineAgentProfile({
            manifest: {key: "inspiration", name: "设计请求测试"}, initialSchema: Type.Object({}), tools: toolset(),
            prepare: () => ({systemPrompt: "旧 Profile System", historyInitMessages: [createStoredUserMessage("旧 Profile 指南")]}),
        }), false);
        const management = usePromptManagement(paths);
        let catalog = await management.catalog();
        catalog = await management.mutate({action: "save", purposeId: "inspiration", expectedRevision: catalog.revision, name: "方案 A", entries: [
            {id: "system", name: "系统", role: "system", content: "系统 A"},
            {id: "example-user", name: "示例用户", role: "user", content: "示例问题"},
            {id: "example-assistant", name: "示例模型", role: "assistant", content: "示例回答"},
        ]});
        const first = await harness.createAgent({profileKey: "inspiration"});
        const firstVersion = await harness.promptSnapshotForSession(first.sessionId);
        await management.mutate({action: "save", purposeId: "inspiration", expectedRevision: catalog.revision, name: "方案 B", entries: [{id: "system", name: "系统", role: "system", content: "系统 B"}]});
        const second = await harness.createAgent({profileKey: "inspiration"});
        const child = await harness.createAgent({profileKey: "inspiration", parentSessionId: first.sessionId});
        const legacy = await harness.repo.createSession({profileKey: "inspiration", initial: {}});
        const fork = await harness.runCommand(first.sessionId, {command: "fork"});
        const legacyFork = await harness.runCommand(legacy.metadata.sessionId, {command: "fork"});
        expect(fork.kind).toBe("created_session");
        expect(legacyFork.kind).toBe("created_session");
        expect((await harness.promptSnapshotForSession(child.sessionId))!.id).toBe(firstVersion!.id);
        expect((await harness.promptSnapshotForSession(fork.sessionId))!.id).toBe(firstVersion!.id);
        expect((await harness.promptSnapshotForSession(legacyFork.sessionId))!.id).toBe((await harness.promptSnapshotForSession(legacy.metadata.sessionId))!.id);
        expect((await harness.promptSnapshotForSession(second.sessionId))!.id).not.toBe(firstVersion!.id);
        const observed: Array<{system: string | undefined; messages: Array<[string, string]>}> = [];
        const response = (context: Context) => {
            observed.push({system: context.systemPrompt, messages: context.messages.map((message: Parameters<typeof messageText>[0]) => [message.role, messageText(message)])});
            return fauxAssistantMessage("完成");
        };
        faux.setResponses([response, response, response, response, response, response]);
        for (const sessionId of [first.sessionId, second.sessionId, child.sessionId, legacy.metadata.sessionId, fork.sessionId, legacyFork.sessionId]) {
            const result = await harness.invokeAgent({sessionId, mode: "prompt", message: {text: "当前需求"}});
            expect(result.status, result.error).toBe("completed");
        }
        expect(observed[0]).toEqual({system: "系统 A", messages: [["user", "示例问题"], ["assistant", "示例回答"], ["user", "当前需求"]]});
        expect(observed[1]).toEqual({system: "系统 B", messages: [["user", "当前需求"]]});
        expect(observed[2]).toEqual(observed[0]);
        expect(observed[3]!.system).toContain("你是 Inspiration");
        expect(observed[3]!.system).not.toContain("系统 B");
        expect(observed[3]!.messages).toEqual([["user", "当前需求"]]);
        expect(observed[4]).toEqual(observed[0]);
        expect(observed[5]).toEqual(observed[3]);
    });
});
