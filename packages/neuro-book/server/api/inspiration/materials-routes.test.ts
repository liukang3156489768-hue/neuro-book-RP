import {beforeEach, describe, expect, it, vi} from "vitest";
import {testAbsoluteFsPath} from "@notnotype/neuro-book-test-support/test-path";
const mocks = vi.hoisted(() => ({query: {} as Record<string, unknown>, guardError: null as Error | null, list: vi.fn(), resolve: vi.fn()}));
vi.mock("h3", async original => ({...await original<typeof import("h3")>(), getQuery: () => mocks.query}));
vi.mock("nbook/server/inspiration/materials", () => ({listInspirationMaterials: mocks.list}));
vi.mock("nbook/server/workspace-files/novel-workspace", () => ({resolveWorkspaceFileTarget: mocks.resolve}));
vi.mock("nbook/server/runtime/paths/runtime-paths", () => ({runtimePathsFromEnv: () => ({})}));
vi.mock("nbook/server/workspace-files/project-open-guard", () => ({withProjectTargetOperation: async (_target: unknown, action: () => Promise<unknown>) => { if (mocks.guardError) throw mocks.guardError; return action(); }}));
import handler from "./materials.get";
describe("改编素材列表 HTTP 边界", () => {
    const root = testAbsoluteFsPath("inspiration-material-http", "project");
    beforeEach(() => { vi.clearAllMocks(); mocks.guardError = null; mocks.resolve.mockResolvedValue({kind: "project-workspace", root}); });
    it("分页参数由 DTO 校验并绑定当前 ready Project", async () => {
        mocks.query = {projectRoot: "novel", offset: "20", limit: "10", category: "character"};
        await handler({} as never);
        expect(mocks.list).toHaveBeenCalledWith(root, {offset: 20, limit: 10, category: "character", query: undefined});
        mocks.guardError = Object.assign(new Error("项目未打开"), {statusCode: 409}); mocks.list.mockClear();
        await expect(handler({} as never)).rejects.toMatchObject({statusCode: 409}); expect(mocks.list).not.toHaveBeenCalled();
    });
    it("无效项目、用户资产和越界分页在文件访问前拒绝", async () => {
        for (const query of [{}, {workspaceKind: "user-assets"}, {projectRoot: "../novel"}, {projectRoot: "novel", limit: "100"}]) {
            mocks.query = query; await expect(handler({} as never)).rejects.toMatchObject({statusCode: 400});
        }
        expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.list).not.toHaveBeenCalled();
    });
});
