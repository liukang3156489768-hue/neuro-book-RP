import {describe, expect, it, vi} from "vitest";
import type {ExtractionTask, ExtractionTaskKind} from "nbook/shared/dto/inspiration-extraction-task.dto";
import {ExtractionFatalError, ExtractionTaskError} from "./errors";
import {ExtractionTaskManager, type ExtractionLaunch} from "./manager";
import {createMemoryExtractionStore} from "./store-memory";
import {
    createClassifyingPipeline,
    createGate,
    createLayeredPipeline,
    createScriptedModel,
    createTestLaunch,
    testSource,
    type ScriptedModelHandler,
} from "./testing";
import type {ExtractionPipeline, ExtractionTaskStore} from "./types";

const SOURCE_HASH = "a".repeat(64);
const LAYOUT = {layout: {v1: ["c1", "c2"]}};

function unitOf(prompt: string): string {
    return /【原文】(\S+)/u.exec(prompt)![1]!;
}

/** 默认每个单元都返回合法产出；脚本可按单元覆盖。 */
function setup(handler?: ScriptedModelHandler, overrides: Partial<{pipelines: Partial<Record<ExtractionTaskKind, ExtractionPipeline>>; launch: ExtractionLaunch; store: ExtractionTaskStore & {snapshot(): ExtractionTask[]}; capturePromptSnapshot: () => Promise<string>}> = {}) {
    const store = overrides.store ?? createMemoryExtractionStore();
    const model = createScriptedModel(handler ?? (request => `OK:${unitOf(request.prompt)}`));
    const sourceHash = {current: SOURCE_HASH};
    const host = createTestLaunch();
    const log = vi.fn();
    const pipelines = {outline: createLayeredPipeline(), material: createClassifyingPipeline(), ...overrides.pipelines};
    const manager = new ExtractionTaskManager({
        store, model, log,
        verifySource: async source => { if (source.sha256 !== sourceHash.current) throw new Error("内容已变化"); },
        resolvePipeline: kind => pipelines[kind],
        launch: overrides.launch ?? host.launch,
        capturePromptSnapshot: overrides.capturePromptSnapshot,
    });
    const startOutline = (path = "reference/novel.md") => manager.start({kind: "outline", source: testSource(path, SOURCE_HASH), params: LAYOUT});
    return {store, model, sourceHash, host, log, manager, pipelines, startOutline};
}

const statuses = (task: ExtractionTask) => Object.fromEntries(task.units.map(unit => [unit.id, unit.status]));

