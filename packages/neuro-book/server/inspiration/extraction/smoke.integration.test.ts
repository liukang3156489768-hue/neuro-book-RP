import {mkdir, readFile, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import {absoluteFsPath, type AbsoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {detailBody} from "nbook/server/outline/detail.fixture";
import {readWriterChapterContext} from "nbook/server/outline/writer-context";
import {readSelectedWriterMaterials} from "nbook/server/outline/writer-materials";
import {assistantCanRead, chapterReferencePaths} from "nbook/server/writing/assistant-scope";
import {buildChapterMaterials} from "nbook/server/writing/scenes";
import {readReadyAssistantFiles} from "nbook/server/writing/host";
import {scanWorkspaceTree, validateWorkspaceTree} from "nbook/server/workspace-files/workspace-files";
import type {ReadyProjectSessionRef} from "nbook/server/workspace-files/project-session-types";
import type {WorkspaceFileTarget} from "nbook/server/workspace-files/workspace-file-target";
import {collectReleasedSqliteHandles} from "nbook/server/workspace-files/sqlite-handle-release";
import type {ExtractionTask} from "nbook/shared/dto/inspiration-extraction-task.dto";
import {prepareInspirationSource} from "../source";
import {ExtractionTaskManager} from "./manager";
import {MaterialReviewService} from "./material-review-service";
import {createMaterialPipeline} from "./material-pipeline";
import {listClassification} from "./material-consolidate";
import {createMaterialModel, buildNovelText} from "./material.fixture";
import {createProjectExtractionModel} from "./model-adapter";
import {listOutlineDestinations} from "./outline-destination";
import {createParagraphLoader} from "./outline-register";
import {createOutlinePipeline, readOutlineExtractionOutcome} from "./outline-pipeline";
import {createReadyOutlinePlanning, readPlanLayout} from "./outline-planning";
import {EXTRACTION_REFERENCE_PURPOSE} from "./outline-writer";
import {createSourceVerifier} from "./source-guard";
import {confirmExtractionStructure, previewExtractionStructure} from "./structure-service";
import {createFileExtractionStore} from "./store-file";
import {createGate, createScriptedModel, createTestLaunch, type ScriptedModel} from "./testing";

/**
 * 提取功能的 Mock 端到端冒烟（t09）。
 *
 * 与分层测试的区别：这里的链路都是真实实现，只替换模型端点、项目会话和文件索引/历史：
 * 真实来源文件 → 章节识别 → 划卷 → 真实任务存储 → 真实 Ready 宿主大纲库 / 真实 lorebook 写入，
 * 模型走真实适配器 `createProjectExtractionModel`（只替换其底层 `tracedCompleteSimple`），
 * 因此“每次调用都不带思考”断言覆盖的是真实适配路径而不是 Mock 模型本身。
 * 路由层的参数校验、确认者与错误映射由 `server/api/inspiration/extraction/routes.test.ts` 与 `http.test.ts` 覆盖。
 */

const mocks = vi.hoisted(() => ({
    requireReadyModuleHandle: vi.fn(),
    requireActiveReadyProject: vi.fn(),
    runReadyProjectOperation: vi.fn(),
    recordProjectWrite: vi.fn(async () => undefined),
    recordProjectDelete: vi.fn(async () => undefined),
    recordProjectRename: vi.fn(async () => undefined),
    loadConfig: vi.fn(),
    resolveModel: vi.fn(),
    resolveModels: vi.fn(),
    complete: vi.fn(),
}));

vi.mock("nbook/server/workspace-files/project-session", () => ({
    requireReadyModuleHandle: mocks.requireReadyModuleHandle,
    requireActiveReadyProject: mocks.requireActiveReadyProject,
    runReadyProjectOperation: mocks.runReadyProjectOperation,
}));
vi.mock("nbook/server/workspace-files/project-file-index", () => ({
    PROJECT_FILE_INDEX_MODULE_TOKEN: {name: "file-index"},
}));
vi.mock("nbook/server/workspace-history/project-history", async importOriginal => ({
    ...await importOriginal<typeof import("nbook/server/workspace-history/project-history")>(),
    PROJECT_HISTORY_MODULE_TOKEN: {name: "history"},
    recordProjectWrite: mocks.recordProjectWrite,
    recordProjectDelete: mocks.recordProjectDelete,
    recordProjectRename: mocks.recordProjectRename,
}));
// 任务存储与 lorebook 写入经项目 mutation gate；测试用临时目录，不打开真实项目。
vi.mock("nbook/server/workspace-files/project-open-guard", async importOriginal => ({
    ...await importOriginal<typeof import("nbook/server/workspace-files/project-open-guard")>(),
    withProjectTargetMutation: async (_target: unknown, action: (handles: undefined) => unknown) => action(undefined),
}));
vi.mock("nbook/server/config/config-service", () => ({loadEffectiveConfigFromTarget: mocks.loadConfig}));
vi.mock("nbook/server/agent/harness/model-resolver", () => ({resolvePiModelFromConfig: mocks.resolveModel}));
vi.mock("nbook/server/agent/harness/pi-runtime-resolver", () => ({resolvePiModelsFromConfig: mocks.resolveModels}));
vi.mock("nbook/server/agent/observability/traced-provider", () => ({tracedCompleteSimple: mocks.complete}));
vi.mock("nbook/server/runtime/installation-paths", async importOriginal => ({
    ...await importOriginal<typeof import("nbook/server/runtime/installation-paths")>(),
    resolveStateWorkspaceRoot: () => "C:/smoke-state-workspace",
}));

/** 大纲来源：4 章，每章 1 个标题段 + 11 个 800 字正文段，共约 105 KB，超过写作素材读取的 64 KiB 上限。 */
const OUTLINE_SOURCE_PATH = "reference/novel.md";
/** 素材来源：沿用素材夹具的 12 万字文本（运行时生成，不入库），与大纲来源是不同文件。 */
const MATERIAL_PATH = "reference/material.md";
const CHAPTERS = 4;
const PARAGRAPHS_PER_CHAPTER = 12;

function buildOutlineSourceText(): string {
    return `${Array.from({length: CHAPTERS}, (_, chapter) => [
        `第${chapter + 1}章 标题${chapter + 1}`,
        ...Array.from({length: PARAGRAPHS_PER_CHAPTER - 1}, (_unused, line) => `章${chapter + 1}段${line + 1}：${"雨".repeat(800)}`),
    ].join("\n")).join("\n")}\n`;
}

type Step = "detail" | "outline" | "volume" | "total";

function stepOf(prompt: string): Step {
    if (prompt.includes("【任务】提取本章的细纲")) return "detail";
    if (prompt.includes("【任务】提取本章的章节大纲")) return "outline";
    if (prompt.includes("的卷纲。")) return "volume";
    return "total";
}

function chapterOfPrompt(prompt: string): number {
    const first = Number(/【P(\d+)】/u.exec(prompt)![1]);
    return Math.floor((first - 1) / PARAGRAPHS_PER_CHAPTER) + 1;
}

const isMaterialPrompt = (prompt: string) => /【任务】(粗读本块|只提取角色|提取本块|分析本块|把上面|用户认为上面|为这些)|【提取目标】本次只处理这些角色/u.test(prompt);

/** 合法产出；`tag` 区分版本，用来验证补充与覆盖。 */
function validOutput(step: Step, chapter: number, tag: string): string {
    const first = (chapter - 1) * PARAGRAPHS_PER_CHAPTER + 1;
    const citation = `【引用】P${first}-P${first + PARAGRAPHS_PER_CHAPTER - 1}`;
    switch (step) {
        case "detail":
            return `${detailBody({scenes: [{name: "场景", plot: [`${tag}第${chapter}章事件`]}], title: `第${chapter}章`})}\n${citation}`;
        case "outline":
            return `# 章节目标\n${tag}第${chapter}章目标\n# 场景设定\n地点\n# 剧情概要\n${tag}第${chapter}章概要\n# 章节结尾\n悬念\n${citation}`;
        case "volume":
            return `# 本卷目标\n${tag}目标\n# 起始状态\n起点\n# 核心冲突\n冲突\n# 结束状态\n终点`;
        case "total":
            return `# 核心冲突\n${tag}冲突\n# 主题\n主题\n# 结局方向\n结局`;
    }
}

type OutlineCall = Readonly<{step: Step; chapter: number; attempt: number; prompt: string}>;
type OutlineScript = (call: OutlineCall) => string | Promise<string | undefined> | undefined;

type Env = Readonly<{
    ready: ReadyProjectSessionRef;
    root: AbsoluteFsPath;
    target: WorkspaceFileTarget;
    store: ReturnType<typeof createFileExtractionStore>;
    planning: ReturnType<typeof createReadyOutlinePlanning>;
    manager: ExtractionTaskManager;
    review: MaterialReviewService;
    /** 真实适配器背后的脚本化端点；其 `requests` 即全部底层模型调用。 */
    endpoint: ScriptedModel;
    /** 设置后续大纲调用的脚本；返回 undefined 走默认合法产出。 */
    script: {outline: OutlineScript; tag: string};
    attempts: Map<string, number>;
    materialBlocks: number;
}>;

const roots: string[] = [];
beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockResolvedValue({models: {providers: {p: {options: {apiKey: "test-only", timeoutMs: 30_000, requestOptions: {}}}}}});
    mocks.resolveModel.mockReturnValue({provider: "p", api: "openai-completions", id: "fiction", maxTokens: 64_000});
    mocks.resolveModels.mockReturnValue({});
});
afterEach(async () => {
    collectReleasedSqliteHandles({force: true});
    await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));
});

