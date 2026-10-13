import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {createExtractionTools} from "nbook/server/agent/tools/extraction-tools";
import type {NeuroToolResult, ToolExecutionContext} from "nbook/server/agent/tools/types";
import {createTaskSerializer, type ExtractionServices} from "nbook/server/inspiration/extraction/host";
import {createMaterialEnv, MATERIAL_SOURCE_PATH, runMaterialPipeline, startMaterialTask, type MaterialEnv} from "nbook/server/inspiration/extraction/material.fixture";
import {MaterialReviewService} from "nbook/server/inspiration/extraction/material-review-service";
import type {ExtractionTask} from "nbook/shared/dto/inspiration-extraction-task.dto";

/** 提取 Agent 工具：Mock 模型 + 临时项目，验证确认者来自会话上下文、只写新条目，且不依赖真实模型。 */

const mocks = vi.hoisted(() => ({services: null as unknown}));

// 工具经动态导入取得 host；替换服务入口即可复用真实管理器与审阅服务。
vi.mock("nbook/server/inspiration/extraction/host", async importOriginal => ({
    ...await importOriginal<typeof import("nbook/server/inspiration/extraction/host")>(),
    useProjectExtractionServices: async () => mocks.services,
}));
vi.mock("nbook/server/workspace-files/project-open-guard", () => ({
    withProjectTargetMutation: async (_target: unknown, action: (handles: undefined) => unknown) => action(undefined),
}));

const tools = createExtractionTools();
const project = {publicId: "p1", generation: 1, workspace: {root: "C:/project", ref: {projectRoot: "novel"}}};
const text = (result: NeuroToolResult) => result.content.map(part => part.type === "text" ? part.text : "").join("");
const context = (overrides: Partial<ToolExecutionContext> = {}) => ({sessionId: 7, currentProject: project, ...overrides}) as unknown as ToolExecutionContext;

let env: MaterialEnv | null = null;
afterEach(async () => {
    await env?.manager.whenIdle();
    await env?.cleanup();
    env = null;
});

async function setup(): Promise<ExtractionServices> {
    env = await createMaterialEnv();
    const services: ExtractionServices = {
        root: env.root,
        manager: env.manager,
        review: new MaterialReviewService({target: env.target, tasks: env.manager, model: env.model}),
        classification: async () => ({categories: [], candidates: []}),
        serialize: createTaskSerializer(),
        withSignal: action => action(new AbortController().signal),
        destinations: async () => { throw new Error("工具不应读取数据去向"); },
        resummarize: async () => { throw new Error("工具不应重新汇总"); },
    };
    mocks.services = services;
    return services;
}

describe("提取 Agent 工具", () => {
    it("只提供下发、进度、确认新条目写入、失败报告四个工具，写入类标记为会改动工作区", () => {
        expect(Object.values(tools).map(tool => tool.key)).toEqual([
            "start_inspiration_extraction", "get_inspiration_extraction_progress", "confirm_inspiration_material_write", "get_inspiration_extraction_failures",
        ]);
        expect(tools.startExtraction.mutatesWorkspace).toBe(true);
        expect(tools.confirmMaterialWrite.mutatesWorkspace).toBe(true);
        expect(tools.getProgress.mutatesWorkspace).toBeUndefined();
        expect(tools.getFailures.mutatesWorkspace).toBeUndefined();
    });

    it("没有绑定项目时拒绝", async () => {
        await setup();
        await expect(tools.getProgress.executeWithContext!(context({currentProject: null}), "call", {})).rejects.toThrow("必须绑定当前已打开的 Project");
    });

    it("下发素材提取：来源哈希取自磁盘；同一来源运行中重复下发得到可读的冲突原因", async () => {
        await setup();
        const first = await tools.startExtraction.executeWithContext!(context(), "call", {kind: "material", path: MATERIAL_SOURCE_PATH});
        expect(first.details).toMatchObject({kind: "material", status: "running", source: {path: MATERIAL_SOURCE_PATH, sha256: env!.source.sha256}});
        expect(text(first)).toContain("不要轮询");
        // 第一个任务尚在运行，占用同一来源。
        await expect(tools.startExtraction.executeWithContext!(context(), "call", {kind: "material", path: MATERIAL_SOURCE_PATH})).rejects.toThrow("已有运行中的素材提取任务");
        await expect(tools.startExtraction.executeWithContext!(context(), "call", {kind: "material", path: MATERIAL_SOURCE_PATH, categories: ["nope"]})).rejects.toThrow("素材类别无效");
    });

    it("下发大纲提取：不修正章节、按建议划卷、数据去向固定为新方案，工作名缺省取文件名", async () => {
        const services = await setup();
        const start = vi.spyOn(services.manager, "start").mockImplementation(async input => ({id: "00000000-0000-4000-8000-000000000001", kind: input.kind, source: input.source, status: "running"}) as unknown as ExtractionTask);
        await tools.startExtraction.executeWithContext!(context(), "call", {kind: "outline", path: MATERIAL_SOURCE_PATH});
        const input = start.mock.calls[0]![0];
        expect(input).toMatchObject({kind: "outline", source: {path: MATERIAL_SOURCE_PATH, sha256: env!.source.sha256}});
        expect(input.params).toMatchObject({workTitle: "novel", corrections: [], destination: {kind: "new"}, structure: {sourceSha256: env!.source.sha256}});
    });

    it("进度：列表与单任务；失败报告包含停止原因与失败单元", async () => {
        await setup();
        const paused = await startMaterialTask(env!);
        const list = await tools.getProgress.executeWithContext!(context(), "call", {});
        expect(text(list)).toContain(paused.id);
        const detail = await tools.getProgress.executeWithContext!(context(), "call", {taskId: paused.id});
        expect(text(detail)).toContain("等待人工输入");
        const failures = await tools.getFailures.executeWithContext!(context(), "call", {taskId: paused.id});
        expect(failures.details).toMatchObject({taskId: paused.id, failedUnits: [], skippedUnits: []});
        await expect(tools.getFailures.executeWithContext!(context(), "call", {taskId: "00000000-0000-4000-8000-0000000000ff"})).rejects.toThrow("不存在");
    });

    it("确认写入：确认者来自会话 ID；只写新条目，与设计条目同名的冲突原样保留并交给用户", async () => {
        const services = await setup();
        const task = await runMaterialPipeline(env!);
        const directory = path.join(env!.root, "lorebook", "character", "林舟");
        await mkdir(directory, {recursive: true});
        await writeFile(path.join(directory, "index.md"), "---\ntitle: 林舟\n---\n用户亲手写的设定。\n", "utf8");
        const spy = vi.spyOn(services.review, "confirmWrite");

        // 模型给出的额外参数（如自报的确认者）不会进入服务调用。
        const result = await tools.confirmMaterialWrite.executeWithContext!(context({sessionId: 42}), "call", {taskId: task.id, confirmer: {kind: "user"}} as never);
        expect(spy).toHaveBeenCalledWith(task.id, {confirmer: {kind: "agent", sessionId: "42"}, signal: expect.any(AbortSignal)});
        expect(result.details).toMatchObject({failed: 0});
        expect((result.details as {conflicts: unknown[]}).conflicts).toHaveLength(1);
        expect(text(result)).toContain("冲突：林舟");
        expect(await readFile(path.join(directory, "index.md"), "utf8")).toContain("用户亲手写的设定");
        expect(await readFile(path.join(env!.root, "lorebook", "location", "青云山", "index.md"), "utf8")).toContain("origin: extract");
    });
});