describe("提取任务管理器：执行与失败", () => {
    it.each(["outline", "material"] as const)("%s 批量重试一次重置多个失败项，已成功项和迟到的重复请求不重复执行", async kind => {
        let fail = true;
        const ctx = setup(request => fail ? "坏产出" : `OK:${unitOf(request.prompt)}`);
        const started = await ctx.manager.start({kind, source: testSource(), params: kind === "outline" ? LAYOUT : {blocks: ["b1"], categories: ["x", "y"]}});
        await ctx.manager.whenIdle();
        const failed = (await ctx.manager.get(started.id)).units.filter(unit => unit.status === "failed").map(unit => unit.id);
        expect(failed).toHaveLength(2);
        fail = false;
        const before = ctx.model.requests.length;
        await ctx.manager.changeFailedUnits(started.id, "retry", [...failed, failed[0]!]);
        await ctx.manager.whenIdle();
        const task = await ctx.manager.get(started.id);
        expect(task.units.filter(unit => failed.includes(unit.id)).every(unit => unit.status === "done" && unit.attempts === 1)).toBe(true);
        const after = ctx.model.requests.length;
        const retried = ctx.model.requests.slice(before);
        if (kind === "outline") expect(retried.map(request => unitOf(request.prompt)).slice(0, 2)).toEqual(failed);
        else expect(retried).toHaveLength(2);
        await ctx.manager.changeFailedUnits(started.id, "retry", failed);
        await ctx.manager.whenIdle();
        expect(ctx.model.requests).toHaveLength(after);
    });

    it.each(["outline", "material"] as const)("%s 一键跳过仅改变失败项，整批完成后才启动后续阶段", async kind => {
        const ctx = setup(request => request.prompt.includes("请提取 chapter:") || request.prompt.includes("请提取 extract:") ? "坏产出" : `OK:${unitOf(request.prompt)}`);
        const started = await ctx.manager.start({kind, source: testSource(), params: kind === "outline" ? LAYOUT : {blocks: ["b1"], categories: ["x", "y"]}});
        await ctx.manager.whenIdle();
        const task = await ctx.manager.get(started.id);
        const failed = task.units.filter(unit => unit.status === "failed").map(unit => unit.id);
        const before = ctx.model.requests.length;
        await ctx.manager.changeFailedUnits(started.id, "skip", failed);
        await ctx.manager.whenIdle();
        const next = await ctx.manager.get(started.id);
        expect(next.units.filter(unit => failed.includes(unit.id)).map(unit => unit.status)).toEqual(["skipped", "skipped"]);
        expect(next.status).toBe(kind === "outline" ? "completed" : "awaiting-input");
        expect(ctx.model.requests.length - before).toBe(kind === "outline" ? 2 : 0);
    });

    it("批量请求包含不存在的 ID 时整批拒绝，已恢复条目只跳过而不报错", async () => {
        const ctx = setup(() => "坏产出");
        const started = await ctx.startOutline();
        await ctx.manager.whenIdle();
        await expect(ctx.manager.changeFailedUnits(started.id, "skip", ["chapter:c1", "missing"])).rejects.toMatchObject({code: "NOT_FOUND"});
        expect((await ctx.manager.get(started.id)).units[0]!.status).toBe("failed");
        await ctx.manager.changeFailedUnits(started.id, "skip", ["chapter:c1"]);
        await ctx.manager.whenIdle();
        await ctx.manager.changeFailedUnits(started.id, "retry", ["chapter:c1", "chapter:c2"]);
        await ctx.manager.whenIdle();
        expect((await ctx.manager.get(started.id)).units[0]!.status).toBe("skipped");
    });

    it("活动任务批量操作不触碰正在运行项，也不自动重试点击后新失败的条目", async () => {
        const entered = createGate();
        const release = createGate();
        let failFirst = true;
        const ctx = setup(async request => {
            const id = unitOf(request.prompt);
            if (id === "chapter:c1") return failFirst ? "坏" : "OK:第一章";
            if (id === "chapter:c2") {entered.open(); await release.wait; return "坏";}
            return `OK:${id}`;
        });
        const started = await ctx.startOutline();
        await entered.wait;
        failFirst = false;
        try {
            await ctx.manager.changeFailedUnits(started.id, "retry", ["chapter:c1", "chapter:c2"]);
            expect((await ctx.manager.get(started.id)).units[1]!.status).toBe("running");
        } finally { release.open(); }
        await ctx.manager.whenIdle();
        expect(statuses(await ctx.manager.get(started.id))).toMatchObject({"chapter:c1": "done", "chapter:c2": "failed"});
        expect(ctx.model.requests.filter(request => unitOf(request.prompt) === "chapter:c2")).toHaveLength(2);
    });
    it("新建任务固定提示词版本，失败重试沿用原版本，新任务才捕获更新", async () => {
        let fail = true;
        const capture = vi.fn().mockResolvedValue("a".repeat(64));
        const {manager, startOutline, store} = setup(request => unitOf(request.prompt) === "chapter:c1" && fail
            ? "坏" : `OK:${unitOf(request.prompt)}`, {capturePromptSnapshot: capture});
        const started = await startOutline();
        await manager.whenIdle();
        expect((await store.read(started.id))!.promptSnapshotId).toBe("a".repeat(64));
        capture.mockResolvedValue("b".repeat(64));
        fail = false;
        await manager.retryUnit(started.id, "chapter:c1");
        await manager.whenIdle();
        expect((await manager.get(started.id)).promptSnapshotId).toBe("a".repeat(64));
        expect(capture).toHaveBeenCalledOnce();
        const next = await startOutline();
        await manager.whenIdle();
        expect(next.promptSnapshotId).toBe("b".repeat(64));
        expect(capture).toHaveBeenCalledTimes(2);
    });

    it("按依赖顺序串行执行：章节 → 卷汇总 → 总纲，每次状态变化都落盘", async () => {
        const writes: string[] = [];
        const inner = createMemoryExtractionStore();
        const recording = {...inner, async write(task: ExtractionTask) { writes.push(task.units.map(unit => unit.status[0]).join("")); await inner.write(task); }};
        const {manager, model, startOutline} = setup(undefined, {store: recording});
        const started = await startOutline();
        expect(started.status).toBe("running");
        await manager.whenIdle();
        const task = await manager.get(started.id);
        expect(task.status).toBe("completed");
        expect(model.requests.map(request => unitOf(request.prompt))).toEqual(["chapter:c1", "chapter:c2", "volume:v1", "total"]);
        expect(model.requests[2]!.prompt).toContain("chapter:c1 => chapter:c1");
        expect(task.state["result:total"]).toBe("total");
        // 单元进入 running 与进入 done 都有一次落盘。
        expect(writes).toContain("rppp");
        expect(writes.at(-1)).toBe("dddd");
    });

    it("校验连续两次失败的单元标记失败，其余单元继续；依赖它的汇总被推迟", async () => {
        const {manager, model, startOutline} = setup(request => unitOf(request.prompt) === "chapter:c1" ? "坏产出" : `OK:${unitOf(request.prompt)}`);
        const started = await startOutline();
        await manager.whenIdle();
        const task = await manager.get(started.id);
        expect(task.status).toBe("partial-failed");
        expect(statuses(task)).toEqual({"chapter:c1": "failed", "chapter:c2": "done", "volume:v1": "pending", total: "pending"});
        const failed = task.units[0]!;
        expect(failed.attempts).toBe(2);
        expect(failed.error).toContain("连续 2 次");
        expect(model.requests).toHaveLength(3);
    });

    it("首次校验失败、修复后通过的单元记录两次尝试且保持完成", async () => {
        const {manager, startOutline} = setup((request, index) => index === 0 ? "坏" : `OK:${unitOf(request.prompt)}`);
        const task = await startOutline();
        await manager.whenIdle();
        const done = await manager.get(task.id);
        expect(done.status).toBe("completed");
        expect(done.units[0]).toMatchObject({status: "done", attempts: 2});
    });

    it("重试单元只重做该单元并清零次数，已完成单元不再请求", async () => {
        let fail = true;
        const {manager, model, startOutline} = setup(request => unitOf(request.prompt) === "chapter:c1" && fail ? "坏" : `OK:${unitOf(request.prompt)}`);
        const started = await startOutline();
        await manager.whenIdle();
        fail = false;
        const before = model.requests.length;
        const restarted = await manager.retryUnit(started.id, "chapter:c1");
        expect(restarted.units[0]).toMatchObject({status: "pending", attempts: 0, error: null});
        await manager.whenIdle();
        const task = await manager.get(started.id);
        expect(task.status).toBe("completed");
        expect(task.units[0]).toMatchObject({status: "done", attempts: 1});
        expect(model.requests.slice(before).map(request => unitOf(request.prompt))).toEqual(["chapter:c1", "volume:v1", "total"]);
    });

    it("明确跳过失败章节后，卷汇总按已完成部分继续，任务完成", async () => {
        const {manager, model, startOutline} = setup(request => unitOf(request.prompt) === "chapter:c1" ? "坏" : `OK:${unitOf(request.prompt)}`);
        const started = await startOutline();
        await manager.whenIdle();
        const skipped = await manager.skipUnit(started.id, "chapter:c1");
        expect(skipped.units[0]!.status).toBe("skipped");
        await manager.whenIdle();
        const task = await manager.get(started.id);
        expect(task.status).toBe("completed");
        expect(statuses(task)).toEqual({"chapter:c1": "skipped", "chapter:c2": "done", "volume:v1": "done", total: "done"});
        const volumePrompt = model.requests.find(request => unitOf(request.prompt) === "volume:v1")!.prompt;
        expect(volumePrompt).toContain("chapter:c2 =>");
        expect(volumePrompt).not.toContain("chapter:c1 =>");
    });

    it("运行中对失败单元重试：循环稍后重做该单元，不需要重启任务", async () => {
        const gate = createGate();
        let c1Fails = true;
        const {manager, model, startOutline} = setup(async request => {
            const id = unitOf(request.prompt);
            if (id === "chapter:c1" && c1Fails) return "坏";
            if (id === "chapter:c2") await gate.wait;
            return `OK:${id}`;
        });
        const started = await startOutline();
        await vi.waitFor(() => expect(model.requests.map(request => unitOf(request.prompt))).toEqual(["chapter:c1", "chapter:c1", "chapter:c2"]));
        c1Fails = false;
        const live = await manager.retryUnit(started.id, "chapter:c1");
        expect(live.units[0]).toMatchObject({status: "pending", attempts: 0});
        gate.open();
        await manager.whenIdle();
        const task = await manager.get(started.id);
        expect(task.status).toBe("completed");
        expect(model.requests.map(request => unitOf(request.prompt))).toEqual(["chapter:c1", "chapter:c1", "chapter:c2", "chapter:c1", "volume:v1", "total"]);
    });

    it("只有失败或已跳过的单元可重试，只有失败的可跳过；任务已停止时要求先继续", async () => {
        const {manager, startOutline} = setup();
        const started = await startOutline();
        await manager.whenIdle();
        await expect(manager.retryUnit(started.id, "chapter:c1")).rejects.toMatchObject({code: "INVALID_STATE"});
        await expect(manager.skipUnit(started.id, "chapter:c1")).rejects.toMatchObject({code: "INVALID_STATE"});
        await expect(manager.retryUnit(started.id, "missing")).rejects.toMatchObject({code: "INVALID_STATE"});
    });
});