async function createEnv(): Promise<Env> {
    const root = absoluteFsPath(await createTestTmpRoot("inspiration-extraction", "smoke-integration"));
    roots.push(root);
    await mkdir(path.join(root, "reference"), {recursive: true});
    await writeFile(path.join(root, OUTLINE_SOURCE_PATH), buildOutlineSourceText(), "utf8");
    await writeFile(path.join(root, MATERIAL_PATH), buildNovelText(), "utf8");
    const target: WorkspaceFileTarget = {kind: "user-assets", root};

    const ready = {publicId: "ready-smoke", workspace: {root}} as ReadyProjectSessionRef;
    const fileIndex = {mutate: vi.fn(async <T>(operation: () => Promise<T>) => operation())};
    mocks.requireReadyModuleHandle.mockImplementation((_ready, token: {name: string}) => token.name === "file-index" ? fileIndex : {});
    mocks.runReadyProjectOperation.mockImplementation(async (_ready, operation) =>
        operation(new AbortController().signal, () => undefined, async () => undefined));

    const store = createFileExtractionStore(target);
    const planning = createReadyOutlinePlanning(ready);
    const materialPrepared = await prepareInspirationSource(root, MATERIAL_PATH);
    const materialModel = createMaterialModel({blocks: materialPrepared.chunks});
    const script = {outline: (() => undefined) as OutlineScript, tag: ""};
    const attempts = new Map<string, number>();
    const endpoint = createScriptedModel(async request => {
        if (isMaterialPrompt(request.prompt)) return materialModel.complete(request);
        const step = stepOf(request.prompt);
        const chapter = step === "detail" || step === "outline" ? chapterOfPrompt(request.prompt) : 0;
        const key = `${step}:${chapter}`;
        const attempt = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, attempt);
        return await script.outline({step, chapter, attempt, prompt: request.prompt}) ?? validOutput(step, chapter, script.tag);
    });
    // 真实适配器的底层补全：从适配器构造的上下文取回提示词，交给脚本化端点（保留取消语义）。
    mocks.complete.mockImplementation(async (_models, _model, context, options) => {
        // 与真实 Provider 一样消费 payload hook，才能覆盖有序消息实际发送的提示词。
        const payload = options.onPayload ? await options.onPayload({messages: context.messages}, _model) : undefined;
        const messages = payload?.messages ?? context.messages;
        const prompt = messages.filter((message: {role: string}) => message.role !== "system").map((message: {content: string | Array<{type: string; text?: string}>}) =>
            typeof message.content === "string" ? message.content : message.content.filter(block => block.type === "text").map(block => block.text ?? "").join("")).join("\n\n");
        const text = await endpoint.complete({
            system: context.systemPrompt, prompt, signal: options.signal,
        });
        return {stopReason: "stop", content: [{type: "text", text}]};
    });

    const outline = createOutlinePipeline({planning, loadParagraphs: createParagraphLoader(root), listTasks: () => store.list()});
    const material = createMaterialPipeline({target});
    const model = createProjectExtractionModel(ready);
    const manager = new ExtractionTaskManager({
        store, model, verifySource: createSourceVerifier(root),
        resolvePipeline: kind => kind === "outline" ? outline : material,
        launch: createTestLaunch().launch,
    });
    return {
        ready, root, target, store, planning, manager, endpoint, script, attempts, materialBlocks: materialPrepared.chunks.length,
        review: new MaterialReviewService({target, tasks: manager, model}),
    };
}

