import {rm} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it, vi} from "vitest";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import type {AgentInvokeOutcome, AgentPort} from "@notnotype/nb-workflow";
import {NeuroAgentHarness} from "nbook/server/agent/harness/neuro-agent-harness";
import {normalizeToolResultDetails} from "nbook/server/agent/messages/message-utils";
import {absoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {createRuntimePaths} from "nbook/server/runtime/paths/runtime-paths";
import {FrozenWriterPromptSchema} from "nbook/shared/dto/tavern-preset.dto";
import {WRITER_COMPILED_PROMPT_KEY} from "nbook/server/prompt-management/agent-runtime";
import {PromptManagementService, usePromptManagement} from "nbook/server/prompt-management/service";
import {createTavernWriterAgentPort, FrozenTavernWriterOutputSchema, TAVERN_WRITER_OUTPUT_KEY} from "./tavern-agent-port";

const roots: string[] = [], harnesses: NeuroAgentHarness[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const harness of harnesses.splice(0)) await harness.dispose();
    await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));
});

async function fixture(options: {raw?: string; persistence?: boolean; tavern?: boolean; profileKey?: string; waiting?: boolean; prototypeVariable?: boolean; nativeDeletion?: boolean} = {}) {
    const root = await createTestTmpRoot("tavern-agent-port", "writer-output-receipt"); roots.push(root);
    const paths = createRuntimePaths({applicationRoot: absoluteFsPath(fileURLToPath(new URL("../../", import.meta.url))),
        stateRoot: absoluteFsPath(join(root, "state"))});
    const harness = new NeuroAgentHarness({runtimePaths: paths, enableSessionSummarizer: false}); harnesses.push(harness);
    const session = await harness.repo.createSession({profileKey: options.profileKey ?? "writing.writer", initial: {}});
    const sessionId = session.metadata.sessionId;
    const sourceJson = JSON.stringify({prompts: [{identifier: "rule", role: "system", content: "只输出<content>正文</content>"}],
        prompt_order: [{character_id: 100001, order: [{identifier: "rule", enabled: true}]}], extensions: {regex_scripts: [
            {scriptName: "保存", findRegex: "/旧词/g", replaceString: options.prototypeVariable
                ? "{{setvar::__proto__::after}}正文" : options.nativeDeletion
                    ? "{{deletevar::mode}}{{deleteglobalvar::obsolete}}{{setvar::name::{{user}}}}正文" : "{{setvar::mode::after}}正文", placement: [2]},
            {scriptName: "显示", findRegex: "/<content>(.*?)<\\/content>/g", replaceString: "<article>$1</article>", placement: [2], markdownOnly: true},
        ]}});
    const local: Record<string, string> = options.prototypeVariable ? JSON.parse('{"__proto__":"before"}') : {mode: "before"};
    let compiled = FrozenWriterPromptSchema.parse({snapshotId: "fixed", systemPrompt: "规则", orderedMessages: [],
        tavernState: {local, global: options.nativeDeletion ? {obsolete: "before"} : {}}, ...(options.tavern === false ? {} : {tavern: {sourceJson,
            bindings: {user: "作者", char: "写手", slots: {}, ...(options.nativeDeletion ? {nativeContext: {now: "2026-10-11T00:00:00Z", randomSeed: "frozen"}} : {})},
            macroEngine: options.nativeDeletion ? "native" : "legacy", extensionPolicy: "prompt-only"}})});
    const management = usePromptManagement(paths);
    if (options.persistence) compiled = await management.compileWriter({projectRoot: root, ownerKey: "owner", purposeId: "writing.writer.scene",
        presetId: "preset", attemptKey: String(sessionId)}, compiled.tavernState!, () => compiled);
    await harness.repo.appendEntry(sessionId, {type: "custom", origin: "projection", key: WRITER_COMPILED_PROMPT_KEY,
        value: normalizeToolResultDetails(compiled)});
    const fromLeaf = (await harness.repo.readSession(sessionId)).leafId;
    const usage = {inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 3,
        cost: {input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3}};
    const invoke = vi.fn(async (): Promise<AgentInvokeOutcome> => {
        const raw = options.raw ?? "说明<content>旧词</content>尾注";
        await harness.repo.appendEntry(sessionId, {type: "custom", origin: "projection", key: "test.provider.response", value: raw});
        return {status: options.waiting ? "waiting" : "completed", message: raw, data: {source: "provider"},
            newLeaf: (await harness.repo.readSession(sessionId)).leafId, usage};
    });
    const delegate: AgentPort = {profileInfo: async key => ({profileKey: key}), invoke};
    const port = createTavernWriterAgentPort(harness, delegate);
    return {harness, sessionId, fromLeaf, invoke, port, compiled, management, usage};
}

