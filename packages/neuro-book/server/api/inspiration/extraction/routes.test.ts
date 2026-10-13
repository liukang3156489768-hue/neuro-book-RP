import {randomUUID} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createGate} from "nbook/server/inspiration/extraction/testing";
import {createMaterialEnv, MATERIAL_SOURCE_PATH, runMaterialPipeline, startMaterialTask, type MaterialEnv} from "nbook/server/inspiration/extraction/material.fixture";
import {MaterialReviewService} from "nbook/server/inspiration/extraction/material-review-service";
import {createTaskSerializer, type ExtractionServices} from "nbook/server/inspiration/extraction/host";
import {listClassification} from "nbook/server/inspiration/extraction/material-consolidate";

/**
 * `/api/inspiration/extraction/**` 路由的边界测试：h3 与项目守卫替身 + 真实管理器 + Mock 模型 + 临时项目，
 * 不接入真实模型。服务端流水线与审阅服务的行为由各自的测试覆盖，这里只验证路由合同：
 * 参数校验、项目未打开、领域错误到状态码的映射、确认者身份、取消与继续、来源哈希变化被拒绝。
 */

const mocks = vi.hoisted(() => ({
    query: {} as Record<string, unknown>,
    body: {} as Record<string, unknown>,
    params: {} as Record<string, string>,
    guardError: null as Error | null,
    status: 0,
    services: null as unknown,
    root: "",
}));

vi.mock("h3", async importOriginal => ({
    ...await importOriginal<typeof import("h3")>(),
    getQuery: () => mocks.query,
    readBody: async () => mocks.body,
    getRouterParam: (_event: unknown, name: string) => mocks.params[name],
    setResponseStatus: (_event: unknown, code: number) => { mocks.status = code; },
}));
vi.mock("nbook/server/runtime/paths/runtime-paths", () => ({runtimePathsFromEnv: () => ({})}));
vi.mock("nbook/server/workspace-files/novel-workspace", () => ({
    resolveWorkspaceFileTarget: async () => ({kind: "project-workspace", root: mocks.root, projectRoot: "novel"}),
}));
vi.mock("nbook/server/workspace-files/project-open-guard", () => {
    const guarded = async (_first: unknown, handler: () => Promise<unknown>) => {
        if (mocks.guardError) throw mocks.guardError;
        return handler();
    };
    return {
        withProjectHandlesOperation: guarded,
        withProjectTargetOperation: guarded,
        withProjectTargetMutation: async (_target: unknown, action: (handles: undefined) => unknown) => action(undefined),
    };
});
vi.mock("nbook/server/inspiration/extraction/host", async importOriginal => ({
    ...await importOriginal<typeof import("nbook/server/inspiration/extraction/host")>(),
    useProjectExtractionServices: async () => mocks.services,
}));

import structureHandler from "./structure.post";
import structureConfirmHandler from "./structure-confirm.post";
import destinationsHandler from "./outline/destinations.get";
import listHandler from "./tasks/index.get";
import startHandler from "./tasks/index.post";
import detailHandler from "./tasks/[taskId]/index.get";
import removeHandler from "./tasks/[taskId]/index.delete";
import cancelHandler from "./tasks/[taskId]/cancel.post";
import resumeHandler from "./tasks/[taskId]/resume.post";
import retryHandler from "./tasks/[taskId]/retry-unit.post";
import skipHandler from "./tasks/[taskId]/skip-unit.post";
import failedUnitsHandler from "./tasks/[taskId]/failed-units.post";
import inputHandler from "./tasks/[taskId]/input.post";
import outlineOutcomeHandler from "./tasks/[taskId]/outline.get";
import resummarizeHandler from "./tasks/[taskId]/outline/resummarize.post";
import classificationHandler from "./tasks/[taskId]/material/classification.get";
import reviewHandler from "./tasks/[taskId]/material/review.get";
import reviewActionHandler from "./tasks/[taskId]/material/review/action.post";
import conflictsHandler from "./tasks/[taskId]/material/review/conflicts.get";
import confirmWriteHandler from "./tasks/[taskId]/material/confirm-write.post";