describe("提取任务管理器：取消、继续与中断", () => {
    it("取消保留已完成成果；继续时只执行未完成单元", async () => {
        const gate = createGate();
        const {manager, model, startOutline} = setup(async request => {
            const id = unitOf(request.prompt);
            if (id === "chapter:c2") await gate.wait;
            return `OK:${id}`;
        });
        const started = await startOutline();
        await vi.waitFor(() => expect(model.requests).toHaveLength(2));
        const cancelled = await manager.cancel(started.id);
        expect(cancelled.status).toBe("cancelled");
        expect(statuses(cancelled)).toEqual({"chapter:c1": "done", "chapter:c2": "pending", "volume:v1": "pending", total: "pending"});
        expect(await manager.cancel(started.id)).toMatchObject({status: "cancelled"});
        const before = model.requests.length;
        gate.open();
        await manager.resume(started.id);
        await manager.whenIdle();
        const task = await manager.get(started.id);
        expect(task.status).toBe("completed");
        expect(model.requests.slice(before).map(request => unitOf(request.prompt))).toEqual(["chapter:c2", "volume:v1", "total"]);
    });

    it("已完成的任务不能取消或继续", async () => {
        const {manager, startOutline} = setup();
        const started = await startOutline();
        await manager.whenIdle();
        await expect(manager.cancel(started.id)).rejects.toMatchObject({code: "INVALID_STATE"});
        await expect(manager.resume(started.id)).rejects.toMatchObject({code: "INVALID_STATE"});
    });

    it("运行中的任务不能再 resume", async () => {
        const gate = createGate();
        const {manager, model, startOutline} = setup(async request => { await gate.wait; return `OK:${unitOf(request.prompt)}`; });
        const started = await startOutline();
        await vi.waitFor(() => expect(model.requests).toHaveLength(1));
        await expect(manager.resume(started.id)).rejects.toMatchObject({code: "INVALID_STATE"});
        gate.open();
        await manager.whenIdle();
    });

    it("项目关闭让任务中断而不是取消，进行中的单元回到等待", async () => {
        const gate = createGate();
        const {manager, model, host, startOutline} = setup(async request => {
            const id = unitOf(request.prompt);
            if (id === "chapter:c2") await gate.wait;
            return `OK:${id}`;
        });
        const started = await startOutline();
        await vi.waitFor(() => expect(model.requests).toHaveLength(2));
        host.closeProject();
        await manager.whenIdle();
        const task = await manager.get(started.id);
        expect(task).toMatchObject({status: "interrupted", stopReason: null});
        expect(statuses(task)).toMatchObject({"chapter:c1": "done", "chapter:c2": "pending"});
    });

    it("重启后没有活动执行者的“运行中”记录读成已中断，并可继续", async () => {
        const gate = createGate();
        const first = setup(async request => {
            const id = unitOf(request.prompt);
            if (id === "chapter:c2") await gate.wait;
            return `OK:${id}`;
        });
        const started = await first.startOutline();
        await vi.waitFor(() => expect(first.model.requests).toHaveLength(2));
        const persisted = first.store.snapshot();
        expect(persisted[0]).toMatchObject({status: "running"});
        expect(persisted[0]!.units[1]!.status).toBe("running");

        // 以上一代遗留的记录启动一个新的管理器，即“进程重启”。
        const restartedStore = createMemoryExtractionStore();
        for (const task of persisted) await restartedStore.write(task);
        const second = setup(undefined, {store: restartedStore});
        const viewed = await second.manager.get(started.id);
        expect(viewed.status).toBe("interrupted");
        expect(viewed.units[1]!.status).toBe("pending");
        expect((await second.manager.progress(started.id)).status).toBe("interrupted");
        expect((await second.manager.list())[0]!.status).toBe("interrupted");
        // 读取不写回：存储里仍是上一代留下的原始记录。
        expect((await restartedStore.read(started.id))!.status).toBe("running");

        await second.manager.resume(started.id);
        await second.manager.whenIdle();
        expect((await second.manager.get(started.id)).status).toBe("completed");
        expect(second.model.requests.map(request => unitOf(request.prompt))).toEqual(["chapter:c2", "volume:v1", "total"]);

        first.host.closeProject();
        await first.manager.whenIdle();
    });
});