/** 真实适配路径上每一次模型调用都显式传 `reasoning: undefined`（不是缺省），且与底层调用一一对应。 */
function expectThinkingOffEverywhere(env: Env): void {
    const calls = mocks.complete.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(env.endpoint.requests.length);
    for (const call of calls) expect(call[3]).toHaveProperty("reasoning", undefined);
}

async function confirmedStructure(env: Env, volumes: ReadonlyArray<readonly [number, number]> = [[1, 2], [3, 4]]) {
    const preview = await previewExtractionStructure(env.root, {path: OUTLINE_SOURCE_PATH, corrections: []});
    expect(preview.mode).toBe("chapters");
    expect(preview.chapters).toHaveLength(CHAPTERS);
    const confirmed = await confirmExtractionStructure(env.root, {
        path: OUTLINE_SOURCE_PATH, corrections: [],
        division: {mode: "chapters", volumes: volumes.map(([first, last], index) => ({title: `第${index + 1}卷`, firstChapterIndex: first, lastChapterIndex: last}))},
    });
    return confirmed;
}

async function startOutline(env: Env, destination: {kind: "new"} | {kind: "supplement" | "overwrite"; planId: string}, structure?: Awaited<ReturnType<typeof confirmedStructure>>) {
    const {source, structure: built} = structure ?? await confirmedStructure(env);
    const task = await env.manager.start({kind: "outline", source, params: {workTitle: "冒烟作品", structure: built, corrections: [], destination} as never});
    await env.manager.whenIdle();
    return env.manager.get(task.id);
}