const event = {} as never;
const PROJECT = {projectRoot: "novel"};

let env: MaterialEnv;
let events: string[];
let resummarizeGate: ReturnType<typeof createGate>;

function buildServices(current: MaterialEnv): ExtractionServices {
    const serialize = createTaskSerializer();
    return {
        root: current.root,
        manager: current.manager,
        review: new MaterialReviewService({target: current.target, tasks: current.manager, model: current.model}),
        classification: async taskId => listClassification(await current.manager.get(taskId)),
        serialize,
        withSignal: action => action(new AbortController().signal),
        destinations: async sourcePath => ({source: {path: sourcePath, sha256: "b".repeat(64)}, options: []}),
        // 与真实实现一样走同一个按任务串行队列；门用来把它停在“进行中”。
        resummarize: taskId => serialize(taskId, async () => {
            events.push("resummarize:start");
            await resummarizeGate.wait;
            events.push("resummarize:end");
            return {volumes: [], total: false} as never;
        }),
    };
}

async function useRoute(taskId: string, body: Record<string, unknown> = PROJECT, query: Record<string, unknown> = PROJECT) {
    mocks.params = {taskId};
    mocks.body = body;
    mocks.query = query;
}

beforeEach(async () => {
    events = [];
    resummarizeGate = createGate();
    mocks.guardError = null;
    mocks.status = 0;
    mocks.params = {};
    mocks.body = {...PROJECT};
    mocks.query = {...PROJECT};
});

afterEach(async () => {
    resummarizeGate.open();
    await env?.manager.whenIdle();
    await env?.cleanup();
});

async function setup(options: Parameters<typeof createMaterialEnv>[0] = {}): Promise<MaterialEnv> {
    env = await createMaterialEnv(options);
    mocks.root = env.root;
    mocks.services = buildServices(env);
    return env;
}

describe("参数校验", () => {
    it("批量失败项请求拒绝空名单、非法动作和额外字段", async () => {
        await setup();
        for (const body of [
            {...PROJECT, action: "retry", unitIds: []},
            {...PROJECT, action: "delete", unitIds: ["u1"]},
            {...PROJECT, action: "retry", unitIds: ["u1"], extra: true},
        ]) {
            await useRoute(randomUUID(), body);
            await expect(failedUnitsHandler(event)).rejects.toMatchObject({statusCode: 400, data: {code: "INVALID_REQUEST"}});
        }
    });
    it("任务 ID 不是 UUID 时 400，且不触碰任何任务", async () => {
        await setup();
        await useRoute("../../etc");
        await expect(detailHandler(event)).rejects.toMatchObject({statusCode: 400, data: {code: "INVALID_REQUEST"}});
        await expect(cancelHandler(event)).rejects.toMatchObject({statusCode: 400});
    });

    it("请求体 strict：多余字段、缺少项目、非法种类都是 400", async () => {
        await setup();
        await useRoute(randomUUID(), {projectRoot: "novel", extra: 1});
        await expect(cancelHandler(event)).rejects.toMatchObject({statusCode: 400});
        await useRoute(randomUUID(), {});
        await expect(cancelHandler(event)).rejects.toMatchObject({statusCode: 400});
        mocks.body = {...PROJECT, kind: "unknown", source: {path: MATERIAL_SOURCE_PATH, sha256: "a".repeat(64)}};
        await expect(startHandler(event)).rejects.toMatchObject({statusCode: 400});
        mocks.body = {...PROJECT, kind: "material", source: {path: "../outside.md", sha256: "a".repeat(64)}};
        await expect(startHandler(event)).rejects.toMatchObject({statusCode: 400});
        mocks.body = {...PROJECT, kind: "material", source: env.source, categories: ["not-a-category"]};
        await expect(startHandler(event)).rejects.toMatchObject({statusCode: 400});
    });

    it("人工输入的形状：两种都不是的 400；大纲覆盖确认送给素材任务 422，且不进入流水线", async () => {
        const current = await setup();
        const paused = await startMaterialTask(current);
        expect(paused.status).toBe("awaiting-input");
        await useRoute(paused.id, {...PROJECT, input: {overwrite: "nope"}});
        await expect(inputHandler(event)).rejects.toMatchObject({statusCode: 400, data: {code: "INVALID_REQUEST"}});
        mocks.body = {...PROJECT, input: {confirmedItems: [{chapterIndex: 1, kind: "outline"}]}};
        await expect(inputHandler(event)).rejects.toMatchObject({statusCode: 422, data: {code: "INVALID_INPUT"}});
        expect((await current.manager.get(paused.id)).status).toBe("awaiting-input");
    });

    it("大纲专属读取遇到素材任务时拒绝", async () => {
        const current = await setup();
        const paused = await startMaterialTask(current);
        await useRoute(paused.id);
        await expect(outlineOutcomeHandler(event)).rejects.toMatchObject({statusCode: 409, data: {code: "INVALID_STATE"}});
        await expect(classificationHandler(event)).resolves.toBeDefined();
    });
});