describe("提取任务管理器：唯一性与来源复核", () => {
    it("同一来源同一种类只能有一个运行中任务；冲突时不调用 prepare", async () => {
        const gate = createGate();
        const {manager, model, pipelines, startOutline} = setup(async request => { await gate.wait; return `OK:${unitOf(request.prompt)}`; });
        const prepare = vi.spyOn(pipelines.outline, "prepare");
        const [first, second] = await Promise.allSettled([startOutline(), startOutline()]);
        expect(first.status).toBe("fulfilled");
        expect(second).toMatchObject({status: "rejected", reason: {code: "CONFLICT"}});
        expect(prepare).toHaveBeenCalledTimes(1);

        // 不同来源、不同种类互不占用。
        await expect(startOutline("reference/other.md")).resolves.toMatchObject({status: "running"});
        await expect(manager.start({kind: "material", source: testSource("reference/novel.md", SOURCE_HASH), params: {blocks: ["b1"], categories: ["人物"]}})).resolves.toMatchObject({kind: "material"});

        // 取消释放占用，之后可以重新开始。
        const id = (first as PromiseFulfilledResult<ExtractionTask>).value.id;
        await vi.waitFor(() => expect(model.requests.length).toBeGreaterThan(0));
        await manager.cancel(id);
        await expect(startOutline()).resolves.toMatchObject({status: "running"});
        gate.open();
        await manager.whenIdle();
    });

    it("已取消或部分失败的任务继续时同样受唯一性约束", async () => {
        const gate = createGate();
        const {manager, model, startOutline} = setup(async request => { await gate.wait; return `OK:${unitOf(request.prompt)}`; });
        const first = await startOutline();
        await vi.waitFor(() => expect(model.requests.length).toBeGreaterThan(0));
        await manager.cancel(first.id);
        await startOutline();
        await expect(manager.resume(first.id)).rejects.toMatchObject({code: "CONFLICT"});
        gate.open();
        await manager.whenIdle();
    });

    it("启动时来源哈希不一致则拒绝，不创建任务也不占用来源", async () => {
        const {manager, sourceHash, store, startOutline} = setup();
        sourceHash.current = "b".repeat(64);
        await expect(startOutline()).rejects.toMatchObject({code: "SOURCE_CHANGED"});
        expect(store.snapshot()).toHaveLength(0);
        sourceHash.current = SOURCE_HASH;
        await expect(startOutline()).resolves.toMatchObject({status: "running"});
        await manager.whenIdle();
    });

    it("继续前来源已变化则拒绝，存储记录保持不变", async () => {
        const gate = createGate();
        const {manager, model, sourceHash, store, startOutline} = setup(async request => { await gate.wait; return `OK:${unitOf(request.prompt)}`; });
        const started = await startOutline();
        await vi.waitFor(() => expect(model.requests).toHaveLength(1));
        await manager.cancel(started.id);
        const before = JSON.stringify(store.snapshot());
        sourceHash.current = "c".repeat(64);
        await expect(manager.resume(started.id)).rejects.toMatchObject({code: "SOURCE_CHANGED"});
        expect(JSON.stringify(store.snapshot())).toBe(before);
    });

    it("运行中来源变化：下一次模型调用前复核失败，任务中断并记录原因，不再请求", async () => {
        const {manager, model, sourceHash, startOutline} = setup(request => {
            sourceHash.current = "d".repeat(64);
            return `OK:${unitOf(request.prompt)}`;
        });
        const started = await startOutline();
        await manager.whenIdle();
        const task = await manager.get(started.id);
        expect(task.status).toBe("interrupted");
        expect(task.stopReason).toMatchObject({code: "source-changed"});
        expect(task.stopReason!.message).toContain("来源已变化");
        expect(model.requests).toHaveLength(1);
        expect(statuses(task)).toMatchObject({"chapter:c1": "done", "chapter:c2": "pending"});
        await expect(manager.resume(started.id)).rejects.toMatchObject({code: "SOURCE_CHANGED"});
    });

    it("宿主拒绝运行（项目未打开）时不留下占用，之后可重新开始", async () => {
        let reject = true;
        const host = createTestLaunch();
        const {manager, startOutline} = setup(undefined, {launch: body => { if (reject) throw new Error("项目未打开"); host.launch(body); }});
        await expect(startOutline()).rejects.toThrow("项目未打开");
        reject = false;
        await expect(startOutline()).resolves.toMatchObject({status: "running"});
        await manager.whenIdle();
    });

    it("流水线未注册或 prepare 失败时不创建任务，也不占用来源", async () => {
        const {store, startOutline} = setup(undefined, {pipelines: {outline: {...createLayeredPipeline(), prepare: async () => { throw new ExtractionTaskError("INVALID_INPUT", "参数不对"); }}}});
        await expect(startOutline()).rejects.toMatchObject({code: "INVALID_INPUT"});
        expect(store.snapshot()).toHaveLength(0);

        const unregistered = new ExtractionTaskManager({
            store: createMemoryExtractionStore(), model: createScriptedModel(() => "OK:x"), verifySource: async () => undefined,
            resolvePipeline: () => { throw new ExtractionTaskError("PIPELINE_UNREGISTERED", "尚未提供"); }, launch: createTestLaunch().launch,
        });
        await expect(unregistered.start({kind: "material", source: testSource(), params: {}})).rejects.toMatchObject({code: "PIPELINE_UNREGISTERED"});
    });
});

