import {describe, expect, it} from "vitest";
import {createUserMessage, createAssistantTextMessage, EMPTY_USAGE} from "nbook/server/agent/messages/message-utils";
import {estimateFinalRequestTokens, estimateRequestTextTokens} from "nbook/server/agent/messages/request-tokens";

describe("complete request token estimates", () => {
    it("包括系统提示与工具schema，不把中文按统一chars/4估算", () => {
        const baseline = estimateFinalRequestTokens({messages: [createUserMessage({text: "继续"})]});
        const full = estimateFinalRequestTokens({messages: [createUserMessage({text: "继续"})],
            systemPrompt: "创作约束".repeat(1_000),
            tools: [{name: "read_entry", description: "条目详情", parameters: {type: "object", properties: {id: {type: "string"}}}}]});
        expect(full).toBeGreaterThan(baseline + 5_000);
        expect(estimateRequestTextTokens("中文😀")).toBe(5);
    });

    it("已校准provider上下文包含原前缀，不重复叠加固定系统和工具", () => {
        const assistant = {...createAssistantTextMessage({text: "回复"}),
            usage: {...EMPTY_USAGE, input: 100, cacheRead: 50_000, totalTokens: 50_100}};
        const measured = estimateFinalRequestTokens({messages: [assistant], systemPrompt: "稳定前缀".repeat(1_000)});
        expect(measured).toBe(50_100);
    });
});