describe("项目未打开", () => {
    it("所有路由在守卫拒绝时原样抛出项目错误，不读取任何数据", async () => {
        await setup();
        mocks.guardError = Object.assign(new Error("项目未打开"), {statusCode: 409});
        // 请求体都是 strict 的，所以每条路由用自己的合法请求，保证拒绝来自守卫而不是校验。
        const path = MATERIAL_SOURCE_PATH;
        const cases: Array<[string, (e: never) => unknown, Record<string, unknown>]> = [
            ["structure", structureHandler, {...PROJECT, path}],
            ["structure-confirm", structureConfirmHandler, {...PROJECT, path, division: {mode: "chunks", chunksPerVolume: 1}}],
            ["start", startHandler, {...PROJECT, kind: "material", source: env.source}],
            ["cancel", cancelHandler, {...PROJECT}],
            ["resume", resumeHandler, {...PROJECT}],
            ["retry-unit", retryHandler, {...PROJECT, unitId: "u"}],
            ["skip-unit", skipHandler, {...PROJECT, unitId: "u"}],
            ["failed-units", failedUnitsHandler, {...PROJECT, action: "retry", unitIds: ["u"]}],
            ["input", inputHandler, {...PROJECT, input: {skip: true}}],
            ["resummarize", resummarizeHandler, {...PROJECT}],
            ["review-action", reviewActionHandler, {...PROJECT, action: {kind: "select", itemIds: ["rv-1"], selected: true}}],
            ["confirm-write", confirmWriteHandler, {...PROJECT}],
        ];
        const reads: Array<[string, (e: never) => unknown, Record<string, unknown>]> = [
            ["destinations", destinationsHandler, {...PROJECT, path}], ["list", listHandler, {...PROJECT}], ["detail", detailHandler, {...PROJECT}],
            ["outline", outlineOutcomeHandler, {...PROJECT}], ["classification", classificationHandler, {...PROJECT}],
            ["review", reviewHandler, {...PROJECT}], ["conflicts", conflictsHandler, {...PROJECT}],
        ];
        mocks.params = {taskId: randomUUID()};
        for (const [name, run, body] of cases) {
            mocks.body = body;
            await expect(Promise.resolve().then(() => run(event)), name).rejects.toMatchObject({statusCode: 409, message: "项目未打开"});
        }
        for (const [name, run, query] of reads) {
            mocks.query = query;
            await expect(Promise.resolve().then(() => run(event)), name).rejects.toMatchObject({statusCode: 409, message: "项目未打开"});
        }
        expect(await env.manager.list()).toEqual([]);
    });
});

