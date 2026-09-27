import {beforeEach, describe, expect, it, vi} from "vitest";
import {testAbsoluteFsPath} from "@notnotype/neuro-book-test-support/test-path";

const mocks = vi.hoisted(() => ({
    query: {} as Record<string, unknown>,
    body: {} as Record<string, unknown>,
    guardError: null as Error | null,
    list: vi.fn(async () => ({sources: []})),
    prepare: vi.fn(async () => ({paragraphs: []})),
    resolve: vi.fn(),
}));

vi.mock("h3", async (importOriginal) => ({
    ...await importOriginal<typeof import("h3")>(),
    getQuery: () => mocks.query,
    readBody: async () => mocks.body,
}));
vi.mock("nbook/server/inspiration/source", () => ({listInspirationSources: mocks.list, prepareInspirationSource: mocks.prepare}));
vi.mock("nbook/server/workspace-files/novel-workspace", () => ({resolveWorkspaceFileTarget: mocks.resolve}));
vi.mock("nbook/server/runtime/paths/runtime-paths", () => ({runtimePathsFromEnv: () => ({})}));
vi.mock("nbook/server/workspace-files/project-open-guard", () => ({
    withProjectTargetOperation: async (_target: unknown, handler: () => Promise<unknown>) => {
        if (mocks.guardError) throw mocks.guardError;
        return handler();
    },
}));

import listHandler from "nbook/server/api/inspiration/sources.get";
import prepareHandler from "nbook/server/api/inspiration/source-prepare.post";

describe("Inspiration source HTTP boundary", () => {
    const root = testAbsoluteFsPath("inspiration-source-http", "project");
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.query = {projectRoot: "novel"};
        mocks.body = {projectRoot: "novel", path: "reference/book.txt"};
        mocks.guardError = null;
        mocks.resolve.mockResolvedValue({kind: "project-workspace", root, projectRoot: "novel"});
    });

    it("GET 与 POST 仅用经过校验的项目定位文件所有权", async () => {
        await listHandler({} as never);
        await prepareHandler({} as never);
        expect(mocks.resolve).toHaveBeenCalledWith({}, {projectRoot: "novel"});
        expect(mocks.list).toHaveBeenCalledWith(root);
        expect(mocks.prepare).toHaveBeenCalledWith(root, "reference/book.txt");
    });

    it("项目未打开时两条数据面路由都拒绝读取", async () => {
        mocks.guardError = Object.assign(new Error("项目未打开"), {statusCode: 409});
        await expect(listHandler({} as never)).rejects.toMatchObject({statusCode: 409});
        await expect(prepareHandler({} as never)).rejects.toMatchObject({statusCode: 409});
        expect(mocks.list).not.toHaveBeenCalled();
        expect(mocks.prepare).not.toHaveBeenCalled();
    });

    it("拒绝缺少项目、user-assets 和越界路径，解析失败不接触文件", async () => {
        mocks.query = {workspaceKind: "user-assets"};
        await expect(listHandler({} as never)).rejects.toMatchObject({statusCode: 400});
        mocks.body = {projectRoot: "novel", path: "reference/../outside.txt"};
        await expect(prepareHandler({} as never)).rejects.toMatchObject({statusCode: 400});
        mocks.body = {projectRoot: "../novel", path: "reference/book.txt"};
        await expect(prepareHandler({} as never)).rejects.toMatchObject({statusCode: 400});
        expect(mocks.resolve).not.toHaveBeenCalled();
        expect(mocks.prepare).not.toHaveBeenCalled();
    });
});
