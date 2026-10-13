import {testHostPath} from "@notnotype/neuro-book-test-support/test-path";
import {randomUUID} from "node:crypto";
import {rm} from "node:fs/promises";
import {join, resolve} from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {Type} from "typebox";
import {fauxAssistantMessage, fauxText, fauxToolCall} from "@earendil-works/pi-ai";
import type {Context} from "@earendil-works/pi-ai";
import {createFauxModels, type FauxModelsFixture} from "nbook/server/agent/test-utils/faux-models";
import {appendCompaction, COMPACTION_PROMPT, COMPACTION_SUMMARY_PREFIX, compactIfNeeded, resolveCompactionOptions, shouldCompactWithOptions, type CompactionProgress} from "nbook/server/agent/harness/compaction";
import {createAssistantTextMessage, createTextToolResult, createUserMessage, messageText} from "nbook/server/agent/messages/message-utils";
import {JsonlSessionRepository} from "nbook/server/agent/session/session-repo";
import type {StoredAgentMessage, StoredAttachmentContent} from "nbook/server/agent/messages/stored-types";
import {attachmentMarker} from "nbook/server/agent/messages/stored-message-presentation";
import {estimateStoredMessageTokens} from "nbook/server/agent/messages/stored-message-tokens";
import {estimateFinalRequestTokens} from "nbook/server/agent/messages/request-tokens";
import {absoluteFsPath, type AbsoluteFsPath} from "nbook/server/runtime/paths/file-path";