describe("来源结构", () => {
    it("字数模式预览返回切分块，非法每卷块数在校验时 422，合法时返回提取结构", async () => {
        await setup();
        mocks.body = {...PROJECT, path: MATERIAL_SOURCE_PATH};
        const preview = await structureHandler(event);
        expect(preview.mode).toBe("chunks");
        expect(preview.chapters.length).toBeGreaterThan(1);
        expect(preview.source.sha256).toBe(env.source.sha256);

        mocks.body = {...PROJECT, path: MATERIAL_SOURCE_PATH, division: {mode: "chunks", chunksPerVolume: 0}};
        await expect(structureConfirmHandler(event)).rejects.toMatchObject({statusCode: 400});
        mocks.body = {...PROJECT, path: MATERIAL_SOURCE_PATH, division: {mode: "chapters", volumes: [{title: null, firstChapterIndex: 1, lastChapterIndex: 1}]}};
        await expect(structureConfirmHandler(event)).rejects.toMatchObject({statusCode: 422});

        mocks.body = {...PROJECT, path: MATERIAL_SOURCE_PATH, division: {mode: "chunks", chunksPerVolume: 1}};
        const confirmed = await structureConfirmHandler(event);
        expect(confirmed.structure.sourceSha256).toBe(env.source.sha256);
        expect(confirmed.structure.volumes.length).toBe(preview.chapters.length);
    });

    it("数据去向选项的来源哈希由服务端给出", async () => {
        await setup();
        mocks.query = {...PROJECT, path: MATERIAL_SOURCE_PATH};
        await expect(destinationsHandler(event)).resolves.toMatchObject({source: {path: MATERIAL_SOURCE_PATH}, options: []});
        mocks.query = {...PROJECT, path: "../x.md"};
        await expect(destinationsHandler(event)).rejects.toMatchObject({statusCode: 400});
    });
});

describe("任务启动、冲突与来源哈希", () => {
    it("启动返回 202 与任务；同一来源已有运行中任务时 409 冲突", async () => {
        const gate = createGate();
        const current = await setup({hook: () => gate.wait.then(() => undefined)});
        mocks.body = {...PROJECT, kind: "material", source: current.source};
        const started = await startHandler(event);
        expect(mocks.status).toBe(202);
        expect(started.task).toMatchObject({kind: "material", status: "running"});

        await expect(startHandler(event)).rejects.toMatchObject({statusCode: 409, data: {code: "CONFLICT"}});
        gate.open();
        await current.manager.whenIdle();

        mocks.query = {...PROJECT, kind: "material", path: current.source.path};
        const listed = await listHandler(event);
        expect(listed.tasks.map(task => task.id)).toEqual([started.task.id]);
        mocks.query = {...PROJECT, kind: "outline"};
        expect((await listHandler(event)).tasks).toEqual([]);
    });

    it("启动时来源哈希与磁盘不一致被拒绝，且不创建任务", async () => {
        const current = await setup();
        mocks.body = {...PROJECT, kind: "material", source: {...current.source, sha256: "c".repeat(64)}};
        await expect(startHandler(event)).rejects.toMatchObject({statusCode: 409, data: {code: "SOURCE_CHANGED"}});
        expect(await current.manager.list()).toEqual([]);
    });

    it("继续任务前来源已被修改则 409，任务保持原状", async () => {
        const current = await setup();
        const paused = await startMaterialTask(current);
        await useRoute(paused.id);
        await cancelHandler(event);
        await writeFile(path.join(current.root, MATERIAL_SOURCE_PATH), "改过的来源\n", "utf8");
        await expect(resumeHandler(event)).rejects.toMatchObject({statusCode: 409, data: {code: "SOURCE_CHANGED"}});
        expect((await current.manager.get(paused.id)).status).toBe("cancelled");
    });
});