describe("提取任务管理器：任务级错误", () => {
    it("模型不可用是任务级错误：任务中断、单元回到等待，不把所有单元标记失败", async () => {
        const {manager, startOutline} = setup(() => { throw new ExtractionFatalError("model-unavailable", "尚无可用的提取模型"); });
        const started = await startOutline();
        await manager.whenIdle();
        const task = await manager.get(started.id);
        expect(task).toMatchObject({status: "interrupted", stopReason: {code: "model-unavailable"}});
        expect(task.units.every(unit => unit.status === "pending")).toBe(true);
    });

    it("模型端口的普通错误（超时等）只让当前单元失败，并保留错误摘要", async () => {
        const {manager, startOutline} = setup(request => {
            if (unitOf(request.prompt) === "chapter:c1") throw new Error("请求超时\n   第二行");
            return `OK:${unitOf(request.prompt)}`;
        });
        const started = await startOutline();
        await manager.whenIdle();
        const task = await manager.get(started.id);
        expect(task.status).toBe("partial-failed");
        expect(task.units[0]).toMatchObject({status: "failed", error: "请求超时 第二行"});
    });

    it("流水线自身的缺陷停止任务并记录 unexpected，而不是静默完成", async () => {
        const broken: ExtractionPipeline = {...createLayeredPipeline(), readyUnits: () => [{id: "ghost", step: "x", label: "x", group: null, status: "pending", attempts: 0, error: null, data: {}}]};
        const {manager, log, startOutline} = setup(undefined, {pipelines: {outline: broken}});
        const started = await startOutline();
        await manager.whenIdle();
        const task = await manager.get(started.id);
        expect(task).toMatchObject({status: "interrupted", stopReason: {code: "unexpected"}});
        expect(log).toHaveBeenCalledWith("inspiration.extraction.runFailed", expect.objectContaining({taskId: started.id}));
    });

    it("没有失败却仍有无法调度的单元时不会标为完成", async () => {
        const stalled: ExtractionPipeline = {...createLayeredPipeline(), readyUnits: () => []};
        const {manager, startOutline} = setup(undefined, {pipelines: {outline: stalled}});
        const started = await startOutline();
        await manager.whenIdle();
        expect((await manager.get(started.id)).stopReason).toMatchObject({code: "unexpected"});
    });
});

