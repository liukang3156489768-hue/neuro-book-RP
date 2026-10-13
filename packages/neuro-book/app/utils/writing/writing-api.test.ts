import {describe, expect, it, vi} from "vitest";
import {createWritingApi} from "./writing-api";

describe("写作 API 客户端", () => {
    it("读取带项目根与查询参数，写入用 POST 带请求体", async () => {
        const fetcher = vi.fn(async () => ({}));
        const api = createWritingApi("E:/project", fetcher);
        await api.entry("ol-detail");
        await api.answer("run-1", "plan", {approved: false, comments: "第二场节奏太快"});
        await api.activeRuns();
        await api.readWriterOutput("run-1", 7);
        expect(fetcher.mock.calls).toEqual([
            ["/api/projects/writing/entry", {query: {projectRoot: "E:/project", entryId: "ol-detail"}}],
            ["/api/projects/writing/answer", {method: "POST", query: {projectRoot: "E:/project"},
                body: {runId: "run-1", key: "plan", decision: {approved: false, comments: "第二场节奏太快"}}}],
            ["/api/projects/writing/active-runs", {query: {projectRoot: "E:/project"}}],
            ["/api/projects/writing/writer-output", {query: {projectRoot: "E:/project", runId: "run-1", sessionId: "7"}}],
        ]);
    });

    it("不提供发起写作或改写的方法", () => {
        const api = createWritingApi("E:/project", vi.fn());
        // 新建章节聊天会话不是发起写作运行；禁止的是运行入口，而不是同前缀的只读或会话操作。
        for (const name of ["start", "write", "rewrite", "startWriting", "startRewrite"]) {
            expect(api).not.toHaveProperty(name);
        }
    });
});