async function readLayout(env: Env, planId: string) {
    const snapshot = await env.planning.snapshot();
    const layout = readPlanLayout(snapshot, planId)!;
    const entry = (id: string) => snapshot.entries.find(({value}) => value.id === id)!.value;
    return {snapshot, layout, entry};
}

const statusOf = (task: ExtractionTask) => Object.fromEntries(task.units.map(unit => [unit.id, unit.status]));

describe("冒烟 A：大纲提取（识别 → 划卷 → 提取 → 大纲库回读）", () => {
    it("真实来源与真实大纲库：新建方案可读回，细纲带来源依据，章节大纲引用原作", async () => {
        const env = await createEnv();
        const task = await startOutline(env, {kind: "new"});
        expect(task.status).toBe("completed");
        // 4 章 x (细纲 + 章节大纲) + 2 卷 + 总纲。
        expect(env.endpoint.requests).toHaveLength(CHAPTERS * 2 + 2 + 1);

        const outcome = readOutlineExtractionOutcome(task);
        expect(outcome.planTitle).toBe("提取方案1·冒烟作品");
        const {snapshot, layout, entry} = await readLayout(env, outcome.planId);
        expect(layout.chapterIds).toHaveLength(CHAPTERS);
        expect(layout.volumeIds).toHaveLength(2);
        const formal = [layout.totalId, ...layout.volumeIds, ...layout.chapterIds].map(entry);
        expect(formal.every(item => item.status === "adopted" && item.body.trim() !== "")).toBe(true);
        const details = snapshot.entries.map(({value}) => value).filter(value => value.kind === "detail");
        expect(details).toHaveLength(CHAPTERS);
        expect(details.every(detail => detail.status === "adopted" && detail.basis?.kind === "source-extraction")).toBe(true);
        for (const chapterId of layout.chapterIds) {
            expect(entry(chapterId).references).toEqual([expect.objectContaining({path: OUTLINE_SOURCE_PATH, purpose: EXTRACTION_REFERENCE_PURPOSE})]);
        }
        // 提取方案可在“数据去向”里被重复提取选中。
        const source = {path: OUTLINE_SOURCE_PATH, sha256: task.source.sha256};
        expect(listOutlineDestinations({snapshot, tasks: await env.store.list(), source}))
            .toEqual([expect.objectContaining({planId: outcome.planId, canSupplement: true, canOverwrite: true, sourceChanged: false})]);
        expectThinkingOffEverywhere(env);
    }, 60_000);

    it("重复提取的三种去向：新建得到新序号方案；补充只补缺；覆盖先对比、确认后只改被确认的项", async () => {
        const env = await createEnv();
        const first = await startOutline(env, {kind: "new"});
        const planId = readOutlineExtractionOutcome(first).planId;

        // 新建：序号递增，旧方案不变。
        const second = await startOutline(env, {kind: "new"});
        expect(readOutlineExtractionOutcome(second).planTitle).toBe("提取方案2·冒烟作品");
        expect(readOutlineExtractionOutcome(second).planId).not.toBe(planId);

        // 补充：删掉第 4 章细纲后，只重新提取这一项，其余内容不变。
        const before = await readLayout(env, planId);
        const detail4 = before.layout.childrenOf(before.layout.chapterIds[3]!).find(({value}) => value.kind === "detail")!;
        await env.planning.removeEntry(detail4.value.id);
        env.script.tag = "补充版";
        const requestsBefore = env.endpoint.requests.length;
        const supplemented = await startOutline(env, {kind: "supplement", planId});
        expect(supplemented.status).toBe("completed");
        expect(env.endpoint.requests.slice(requestsBefore).map(request => `${stepOf(request.prompt)}:${chapterOfPrompt(request.prompt)}`)).toEqual(["detail:4"]);
        const afterSupplement = await readLayout(env, planId);
        expect(afterSupplement.entry(afterSupplement.layout.chapterIds[0]!).body).toBe(before.entry(before.layout.chapterIds[0]!).body);
        expect(afterSupplement.layout.childrenOf(afterSupplement.layout.chapterIds[3]!).filter(({value}) => value.kind === "detail")).toHaveLength(1);

        // 覆盖：确认前不写入；只确认第 1 章大纲，第 2 章保持原样。
        env.script.tag = "新版";
        const overwritten = await startOutline(env, {kind: "overwrite", planId});
        expect(overwritten.status).toBe("awaiting-input");
        const comparison = readOutlineExtractionOutcome(overwritten).comparison!;
        expect(comparison.some(item => item.chapterIndex === 1 && item.kind === "outline" && item.changed)).toBe(true);
        const untouched = await readLayout(env, planId);
        expect(untouched.entry(untouched.layout.chapterIds[0]!).body).not.toContain("新版");
        await env.manager.provideInput(overwritten.id, {confirmedItems: [{chapterIndex: 1, kind: "outline"}]});
        await env.manager.whenIdle();
        expect((await env.manager.get(overwritten.id)).status).toBe("completed");
        const afterOverwrite = await readLayout(env, planId);
        expect(afterOverwrite.entry(afterOverwrite.layout.chapterIds[0]!).body).toContain("新版第1章目标");
        expect(afterOverwrite.entry(afterOverwrite.layout.chapterIds[1]!).body).not.toContain("新版");
        expectThinkingOffEverywhere(env);
    }, 120_000);

    it("取消后继续、失败章节重试：已完成单元不重做，修复后补齐并完成", async () => {
        const env = await createEnv();
        const gate = createGate();
        let fixed = false;
        env.script.outline = async ({step, chapter, attempt}) => {
            if (step === "outline" && chapter === 2 && attempt === 1) await gate.wait;
            // 第 3 章细纲引用越界：首次与修复重试都不合格，该章失败。
            if (step === "detail" && chapter === 3 && !fixed) return validOutput("detail", 3, "").replace(/【引用】.*/u, "【引用】P9999");
            return undefined;
        };
        const {source, structure} = await confirmedStructure(env);
        const started = await env.manager.start({kind: "outline", source, params: {workTitle: "冒烟作品", structure, corrections: [], destination: {kind: "new"}} as never});
        while (!env.attempts.has("outline:2")) await new Promise(resolve => setTimeout(resolve, 5));
        const cancelled = await env.manager.cancel(started.id);
        expect(cancelled.status).toBe("cancelled");
        expect(cancelled.units.find(unit => unit.id === "chapter-2:outline")!.status).not.toBe("done");

        const doneBefore = cancelled.units.filter(unit => unit.status === "done").map(unit => unit.id);
        const requestsBefore = env.endpoint.requests.length;
        await env.manager.resume(started.id);
        await env.manager.whenIdle();
        const partial = await env.manager.get(started.id);
        expect(partial.status).toBe("partial-failed");
        expect(statusOf(partial)["chapter-3:detail"]).toBe("failed");
        // 继续阶段不再请求已完成的单元。
        const redone = env.endpoint.requests.slice(requestsBefore).map(request => stepOf(request.prompt))
            .flatMap((step, index) => step === "detail" || step === "outline"
                ? [`${step}-${chapterOfPrompt(env.endpoint.requests[requestsBefore + index]!.prompt)}`] : []);
        for (const id of doneBefore.filter(unit => /^chapter-\d+:(detail|outline)$/u.test(unit))) {
            const [, chapter, step] = /^chapter-(\d+):(.+)$/u.exec(id)!;
            expect(redone).not.toContain(`${step}-${chapter}`);
        }

        fixed = true;
        await env.manager.retryUnit(started.id, "chapter-3:detail");
        await env.manager.whenIdle();
        const done = await env.manager.get(started.id);
        expect(done.status).toBe("completed");
        expect(done.units.every(unit => unit.status === "done")).toBe(true);
        const {layout, entry} = await readLayout(env, readOutlineExtractionOutcome(done).planId);
        expect([...layout.chapterIds, ...layout.volumeIds, layout.totalId].map(entry).every(item => item.status === "adopted")).toBe(true);
        expectThinkingOffEverywhere(env);
    }, 60_000);
});