describe("提取任务管理器：等待人工输入与动态追加", () => {
    const materialInput = {kind: "material" as const, source: testSource(), params: {blocks: ["b1", "b2"], categories: ["人物", "地点"]}};

    it("块 × 类别单元全部完成后暂停等待输入；输入被接受后追加整合单元并继续到完成", async () => {
        const {manager, model} = setup();
        const started = await manager.start(materialInput);
        await manager.whenIdle();
        const waiting = await manager.get(started.id);
        expect(waiting).toMatchObject({status: "awaiting-input", awaitingInput: "等待归类确认"});
        expect(waiting.units).toHaveLength(4);
        // 同一块的不同类别共享逐字节相同的提示词前缀。
        const [first, second] = model.requests;
        const shared = "【原文】b1";
        expect(first!.prompt.startsWith(shared)).toBe(true);
        expect(second!.prompt.startsWith(shared)).toBe(true);

        await expect(manager.provideInput(started.id, {confirmed: false})).rejects.toMatchObject({code: "INVALID_INPUT"});
        expect((await manager.get(started.id)).status).toBe("awaiting-input");
        await expect(manager.resume(started.id)).rejects.toMatchObject({code: "INVALID_STATE"});

        await manager.provideInput(started.id, {confirmed: true});
        await manager.whenIdle();
        const done = await manager.get(started.id);
        expect(done.status).toBe("completed");
        expect(done.units.map(unit => unit.id).slice(4)).toEqual(["integrate:人物", "integrate:地点"]);
        expect(done.units.every(unit => unit.status === "done")).toBe(true);
        const progress = await manager.progress(started.id);
        expect(progress.groups.map(group => group.group)).toEqual(["b1", "b2", "整合"]);
        expect(progress.overall).toMatchObject({total: 6, done: 6});
    });

    it("等待输入的任务可以放弃，也只在等待输入时接受输入", async () => {
        const {manager} = setup();
        const started = await manager.start(materialInput);
        await manager.whenIdle();
        expect((await manager.cancel(started.id)).status).toBe("cancelled");
        await expect(manager.provideInput(started.id, {confirmed: true})).rejects.toMatchObject({code: "INVALID_STATE"});
    });

    it("流水线不接受输入时 provideInput 报状态错误", async () => {
        const {manager, startOutline} = setup(request => unitOf(request.prompt) === "chapter:c1" ? "坏" : `OK:${unitOf(request.prompt)}`);
        const started = await startOutline();
        await manager.whenIdle();
        await expect(manager.provideInput(started.id, {})).rejects.toMatchObject({code: "INVALID_STATE"});
    });
});

