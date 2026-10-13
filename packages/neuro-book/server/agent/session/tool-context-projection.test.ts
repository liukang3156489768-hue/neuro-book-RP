import {describe, expect, it} from "vitest";
import {createAssistantTextMessage, createStoredTextToolResult, EMPTY_USAGE} from "nbook/server/agent/messages/message-utils";
import type {SessionEntry} from "nbook/server/agent/session/types";
import {planToolContextPruning, projectToolContextPath} from "nbook/server/agent/session/tool-context-projection";

function result(id: string, data: unknown, toolName = "get_planning_context"): SessionEntry {
    return {id, parentId: null, timestamp: 1, type: "message",
        message: createStoredTextToolResult({toolCallId: id, toolName, text: JSON.stringify(data), timestamp: 1})};
}

function persist(path: SessionEntry[], drafts = planToolContextPruning(path)): SessionEntry[] {
    return [...path, ...drafts.map((draft, index) => ({...draft, id: "projection-" + index,
        parentId: path.at(-1)?.id ?? null, timestamp: 10 + index}))];
}

const shared = {revision: 4, entries: [{id: "chapter", title: "章节".repeat(2_000)}]};

describe("planning tool context projection", () => {
    it("只替换重复读取，保留原结果、最新完整副本和正文决定", () => {
        const path = [result("old", shared), result("latest", shared)];
        const projected = projectToolContextPath(persist(path));
        expect(projected[0]).toMatchObject({message: {toolCallId: "old", content: [{text: expect.stringContaining("_contextReference")}]}});
        expect(projected[1]).toEqual(path[1]);
        expect(path[0]).toMatchObject({message: {content: [{text: JSON.stringify(shared)}]}});
        expect(planToolContextPruning(persist(path))).toEqual([]);
    });

    it("合并相同索引，但保留不同条目全文、各自版本和CAS字段", () => {
        const path = [result("a", {...shared, details: [{id: "a", body: "原正文", contentHash: "cas-a"}]}),
            result("b", {...shared, revision: 5, details: [{id: "b", body: "新正文", contentHash: "cas-b"}]})];
        const projected = projectToolContextPath(persist(path));
        const first = projected[0];
        const message = first?.type === "message" ? first.message : null;
        expect(message?.role).toBe("toolResult");
        const text = message?.content[0]?.type === "text" ? message.content[0].text : "";
        expect(JSON.parse(text)).toMatchObject({revision: 4, details: [{body: "原正文", contentHash: "cas-a"}],
            _contextReferences: {entries: {entryId: "b"}}});
        expect(projected[1]).toEqual(path[1]);
    });

    it("正文、写工具结果、错误、未知格式及本轮保护尾部不裁剪", () => {
        const path = [result("writer", shared, "write_file"), result("reader", shared),
            result("reader-2", shared), result("last", shared)];
        const drafts = planToolContextPruning(path, 2);
        expect(drafts).toHaveLength(1);
        expect(drafts[0]).toMatchObject({value: {sourceEntryId: "reader"}});
        const error = result("error", shared);
        if (error.type === "message" && error.message.role === "toolResult") error.message.isError = true;
        expect(planToolContextPruning([error, result("final", shared)])).toEqual([]);
    });

    it("分支缺失引用或源指纹变化时不套用替换", () => {
        const path = [result("old", shared), result("latest", shared)];
        const durable = persist(path);
        const withoutReference = durable.filter(entry => entry.id !== "latest");
        expect(projectToolContextPath(withoutReference)[0]).toEqual(path[0]);
        const changed = [result("old", {...shared, revision: 99}), ...durable.slice(1)];
        expect(projectToolContextPath(changed)[0]).toEqual(changed[0]);
    });

    it("连续维护不将既有完整引用来源变成新的引用链", () => {
        const first = persist([result("a", shared), result("b", shared)]);
        const second = [...first, result("c", shared)];
        const drafts = planToolContextPruning(second);
        expect(drafts).toEqual([]);
        const projected = projectToolContextPath(second);
        expect(projected.find(entry => entry.id === "b")).toEqual(result("b", shared));
        expect(projected.find(entry => entry.id === "a")).toMatchObject({message: {content: [{text: expect.stringContaining('"entryId":"b"')}]}});
    });

    it("替换前usage失效，替换后新请求usage仍可校准，原始费用不变", () => {
        const oldReply: SessionEntry = {id: "reply", parentId: null, type: "message", timestamp: 2,
            message: {...createAssistantTextMessage({text: "旧回复"}), usage: {...EMPTY_USAGE, input: 900_000, totalTokens: 900_000}}};
        const path = [result("old", shared), result("latest", shared), oldReply];
        const durable = persist(path);
        const newReply: SessionEntry = {...oldReply, id: "new", timestamp: 50,
            message: {...createAssistantTextMessage({text: "新回复"}), usage: {...EMPTY_USAGE, input: 20_000, totalTokens: 20_000}}};
        const projected = projectToolContextPath([...durable, newReply]);
        expect(projected.find(entry => entry.id === "reply")).toMatchObject({message: {usage: EMPTY_USAGE}});
        expect(projected.at(-1)).toEqual(newReply);
        expect(oldReply).toMatchObject({message: {usage: {input: 900_000}}});
    });
});
