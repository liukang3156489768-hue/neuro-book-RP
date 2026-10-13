import fs from "node:fs/promises";
import path from "node:path";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import {MemorySessionStore, MockAgentPort, type AgentPort, type JsonValue, type MockResponder} from "@notnotype/nb-workflow";
import {collectReleasedSqliteHandles} from "../workspace-files/sqlite-handle-release";
import type {ReadyProjectSessionRef} from "nbook/server/workspace-files/project-session-types";
import {PlanningFixture} from "nbook/server/outline/line-graph.fixture";
import {analyzeDetail, confirmDetail} from "nbook/server/outline/detail-analysis";
import {invalidateDependentDetails} from "nbook/server/outline/analysis-invalidation";
import type {OutlineId} from "nbook/server/outline/format";
import {detailBody} from "nbook/server/outline/detail.fixture";

const mocks = vi.hoisted(() => ({
    requireReadyModuleHandle: vi.fn(),
    runReadyProjectOperation: vi.fn(),
}));

vi.mock("nbook/server/workspace-files/project-session", () => ({
    requireReadyModuleHandle: mocks.requireReadyModuleHandle,
    runReadyProjectOperation: mocks.runReadyProjectOperation,
}));
vi.mock("nbook/server/workspace-files/project-file-index", () => ({PROJECT_FILE_INDEX_MODULE_TOKEN: {name: "file-index"}}));
vi.mock("nbook/server/workspace-history/project-history", () => ({
    PROJECT_HISTORY_MODULE_TOKEN: {name: "history"},
    LOCAL_USER_ID: "local",
    recordProjectWrite: vi.fn(async () => undefined),
    recordProjectDelete: vi.fn(async () => undefined),
    recordProjectRename: vi.fn(async () => undefined),
}));

const actor = {kind: "user" as const, userId: "local"};
const roots: string[] = [];

