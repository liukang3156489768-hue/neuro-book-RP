import {once} from "node:events";
import {createServer} from "node:http";
import {mkdtemp, readFile, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {createModels, createProvider, envApiKeyAuth, lazyApi, type Api, type Context, type Model} from "@earendil-works/pi-ai";
import {PiRequestRecorder} from "nbook/server/agent/observability/pi-request-recorder";
import {tracedCompleteSimple} from "nbook/server/agent/observability/traced-provider";
import {managedProviderMessages} from "./provider-messages";
import {prepareOrderedProviderRequest} from "./ordered-provider-request";
import type {PromptMessage} from "nbook/shared/dto/prompt-management.dto";

const entries: PromptMessage[] = [
    {role: "system", content: "规则一"}, {role: "user", content: "示例问题"},
    {role: "system", content: "规则二"}, {role: "assistant", content: "示例回答"},
    {role: "user", content: "任务细纲"}, {role: "user", content: "补充要求"},
];
const model: Model<Api> = {id: "order-test", name: "Order Test", api: "openai-completions", provider: "order-test", baseUrl: "http://127.0.0.1",
    reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 1000, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};
const context: Context = {systemPrompt: "规则一\n\n规则二", messages: [...managedProviderMessages(entries.filter(entry => entry.role !== "system")),
    {role: "user", content: "当前需求", timestamp: 1}], tools: []};

describe("提示词顺序的 Provider 边界", () => {
    it("Responses 的 input 保留三种角色、相邻同角色边界、后续工具调用与原回调", async () => {
        const responseModel = {...model, api: "openai-responses"};
        const prepared = prepareOrderedProviderRequest(responseModel, context, {onPayload: payload => ({...Object(payload), temperature: 0.5})}, entries, 4);
        const tail = {type: "function_call", call_id: "tool-1", name: "lookup", arguments: "{}"};
        const payload = await prepared.options.onPayload!({input: [tail], stream: true}, responseModel);
        expect(payload).toEqual({input: [...entries.map(entry => ({type: "message", ...entry})), tail], stream: true, temperature: 0.5});
        expect(prepared.context.messages).toHaveLength(1);
        expect(context.messages).toHaveLength(5);
    });
    it("旧快照透传，不能表达交错 system 的接口明确拒绝而不重排", () => {
        expect(prepareOrderedProviderRequest(model, context, {}, undefined, 0).context).toBe(context);
        expect(() => prepareOrderedProviderRequest({...model, api: "anthropic-messages"}, context, {}, entries, 4)).toThrow("无法保持");
        expect(() => prepareOrderedProviderRequest({...model, api: "google-generative-ai"}, context, {}, [entries[1]!, entries[0]!], 1)).toThrow("无法保持");
        expect(prepareOrderedProviderRequest({...model, api: "anthropic-messages"}, context, {}, [entries[0]!, entries[1]!], 1).context).toBe(context);
    });
    it("真实 Chat Completions SDK 发出的 HTTP 请求与落盘日志均保留原始完整序列", async () => {
        const requests: unknown[] = [];
        const server = createServer(async (request, response) => {
            let body = "";
            for await (const part of request) body += part;
            requests.push(JSON.parse(body));
            response.writeHead(200, {"content-type": "text/event-stream"});
            for (const choice of [{index: 0, delta: {role: "assistant", content: "正文"}, finish_reason: null}, {index: 0, delta: {}, finish_reason: "stop"}]) {
                response.write(`data: ${JSON.stringify({id: "order-test", object: "chat.completion.chunk", created: 1, model: model.id, choices: [choice]})}\n\n`);
            }
            response.end("data: [DONE]\n\n");
        });
        const root = await mkdtemp(join(tmpdir(), "ordered-provider-"));
        const recorder = new PiRequestRecorder({tracesRoot: root});
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        try {
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("无法取得模拟 Provider 地址");
            const selected = {...model, baseUrl: `http://127.0.0.1:${address.port}/v1`};
            const models = createModels();
            models.setProvider(createProvider({id: selected.provider, name: "顺序验收", baseUrl: selected.baseUrl, models: [selected],
                auth: {apiKey: envApiKeyAuth("本地模拟 Provider", [])},
                api: lazyApi(() => import("@earendil-works/pi-ai/api/openai-completions"))}));
            const ordered = prepareOrderedProviderRequest(selected, context, {apiKey: "test-only", maxRetries: 0}, entries, 4);
            const result = await tracedCompleteSimple(models, selected, ordered.context, ordered.options, {recorder,
                settings: {enabled: true, capturePayload: true, maxRecords: 10}, correlation: {kind: "turn", sessionId: 42, invocationId: "order", profileKey: "writing.writer", turnIndex: 0}});
            expect(result.stopReason, result.errorMessage).toBe("stop");
            const request = requests[0] as {messages: PromptMessage[]};
            expect(request.messages.slice(0, entries.length)).toEqual(entries);
            expect(request.messages).toHaveLength(entries.length + 1);
            expect(request.messages.at(-1)).toMatchObject({role: "user", content: "当前需求"});
            await recorder.flush();
            const files = await readdir(join(root, "42"));
            const trace = JSON.parse(await readFile(join(root, "42", files.find(file => file.endsWith(".json"))!), "utf8"));
            expect(trace.request.payload.messages).toEqual(request.messages);
        } finally {
            await recorder.flush();
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            await rm(root, {recursive: true, force: true});
        }
    });
});