describe("酒馆写手AgentPort", () => {
    it("生产调用冻结原文和显示结果，返回提取正文及新的持久游标，保留usage/data", async () => {
        const f = await fixture();
        const result = await f.port.invoke(f.sessionId, f.fromLeaf, {message: "写场景"});
        expect(result.message).toBe("正文");
        expect(result.data).toEqual({source: "provider"});
        expect(result.usage).toEqual(f.usage);
        const snapshot = await f.harness.repo.readSession(f.sessionId);
        expect(result.newLeaf).toBe(snapshot.leafId);
        const saved = FrozenTavernWriterOutputSchema.parse(f.harness.repo.reduce(snapshot).customState[TAVERN_WRITER_OUTPUT_KEY]);
        expect(saved.output).toMatchObject({raw: "说明<content>旧词</content>尾注", stored: "说明<content>正文</content>尾注",
            display: "说明<article>正文</article>尾注", prose: "正文", extractionError: null});
        expect(saved.responseLeaf).not.toBe(result.newLeaf);
    });
    it("标签提取失败保留原始记录，workflow收到空正文进入已有重试", async () => {
        const f = await fixture({raw: "说明文字，没有正文封套"});
        const result = await f.port.invoke(f.sessionId, f.fromLeaf, {message: "写场景"});
        expect(result.message).toBe("");
        const state = await f.harness.readSessionContext(f.sessionId);
        expect(FrozenTavernWriterOutputSchema.parse(state.customState[TAVERN_WRITER_OUTPUT_KEY]).output).toMatchObject({
            raw: "说明文字，没有正文封套", prose: null, extractionError: expect.any(String)});
    });
    it("冻结后变量提交失败时恢复同次结果，不再次调用网络或重新求正则，保留首次usage", async () => {
        const f = await fixture({persistence: true});
        const apply = vi.spyOn(PromptManagementService.prototype, "applyWriterOutput").mockRejectedValueOnce(new Error("变量写入暂时失败"));
        await expect(f.port.invoke(f.sessionId, f.fromLeaf, {message: "写场景"})).rejects.toThrow("变量写入暂时失败");
        const outputLeaf = (await f.harness.repo.readSession(f.sessionId)).leafId;
        const result = await f.port.invoke(f.sessionId, f.fromLeaf, {message: "写场景"});
        expect(result.message).toBe("正文");
        expect(result.newLeaf).toBe(outputLeaf);
        expect(result.usage).toEqual(f.usage);
        expect(f.invoke).toHaveBeenCalledTimes(1);
        expect(apply).toHaveBeenCalledTimes(2);
        const next = await f.management.compileWriter({...f.compiled.variableScope!, attemptKey: "next"}, {local: {}, global: {}}, variables => ({
            ...f.compiled, tavernState: variables}));
        expect(next.tavernState!.local).toEqual({mode: "after"});
        await f.port.invoke(f.sessionId, f.fromLeaf, {message: "写场景"});
        expect(f.invoke).toHaveBeenCalledTimes(1);
    });
    it("损坏记录或游标分支不一致明确拒绝恢复，不再发模型请求", async () => {
        const f = await fixture();
        await f.port.invoke(f.sessionId, f.fromLeaf, {message: "写场景"});
        await f.harness.repo.appendEntry(f.sessionId, {type: "custom", origin: "projection", key: "unrelated", value: true});
        await expect(f.port.invoke(f.sessionId, f.fromLeaf, {message: "写场景"})).rejects.toThrow("游标不一致");
        const value = (await f.harness.readSessionContext(f.sessionId)).customState[TAVERN_WRITER_OUTPUT_KEY];
        const corrupt = FrozenTavernWriterOutputSchema.parse(value);
        corrupt.output.raw = "损坏文本";
        await f.harness.freezeWriterOutput(f.sessionId, normalizeToolResultDetails(corrupt), (await f.harness.repo.readSession(f.sessionId)).leafId);
        await expect(f.port.invoke(f.sessionId, f.fromLeaf, {message: "写场景"})).rejects.toThrow("原始回复不一致");
        expect(f.invoke).toHaveBeenCalledTimes(1);
    });
    it("不同请求要求新写手尝试，不冒用旧结果或丢弃新输出的变量副作用", async () => {
        const f = await fixture();
        const first = await f.port.invoke(f.sessionId, f.fromLeaf, {message: "写场景"});
        await expect(f.port.invoke(f.sessionId, first.newLeaf, {message: "修改场景"})).rejects.toThrow("创建新的写手尝试");
        expect(f.invoke).toHaveBeenCalledTimes(1);
    });
    it("冻结前确定性并发移动游标时拒绝挂接到其他分支且不提交输出变量", async () => {
        const f = await fixture({persistence: true});
        const originalFreeze = f.harness.freezeWriterOutput.bind(f.harness);
        vi.spyOn(f.harness, "freezeWriterOutput").mockImplementationOnce(async (sessionId, output, expectedLeaf) => {
            await f.harness.repo.appendEntry(sessionId, {type: "custom", origin: "projection", key: "concurrent.mutation", value: true});
            return originalFreeze(sessionId, output, expectedLeaf);
        });
        const apply = vi.spyOn(PromptManagementService.prototype, "applyWriterOutput");
        await expect(f.port.invoke(f.sessionId, f.fromLeaf, {message: "写场景"})).rejects.toThrow("游标已变化");
        const snapshot = await f.harness.repo.readSession(f.sessionId);
        expect(snapshot.entries.some(entry => entry.type === "custom" && entry.key === TAVERN_WRITER_OUTPUT_KEY)).toBe(false);
        expect(apply).not.toHaveBeenCalled();
        const next = await f.management.compileWriter({...f.compiled.variableScope!, attemptKey: "next"}, {local: {}, global: {}}, variables => ({
            ...f.compiled, tavernState: variables}));
        expect(next.tavernState!.local).toEqual({mode: "before"});
    });
    it("__proto__作为own变量键跨冻结与失败恢复保留，既不丢增量也不修改对象原型", async () => {
        const f = await fixture({persistence: true, prototypeVariable: true});
        const apply = vi.spyOn(PromptManagementService.prototype, "applyWriterOutput").mockRejectedValueOnce(new Error("变量暂不可写"));
        await expect(f.port.invoke(f.sessionId, f.fromLeaf, {message: "写场景"})).rejects.toThrow("变量暂不可写");
        const record = FrozenTavernWriterOutputSchema.parse((await f.harness.readSessionContext(f.sessionId)).customState[TAVERN_WRITER_OUTPUT_KEY]);
        expect(Object.hasOwn(record.output.variablesAfter.local, "__proto__")).toBe(true);
        expect(record.output.variablesAfter.local["__proto__"]).toBe("after");
        expect(Object.getPrototypeOf(record.output.variablesAfter.local)).toBe(Object.prototype);
        const replay = await f.port.invoke(f.sessionId, f.fromLeaf, {message: "写场景"});
        expect(replay.message).toBe("正文");
        expect(f.invoke).toHaveBeenCalledTimes(1);
        expect(apply).toHaveBeenCalledTimes(2);
        const next = await f.management.compileWriter({...f.compiled.variableScope!, attemptKey: "next"}, {local: {}, global: {}}, variables => ({
            ...f.compiled, tavernState: variables}));
        expect(Object.hasOwn(next.tavernState!.local, "__proto__")).toBe(true);
        expect(next.tavernState!.local["__proto__"]).toBe("after");
        expect(Object.getPrototypeOf(next.tavernState!.local)).toBe(Object.prototype);
    });
    it("native输出宏删除本地与全局变量，提交故障恢复冻结结果而不重跑嵌套replacement", async () => {
        const f = await fixture({persistence: true, nativeDeletion: true});
        const apply = vi.spyOn(PromptManagementService.prototype, "applyWriterOutput").mockRejectedValueOnce(new Error("变量暂不可写"));
        await expect(f.port.invoke(f.sessionId, f.fromLeaf, {message: "写场景"})).rejects.toThrow("变量暂不可写");
        const record = FrozenTavernWriterOutputSchema.parse((await f.harness.readSessionContext(f.sessionId)).customState[TAVERN_WRITER_OUTPUT_KEY]);
        expect(record.output.variablesAfter).toEqual({local: {name: "作者"}, global: {}});
        const result = await f.port.invoke(f.sessionId, f.fromLeaf, {message: "写场景"});
        expect(result.message).toBe("正文");
        expect(f.invoke).toHaveBeenCalledTimes(1);
        expect(apply).toHaveBeenCalledTimes(2);
        const next = await f.management.compileWriter({...f.compiled.variableScope!, attemptKey: "next"}, {local: {}, global: {}}, variables => ({
            ...f.compiled, tavernState: variables}));
        expect(next.tavernState).toEqual({local: {name: "作者"}, global: {}});
    });
    it("output已冻结且变量已提交后回到原始游标，从旁支恢复原输出而不生成不同正文", async () => {
        const f = await fixture({persistence: true});
        const first = await f.port.invoke(f.sessionId, f.fromLeaf, {message: "写场景"});
        await f.harness.repo.moveLeaf(f.sessionId, f.fromLeaf);
        const rewound = await f.harness.repo.readSession(f.sessionId);
        expect(rewound.leafId).toBe(f.fromLeaf);
        expect(f.harness.repo.activePath(rewound).some(entry => entry.id === first.newLeaf)).toBe(false);
        const replay = await f.port.invoke(f.sessionId, f.fromLeaf, {message: "写场景"});
        expect(replay).toEqual(first);
        expect(f.invoke).toHaveBeenCalledTimes(1);
        expect((await f.harness.repo.readSession(f.sessionId)).leafId).toBe(first.newLeaf);
        const next = await f.management.compileWriter({...f.compiled.variableScope!, attemptKey: "next"}, {local: {}, global: {}}, variables => ({
            ...f.compiled, tavernState: variables}));
        expect(next.tavernState!.local).toEqual({mode: "after"});
    });
    it.each([{tavern: false}, {profileKey: "writing.assistant"}, {waiting: true}])("普通写手、其他Agent和waiting结果原样通过：%o", async options => {
        const f = await fixture(options);
        const result = await f.port.invoke(f.sessionId, f.fromLeaf, {message: "写场景"});
        expect(result.message).toBe("说明<content>旧词</content>尾注");
        expect((await f.harness.readSessionContext(f.sessionId)).customState[TAVERN_WRITER_OUTPUT_KEY]).toBeUndefined();
    });
});