describe("任务控制", () => {
    it.each(["retry", "skip"] as const)("批量%s通过实际管理器处理失败项，成功单元保持不变", async action => {
        let fail = true;
        const current = await setup({hook: info => fail && info.kind === "extract" && info.category === "world" ? "invalid" : undefined});
        const paused = await startMaterialTask(current);
        const failed = paused.units.filter(unit => unit.status === "failed").map(unit => unit.id);
        const successful = paused.units.filter(unit => unit.status === "done");
        expect(failed.length).toBeGreaterThan(1);
        await useRoute(paused.id, {...PROJECT, action, unitIds: [...failed, "missing"]});
        await expect(failedUnitsHandler(event)).rejects.toMatchObject({statusCode: 404, data: {code: "NOT_FOUND"}});
        expect(await current.manager.get(paused.id)).toEqual(paused);
        fail = false;
        mocks.body = {...PROJECT, action, unitIds: [...failed, failed[0], successful[0]!.id]};
        expect((await failedUnitsHandler(event)).task.id).toBe(paused.id);
        await current.manager.whenIdle();
        const changed = await current.manager.get(paused.id);
        expect(changed.units.filter(unit => failed.includes(unit.id)).every(unit => unit.status === (action === "retry" ? "done" : "skipped"))).toBe(true);
        expect(changed.units.filter(unit => successful.some(previous => previous.id === unit.id))).toEqual(successful);
    });

    it("删除任务返回确认并移除任务，删除后详情为 404", async () => {
        const current = await setup();
        const task = await startMaterialTask(current);
        await useRoute(task.id);
        const removed = await removeHandler(event);
        expect(removed).toEqual({deleted: true, taskId: task.id});
        await expect(detailHandler(event)).rejects.toMatchObject({statusCode: 404, data: {code: "NOT_FOUND"}});
    });

    it("读取任务、取消（幂等）与继续", async () => {
        const current = await setup();
        const paused = await startMaterialTask(current);
        await useRoute(paused.id);
        const detail = await detailHandler(event);
        expect(detail.task.id).toBe(paused.id);
        expect(detail.progress.status).toBe("awaiting-input");

        expect((await cancelHandler(event)).task.status).toBe("cancelled");
        expect((await cancelHandler(event)).task.status).toBe("cancelled");
        // 取消后的素材任务回到归类暂停点之前的单元都已完成，继续后重新停在等待输入。
        const resumed = await resumeHandler(event);
        await current.manager.whenIdle();
        expect(resumed.task.id).toBe(paused.id);
        expect((await current.manager.get(paused.id)).status).toBe("awaiting-input");
    });

    it("不存在的任务 404；已结束的任务不能取消（409）", async () => {
        const current = await setup();
        await useRoute(randomUUID());
        await expect(detailHandler(event)).rejects.toMatchObject({statusCode: 404, data: {code: "NOT_FOUND"}});
        const done = await runMaterialPipeline(current);
        await useRoute(done.id);
        await expect(cancelHandler(event)).rejects.toMatchObject({statusCode: 409, data: {code: "INVALID_STATE"}});
    });

    it("重试与跳过：单元不存在 404；单元不是失败状态 409，任务记录不变", async () => {
        const current = await setup();
        const paused = await startMaterialTask(current);
        const done = paused.units.find(unit => unit.status === "done")!;
        for (const handler of [retryHandler, skipHandler]) {
            await useRoute(paused.id, {...PROJECT, unitId: "no-such-unit"});
            await expect(handler(event)).rejects.toMatchObject({statusCode: 404, data: {code: "NOT_FOUND"}});
            mocks.body = {...PROJECT, unitId: done.id};
            await expect(handler(event)).rejects.toMatchObject({statusCode: 409, data: {code: "INVALID_STATE"}});
        }
        expect(await current.manager.get(paused.id)).toEqual(paused);
    });

    it("重新汇总与同一任务的取消串行，不交错", async () => {
        const current = await setup();
        const paused = await startMaterialTask(current);
        await useRoute(paused.id);
        const resummarizing = resummarizeHandler(event);
        await vi.waitFor(() => expect(events).toEqual(["resummarize:start"]));
        const original = current.manager.cancel.bind(current.manager);
        const cancelSpy = vi.spyOn(current.manager, "cancel").mockImplementation(async id => {
            events.push("cancel");
            return original(id);
        });
        const cancelling = cancelHandler(event);
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(events).toEqual(["resummarize:start"]);
        resummarizeGate.open();
        await Promise.all([resummarizing, cancelling]);
        expect(events).toEqual(["resummarize:start", "resummarize:end", "cancel"]);
        cancelSpy.mockRestore();
    });
});

