import {describe, expect, it} from "vitest";
import {inspectTavernRequestReference, parseTavernConsoleRequest} from "./tavern-request-reference";

describe("酒馆截断日志的只读对照", () => {
    it("带头日志还原消息边界与字符串拼接，保留结构和正文等价的区别", () => {
        const text = "Applying custom prompt post-processing of type strict\nChat Completion request: {\n  messages: [{role: 'system', content: '规则\\n' + '二'}, {role: 'user', content: '任务'}\n  ],\n  prompt: undefined,\n  model: 'test',\n}";
        const messages = [{role: "system" as const, content: "规则\n二"}, {role: "user" as const, content: "任务"}];
        expect(parseTavernConsoleRequest(text)).toEqual({messages, postProcessing: "strict"});
        expect(inspectTavernRequestReference(text, {}, messages)).toMatchObject({messageBoundariesAvailable: true,
            finalMessageComparison: {roles: true, exactContent: true, observedCount: 2}});
        expect(() => parseTavernConsoleRequest("Chat Completion request: {messages: process.exit()}" )).toThrow("可执行");
        expect(() => parseTavernConsoleRequest("Chat Completion request: {messages: []}; process.exit()" )).toThrow("只包含");
    });
    it("只采信参数尾部，区分文字匹配与完整请求证明", () => {
        const log = "预设正文\r\n  model: 'fake',\r\n    },\r\n    {\r\n      role: 'assistant',\r\n      content: 'output'\r\n    },\r\n    {\r\n      role: 'user',\r\n      content: '[Continue]'\r\n    }\r\n  ],\r\n  prompt: undefined,\r\n  model: 'claude-test',\r\n  temperature: 1,\r\n  max_tokens: 50000,\r\n  top_p: 0,\r\n  stream: true,\r\n  top_k: undefined,\r\n}";
        const report = inspectTavernRequestReference(log, {temperature: 1, top_p: 0.5, openai_max_tokens: 50000, continue_nudge_prompt: "[Continue]"},
            [{role: "system", content: "预设正文"}, {role: "user", content: "absent"}]);
        expect(report).toMatchObject({completeMessages: false, visibleTrailingRoles: ["assistant", "user"], requestFields: {model: "claude-test", stream: true},
            continuationNudgeObserved: true, textMatches: {matched: 1, total: 2}});
        expect(report.requestFields).not.toHaveProperty("top_k");
        expect(report.sampling.find(item => item.field === "top_p")).toMatchObject({equal: false});
    });
    it("拒绝可执行表达式和缺少边界的文档", () => {
        expect(() => inspectTavernRequestReference("model: 'guess'", {}, [])).toThrow("边界");
        expect(() => inspectTavernRequestReference("\n  ],\n  prompt: undefined,\n  temperature: process.exit(),\n}", {}, [])).toThrow("字面值");
    });
});