beforeEach(() => {
    vi.clearAllMocks();
    const fileIndex = {mutate: vi.fn(async <T>(operation: () => Promise<T>) => operation())};
    mocks.requireReadyModuleHandle.mockImplementation((_ready, token: {name: string}) => token.name === "file-index" ? fileIndex : {});
    mocks.runReadyProjectOperation.mockImplementation(async (_ready, operation) =>
        operation(new AbortController().signal, () => undefined, async () => undefined));
});
afterEach(async () => {
    collectReleasedSqliteHandles({force: true});
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

async function review(fixture: PlanningFixture, planId: string, detailId: OutlineId): Promise<void> {
    const source = fixture.entry(detailId);
    const request = {planId, entryId: detailId, expectedRevision: fixture.snapshot.manifest.revision,
        expectedVersion: source.value.version, expectedContentHash: source.contentHash};
    const report = await analyzeDetail(fixture.snapshot, request, async () => JSON.stringify({summary: "一致", deviations: [], conflicts: []}));
    fixture.publish(invalidateDependentDetails(fixture.snapshot,
        confirmDetail(fixture.snapshot, request, report, report.report.reportId, true, []).publish));
}

async function syncOutline(root: string, fixture: PlanningFixture): Promise<void> {
    await fs.rm(path.join(root, "outline"), {recursive: true, force: true});
    for (const [relativePath, content] of fixture.files) {
        await fs.mkdir(path.dirname(path.join(root, relativePath)), {recursive: true});
        await fs.writeFile(path.join(root, relativePath), content, "utf8");
    }
}

/**
 * 场景字数须与 Mock 写手的输出字数一致才能在上下 50% 内通过；默认输出“场景n正文。”为 6 字。
 * 整章目标 100 字与场景之和不符，用来产生字数提示。
 */
const detailFor = (words: number) => detailBody({targetWords: 100, scenes: [
    {name: "入城", summary: "主角牵马入城", words, plot: ["要素1"]},
    {name: "夜宿", summary: "客栈里遇见旧识", words, plot: ["要素2"]},
]});

/** 总纲 → 卷一 → 第一章（一份已审阅细纲，两个场景；章节目标字数与场景之和不符），已选方案与文风。 */
async function project(name: string, sceneWords = 6) {
    const root = await createTestTmpRoot("writing-run", name);
    roots.push(root);
    const ready = {publicId: "ready-1", workspace: {root, ref: {projectRoot: "p"}}} as unknown as ReadyProjectSessionRef;
    const fixture = new PlanningFixture();
    const adopt = (planId: string, entryId: OutlineId) => {
        const source = fixture.entry(entryId);
        fixture.library({kind: "adopt-entry", planId, entryId, expectedVersion: source.value.version, expectedContentHash: source.contentHash});
    };
    const {planId, entryId: rootId} = fixture.library({kind: "create-plan", title: "主方案"}) as {planId: string; entryId: string};
    adopt(planId, rootId);
    const volumeId = fixture.library({kind: "create-entry", planId, parentId: rootId, entryKind: "volume", title: "卷一", body: "卷"}).entryId!;
    adopt(planId, volumeId);
    const chapterId = fixture.library({kind: "create-entry", planId, parentId: volumeId, entryKind: "chapter", title: "第一章", body: "章节大纲", targetWords: 100}).entryId!;
    adopt(planId, chapterId);
    const detailId = fixture.library({kind: "create-entry", planId, parentId: chapterId, entryKind: "detail", title: "第一章细纲", body: detailFor(sceneWords)}).entryId!;
    await review(fixture, planId, detailId);
    await syncOutline(root, fixture);
    await fs.mkdir(path.join(root, "lorebook/instruction/文风"), {recursive: true});
    await fs.writeFile(path.join(root, "lorebook/instruction/文风/index.md"),
        "---\ntype: instruction\nsubtype: writing-style\n---\n\n## 文风要求\n克制\n", "utf8");
    const host = await import("./host");
    await host.setReadyWritingPlan(ready, planId, actor);
    await host.setReadyWritingStyle(ready, "lorebook/instruction/文风/index.md", actor);
    const editDetail = async (body: string) => {
        const detail = fixture.entry(detailId);
        fixture.library({kind: "edit-entry", planId, entryId: detailId, expectedVersion: detail.value.version,
            expectedContentHash: detail.contentHash, title: detail.value.title, body});
        await review(fixture, planId, detailId);
        await syncOutline(root, fixture);
    };
    const prose = () => fs.readFile(path.join(root, "manuscript/卷一/第一章/index.md"), "utf8");
    const issues = () => fs.readFile(path.join(root, `writing/issues/${chapterId}.yaml`), "utf8");
    return {root, ready, chapterId, detailId, editDetail, prose, issues};
}

type Turn = Parameters<MockResponder>[0];
const inputOf = (turn: Turn) => turn.input as {[key: string]: JsonValue};

const planOf = (turn: Turn) => {
    const materials = inputOf(turn).materials as {scenes: {index: number; heading: string}[]};
    return {scenes: materials.scenes.map(({index, heading}) => ({index, heading,
        techniques: {points: ["短句"], excerpts: []}, background: {points: [], excerpts: []}, extraMustInclude: []}))};
};
const passing = (turn: Turn) => {
    const index = inputOf(turn).sceneIndex as number;
    return {passed: true, elements: [{element: `要素${index}`, covered: true}], problems: []};
};

type Agents = Readonly<{
    materialReview?: (turn: Turn, call: number) => JsonValue | Promise<JsonValue>;
    plan?: (turn: Turn, call: number) => JsonValue | Promise<JsonValue>;
    review?: (turn: Turn, call: number) => JsonValue | Promise<JsonValue>;
    write?: (turn: Turn, call: number) => string | Promise<string>;
    rewritePlan?: (turn: Turn, call: number) => JsonValue | Promise<JsonValue>;
    rewriteReview?: (turn: Turn, call: number) => JsonValue | Promise<JsonValue>;
    rewrite?: (turn: Turn, call: number) => string | Promise<string>;
}>;

const REWRITE_PLAN = {requirement: "更紧张", perspective: "第三人称", techniques: {points: ["短句"], excerpts: []}, background: {points: [], excerpts: []}};

/** 记录每次调用的助手与写手 Mock；未指定时助手照素材填规划、审阅一律通过，写手按场景输出固定正文，改写输出“改写n。”。 */
function mockAgents(sessions: MemorySessionStore, agents: Agents = {}) {
    const port = new MockAgentPort(sessions);
    const calls = {plan: [] as Turn[], review: [] as Turn[], write: [] as Turn[], rewritePlan: [] as Turn[], rewriteReview: [] as Turn[], rewrite: [] as Turn[]};
    const materialReviews: Turn[] = [];
    port.register("writing.material-review", async turn => {
        materialReviews.push(turn);
        return {message: "资料审核", data: await agents.materialReview?.(turn, materialReviews.length)
            ?? {materialReview: {passed: true, problems: []}}};
    });
    port.register("writing.assistant", async (turn) => {
        if (inputOf(turn).kind === "plan-rewrite") {
            calls.rewritePlan.push(turn);
            return {message: "改写规划", data: await agents.rewritePlan?.(turn, calls.rewritePlan.length) ?? {rewrite: REWRITE_PLAN}};
        }
        if (inputOf(turn).kind === "review-rewrite") {
            calls.rewriteReview.push(turn);
            return {message: "改写审阅", data: await agents.rewriteReview?.(turn, calls.rewriteReview.length) ?? {rewriteReview: {passed: true, problems: []}}};
        }
        if (inputOf(turn).kind === "plan-scenes") {
            calls.plan.push(turn);
            return {message: "规划", data: await agents.plan?.(turn, calls.plan.length) ?? {plan: planOf(turn)}};
        }
        calls.review.push(turn);
        return {message: "审阅", data: await agents.review?.(turn, calls.review.length) ?? {review: passing(turn)}};
    });
    port.register("writing.writer", async (turn) => {
        if ((turn.message ?? "").includes("修改要求")) {
            calls.rewrite.push(turn);
            return {message: await agents.rewrite?.(turn, calls.rewrite.length) ?? `改写${calls.rewrite.length}。`};
        }
        calls.write.push(turn);
        const scene = /本场景（场景 (\d+)/u.exec(turn.message ?? "")?.[1];
        return {message: await agents.write?.(turn, calls.write.length) ?? `场景${scene}正文。`};
    });
    return {port, calls, materialReviews};
}

async function service(ready: ReadyProjectSessionRef, sessions: MemorySessionStore, agents: AgentPort) {
    const {WritingRunService} = await import("./run-service");
    return new WritingRunService({ready, actor, sessions, agents});
}

type Service = Awaited<ReturnType<typeof service>>;

/** 逐轮应答场景规划核对；answers 依次给出每个待应答项的答复，用完后一律通过。 */
async function answerAll(runs: Service, runId: string, answers: JsonValue[] = []) {
    const titles: string[] = [];
    for (;;) {
        const settled = await runs.settle(runId);
        if (settled.status !== "waiting") return {settled, titles};
        const view = await runs.view(runId);
        titles.push(...view.pendingAsks.map(({spec}) => spec.title));
        await runs.answer(runId, Object.fromEntries(view.pendingAsks.map(({key}) => [key, answers.shift() ?? true])));
    }
}

describe("writing chapter workflow", () => {
    it("没有正文时也能查看并忽略阻断条目，同一问题再次提交不阻止写作", async () => {
        const {ready, chapterId, detailId} = await project("ignored-blocking");
        const sessions = new MemorySessionStore();
        const draft = {code: "OTHER", severity: "blocking", message: "用户已确认可以省略该背景", location: {entryId: detailId, sceneIndex: 1}};
        const {port, calls} = mockAgents(sessions, {plan: (turn) => ({plan: planOf(turn), issues: [draft]})});
        const runs = await service(ready, sessions, port);
        const first = await runs.start({chapterEntryId: chapterId, task: "new", mode: "auto"});
        expect((await runs.settle(first.runId)).result).toMatchObject({outcome: "stopped", reason: "blocking-issue"});
        expect(calls.write).toHaveLength(0);
        const host = await import("./host");
        const before = await host.readReadyWritingIssues(ready);
        expect(before.chapters[0]).toMatchObject({chapterEntryId: chapterId, blocking: 1});
        const issueId = before.chapters[0]!.issues.find(issue => issue.severity === "blocking")!.id;
        expect(await host.ignoreReadyWritingIssue(ready, {chapterEntryId: chapterId, issueId}, actor)).toMatchObject({blocking: 0});
        const next = await runs.start({chapterEntryId: chapterId, task: "new", mode: "auto"});
        expect((await runs.settle(next.runId)).result).toMatchObject({outcome: "completed", passedScenes: 2});
        expect((await host.readReadyWritingIssues(ready)).chapters[0]!.issues.find(issue => issue.id === issueId)?.status).toBe("ignored");
    });

    it("整章重写默认保留已确认规划，从场景 1 重写，来源变化后重新规划", async () => {
        const {ready, chapterId, prose, editDetail} = await project("reuse-plan-rewrite");
        const sessions = new MemorySessionStore();
        const {port, calls, materialReviews} = mockAgents(sessions, {write: (_turn, call) => `第${call}次产出的正文。`});
        const runs = await service(ready, sessions, port);
        const first = await runs.start({chapterEntryId: chapterId, task: "new", mode: "auto"});
        expect((await runs.settle(first.runId)).result).toMatchObject({outcome: "completed"});
        const oldProse = await prose();
        const again = await runs.start({chapterEntryId: chapterId, task: "rewrite", mode: "discussion"});
        expect((await runs.settle(again.runId)).result).toMatchObject({outcome: "completed", passedScenes: 2});
        expect(calls.plan).toHaveLength(2);
        expect(materialReviews).toHaveLength(2);
        expect(calls.write).toHaveLength(4);
        expect(calls.write[2]!.message).not.toContain("第1次产出的正文");
        expect(await prose()).not.toBe(oldProse);
        expect(await prose()).toContain("第3次产出的正文");
        expect(await prose()).not.toContain("第1次产出的正文");
        await editDetail(detailFor(7));
        const changed = await runs.start({chapterEntryId: chapterId, task: "rewrite", mode: "auto"});
        expect((await runs.settle(changed.runId)).result).toMatchObject({outcome: "completed"});
        expect(calls.plan).toHaveLength(4);
        expect(materialReviews).toHaveLength(4);
        const fresh = await runs.start({chapterEntryId: chapterId, task: "rewrite", mode: "auto", reusePlan: false});
        await runs.settle(fresh.runId);
        expect(calls.plan).toHaveLength(6);
    });

    it("主创正文删改保留文件与规划，清除旧生成依据；版本冲突及运行中拒绝变更", async () => {
        const {ready, chapterId, prose} = await project("edit-prose");
        const sessions = new MemorySessionStore();
        const {port} = mockAgents(sessions);
        const runs = await service(ready, sessions, port);
        const first = await runs.start({chapterEntryId: chapterId, task: "new", mode: "discussion"});
        await runs.settle(first.runId);
        await expect(runs.editProse({chapterEntryId: chapterId, baseHash: "stale", replacement: ""}))
            .rejects.toMatchObject({code: "RUN_ACTIVE"});
        await answerAll(runs, first.runId);
        const host = await import("./host");
        const read = () => host.readReadyWritingRunFacts(ready, {chapterEntryId: chapterId});
        const original = (await read()).prose!;
        const edited = await runs.editProse({chapterEntryId: chapterId, baseHash: original.hash,
            target: {paragraphs: {from: 2}}, replacement: ""});
        expect(edited.status).toBe("written");
        expect((await read()).prose!.body).toBe("场景1正文。");
        expect(await prose()).toContain(`chapterEntryId: ${chapterId}`);
        expect(await prose()).not.toContain("generatedAt:");
        const afterDelete = await prose();
        expect(await runs.editProse({chapterEntryId: chapterId, baseHash: original.hash, replacement: ""})).toMatchObject({status: "conflict"});
        expect(await prose()).toBe(afterDelete);
        await runs.editProse({chapterEntryId: chapterId, baseHash: edited.hash, target: {quote: "场景1正文"}, replacement: "用户的替换文案。"});
        expect((await read()).prose!.body).toBe("用户的替换文案。");
        await runs.editProse({chapterEntryId: chapterId, baseHash: (await read()).prose!.hash, replacement: ""});
        expect((await read()).prose!.body).toBe("");
        expect((await runs.listChapterRuns(chapterId))[0]).toMatchObject({progress: {plan: {scenes: [{index: 1}, {index: 2}]}}});
        expect((await read()).context).not.toBeNull();
    });

    it("重写首个场景未通过时旧正文保持完整；续写后才替换，并保留已确认规划", async () => {
        const {ready, chapterId, prose} = await project("rewrite-first-scene-fails");
        const sessions = new MemorySessionStore();
        let fail = false;
        const {port, calls} = mockAgents(sessions, {write: () => fail ? "" : "新的场景正文。"});
        const runs = await service(ready, sessions, port);
        const first = await runs.start({chapterEntryId: chapterId, task: "new", mode: "auto"});
        await runs.settle(first.runId);
        const old = await prose();
        fail = true;
        const rewrite = await runs.start({chapterEntryId: chapterId, task: "rewrite", mode: "auto"});
        expect((await runs.settle(rewrite.runId)).result).toMatchObject({outcome: "stopped", reason: "scene-failed", passedScenes: 0});
        expect(await prose()).toBe(old);
        fail = false;
        const continued = await runs.continue({chapterEntryId: chapterId});
        expect((await runs.settle(continued.runId)).result).toMatchObject({outcome: "completed", passedScenes: 2});
        expect(calls.plan).toHaveLength(2);
        expect((await runs.listChapterRuns(chapterId)).find(run => run.runId === continued.runId))
            .toMatchObject({progress: {passed: 2, replaceBody: false}});
    });

    it("逐场景确认后才推进，第二个场景退回只重做第二个；停止后沿用已确认规划", async () => {
        const {ready, chapterId} = await project("sequential-planning");
        const sessions = new MemorySessionStore();
        const {port, calls, materialReviews} = mockAgents(sessions);
        const runs = await service(ready, sessions, port);
        const {runId} = await runs.start({chapterEntryId: chapterId, task: "new", mode: "discussion"});
        const approve = async (id: string, answer: JsonValue = true, answerer: "lead" | "user" = "lead") => {
            await runs.settle(id);
            const [ask] = (await runs.progress(id)).asks;
            await runs.answer(id, {[ask!.key]: answer}, answerer);
            return runs.settle(id);
        };

        await runs.settle(runId);
        expect(calls.plan).toHaveLength(1);
        expect(await runs.progress(runId)).toMatchObject({scenes: [{state: "planning"}, {state: "unplanned"}]});
        await approve(runId);
        expect(calls.plan).toHaveLength(1);
        expect((await runs.progress(runId)).asks[0]!.description).not.toContain("### 场景2");
        await approve(runId, true, "user");
        expect(calls.plan).toHaveLength(2);
        expect(calls.write).toHaveLength(0);
        expect(await runs.progress(runId)).toMatchObject({scenes: [{state: "pending"}, {state: "planning"}]});
        await runs.stop(runId);

        const next = await runs.continue({chapterEntryId: chapterId});
        await runs.settle(next.runId);
        expect(calls.plan).toHaveLength(3);
        await approve(next.runId);
        await approve(next.runId, {approved: false, comments: "夜宿环境更安静"}, "user");
        expect(calls.plan).toHaveLength(4);
        expect(inputOf(calls.plan[3]!).feedback).toEqual({comments: "夜宿环境更安静"});
        expect(calls.plan.map(turn => inputOf(turn).sceneIndex)).toEqual([1, 2, 2, 2]);
        expect(calls.plan.every(turn => (inputOf(turn).materials as {scenes: unknown[]}).scenes.length === 1)).toBe(true);
        expect(materialReviews).toHaveLength(4);
        expect(calls.write).toHaveLength(0);
        expect((await answerAll(runs, next.runId)).settled.result).toMatchObject({outcome: "completed", passedScenes: 2});
    });

    it("自动模式审核当前场景后才规划下一场景，审核退回仅重做当前场景且没有人工待应答", async () => {
        const {ready, chapterId} = await project("automatic-planning");
        const sessions = new MemorySessionStore();
        const order: string[] = [];
        const {port, calls} = mockAgents(sessions, {
            plan: turn => {order.push(`plan-${inputOf(turn).sceneIndex}`); return {plan: planOf(turn)};},
            materialReview: turn => {
                const draft = inputOf(turn).draft as {plan: {scenes: {index: number}[]}};
                const index = draft.plan.scenes[0]!.index;
                order.push(`audit-${index}`);
                const rejected = index === 2 && order.filter(item => item === "audit-2").length === 1;
                return {materialReview: {passed: !rejected, problems: rejected ? ["补充夜宿地点资料"] : []}};
            },
        });
        const runs = await service(ready, sessions, port);
        const {runId} = await runs.start({chapterEntryId: chapterId, task: "new", mode: "auto"});
        const done = await runs.settle(runId);
        expect(done.result).toMatchObject({outcome: "completed", passedScenes: 2});
        expect(order).toEqual(["plan-1", "audit-1", "plan-2", "audit-2", "plan-2", "audit-2"]);
        expect(calls.plan.map(turn => inputOf(turn).sceneIndex)).toEqual([1, 2, 2]);
        expect((await runs.view(runId)).journal.some(({kind}) => kind === "ask")).toBe(false);
        expect((await runs.progress(runId)).asks).toEqual([]);
    });

    it("资料在审核后或正文生成期间改变时，不调用写手或不写入过期产物", async () => {
        for (const duringWriting of [false, true]) {
            const {root, ready, chapterId, prose} = await project(`material-change-${duringWriting}`);
            const materialPath = "lorebook/location/教室/index.md";
            const file = path.join(root, materialPath);
            await fs.mkdir(path.dirname(file), {recursive: true});
            await fs.writeFile(file, "# 环境\n\n后排靠窗。", "utf8");
            const sessions = new MemorySessionStore();
            const {port, calls} = mockAgents(sessions, {
                plan: turn => ({plan: {scenes: planOf(turn).scenes.map(scene => ({...scene,
                    background: {points: ["后排靠窗"], excerpts: [{path: materialPath, heading: "环境"}]}}))}}),
                write: async () => {if (duringWriting) await fs.writeFile(file, "# 环境\n\n后排无窗。", "utf8"); return "场景1正文。";},
            });
            const runs = await service(ready, sessions, port);
            const {runId} = await runs.start({chapterEntryId: chapterId, task: "new", mode: "discussion"});
            await runs.settle(runId);
            if (!duringWriting) await fs.writeFile(file, "# 环境\n\n后排无窗。", "utf8");
            const {settled} = await answerAll(runs, runId);
            expect(settled.result).toMatchObject({outcome: "stopped", reason: "source-unreadable", passedScenes: 0});
            expect(calls.write).toHaveLength(duringWriting ? 1 : 0);
            await expect(prose()).rejects.toMatchObject({code: "ENOENT"});
        }
    });
    it("旧版本等待运行保留记录，续写新建运行并重新补充与审核", async () => {
        const {ready, root, chapterId} = await project("legacy-review");
        const sessions = new MemorySessionStore();
        const {port, calls, materialReviews} = mockAgents(sessions);
        const first = await service(ready, sessions, port);
        const {runId} = await first.start({chapterEntryId: chapterId, task: "new", mode: "discussion"});
        await first.settle(runId);
        const file = path.join(root, "writing/runs", `${runId}.json`);
        const record = JSON.parse(await fs.readFile(file, "utf8"));
        record.definition.version = "3";
        record.definition.manifestHash = "writing.chapter@3";
        await fs.writeFile(file, JSON.stringify(record));
        const restored = await service(ready, sessions, port);
        const next = await restored.continue({chapterEntryId: chapterId});
        expect(next.runId).not.toBe(runId);
        await restored.settle(next.runId);
        expect((await restored.listChapterRuns(chapterId)).find(item => item.runId === runId)?.status).toBe("cancelled");
        expect(calls.plan).toHaveLength(2);
        expect(materialReviews).toHaveLength(2);
        expect(calls.write).toHaveLength(0);
        await answerAll(restored, next.runId);
    });
    it("独立审核退回后先修订再审核，通过前没有写手调用，审核会话与资料助手隔离", async () => {
        const {ready, chapterId} = await project("material-review-retry");
        const sessions = new MemorySessionStore();
        const {port, calls, materialReviews} = mockAgents(sessions, {materialReview: (_turn, call) =>
            ({materialReview: {passed: call > 1, problems: call === 1 ? ["补充走廊资料，保持原情节"] : []}})});
        const runs = await service(ready, sessions, port);
        const {runId} = await runs.start({chapterEntryId: chapterId, task: "new", mode: "discussion"});
        await runs.settle(runId);
        expect(calls.plan).toHaveLength(2);
        expect(calls.write).toHaveLength(0);
        expect(inputOf(calls.plan[1]!).feedback).toEqual({errors: ["补充走廊资料，保持原情节"]});
        expect(materialReviews).toHaveLength(2);
        expect(new Set(materialReviews.map(turn => turn.sessionId)).size).toBe(2);
        expect(materialReviews.every(turn => turn.sessionId !== calls.plan[0]!.sessionId)).toBe(true);
        const completed = await answerAll(runs, runId);
        expect(completed.settled.result).toMatchObject({outcome: "completed"});
    });

    it("独立审核连续退回或提交非法结果耗尽后停止，不生成或写入正文", async () => {
        for (const malformed of [false, true]) {
            const {ready, chapterId, prose} = await project(`material-review-stop-${malformed}`);
            const sessions = new MemorySessionStore();
            const {port, calls, materialReviews} = mockAgents(sessions, {materialReview: () =>
                malformed ? {materialReview: {passed: true, problems: ["矛盾结果"]}} : {materialReview: {passed: false, problems: ["缺少必要环境依据"]}}});
            const runs = await service(ready, sessions, port);
            const {runId} = await runs.start({chapterEntryId: chapterId, task: "new", mode: "auto"});
            const stopped = await runs.settle(runId);
            expect(stopped.result).toMatchObject({outcome: "stopped", reason: malformed ? "material-review-invalid" : "material-rejected"});
            expect(materialReviews).toHaveLength(3);
            expect(calls.write).toHaveLength(0);
            await expect(prose()).rejects.toMatchObject({code: "ENOENT"});
        }
    });
    it("新运行传递写手模板变量，并将固定版本的实际提示词交给审阅", async () => {
        const {ready, chapterId} = await project("managed-writer-review");
        const sessions = new MemorySessionStore();
        const owner = await sessions.createSession({profileKey: "writing.lead", kind: "chat", tags: []});
        const created = vi.spyOn(sessions, "createSession");
        const {port, calls} = mockAgents(sessions);
        const {WritingRunService} = await import("./run-service");
        const actual = {system: "自定义系统规则", user: "自定义正文任务", preMessages: [{role: "assistant" as const, content: "示例"}, {role: "user" as const, content: "自定义正文任务"}]};
        const resolveWriterPrompt = vi.fn(async () => actual);
        const runs = new WritingRunService({ready, actor, sessions, agents: port, resolveWriterPrompt});
        const started = await runs.start({chapterEntryId: chapterId, task: "new", mode: "auto", ownerSessionId: owner.sessionId});
        expect((await answerAll(runs, started.runId)).settled.status).toBe("completed");
        expect(resolveWriterPrompt).toHaveBeenCalledTimes(2);
        expect(calls.review.map(turn => inputOf(turn).prompt)).toEqual([actual, actual]);
        const writers = created.mock.calls.map(([init]) => init).filter(init => init.profileKey === "writing.writer");
        expect(writers.map(init => init.initial)).toEqual([0, 1].map(() => expect.objectContaining({managedPurposeId: "writing.writer.scene", managedVariables: expect.objectContaining({requirements: "克制"})})));
        expect(writers.every(init => init.parentSessionId !== undefined)).toBe(true);
    });
    it("整章完成：场景逐个通过后正文连续、写入依据，提示问题随报告返回", async () => {
        const {ready, chapterId, prose, issues} = await project("complete");
        const sessions = new MemorySessionStore();
        const created = vi.spyOn(sessions, "createSession");
        const {port, calls} = mockAgents(sessions);
        const runs = await service(ready, sessions, port);

        const started = await runs.start({chapterEntryId: chapterId, task: "new", mode: "auto"});
        await expect(runs.start({chapterEntryId: chapterId, task: "new", mode: "auto"})).rejects.toMatchObject({code: "RUN_ACTIVE"});
        const {settled, titles} = await answerAll(runs, started.runId);

        expect(titles).toEqual([]);
        expect(settled).toMatchObject({status: "completed", progress: {passed: 2}, result: {outcome: "completed", passedScenes: 2, totalScenes: 2}});
        expect(settled.result!.hints.map(({code}) => code).sort()).toEqual(["WORD_TARGET_MISMATCH"]);
        const content = await prose();
        expect(content).toContain("场景1正文。\n\n场景2正文。");
        expect(content).toContain("source:");
        expect(calls.write).toHaveLength(2);
        expect(calls.write[1]!.message).toContain("场景1正文。");
        expect(calls.review.map((turn) => inputOf(turn).output)).toEqual(["场景1正文。", "场景2正文。"]);
        // 规划与审阅在同一个助手会话里，写手每个场景都是新会话。
        expect(new Set([...calls.plan, ...calls.review].map(({sessionId}) => sessionId)).size).toBe(1);
        expect(new Set(calls.write.map(({sessionId}) => sessionId)).size).toBe(2);
        // 写手的系统提示随会话初始值进入 Profile，调用本身不带输入。
        expect(calls.write.map(({input}) => input ?? null)).toEqual([null, null]);
        const writerInits = created.mock.calls.map(([init]) => init).filter(({profileKey}) => profileKey === "writing.writer");
        expect(writerInits.map(({initial}) => initial)).toEqual([0, 1].map(() => ({system: expect.stringContaining("## 文风要求")})));
        expect(await issues()).toContain("WORD_TARGET_MISMATCH");
        // 运行记录保留每个场景写手收到的提示与助手的审阅请求。
        const journal = (await runs.view(started.runId)).journal.map(({params}) => params ?? "");
        expect(journal.filter((params) => params.includes("本场景（场景"))).toHaveLength(4);
        expect(journal.filter((params) => params.includes("review-scene"))).toHaveLength(2);
        await expect(runs.start({chapterEntryId: chapterId, task: "new", mode: "auto"}).then(({runId}) => runs.settle(runId)))
            .resolves.toMatchObject({status: "completed", result: {outcome: "stopped", reason: "has-prose"}});
    });

    it("摘录位置非法时退回助手，写手不被调用；连续 3 次未通过即停止", async () => {
        const {ready, chapterId} = await project("plan-invalid");
        const sessions = new MemorySessionStore();
        const excerpt = (turn: Turn) => {
            const plan = planOf(turn);
            plan.scenes[0]!.background.excerpts = [{path: "outline/foreshadowing/ol-fs-x.md", heading: "来历"}] as never;
            return {plan};
        };
        const {port, calls} = mockAgents(sessions, {plan: (turn, call) => call === 1 ? excerpt(turn) : {plan: planOf(turn)}});
        const runs = await service(ready, sessions, port);
        const first = await runs.start({chapterEntryId: chapterId, task: "new", mode: "discussion"});
        expect((await runs.settle(first.runId)).status).toBe("waiting");
        expect(calls.write).toHaveLength(0);
        expect(inputOf(calls.plan[1]!).feedback).toEqual({errors: [expect.stringContaining("outline/foreshadowing/ol-fs-x.md")]});
        await runs.stop(first.runId);

        const invalid = mockAgents(sessions, {plan: (turn) => excerpt(turn)});
        const again = await service(ready, sessions, invalid.port);
        const second = await again.start({chapterEntryId: chapterId, task: "new", mode: "auto"});
        expect(await again.settle(second.runId)).toMatchObject({result: {outcome: "stopped", reason: "plan-invalid"}});
        expect(invalid.calls.plan).toHaveLength(3);
        expect(invalid.calls.write).toHaveLength(0);
    });

    it("主创退回的意见交回助手；退回 3 次即停止", async () => {
        const {ready, chapterId} = await project("plan-rejected");
        const sessions = new MemorySessionStore();
        const {port, calls} = mockAgents(sessions);
        const runs = await service(ready, sessions, port);
        const {runId} = await runs.start({chapterEntryId: chapterId, task: "new", mode: "discussion"});
        const {settled, titles} = await answerAll(runs, runId, [{approved: false, comments: "效果要求太泛"}, false, false]);
        expect(titles).toHaveLength(3);
        expect(inputOf(calls.plan[1]!).feedback).toEqual({comments: "效果要求太泛"});
        expect(settled).toMatchObject({status: "completed", result: {outcome: "stopped", reason: "plan-rejected", passedScenes: 0}});
        expect(calls.write).toHaveLength(0);
    });

    it("讨论模式：主创通过后再交用户确认，用户退回计入退回次数", async () => {
        const {ready, chapterId} = await project("discussion");
        const sessions = new MemorySessionStore();
        const {port, calls} = mockAgents(sessions);
        const runs = await service(ready, sessions, port);
        const {runId} = await runs.start({chapterEntryId: chapterId, task: "new", mode: "discussion"});
        const {settled, titles} = await answerAll(runs, runId, [true, {approved: false, comments: "场景二要更冷"}]);
        expect(titles).toEqual(["核对场景规划（第 1 轮）", "确认场景规划（第 1 轮）", "核对场景规划（第 2 轮）", "确认场景规划（第 2 轮）",
            "核对场景规划（第 1 轮）", "确认场景规划（第 1 轮）"]);
        expect(inputOf(calls.plan[1]!).feedback).toEqual({comments: "场景二要更冷"});
        expect(settled.result).toMatchObject({outcome: "completed"});
    });

    it("场景重写 2 次仍未通过即停止，正文只含此前通过的场景", async () => {
        const {ready, chapterId, prose} = await project("scene-failed");
        const sessions = new MemorySessionStore();
        const {port, calls} = mockAgents(sessions, {review: (turn) => inputOf(turn).sceneIndex === 2
            ? {review: {passed: false, elements: [{element: "要素2", covered: false}], problems: ["节奏太快"]}}
            : {review: passing(turn)}});
        const runs = await service(ready, sessions, port);
        const {runId} = await runs.start({chapterEntryId: chapterId, task: "new", mode: "auto"});
        const {settled} = await answerAll(runs, runId);
        expect(settled.result).toMatchObject({outcome: "stopped", reason: "scene-failed", passedScenes: 1,
            failedScene: {index: 2, heading: "场景2：夜宿", problems: ["节奏太快", "没有写到：要素2"]}});
        expect(calls.write).toHaveLength(4);
        expect(calls.write[2]!.message).toContain("上次产出未通过的问题（本次必须改正）\n\n- 节奏太快\n- 没有写到：要素2");
        const content = await prose();
        expect(content).toContain("场景1正文。");
        expect(content).not.toContain("场景2正文。");
        expect(content).not.toContain("source:");
    });

    it("写作中修改细纲：下一场景开始前停止并登记规划已变化", async () => {
        const {ready, chapterId, editDetail, issues} = await project("planning-changed");
        const sessions = new MemorySessionStore();
        const {port, calls} = mockAgents(sessions, {write: async (_turn, call) => {
            if (call === 1) await editDetail(`${detailFor(6)}\n\n补一句。`);
            return `第${call}次正文。`;
        }});
        const runs = await service(ready, sessions, port);
        const {runId} = await runs.start({chapterEntryId: chapterId, task: "new", mode: "auto"});
        const {settled} = await answerAll(runs, runId);
        expect(settled.result).toMatchObject({outcome: "stopped", reason: "planning-changed", passedScenes: 1});
        expect(calls.write).toHaveLength(1);
        expect(await issues()).toContain("PLANNING_CHANGED");
    });

    it("停止后续写：依据未变时沿用规划，从第一个未通过的场景开始", async () => {
        const {ready, chapterId, prose} = await project("stop-continue");
        const sessions = new MemorySessionStore();
        let stopping: Promise<unknown> | null = null;
        let runs: Service;
        let runId = "";
        const {port, calls} = mockAgents(sessions, {write: (_turn, call) => {
            if (call === 2) stopping = runs.stop(runId);
            return `第${call}次正文。`;
        }});
        runs = await service(ready, sessions, port);
        await expect(runs.continue({chapterEntryId: chapterId})).rejects.toMatchObject({code: "RUN_NOT_FOUND"});
        runId = (await runs.start({chapterEntryId: chapterId, task: "new", mode: "auto"})).runId;
        await answerAll(runs, runId);
        await stopping;
        expect(await runs.settle(runId)).toMatchObject({status: "cancelled", error: null, progress: {passed: 1}});

        const resumed = await runs.continue({chapterEntryId: chapterId});
        expect(resumed).toMatchObject({task: "continue", mode: "auto", progress: {passed: 1}});
        const {settled, titles} = await answerAll(runs, resumed.runId);
        expect(titles).toEqual([]);
        expect(settled.result).toMatchObject({outcome: "completed", passedScenes: 2});
        expect(calls.plan).toHaveLength(2);
        expect(calls.write).toHaveLength(3);
        const content = await prose();
        expect(content).toContain("第1次正文。\n\n第3次正文。");
        expect(content).not.toContain("第2次正文。");
        expect((await runs.listChapterRuns(chapterId)).map(({status}) => status)).toEqual(["cancelled", "completed"]);
    });

    it("审阅中进程中断：新进程按运行记录恢复，已完成的写手调用不重复", async () => {
        const {ready, chapterId, prose} = await project("interrupted");
        const sessions = new MemorySessionStore();
        let reviewStarted!: () => void;
        const started = new Promise<void>((resolve) => { reviewStarted = resolve; });
        const first = mockAgents(sessions, {review: () => {
            reviewStarted();
            return new Promise<JsonValue>(() => undefined);
        }});
        const before = await service(ready, sessions, first.port);
        const {runId} = await before.start({chapterEntryId: chapterId, task: "new", mode: "auto"});
        await started;

        const second = mockAgents(sessions);
        const after = await service(ready, sessions, second.port);
        const [interrupted] = await after.listChapterRuns(chapterId);
        expect(interrupted).toMatchObject({runId, status: "running", interrupted: true});
        await expect(after.start({chapterEntryId: chapterId, task: "new", mode: "auto"})).rejects.toMatchObject({code: "RUN_ACTIVE"});
        await after.continue({chapterEntryId: chapterId});
        expect(await after.settle(runId)).toMatchObject({status: "completed", result: {outcome: "completed", passedScenes: 2}});
        expect(first.calls.write).toHaveLength(1);
        expect(second.calls.write).toHaveLength(1);
        expect(second.calls.review).toHaveLength(2);
        expect(await prose()).toContain("场景1正文。\n\n场景2正文。");
    });

    it("停止中断的运行：不再调用模型，直接转为已取消", async () => {
        const {ready, chapterId} = await project("stop-interrupted");
        const sessions = new MemorySessionStore();
        const first = mockAgents(sessions, {plan: () => new Promise<JsonValue>(() => undefined)});
        const before = await service(ready, sessions, first.port);
        const {runId} = await before.start({chapterEntryId: chapterId, task: "new", mode: "auto"});
        await vi.waitFor(() => expect(first.calls.plan).toHaveLength(1));

        const second = mockAgents(sessions);
        const after = await service(ready, sessions, second.port);
        expect(await after.stop(runId)).toMatchObject({status: "cancelled"});
        expect(second.calls.plan).toHaveLength(0);
    });
});

describe("writing rewrite workflow", () => {
    const threeParagraphs = (turn: Turn) => {
        const scene = /本场景（场景 (\d+)/u.exec(turn.message ?? "")?.[1];
        return ["甲", "乙", "丙"].map((mark) => `场景${scene}${mark}。`).join("\n\n");
    };

    /** 先整章写出六段正文，再在同一服务上发起改写。 */
    async function written(name: string, agents: Agents = {}) {
        const fixture = await project(name, 15);
        const sessions = new MemorySessionStore();
        const mock = mockAgents(sessions, {write: threeParagraphs, ...agents});
        const runs = await service(fixture.ready, sessions, mock.port);
        const {runId} = await runs.start({chapterEntryId: fixture.chapterId, task: "new", mode: "auto"});
        expect((await answerAll(runs, runId)).settled.result).toMatchObject({outcome: "completed"});
        return {...fixture, runs, calls: mock.calls};
    }

    async function pendingConfirm(runs: Service, runId: string) {
        expect((await runs.settle(runId)).status).toBe("waiting");
        const [ask, ...rest] = (await runs.view(runId)).pendingAsks;
        expect(rest).toEqual([]);
        return ask!;
    }

    it("局部改写资料连续三次被独立审核退回时，不调用写手且原正文不变", async () => {
        const problems = ["角色认知与原细纲不符，请修订信息差资料"];
        const {runs, chapterId, prose, calls} = await written("rewrite-material-rejected", {
            materialReview: turn => {
                const draft = inputOf(turn).draft as {[key: string]: JsonValue};
                if (!("requirement" in draft)) return {materialReview: {passed: true, problems: []}};
                expect(draft).toMatchObject({requirement: "更紧张", window: {target: "场景2甲。"},
                    guidance: {materials: {scenes: expect.any(Array)}}});
                return {materialReview: {passed: false, problems}};
            },
        });
        const before = await prose();
        const started = await runs.startRewrite({chapterEntryId: chapterId, target: {quote: "场景2甲"}, requirement: "更紧张"});
        expect(await runs.settle(started.runId)).toMatchObject({result: {outcome: "stopped", reason: "material-rejected"}});
        expect(calls.rewritePlan).toHaveLength(3);
        expect(inputOf(calls.rewritePlan[1]!).feedback).toEqual({errors: problems});
        expect(calls.rewrite).toHaveLength(0);
        expect(await prose()).toBe(before);
    });

    it("改写：规划与审阅退回后重写，确认后只替换目标段落，文件头与依据不变", async () => {
        const invalid = {...REWRITE_PLAN, background: {points: [], excerpts: [{path: "outline/foreshadowing/ol-fs-x.md", heading: "来历"}]}};
        const {runs, chapterId, prose, calls} = await written("rewrite-replaced", {
            rewritePlan: (_turn, call) => ({rewrite: call === 1 ? invalid : REWRITE_PLAN}),
            rewriteReview: (_turn, call) => ({rewriteReview: call === 1 ? {passed: false, problems: ["不够紧张"]} : {passed: true, problems: []}}),
        });
        const before = await prose();
        const started = await runs.startRewrite({chapterEntryId: chapterId, target: {quote: "场景2甲"}, requirement: "更紧张"});
        const ask = await pendingConfirm(runs, started.runId);
        await expect(runs.start({chapterEntryId: chapterId, task: "rewrite", mode: "auto"})).rejects.toMatchObject({code: "RUN_ACTIVE"});

        expect(inputOf(calls.rewritePlan[0]!)).toMatchObject({requirement: "更紧张",
            window: {before: ["场景1乙。", "场景1丙。"], target: "场景2甲。", after: ["场景2乙。", "场景2丙。"]}});
        expect(inputOf(calls.rewritePlan[1]!).feedback).toEqual({errors: [expect.stringContaining("outline/foreshadowing/ol-fs-x.md")]});
        expect(calls.rewrite).toHaveLength(2);
        expect(calls.rewrite[1]!.message).toContain("不够紧张");
        expect(ask.spec).toMatchObject({title: "确认替换改写段落", description: expect.stringContaining("### 原文（第 4 段）\n\n场景2甲。\n\n### 改写\n\n改写2。")});
        expect(await prose()).toBe(before);

        await runs.answer(started.runId, {[ask.key]: true});
        expect(await runs.settle(started.runId)).toMatchObject({kind: "rewrite", status: "completed",
            result: {outcome: "replaced", range: {from: 4, to: 4}, original: "场景2甲。", replacement: "改写2。"}});
        expect(await prose()).toBe(before.replace("场景2甲。", "改写2。"));
        expect((await runs.listChapterRuns(chapterId)).map(({kind}) => kind)).toEqual(["chapter", "rewrite"]);
    });

    it("放弃时正文不变；目标被改动时不替换，目标之外的改动不阻止替换", async () => {
        const {runs, chapterId, prose, root} = await written("rewrite-discarded");
        const file = path.join(root, "manuscript/卷一/第一章/index.md");
        const before = await prose();

        const discarded = await runs.startRewrite({chapterEntryId: chapterId, target: {paragraphs: {from: 2}}, requirement: "更紧张"});
        await runs.answer(discarded.runId, {[(await pendingConfirm(runs, discarded.runId)).key]: false});
        expect(await runs.settle(discarded.runId)).toMatchObject({result: {outcome: "discarded"}});
        expect(await prose()).toBe(before);

        const changed = await runs.startRewrite({chapterEntryId: chapterId, target: {paragraphs: {from: 2, to: 3}}, requirement: "更紧张"});
        const changedAsk = await pendingConfirm(runs, changed.runId);
        await fs.writeFile(file, before.replace("场景1乙。", "用户改过。"), "utf8");
        await runs.answer(changed.runId, {[changedAsk.key]: true});
        expect(await runs.settle(changed.runId)).toMatchObject({result: {outcome: "stopped", reason: "target-changed"}});
        expect(await prose()).toBe(before.replace("场景1乙。", "用户改过。"));

        await fs.writeFile(file, before, "utf8");
        const shifted = await runs.startRewrite({chapterEntryId: chapterId, target: {quote: "场景2丙"}, requirement: "更紧张"});
        const shiftedAsk = await pendingConfirm(runs, shifted.runId);
        await fs.writeFile(file, before.replace("场景1甲。", "新加的一段。\n\n场景1甲。"), "utf8");
        await runs.answer(shifted.runId, {[shiftedAsk.key]: true});
        expect(await runs.settle(shifted.runId)).toMatchObject({result: {outcome: "replaced"}});
        expect(await prose()).toBe(before.replace("场景1甲。", "新加的一段。\n\n场景1甲。").replace("场景2丙。", "改写3。"));
    });

    it("没有正文或找不到目标时停止，不调用模型", async () => {
        const {ready, chapterId} = await project("rewrite-no-prose");
        const sessions = new MemorySessionStore();
        const {port, calls} = mockAgents(sessions);
        const runs = await service(ready, sessions, port);
        const started = await runs.startRewrite({chapterEntryId: chapterId, target: {paragraphs: {from: 1}}, requirement: "更紧张"});
        expect(await runs.settle(started.runId)).toMatchObject({result: {outcome: "stopped", reason: "no-prose"}});

        const {runs: again, chapterId: id, calls: after} = await written("rewrite-missing-target");
        const missing = await again.startRewrite({chapterEntryId: id, target: {quote: "不存在的句子"}, requirement: "更紧张"});
        expect(await again.settle(missing.runId)).toMatchObject({result: {outcome: "stopped", reason: "target"}});
        expect([...calls.rewritePlan, ...after.rewritePlan, ...after.rewrite]).toEqual([]);
    });
});

describe("retryOnceAgentPort", () => {
    it("失败重试一次；已停止时不重试", async () => {
        const {retryOnceAgentPort} = await import("./run-service");
        const invoke = vi.fn<AgentPort["invoke"]>()
            .mockRejectedValueOnce(new Error("网络错误"))
            .mockResolvedValueOnce({status: "completed", message: "好", data: null, newLeaf: "leaf-2"});
        const port = retryOnceAgentPort({profileInfo: async () => null, invoke});
        await expect(port.invoke(1, "leaf-1", {})).resolves.toMatchObject({message: "好"});
        expect(invoke.mock.calls.map(([, leaf]) => leaf)).toEqual(["leaf-1", "leaf-1"]);

        const aborted = new AbortController();
        aborted.abort();
        invoke.mockReset().mockRejectedValue(new Error("已取消"));
        await expect(port.invoke(1, "leaf-1", {signal: aborted.signal})).rejects.toThrow("已取消");
        expect(invoke).toHaveBeenCalledTimes(1);
    });
});

describe("writing run progress", () => {
    function gate() {
        let open!: () => void;
        const opened = new Promise<void>((resolve) => { open = resolve; });
        return {open, opened};
    }

    async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
        for (let tries = 0; tries < 500; tries += 1) {
            const value = await read();
            if (done(value)) return value;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`等待进度超时：${JSON.stringify(await read()).slice(0, 600)}`);
    }

    type Progress = Awaited<ReturnType<Service["progress"]>>;
    const states = (value: Progress) => value.kind === "chapter" ? value.scenes.map(({state, retry}) => `${state}${retry || ""}`).join() : "";
    const failing = {review: {passed: false, elements: [{element: "要素1", covered: false}], problems: ["节奏太快"]}};

    it("进行中的场景按最后一条记录显示重写第 N 次、审阅中，完成后保留每次提示与判定", async () => {
        const {ready, chapterId} = await project("progress-live");
        const sessions = new MemorySessionStore();
        const writing = gate();
        const reviewing = gate();
        const {port} = mockAgents(sessions, {
            write: async (turn, call) => {
                if (call === 2) await writing.opened;
                return `场景${/本场景（场景 (\d+)/u.exec(turn.message ?? "")?.[1]}正文。`;
            },
            review: async (turn, call) => {
                if (call === 1) return failing;
                if (call === 2) await reviewing.opened;
                return {review: passing(turn)};
            },
        });
        const runs = await service(ready, sessions, port);
        const {runId} = await runs.start({chapterEntryId: chapterId, task: "new", mode: "auto"});

        const retrying = await until(() => runs.progress(runId), (value) => states(value) === "retrying1,pending");
        // 创建记录先于模型返回，展开运行中的尝试也必须能找到写手。
        expect(retrying.kind === "chapter" && retrying.scenes[0]!.attempts.at(-1)?.writerSessionId).toEqual(expect.any(Number));
        writing.open();
        await until(() => runs.progress(runId), (value) => states(value) === "reviewing,pending");
        reviewing.open();
        await runs.settle(runId);

        const done = await runs.progress(runId);
        if (done.kind !== "chapter") throw new Error("应为整章写作");
        expect(states(done)).toBe("passed,passed");
        expect(done).toMatchObject({status: "completed", asks: [], result: {outcome: "completed"}});
        const [first, second] = done.scenes;
        expect(first!.attempts.map(({output, judgement}) => [output, judgement])).toEqual([
            ["场景1正文。", {passed: false, problems: ["节奏太快", "没有写到：要素1"]}],
            ["场景1正文。", {passed: true, problems: []}],
        ]);
        expect(first!.attempts[0]!.prompt).toMatchObject({system: expect.stringContaining("## 文风要求"),
            user: expect.stringContaining("本场景（场景 1：入城）")});
        expect(first!.attempts[1]!.prompt!.user).toContain("上次产出未通过的问题（本次必须改正）\n\n- 节奏太快");
        expect(second!.attempts).toHaveLength(1);
        const writerIds = [...first!.attempts, ...second!.attempts].map(attempt => attempt.writerSessionId);
        expect(writerIds.every(id => typeof id === "number")).toBe(true);
        expect(new Set(writerIds).size).toBe(3);
    });

    it("重写用尽的场景为未通过，其后场景待写；写作中停止的场景回到待写", async () => {
        const {ready, chapterId} = await project("progress-failed");
        const sessions = new MemorySessionStore();
        const {port} = mockAgents(sessions, {review: () => failing});
        const runs = await service(ready, sessions, port);
        const {runId} = await runs.start({chapterEntryId: chapterId, task: "new", mode: "auto"});
        await answerAll(runs, runId);
        expect(await runs.progress(runId)).toMatchObject({status: "completed", result: {outcome: "stopped", reason: "scene-failed"},
            scenes: [{state: "failed", attempts: [{}, {}, {}]}, {state: "pending", attempts: []}]});

        const other = await project("progress-stopped");
        const blocked = gate();
        const stopping = mockAgents(sessions, {write: async () => { await blocked.opened; return "正文。"; }});
        const stoppable = await service(other.ready, sessions, stopping.port);
        const started = await stoppable.start({chapterEntryId: other.chapterId, task: "new", mode: "auto"});
        await until(() => stoppable.progress(started.runId), (value) => states(value) === "writing,pending");
        const stopped = stoppable.stop(started.runId);
        blocked.open();
        await stopped;
        expect(await stoppable.progress(started.runId)).toMatchObject({status: "cancelled", scenes: [{state: "pending"}, {state: "pending"}]});
    });

    it("讨论模式的用户确认可由用户应答，卡片带场景规划摘要", async () => {
        const {ready, chapterId} = await project("progress-discussion");
        const sessions = new MemorySessionStore();
        const {port} = mockAgents(sessions);
        const runs = await service(ready, sessions, port);
        const {runId} = await runs.start({chapterEntryId: chapterId, task: "new", mode: "discussion"});
        await runs.settle(runId);
        await runs.answer(runId, {[(await runs.progress(runId)).asks[0]!.key]: true});
        await runs.settle(runId);
        const confirming = await runs.progress(runId);
        expect(confirming.asks).toEqual([{key: expect.any(String), role: "user-confirm", title: "确认场景规划（第 1 轮）",
            description: expect.stringContaining("### 场景1：入城")}]);
        await runs.answer(runId, {[confirming.asks[0]!.key]: true}, "user");
        await runs.settle(runId);
        const second = await runs.progress(runId);
        expect(second).toMatchObject({scenes: [{state: "pending"}, {state: "planning"}]});
        expect(second.asks[0]!.description).toContain("### 场景2：夜宿");
        expect((await answerAll(runs, runId)).settled).toMatchObject({status: "completed", result: {outcome: "completed"}});
    });

    it("改写的进度含目标段落、原文、通过审阅的新段落与每次尝试", async () => {
        const {ready, chapterId} = await project("progress-rewrite");
        const sessions = new MemorySessionStore();
        const {port} = mockAgents(sessions, {
            rewriteReview: (_turn, call) => ({rewriteReview: call === 1 ? {passed: false, problems: ["不够紧张"]} : {passed: true, problems: []}}),
        });
        const runs = await service(ready, sessions, port);
        const {runId: writeId} = await runs.start({chapterEntryId: chapterId, task: "new", mode: "auto"});
        await answerAll(runs, writeId);
        const {runId} = await runs.startRewrite({chapterEntryId: chapterId, target: {quote: "场景2正文"}, requirement: "更紧张"});
        await runs.settle(runId);
        const progress = await runs.progress(runId);
        expect(progress.kind === "rewrite" && progress.attempts.every(attempt => typeof attempt.writerSessionId === "number")).toBe(true);
        expect(progress).toMatchObject({kind: "rewrite", status: "waiting", phase: "confirming", requirement: "更紧张",
            range: {from: 2, to: 2}, original: "场景2正文。", replacement: "改写2。", asks: [{role: "rewrite-confirm"}],
            attempts: [
                {output: "改写1。", judgement: {passed: false, problems: ["不够紧张"]}, prompt: {user: expect.stringContaining("修改要求")}},
                {output: "改写2。", judgement: {passed: true, problems: []}},
            ]});
        expect((await runs.activeRunSummaries()).map((summary) => `${summary.runId}:${summary.status}`)).toEqual([`${runId}:waiting`]);
        await runs.answer(runId, {[progress.asks[0]!.key]: false}, "user");
        await runs.settle(runId);
        expect(await runs.progress(runId)).toMatchObject({status: "completed", result: {outcome: "discarded"}, replacement: "改写2。"});
        await expect(runs.activeRunSummaries()).resolves.toEqual([]);
        expect((await runs.chapterRunSummaries(chapterId)).map(({kind, status}) => `${kind}:${status}`))
            .toEqual(["chapter:completed", "rewrite:completed"]);
    });
});