describe("冒烟 B：素材提取（分类 → 归类暂停 → 整合 → 审阅 → 写入）", () => {
    it("lorebook 条目带 origin/extraction 并可被索引；与用户设计条目同名时先冲突，另存为后原条目不变", async () => {
        const env = await createEnv();
        const source = {path: MATERIAL_PATH, sha256: (await prepareInspirationSource(env.root, MATERIAL_PATH)).source.sha256};
        const started = await env.manager.start({kind: "material", source, params: {}});
        await env.manager.whenIdle();
        const paused = await env.manager.get(started.id);
        expect(paused.status).toBe("awaiting-input");
        expect(paused.units.filter(unit => unit.step === "extract")).toHaveLength(env.materialBlocks * 8);
        expect(paused.units.filter(unit => unit.step === "discover")).toHaveLength(env.materialBlocks);
        expect(paused.units.filter(unit => unit.step === "extract-character").length).toBeGreaterThan(0);
        // 归类暂停点：苏晴与沈念共用别称，被标为疑似同一实体，但不自动合并。
        expect(listClassification(paused).candidates.some(candidate => candidate.category === "character")).toBe(true);

        await env.manager.provideInput(started.id, {skip: true});
        await env.manager.whenIdle();
        const task = await env.manager.get(started.id);
        expect(task.status).toBe("completed");

        const review = await env.review.get(task.id);
        expect(review.items.length).toBeGreaterThan(0);
        // 提取任务先确定稳定 ID，再在同一目录制造用户设计文件验证冲突。
        const characterItem = review.items.find(item => item.title === "林舟")!;
        const designed = path.join(env.root, "lorebook", "character", characterItem.directoryName, "index.md");
        await mkdir(path.dirname(designed), {recursive: true});
        const original = "---\ntitle: 林舟\ntype: character\n---\n\n用户亲手设计的林舟。\n";
        await writeFile(designed, original, "utf8");
        const report = await env.review.confirmWrite(task.id, {confirmer: {kind: "user"}});
        expect(report.outcomes.find(outcome => outcome.title === "林舟")!.status).toBe("conflict");
        expect(await readFile(designed, "utf8")).toBe(original);
        const conflictItem = review.items.find(item => item.title === "林舟")!;
        const saved = await env.review.confirmWrite(task.id, {confirmer: {kind: "user"}, decisions: [{itemId: conflictItem.id, action: "save-as"}]});
        expect(saved.outcomes.find(outcome => outcome.itemId === conflictItem.id)).toMatchObject({status: "written", title: "林舟（提取）"});
        expect(await readFile(designed, "utf8")).toBe(original);

        // 写入的素材是普通内容节点：被扫描索引，带提取来源标记，且整棵 lorebook 没有校验问题。
        const nodes = await scanWorkspaceTree({root: env.root, targets: ["lorebook"]});
        const extracted = nodes.filter(node => node.contentNode && node.frontmatter.origin === "extract");
        expect(extracted.length).toBeGreaterThanOrEqual(report.outcomes.filter(outcome => outcome.status === "written").length);
        const sampleItem = review.items.find(item => item.title === "苏晴")!;
        const sample = await readFile(path.join(env.root, "lorebook", "character", sampleItem.directoryName, "index.md"), "utf8");
        expect(sample).toContain("origin: extract");
        expect(sample).toMatch(/sha256: ["']?[0-9a-f]{64}/u);
        expect(sample).toContain(MATERIAL_PATH);
        // 用户手写的最小 frontmatter 条目本身不满足内容节点 schema，不属于提取产物，排除后其余应零问题。
        const issues = await validateWorkspaceTree({root: env.root, targets: ["lorebook"]});
        expect(issues.filter(issue => issue.path !== `lorebook/character/${characterItem.directoryName}/`)).toEqual([]);
        expectThinkingOffEverywhere(env);
    }, 120_000);
});

describe("冒烟 C：大纲与素材任务并行互不阻塞", () => {
    it("大纲任务停在模型调用时，素材任务可以跑到归类暂停；放行后两者各自完成，调用全部不带思考", async () => {
        const env = await createEnv();
        const gate = createGate();
        env.script.outline = async ({step, chapter, attempt}) => {
            if (step === "detail" && chapter === 2 && attempt === 1) await gate.wait;
            return undefined;
        };
        const {source: outlineSource, structure} = await confirmedStructure(env);
        const outline = await env.manager.start({kind: "outline", source: outlineSource, params: {workTitle: "冒烟作品", structure, corrections: [], destination: {kind: "new"}} as never});
        const materialSource = {path: MATERIAL_PATH, sha256: (await prepareInspirationSource(env.root, MATERIAL_PATH)).source.sha256};
        const material = await env.manager.start({kind: "material", source: materialSource, params: {}});

        const deadline = Date.now() + 30_000;
        while ((await env.manager.get(material.id)).status !== "awaiting-input") {
            if (Date.now() > deadline) throw new Error("素材任务在大纲任务停顿期间没有到达归类暂停点");
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        // 此时大纲任务仍卡在第 2 章细纲上。
        expect((await env.manager.get(outline.id)).status).toBe("running");

        gate.open();
        await env.manager.provideInput(material.id, {skip: true});
        await env.manager.whenIdle();
        expect((await env.manager.get(outline.id)).status).toBe("completed");
        expect((await env.manager.get(material.id)).status).toBe("completed");
        expectThinkingOffEverywhere(env);
    }, 120_000);
});

describe("写作交接核实：提取的章节大纲 references 指向原作", () => {
    it("writer-materials 只在显式选择且不超过 64 KiB 时读取，整本原作不会被灌入；写作助手可读范围包含该路径", async () => {
        const env = await createEnv();
        const task = await startOutline(env, {kind: "new"});
        const outcome = readOutlineExtractionOutcome(task);
        const {snapshot, layout} = await readLayout(env, outcome.planId);

        const context = readWriterChapterContext(snapshot, {planId: outcome.planId, chapterEntryId: layout.chapterIds[0]!});
        // 来源提取细纲免分析报告也被识别为正式细纲：每章交接带回自己的细纲，写作侧能据此生成场景素材。
        expect(context.details).toHaveLength(1);
        expect(context.details[0]!.title).toBeTruthy();
        expect(buildChapterMaterials(context).ok).toBe(true);
        // 交接上下文只带路径与定位，不带原文。
        expect(context.chapter.references).toEqual([expect.objectContaining({path: OUTLINE_SOURCE_PATH, purpose: EXTRACTION_REFERENCE_PURPOSE})]);
        expect(JSON.stringify(context)).not.toContain("雨雨雨");

        // 未显式选择素材路径时没有任何读取入口；显式选择整本原作（约 105 KB）被拒绝而不是截断。
        await expect(readSelectedWriterMaterials(env.root, context, [])).rejects.toThrow("素材读取必须指定");
        await expect(readSelectedWriterMaterials(env.root, context, [OUTLINE_SOURCE_PATH])).rejects.toThrow("所选素材过大");

        // 写作助手侧（server/writing）：交接列出的路径即在可读范围内，而 `read_writing_material` 读取时没有体积上限。
        const referencePaths = chapterReferencePaths(context);
        expect(referencePaths).toContain(OUTLINE_SOURCE_PATH);
        expect(assistantCanRead(OUTLINE_SOURCE_PATH, referencePaths)).toBe(true);
        expect(assistantCanRead("reference/other.md", referencePaths)).toBe(false);
        // 记录的现状：助手工具 `read_writing_material` 走 readReadyAssistantFiles，没有体积上限，会整本返回原作。
        const files = await readReadyAssistantFiles(env.ready, {paths: [OUTLINE_SOURCE_PATH], referencePaths});
        expect(Buffer.byteLength(files.get(OUTLINE_SOURCE_PATH)!)).toBeGreaterThan(64 * 1024);
    }, 60_000);
});