describe("compaction", () => {
    let root: AbsoluteFsPath;
    let repo: JsonlSessionRepository;
    let faux: FauxModelsFixture;

    beforeEach(() => {
        root = absoluteFsPath(testHostPath("agent-compaction-test", randomUUID()));
        repo = new JsonlSessionRepository(root);
        faux = createFauxModels({
            models: [{
                id: `faux-compact-${randomUUID()}`,
                contextWindow: 128_000,
                maxTokens: 8_000,
            }],
        });
    });

    afterEach(async () => {
        await rm(root, {recursive: true, force: true});
    });

    it("使用 LLM 生成 summary，并在 reduce 后保留 summary + recent messages", async () => {
        let summaryPrompt: Context | null = null;
        faux.setResponses([
            (context) => {
                summaryPrompt = context;
                return fauxAssistantMessage(fauxText("LLM SUMMARY"));
            },
        ]);
        const session = await repo.createSession({
            profileKey: "leader.default",
            initial: {},
        });
        const writeCompactionEntry = createCompactionEntryWriter(repo, session.metadata.sessionId);
        for (let index = 1; index <= 6; index += 1) {
            await repo.appendMessage(session.metadata.sessionId, createUserMessage({text: `user ${String(index)}`}));
        }
        const snapshot = await repo.readSession(session.metadata.sessionId);

        await appendCompaction({
            repo,
            snapshot,
            messages: repo.reduce(snapshot).messages,
            models: faux.runtime,
            model: faux.getModel(),
            instructions: "focus on files",
            writeCompactionEntry,
            compaction: {
                reserveTokens: 2_000,
                keepRecent: {kind: "tokens", value: 1},
            },
        });

        const context = repo.reduce(await repo.readSession(session.metadata.sessionId));

        expect(summaryPromptText(summaryPrompt)).toContain("focus on files");
        expect(messageText(context.messages[0] as never)).toContain(COMPACTION_SUMMARY_PREFIX);
        expect(messageText(context.messages[0] as never)).toContain("LLM SUMMARY");
        expect(context.messages.map((message) => message.role)).toEqual(["user", "user"]);
        expect(messageText(context.messages[1] as never)).toBe("user 6");
    });

    it("AbortSignal透传给摘要Provider，取消后不写compaction entry", async () => {
        let receivedSignal: AbortSignal | undefined;
        let markProviderStarted: () => void = () => undefined;
        const providerStarted = new Promise<void>((resolve) => {
            markProviderStarted = resolve;
        });
        faux.setResponses([
            async (_context, options) => {
                receivedSignal = options?.signal;
                markProviderStarted();
                if (!receivedSignal) {
                    throw new Error("测试未收到 compaction AbortSignal");
                }
                await new Promise<void>((resolve) => {
                    if (receivedSignal?.aborted) {
                        resolve();
                        return;
                    }
                    receivedSignal?.addEventListener("abort", () => resolve(), {once: true});
                });
                return fauxAssistantMessage([], {
                    stopReason: "aborted",
                    errorMessage: "compaction cancelled",
                });
            },
        ]);
        const session = await repo.createSession({
            profileKey: "leader.default",
            initial: {},
        });
        await repo.appendMessage(session.metadata.sessionId, createUserMessage({text: "old context"}));
        const snapshot = await repo.readSession(session.metadata.sessionId);
        const controller = new AbortController();
        let writeCalled = false;
        const progress: CompactionProgress[] = [];

        const compacting = appendCompaction({
            repo,
            snapshot,
            messages: repo.reduce(snapshot).messages,
            models: faux.runtime,
            model: faux.getModel(),
            signal: controller.signal,
            onProgress: async event => {progress.push(event);},
            writeCompactionEntry: async () => {
                writeCalled = true;
            },
            compaction: {
                reserveTokens: 2_000,
                keepRecent: {kind: "tokens", value: 1},
            },
        });
        await providerStarted;
        controller.abort(new Error("project closing"));

        await expect(compacting).rejects.toThrow("project closing");
        expect(receivedSignal).toBe(controller.signal);
        expect(writeCalled).toBe(false);
        expect(progress.at(-1)?.status).toBe("cancelled");
        expect(progress.filter(event => event.status !== "running")).toHaveLength(1);
    });

    it("摘要复用原system/tools和完整工具消息前缀，将摘要指令置尾并单独记录用量", async () => {
        let captured: Context | undefined;
        faux.setResponses([(context) => {
            captured = context;
            return fauxAssistantMessage(fauxText("保留用户决定"));
        }]);
        const session = await repo.createSession({profileKey: "outline.planner", initial: {}});
        await repo.appendEntry(session.metadata.sessionId, {type: "custom_message", visibleToModel: true,
            message: createUserMessage({text: "稳定规划资料"})});
        await repo.appendMessage(session.metadata.sessionId, createUserMessage({text: "用户决定：保留主角动机"}));
        const call = createAssistantTextMessage({text: ""});
        call.content = [fauxToolCall("get_planning_context", {entryIds: ["entry-1"]}, {id: "read-1"})];
        await repo.appendMessage(session.metadata.sessionId, call);
        await repo.appendMessage(session.metadata.sessionId, createTextToolResult({toolCallId: "read-1", toolName: "get_planning_context", text: "条目详情"}));
        await repo.appendMessage(session.metadata.sessionId, createUserMessage({text: "当前任务"}));
        const snapshot = await repo.readSession(session.metadata.sessionId);
        const tools = [{name: "get_planning_context", description: "读取资料", parameters: Type.Object({})}];
        await appendCompaction({repo, snapshot, messages: repo.reduce(snapshot).messages, models: faux.runtime,
            model: faux.getModel(), systemPrompt: "原系统提示", tools,
            compaction: {keepRecent: {kind: "tokens", value: 1}},
            writeCompactionEntry: createCompactionEntryWriter(repo, session.metadata.sessionId)});
        expect(captured?.systemPrompt).toBe("原系统提示");
        expect(captured?.tools).toEqual(tools);
        expect(captured?.messages.slice(0, -1)).toEqual(snapshot.entries.filter(entry => entry.type === "message" || entry.type === "custom_message").slice(0, -1).map(entry => entry.message));
        expect(messageText(captured!.messages.at(-1)!)).toContain(COMPACTION_PROMPT);
        const receipt = (await repo.readSession(session.metadata.sessionId)).entries.find(entry => entry.type === "compaction");
        expect(receipt?.type === "compaction" ? receipt.details?.usage?.input : undefined).toBeGreaterThan(0);
        expect(receipt?.type === "compaction" ? receipt.details?.totalBatches : undefined).toBe(1);
    });

    it("摘要被输出上限截断时不保存压缩收据", async () => {
        faux.setResponses([fauxAssistantMessage(fauxText("不完整摘要"), {stopReason: "length"})]);
        const session = await repo.createSession({profileKey: "outline.planner", initial: {}});
        await repo.appendMessage(session.metadata.sessionId, createUserMessage({text: "较早规划"}));
        await repo.appendMessage(session.metadata.sessionId, createUserMessage({text: "当前任务"}));
        const snapshot = await repo.readSession(session.metadata.sessionId);
        await expect(appendCompaction({
            repo, snapshot, messages: repo.reduce(snapshot).messages, models: faux.runtime, model: faux.getModel(),
            compaction: {keepRecent: {kind: "tokens", value: 1}},
            writeCompactionEntry: createCompactionEntryWriter(repo, session.metadata.sessionId),
        })).rejects.toThrow("不完整");
        expect((await repo.readSession(session.metadata.sessionId)).entries.some(entry => entry.type === "compaction")).toBe(false);
    });

    it("cut point 不会从 toolResult 半截开始", async () => {
        faux.setResponses([fauxAssistantMessage(fauxText("TOOL SUMMARY"))]);
        const session = await repo.createSession({
            profileKey: "leader.default",
            initial: {},
        });
        const writeCompactionEntry = createCompactionEntryWriter(repo, session.metadata.sessionId);
        await repo.appendMessage(session.metadata.sessionId, createUserMessage({text: "old"}));
        const assistant = createAssistantTextMessage({text: ""});
        assistant.content = [
            fauxText("call"),
            fauxToolCall("report_result", {result: "ok"}, {id: "tool-1"}),
        ];
        await repo.appendMessage(session.metadata.sessionId, assistant);
        await repo.appendMessage(session.metadata.sessionId, createTextToolResult({
            toolCallId: "tool-1",
            toolName: "report_result",
            text: "ok",
        }));
        const snapshot = await repo.readSession(session.metadata.sessionId);

        await appendCompaction({
            repo,
            snapshot,
            messages: repo.reduce(snapshot).messages,
            models: faux.runtime,
            model: faux.getModel(),
            writeCompactionEntry,
            compaction: {
                reserveTokens: 2_000,
                keepRecent: {kind: "tokens", value: 1},
            },
        });

        const context = repo.reduce(await repo.readSession(session.metadata.sessionId));

        expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
        expect(messageText(context.messages[1] as never)).toContain("[tool:report_result]");
        expect(messageText(context.messages[2] as never)).toBe("ok");
    });

    it("存在未完成 tool call 时拒绝压缩", async () => {
        const session = await repo.createSession({
            profileKey: "leader.default",
            initial: {},
        });
        const writeCompactionEntry = createCompactionEntryWriter(repo, session.metadata.sessionId);
        const assistant = createAssistantTextMessage({text: ""});
        assistant.content = [fauxToolCall("request_user_input", {questions: []}, {id: "approval-1"})];
        await repo.appendMessage(session.metadata.sessionId, assistant);
        const snapshot = await repo.readSession(session.metadata.sessionId);

        await expect(appendCompaction({
            repo,
            snapshot,
            messages: repo.reduce(snapshot).messages,
            models: faux.runtime,
            model: faux.getModel(),
            writeCompactionEntry,
            compaction: {
                reserveTokens: 2_000,
                keepRecent: {kind: "tokens", value: 1},
            },
        })).rejects.toThrow("未完成 tool call");
    });

    it("没有 profile Compaction policy 时不会自动压缩", async () => {
        const session = await repo.createSession({
            profileKey: "leader.default",
            initial: {},
        });
        const writeCompactionEntry = createCompactionEntryWriter(repo, session.metadata.sessionId);
        await repo.appendMessage(session.metadata.sessionId, createUserMessage({text: "old context"}));
        const snapshot = await repo.readSession(session.metadata.sessionId);

        const compacted = await compactIfNeeded({
            repo,
            snapshot,
            messages: repo.reduce(snapshot).messages,
            models: faux.runtime,
            model: faux.getModel(),
            writeCompactionEntry,
        });

        expect(compacted).toBe(false);
    });

    it("解析默认 prompt/prefix、百分比触发和 recent 百分比", () => {
        const options = resolveCompactionOptions({
            trigger: {kind: "percent", value: 0.8},
            keepRecent: {kind: "percent", value: 0.25},
        }, faux.getModel());

        expect(options.prompt).toBe(COMPACTION_PROMPT);
        expect(options.summaryPrefix).toBe(COMPACTION_SUMMARY_PREFIX);
        expect(options.keepRecentTokens).toBe(32_000);
        expect(shouldCompactWithOptions(102_400, 128_000, options)).toBe(true);
        expect(shouldCompactWithOptions(102_399, 128_000, options)).toBe(false);
    });

    it("默认500k触发包含缓存上下文，并提前保护小模型窗口，显式配置优先", () => {
        const largeModel = {...faux.getModel(), contextWindow: 1_000_000};
        const defaults = resolveCompactionOptions({}, largeModel);
        expect(shouldCompactWithOptions(499_999, largeModel.contextWindow, defaults)).toBe(false);
        expect(shouldCompactWithOptions(500_000, largeModel.contextWindow, defaults)).toBe(true);
        expect(resolveCompactionOptions({trigger: {kind: "tokens", value: 300_000}}, largeModel).triggerTokens).toBe(300_000);
        expect(shouldCompactWithOptions(867_029, largeModel.contextWindow, defaults)).toBe(true);
        expect(defaults.keepRecentTokens).toBe(24_000);
        const small = resolveCompactionOptions({}, faux.getModel());
        expect(small.triggerTokens).toBe(102_400);
        expect(shouldCompactWithOptions(102_400, 128_000, small)).toBe(true);
        expect(resolveCompactionOptions({trigger: {kind: "autoReserve"}}, largeModel).triggerTokens).toBeUndefined();
    });

    it("长中文历史分批摘要，每批合并已有摘要且完成后仅落一份收据", async () => {
        const inputs: Context[] = [];
        const progress: CompactionProgress[] = [];
        faux.setResponses(Array.from({length: 8}, (_, index) => (context: Context) => {
            const text = summaryPromptText(context);
            expect(estimateFinalRequestTokens(context)).toBeLessThanOrEqual(102_400);
            if (index > 0) expect(text).toContain(`摘要${index}`);
            inputs.push(context);
            return fauxAssistantMessage(fauxText(`摘要${index + 1}`));
        }));
        const session = await repo.createSession({profileKey: "outline.planner", initial: {}});
        const history = "较早规划📝".repeat(50_000);
        await repo.appendMessage(session.metadata.sessionId, createUserMessage({text: history}));
        await repo.appendMessage(session.metadata.sessionId, createUserMessage({text: "当前任务"}));
        const snapshot = await repo.readSession(session.metadata.sessionId);
        await appendCompaction({repo, snapshot, messages: repo.reduce(snapshot).messages, models: faux.runtime, model: faux.getModel(),
            compaction: {keepRecent: {kind: "tokens", value: 1}},
            onProgress: async event => {progress.push(event);},
            writeCompactionEntry: createCompactionEntryWriter(repo, session.metadata.sessionId)});
        const after = await repo.readSession(session.metadata.sessionId);
        expect(inputs.length).toBeGreaterThan(1);
        const chunks = inputs.map(context => messageText(context.messages.at(-2)!).replace(/^\[Oversized conversation group[^\n]*\]\n/, ""));
        expect(JSON.parse(chunks.join(""))[0].content).toEqual([{type: "text", text: history}]);
        for (const chunk of chunks) expect(chunk).toBe(Buffer.from(chunk).toString("utf8"));
        expect(after.entries.filter(entry => entry.type === "compaction")).toHaveLength(1);
        expect(progress.at(-1)?.status).toBe("completed");
        expect(progress.at(-1)?.completedBatches).toBe(inputs.length);
        expect(progress.at(-1)?.totalBatches).toBe(inputs.length);
        expect(messageText(repo.reduce(after).messages.at(-1)!)).toBe("当前任务");
    });

    it("后续摘要分批失败时不保存半份压缩结果", async () => {
        faux.setResponses([fauxAssistantMessage(fauxText("第一批摘要")), fauxAssistantMessage(fauxText(""))]);
        const session = await repo.createSession({profileKey: "outline.planner", initial: {}});
        await repo.appendMessage(session.metadata.sessionId, createUserMessage({text: "规划".repeat(80_000)}));
        await repo.appendMessage(session.metadata.sessionId, createUserMessage({text: "当前任务"}));
        const snapshot = await repo.readSession(session.metadata.sessionId);
        const progress: CompactionProgress[] = [];
        await expect(appendCompaction({repo, snapshot, messages: repo.reduce(snapshot).messages, models: faux.runtime, model: faux.getModel(),
            compaction: {keepRecent: {kind: "tokens", value: 1}},
            onProgress: async event => {progress.push(event);},
            writeCompactionEntry: createCompactionEntryWriter(repo, session.metadata.sessionId)})).rejects.toThrow("summary 为空");
        expect((await repo.readSession(session.metadata.sessionId)).entries.some(entry => entry.type === "compaction")).toBe(false);
        expect(progress.at(-1)?.status).toBe("failed");
        expect(progress.at(-1)?.completedBatches).toBe(1);
        expect(progress.at(-1)?.usage?.input).toBeGreaterThan(0);
        expect(progress.filter(event => event.status !== "running")).toHaveLength(1);
    });

    it("大窗口可容纳中文历史时只摘要一批，不再按200k UTF8字节上限拆分", async () => {
        let captured: Context | undefined;
        faux.setResponses([(context) => {captured = context; return fauxAssistantMessage(fauxText("摘要"));}]);
        const session = await repo.createSession({profileKey: "outline.planner", initial: {}});
        const history = "中文规划资料".repeat(25_000);
        await repo.appendMessage(session.metadata.sessionId, createUserMessage({text: history}));
        await repo.appendMessage(session.metadata.sessionId, createUserMessage({text: "当前任务"}));
        const snapshot = await repo.readSession(session.metadata.sessionId);
        await appendCompaction({repo, snapshot, messages: repo.reduce(snapshot).messages, models: faux.runtime,
            model: {...faux.getModel(), contextWindow: 1_000_000}, compaction: {keepRecent: {kind: "tokens", value: 1}},
            writeCompactionEntry: createCompactionEntryWriter(repo, session.metadata.sessionId)});
        expect(faux.state.callCount).toBe(1);
        expect(messageText(captured!.messages[0]!)).toBe(history);
    });

    it("triggerTokens 生效并把自定义 prompt/prefix 写入 summary 调用和 compaction entry", async () => {
        let summaryPrompt: Context | null = null;
        let summaryHeaders: Record<string, string | null> | undefined;
        let summaryMaxRetries: number | undefined;
        faux.setResponses([
            (context, options) => {
                summaryPrompt = context;
                summaryHeaders = options?.headers;
                summaryMaxRetries = options?.maxRetries;
                return fauxAssistantMessage(fauxText("CUSTOM SUMMARY"));
            },
        ]);
        const session = await repo.createSession({
            profileKey: "leader.default",
            initial: {},
        });
        const writeCompactionEntry = createCompactionEntryWriter(repo, session.metadata.sessionId);
        await repo.appendMessage(session.metadata.sessionId, createUserMessage({text: "old context"}));
        const snapshot = await repo.readSession(session.metadata.sessionId);

        const compacted = await compactIfNeeded({
            repo,
            snapshot,
            messages: repo.reduce(snapshot).messages,
            models: faux.runtime,
            model: {
                ...faux.getModel(),
                headers: {
                    "x-model": "model",
                    "x-shared": "model",
                },
            },
            requestOptions: {
                headers: {
                    "x-request": "request",
                    "x-shared": "request",
                },
            },
            compaction: {
                trigger: {kind: "tokens", value: 1},
                keepRecent: {kind: "tokens", value: 1},
                prompt: "CUSTOM PROMPT",
                summaryPrefix: "CUSTOM PREFIX",
            },
            writeCompactionEntry,
        });

        const reduced = repo.reduce(await repo.readSession(session.metadata.sessionId));
        expect(compacted).toBe(true);
        const capturedPrompt = summaryPrompt as Context | null;
        expect(messageText(capturedPrompt!.messages.at(-1)!)).toContain("CUSTOM PROMPT");
        expect(summaryMaxRetries).toBe(5);
        expect(summaryHeaders).toEqual({
            "x-request": "request",
            "x-model": "model",
            "x-shared": "request",
        });
        expect(messageText(reduced.messages[0] as never)).toContain("CUSTOM PREFIX");
    });

    it("visible custom_message 按原顺序参与摘要回放和 recent cut 预算", async () => {
        let secondSummaryPrompt: Context | null = null;
        faux.setResponses([
            () => {
                return fauxAssistantMessage(fauxText("FIRST SUMMARY"));
            },
            (context) => {
                secondSummaryPrompt = context;
                return fauxAssistantMessage(fauxText("SECOND SUMMARY"));
            },
        ]);
        const session = await repo.createSession({
            profileKey: "leader.default",
            initial: {},
        });
        const writeCompactionEntry = createCompactionEntryWriter(repo, session.metadata.sessionId);
        await repo.appendEntry(session.metadata.sessionId, {
            type: "custom_message",
            message: createUserMessage({text: "OLD HISTORYSET SHOULD BE CUT " + "old ".repeat(200)}),
            visibleToModel: true,
        });
        await repo.appendMessage(session.metadata.sessionId, createUserMessage({text: "old user dialogue"}));
        const firstSnapshot = await repo.readSession(session.metadata.sessionId);

        await compactIfNeeded({
            repo,
            snapshot: firstSnapshot,
            messages: repo.reduce(firstSnapshot).messages,
            models: faux.runtime,
            model: faux.getModel(),
            compaction: {
                trigger: {kind: "tokens", value: 1},
                keepRecent: {kind: "tokens", value: 1},
            },
            writeCompactionEntry,
        });

        await repo.appendEntry(session.metadata.sessionId, {
            type: "custom_message",
            message: createUserMessage({text: "NEW HISTORYSET SHOULD STAY " + "new ".repeat(200)}),
            visibleToModel: true,
        });
        await repo.appendMessage(session.metadata.sessionId, createUserMessage({text: "new user dialogue"}));
        const secondSnapshot = await repo.readSession(session.metadata.sessionId);
        await compactIfNeeded({
            repo,
            snapshot: secondSnapshot,
            messages: repo.reduce(secondSnapshot).messages,
            models: faux.runtime,
            model: faux.getModel(),
            compaction: {
                trigger: {kind: "tokens", value: 1},
                keepRecent: {kind: "tokens", value:
                    estimateStoredMessageTokens(createUserMessage({text: "NEW HISTORYSET SHOULD STAY " + "new ".repeat(200)}))
                    + estimateStoredMessageTokens(createUserMessage({text: "new user dialogue"})),
                },
            },
            writeCompactionEntry,
        });

        const snapshot = await repo.readSession(session.metadata.sessionId);
        const reducedText = repo.reduce(snapshot).messages.map((message) => messageText(message as never)).join("\n");
        const latestCompaction = snapshot.entries.filter((entry) => entry.type === "compaction").at(-1);
        expect(reducedText).not.toContain("OLD HISTORYSET SHOULD BE CUT");
        expect(reducedText).toContain("NEW HISTORYSET SHOULD STAY");
        expect(summaryPromptText(secondSummaryPrompt)).not.toContain("OLD HISTORYSET SHOULD BE CUT");
        expect(summaryPromptText(secondSummaryPrompt)).not.toContain("NEW HISTORYSET SHOULD STAY");
        expect(summaryPromptText(secondSummaryPrompt)).toContain("old user dialogue");
        expect(latestCompaction?.type === "compaction" ? latestCompaction.details?.firstKeptEntryType : undefined).toBe("custom_message");
        expect(latestCompaction?.type === "compaction" ? latestCompaction.details?.recentTokens : undefined).toBeGreaterThan(0);
        expect(latestCompaction?.type === "compaction" ? latestCompaction.details?.visibleTokensBefore : undefined)
            .toBe(latestCompaction?.type === "compaction" ? latestCompaction.tokensBefore : undefined);
    });

    it("persisted sidecar 和模型可见 custom message 按原顺序进入 summary 输入", async () => {
        let summaryPrompt: Context | null = null;
        faux.setResponses([
            (context) => {
                summaryPrompt = context;
                return fauxAssistantMessage(fauxText("SIDECAR SUMMARY"));
            },
        ]);
        const session = await repo.createSession({
            profileKey: "leader.default",
            initial: {},
        });
        const writeCompactionEntry = createCompactionEntryWriter(repo, session.metadata.sessionId);
        await repo.appendEntry(session.metadata.sessionId, {
            type: "message",
            message: createUserMessage({text: "PERSISTED SIDECAR CONTEXT"}),
            clientMessageId: randomUUID(),
            intent: "normal",
            origin: "harness",
        });
        await repo.appendEntry(session.metadata.sessionId, {
            type: "custom_message",
            message: createUserMessage({text: "RUNTIME ONLY SHADOW SHOULD NOT EXIST IN SUMMARY"}),
            visibleToModel: true,
        });
        await repo.appendMessage(session.metadata.sessionId, createUserMessage({text: "recent"}));
        const snapshot = await repo.readSession(session.metadata.sessionId);

        await appendCompaction({
            repo,
            snapshot,
            messages: repo.reduce(snapshot).messages,
            models: faux.runtime,
            model: faux.getModel(),
            writeCompactionEntry,
            compaction: {
                reserveTokens: 2_000,
                keepRecent: {kind: "tokens", value: 1},
            },
        });

        expect(summaryPromptText(summaryPrompt)).toContain("PERSISTED SIDECAR CONTEXT");
        expect(summaryPromptText(summaryPrompt)).toContain("RUNTIME ONLY SHADOW SHOULD NOT EXIST IN SUMMARY");
    });

    it("attachment 使用 marker 参与 compaction 与固定 token 预算，不读取 blob", async () => {
        let summaryPrompt: Context | null = null;
        faux.setResponses([(context) => {
            summaryPrompt = context;
            return fauxAssistantMessage(fauxText("ATTACHMENT SUMMARY"));
        }]);
        const session = await repo.createSession({
            profileKey: "leader.default",
            initial: {},
        });
        const block: StoredAttachmentContent = {
            type: "attachment",
            attachment: {
                id: `sha256:${"b".repeat(64)}`,
                mimeType: "image/png",
                bytes: 7_170_689,
            },
            name: "world-map.png",
        };
        const imageMessage: StoredAgentMessage = {role: "user", content: [block], timestamp: 1};
        await repo.appendMessage(session.metadata.sessionId, imageMessage as never);
        await repo.appendMessage(session.metadata.sessionId, createUserMessage({text: "recent"}));
        const snapshot = await repo.readSession(session.metadata.sessionId);

        await appendCompaction({
            repo,
            snapshot,
            messages: repo.reduce(snapshot).messages,
            models: faux.runtime,
            model: faux.getModel(),
            writeCompactionEntry: createCompactionEntryWriter(repo, session.metadata.sessionId),
            compaction: {
                reserveTokens: 2_000,
                keepRecent: {kind: "tokens", value: 1},
            },
        });

        const latest = (await repo.readSession(session.metadata.sessionId)).entries
            .filter((entry) => entry.type === "compaction")
            .at(-1);
        expect(summaryPromptText(summaryPrompt)).toContain(attachmentMarker(block));
        expect(latest?.type === "compaction" ? latest.details?.summarizedTokens : undefined).toBe(1_200);
        expect(latest?.type === "compaction" ? latest.tokensBefore : undefined).toBeGreaterThanOrEqual(1_200);
    });
});

function createCompactionEntryWriter(repo: JsonlSessionRepository, sessionId: number): Parameters<typeof appendCompaction>[0]["writeCompactionEntry"] {
    return async (entry) => {
        await repo.appendEntry(sessionId, entry);
    };
}

function summaryPromptText(context: Context | null): string {
    if (!context) {
        return "";
    }
    return context.messages.map((message) => messageText(message as never)).join("\n");
}