describe("素材归类、审阅与确认者身份", () => {
    it("归类列表、审阅清单与审阅操作", async () => {
        const current = await setup();
        const paused = await startMaterialTask(current);
        await useRoute(paused.id);
        const classification = await classificationHandler(event);
        expect(classification.categories.length).toBeGreaterThan(0);

        mocks.body = {...PROJECT, input: {skip: true}};
        await inputHandler(event);
        await current.manager.whenIdle();

        const review = await reviewHandler(event);
        expect(review.items.length).toBeGreaterThan(0);
        const first = review.items[0]!;
        mocks.body = {...PROJECT, action: {kind: "select", itemIds: [first.id], selected: false}};
        const after = await reviewActionHandler(event);
        expect(after.items.find(item => item.id === first.id)?.selected).toBe(false);

        mocks.body = {...PROJECT, action: {kind: "remove", itemId: "rv-999"}};
        await expect(reviewActionHandler(event)).rejects.toMatchObject({statusCode: 404, data: {code: "REVIEW_NOT_FOUND"}});
        mocks.body = {...PROJECT, action: {kind: "select", itemIds: [], selected: true}};
        await expect(reviewActionHandler(event)).rejects.toMatchObject({statusCode: 400});
    });

    it("确认写入：请求体里自报 confirmer 被拒绝，服务端固定使用用户身份", async () => {
        const current = await setup();
        const task = await runMaterialPipeline(current);
        const services = mocks.services as ExtractionServices;
        const spy = vi.spyOn(services.review, "confirmWrite");
        await useRoute(task.id);

        mocks.body = {...PROJECT, confirmer: {kind: "agent", sessionId: "s1"}};
        await expect(confirmWriteHandler(event)).rejects.toMatchObject({statusCode: 400, data: {code: "INVALID_REQUEST"}});
        expect(spy).not.toHaveBeenCalled();

        mocks.body = {...PROJECT};
        const report = await confirmWriteHandler(event);
        expect(spy).toHaveBeenCalledWith(task.id, {confirmer: {kind: "user"}, signal: expect.any(AbortSignal)});
        expect(report.outcomes.every(outcome => outcome.status === "written")).toBe(true);
        const character = (await services.review.get(task.id)).items.find(item => item.category === "character" && item.title === "林舟")!;
        expect(await readFile(path.join(current.root, "lorebook", "character", character.directoryName, "index.md"), "utf8")).toContain("origin: extract");
    });

    it("冲突对照按用户身份判定：用户可以覆盖没有来源标记的设计条目", async () => {
        const current = await setup();
        const task = await runMaterialPipeline(current);
        const character = (await (mocks.services as ExtractionServices).review.get(task.id)).items.find(item => item.category === "character" && item.title === "林舟")!;
        const directory = path.join(current.root, "lorebook", "character", character.directoryName);
        await mkdir(directory, {recursive: true});
        await writeFile(path.join(directory, "index.md"), "---\ntitle: 林舟\n---\n用户亲手写的设定。\n", "utf8");
        await useRoute(task.id);
        const conflicts = await conflictsHandler(event);
        const mine = conflicts.find(conflict => conflict.title === "林舟");
        expect(mine).toMatchObject({overwriteAllowed: true, existing: {origin: "design"}});

        // 未给决定时冲突条目保持待写入，原文件不被改动。
        mocks.body = {...PROJECT};
        const report = await confirmWriteHandler(event);
        expect(report.conflicts.some(conflict => conflict.title === "林舟")).toBe(true);
        expect(await readFile(path.join(directory, "index.md"), "utf8")).toContain("用户亲手写的设定");
    });
});
