import {describe, expect, it} from "vitest";
import type {AgentMessage} from "nbook/app/components/novel-ide/agent/agent-message";
import {formatOutlineWorkbenchPrompt, projectOutlineWorkbenchMessage} from "nbook/app/utils/outline/outline-workbench-message";

const context = {creationMode: "adaptation", targetPlanId: "plan-city-night"} as const;

describe("大纲工作台消息展示", () => {
    it("乐观消息与恢复历史都仅显示原话，完整上下文与匹配身份保留在原消息", () => {
        const originalText = "插入追踪失踪者的新章节\n请保留前后衔接。";
        const text = formatOutlineWorkbenchPrompt(originalText, context);
        const optimistic: AgentMessage = {id: "optimistic", type: "user", content: text, deliveryState: "pending"};
        const durable: AgentMessage = {
            id: "durable", type: "user", content: text, contentBytes: 310,
            projectionSource: "durable", userContentIdentity: "stored-identity",
            contentBlocks: [{type: "text", contentIndex: 0, content: {preview: text, bytes: 310, omitted: false}}],
        };
        const optimisticDisplay = projectOutlineWorkbenchMessage(optimistic);
        const durableDisplay = projectOutlineWorkbenchMessage(durable);
        expect(optimisticDisplay.content).toBe(originalText);
        expect(durableDisplay.content).toBe(originalText);
        expect(durableDisplay.contentBlocks?.[0]).toMatchObject({content: {preview: originalText, bytes: 310, omitted: false}});
        expect(durableDisplay.userContentIdentity).toBe("stored-identity");
        expect(durableDisplay.contentBytes).toBe(310);
        expect(optimistic.content).toBe(text);
        expect(durable.contentBlocks?.[0]).toMatchObject({content: {preview: text}});
    });

    it("保留正文中的手写包裹内容，仅隐藏最外层工作台上下文", () => {
        const userText = formatOutlineWorkbenchPrompt("这是我要讨论的格式示例", {creationMode: "original", targetPlanId: null});
        const message: AgentMessage = {id: "nested", type: "user", content: formatOutlineWorkbenchPrompt(userText, context)};
        expect(projectOutlineWorkbenchMessage(message).content).toBe(userText);
    });

    it.each([
        "普通角色规划请求",
        '[大纲工作台当前任务]\n我想讨论这个标题\n[/大纲工作台当前任务]\n\n正文',
        '[大纲工作台当前任务]\n{"creationMode":"unknown","targetPlanId":null}\n[/大纲工作台当前任务]\n\n正文',
        '[大纲工作台当前任务]\n{"creationMode":"original","targetPlanId":null,"version":2}\n[/大纲工作台当前任务]\n\n正文',
        '[大纲工作台当前任务]\n{"creationMode": "original", "targetPlanId": null}\n[/大纲工作台当前任务]\n\n正文',
        '[大纲工作台当前任务]\n{"creationMode":"original","targetPlanId":42}\n[/大纲工作台当前任务]\n\n正文',
        '[大纲工作台当前任务]\n{"creationMode":"original","targetPlanId":null}',
    ])("未知或普通手写文本不被误删：%s", (content) => {
        const message: AgentMessage = {id: "ordinary", type: "user", content};
        expect(projectOutlineWorkbenchMessage(message)).toBe(message);
    });

    it("助手、系统与工具消息不变，省略状态与后续文本块不被改变", () => {
        const text = formatOutlineWorkbenchPrompt("公开正文预览", context);
        const toolCalls: AgentMessage["toolCalls"] = [{id: "read", index: 0, name: "read", argsText: "{}", status: "success"}];
        for (const type of ["ai", "system"] as const) {
            const message: AgentMessage = {id: type, type, content: text, toolCalls};
            expect(projectOutlineWorkbenchMessage(message)).toBe(message);
        }
        const laterBlock = {type: "text", contentIndex: 1, content: {preview: text, bytes: 150, omitted: false}} as const;
        const user: AgentMessage = {
            id: "omitted", type: "user", content: text, contentOmitted: true,
            contentBlocks: [{type: "text", contentIndex: 0, content: {preview: text, bytes: 1000, omitted: true}}, laterBlock],
        };
        const display = projectOutlineWorkbenchMessage(user);
        expect(display.contentOmitted).toBe(true);
        expect(display.contentBlocks?.[0]).toMatchObject({content: {preview: "公开正文预览", bytes: 1000, omitted: true}});
        expect(display.contentBlocks?.[1]).toBe(laterBlock);
    });
});