describe("提取任务管理器：查询", () => {
    it("get 对不存在的任务报 NOT_FOUND；list 可按种类与来源过滤", async () => {
        const {manager, startOutline} = setup();
        await expect(manager.get("00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({code: "NOT_FOUND"});
        await startOutline("reference/a.md");
        await startOutline("reference/b.md");
        await manager.whenIdle();
        expect(await manager.list()).toHaveLength(2);
        expect(await manager.list({sourcePath: "reference/a.md"})).toHaveLength(1);
        expect(await manager.list({kind: "material"})).toHaveLength(0);
    });

    it("运行中的 get 与 progress 读内存真值，返回副本而不是内部对象", async () => {
        const gate = createGate();
        const {manager, model, startOutline} = setup(async request => { await gate.wait; return `OK:${unitOf(request.prompt)}`; });
        const started = await startOutline();
        await vi.waitFor(() => expect(model.requests).toHaveLength(1));
        const progress = await manager.progress(started.id);
        expect(progress.status).toBe("running");
        expect(progress.overall).toMatchObject({total: 4, running: 1, pending: 3});
        const view = await manager.get(started.id);
        view.units[0]!.status = "done";
        expect((await manager.get(started.id)).units[0]!.status).toBe("running");
        gate.open();
        await manager.whenIdle();
    });

    it("删除任务会停止活动执行者并移除存储记录", async () => {
        const gate = createGate();
        const {manager, model, store, startOutline} = setup(async request => {
            await gate.wait;
            return `OK:${unitOf(request.prompt)}`;
        });
        const started = await startOutline();
        await vi.waitFor(() => expect(model.requests).toHaveLength(1));
        const removing = manager.remove(started.id);
        gate.open();
        await removing;
        await manager.whenIdle();
        expect(await store.read(started.id)).toBeNull();
        await expect(manager.get(started.id)).rejects.toMatchObject({code: "NOT_FOUND"});
    });
});
