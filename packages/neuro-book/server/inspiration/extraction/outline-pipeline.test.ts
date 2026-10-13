import {describe, expect, it} from "vitest";
import {detailBody} from "nbook/server/outline/detail.fixture";
import type {ExtractionModelRequest} from "./types";
import type {ExtractionStructureDto} from "nbook/shared/dto/inspiration-outline-structure.dto";
import type {OutlineDestinationDto} from "nbook/shared/dto/inspiration-outline-extraction.dto";
import type {ExtractionTask} from "nbook/shared/dto/inspiration-extraction-task.dto";
import {ExtractionTaskError} from "./errors";
import {ExtractionTaskManager} from "./manager";
import {listOutlineDestinations} from "./outline-destination";
import {
    createOutlinePipeline, readOutlineExtractionOutcome, STALE_NOTICE, type SourceParagraph,
} from "./outline-pipeline";
import {MISSING_ITEM_TEXT} from "./outline-prompts";
import {readPlanLayout} from "./outline-planning";
import {createFixturePlanning} from "./outline-planning.fixture";
import {resummarizeVolumesAndTotal} from "./outline-resummarize";
import {createMemoryExtractionStore} from "./store-memory";
import {createScriptedModel, createGate, createTestLaunch, testSource} from "./testing";

/** 每章 4 段（P(4n-3) 是标题，其余是正文）；10 章分两卷：第 1-5 章、第 6-10 章。 */
const PARAGRAPHS_PER_CHAPTER = 4;
const SOURCE = testSource("reference/novel.md", "a".repeat(64));
const ORIGINAL_MARK = "原文句子";

function paragraphsOf(chapters: number): SourceParagraph[] {
    return Array.from({length: chapters * PARAGRAPHS_PER_CHAPTER}, (_, position) => {
        const id = position + 1;
        const chapter = Math.floor(position / PARAGRAPHS_PER_CHAPTER) + 1;
        return {id: `P${id}`, text: position % PARAGRAPHS_PER_CHAPTER === 0 ? `第${chapter}章 标题${chapter}` : `${ORIGINAL_MARK}${id}`};
    });
}

function structureOf(chapters: number, volumes: readonly (readonly [number, number])[], sha = SOURCE.sha256): ExtractionStructureDto {
    return {
        sourceSha256: sha, mode: "chapters",
        chapters: Array.from({length: chapters}, (_, position) => ({
            index: position + 1, title: `标题${position + 1}`,
            firstParagraphId: `P${position * PARAGRAPHS_PER_CHAPTER + 1}`, lastParagraphId: `P${(position + 1) * PARAGRAPHS_PER_CHAPTER}`,
            characterCount: 100,
        })),
        volumes: volumes.map(([first, last], position) => ({index: position + 1, title: `卷${position + 1}`, firstChapterIndex: first, lastChapterIndex: last})),
    };
}

const TEN_CHAPTERS = structureOf(10, [[1, 5], [6, 10]]);

function paramsOf(destination: OutlineDestinationDto = {kind: "new"}, structure = TEN_CHAPTERS) {
    return {workTitle: "测试作品", structure, corrections: [], destination} as never;
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

/** 产出合法内容；`tag` 区分不同版本，用来验证覆盖。 */
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

type Script = (input: {step: Step; chapter: number; prompt: string; request: ExtractionModelRequest; attempt: number}) => string | Promise<string> | undefined;

function setup(options: {script?: Script; tag?: string; chapters?: number} = {}) {
    const planning = createFixturePlanning();
    const store = createMemoryExtractionStore();
    const host = createTestLaunch();
    const attempts = new Map<string, number>();
    const tag = {current: options.tag ?? ""};
    const model = createScriptedModel(request => {
        const step = stepOf(request.prompt);
        const chapter = step === "detail" || step === "outline" ? chapterOfPrompt(request.prompt) : 0;
        const key = `${step}:${chapter}`;
        const attempt = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, attempt);
        return options.script?.({step, chapter, prompt: request.prompt, request, attempt}) ?? validOutput(step, chapter, tag.current);
    });
    const paragraphs = paragraphsOf(options.chapters ?? 10);
    const pipeline = createOutlinePipeline({
        planning, loadParagraphs: async () => paragraphs, listTasks: () => store.list(),
    });
    const manager = new ExtractionTaskManager({
        store, model, verifySource: async () => undefined, resolvePipeline: () => pipeline, launch: host.launch,
    });
    const start = async (destination: OutlineDestinationDto = {kind: "new"}, structure = TEN_CHAPTERS, source = SOURCE) => {
        const task = await manager.start({kind: "outline", source, params: paramsOf(destination, structure)});
        await manager.whenIdle();
        return manager.get(task.id);
    };
    return {planning, store, model, manager, tag, start, attempts};
}

type Harness = ReturnType<typeof setup>;

async function layoutOf(harness: Harness, planId: string) {
    const snapshot = await harness.planning.snapshot();
    const layout = readPlanLayout(snapshot, planId)!;
    const entry = (id: string) => snapshot.entries.find(({value}) => value.id === id)!.value;
    return {snapshot, layout, entry};
}

const unitStatuses = (task: ExtractionTask) => Object.fromEntries(task.units.map(unit => [unit.id, unit.status]));

describe("大纲提取流水线：完整运行", () => {
    it("10 章两卷完整提取：方案命名、正式条目、来源依据与单元数量", async () => {
        const harness = setup();
        const task = await harness.start();
        expect(task.status).toBe("completed");
        const outcome = readOutlineExtractionOutcome(task);
        expect(outcome.planTitle).toBe("提取方案1·测试作品");
        expect(outcome.staleNotice).toBeNull();

        const {layout, entry} = await layoutOf(harness, outcome.planId);
        expect(layout.volumeIds).toHaveLength(2);
        expect(layout.chapterIds).toHaveLength(10);
        // 10 章 × (细纲 + 章节大纲) + 2 卷 + 1 总纲。
        expect(harness.model.requests).toHaveLength(23);

        const total = entry(layout.totalId);
        expect(total).toMatchObject({status: "adopted"});
        expect(total.body).toContain("# 核心冲突");
        for (const volumeId of layout.volumeIds) expect(entry(volumeId)).toMatchObject({status: "adopted"});
        layout.chapterIds.forEach((chapterId, position) => {
            const chapter = entry(chapterId);
            expect(chapter.status).toBe("adopted");
            expect(chapter.body).toContain(`第${position + 1}章目标`);
            expect(chapter.references?.[0]).toMatchObject({path: "reference/novel.md"});
            const details = layout.childrenOf(chapterId).filter(({value}) => value.kind === "detail");
            expect(details).toHaveLength(1);
            expect(details[0]!.value).toMatchObject({status: "adopted", basis: {kind: "source-extraction", sources: [{path: "reference/novel.md"}]}});
        });
    });

    it("卷纲与总纲的输入不含原文；章节大纲带细纲；所有请求都不带思考开关", async () => {
        const harness = setup();
        await harness.start();
        const byStep = (step: Step) => harness.model.requests.filter(request => stepOf(request.prompt) === step);
        for (const request of [...byStep("volume"), ...byStep("total")]) {
            expect(request.prompt).not.toContain(ORIGINAL_MARK);
            expect(request.prompt).not.toMatch(/【P\d+】/u);
            expect(request.prompt).not.toContain("【原文】");
        }
        // 卷纲只含本卷章节大纲，总纲只含各卷卷纲。
        expect(byStep("volume")[0]!.prompt).toContain("第1章目标");
        expect(byStep("volume")[0]!.prompt).not.toContain("第6章目标");
        expect(byStep("total")[0]!.prompt).toContain("卷1");
        expect(byStep("total")[0]!.prompt).not.toContain("第1章目标");

        // 同一章的细纲与章节大纲共用系统提示和逐字节相同的原文前缀；章节大纲再附上细纲。
        const [detail, outline] = [byStep("detail")[0]!, byStep("outline")[0]!];
        expect(detail.system).toBe(outline.system);
        const prefix = detail.prompt.slice(0, detail.prompt.indexOf("【任务】"));
        expect(outline.prompt.startsWith(prefix)).toBe(true);
        expect(outline.prompt).toContain("【本章已提取的细纲】");
        expect(outline.prompt).toContain("第1章事件");
        expect(outline.prompt.indexOf("【本章已提取的细纲】")).toBeLessThan(outline.prompt.indexOf("【任务】"));

        // 提取请求不提供思考开关，适配器统一关闭；观测元数据不改变此合同。
        for (const request of harness.model.requests) {
            expect(request).not.toHaveProperty("reasoning");
            expect(request.metadata?.prefixHash).toMatch(/^[a-f0-9]{64}$/u);
        }
    });

    it("同一作品连续新建的方案序号递增，且重复启动不会产生第二个方案", async () => {
        const harness = setup();
        const gate = createGate();
        const slow = setup({script: async ({step, chapter}) => { await gate.wait; return validOutput(step, chapter, ""); }});
        const running = await slow.manager.start({kind: "outline", source: SOURCE, params: paramsOf()});
        await expect(slow.manager.start({kind: "outline", source: SOURCE, params: paramsOf()}))
            .rejects.toMatchObject({code: "CONFLICT"});
        expect((await slow.planning.snapshot()).manifest.plans).toHaveLength(1);
        gate.open();
        await slow.manager.whenIdle();
        expect((await slow.manager.get(running.id)).status).toBe("completed");

        const first = await harness.start();
        const second = await harness.start();
        expect(readOutlineExtractionOutcome(first).planTitle).toBe("提取方案1·测试作品");
        expect(readOutlineExtractionOutcome(second).planTitle).toBe("提取方案2·测试作品");
    });
});

describe("大纲提取流水线：校验、失败与依赖", () => {
    it("引用越界先带错误信息重试一次；重试仍越界则该章失败，其余章节继续，卷纲与总纲留在等待", async () => {
        const harness = setup({script: ({step, chapter, attempt}) => {
            if (step === "detail" && chapter === 3) return validOutput("detail", 3, "").replace(/【引用】.*/u, "【引用】P9999");
            if (step === "detail" && chapter === 2 && attempt === 1) return validOutput("detail", 2, "").replace(/【引用】.*/u, "【引用】P9999");
            return undefined;
        }});
        const task = await harness.start();
        expect(task.status).toBe("partial-failed");
        const status = unitStatuses(task);
        expect(status["chapter-3:detail"]).toBe("failed");
        expect(task.units.find(unit => unit.id === "chapter-3:detail")!.error).toContain("超出本章范围");
        // 第 2 章第一次越界、第二次合格：重试成功。
        expect(status["chapter-2:detail"]).toBe("done");
        expect(harness.attempts.get("detail:2")).toBe(2);
        expect(harness.attempts.get("detail:3")).toBe(2);
        const repairPrompt = harness.model.requests.filter(request => stepOf(request.prompt) === "detail" && chapterOfPrompt(request.prompt) === 3)[1]!.prompt;
        expect(repairPrompt).toContain("【上一次产出未通过校验】");
        expect(repairPrompt).toContain("超出本章范围");
        // 失败章节的章节大纲、所属卷纲和总纲没有执行；另一卷照常完成。
        expect(status["chapter-3:outline"]).toBe("pending");
        expect(status["volume-1:summary"]).toBe("pending");
        expect(status["chapter-4:outline"]).toBe("done");
        expect(status["volume-2:summary"]).toBe("done");
        expect(status["total"]).toBe("pending");
    });

    it("跳过失败章节后，卷纲按已完成章节汇总并标明缺失，总纲随之继续", async () => {
        const harness = setup({script: ({step, chapter}) =>
            step === "outline" && chapter === 3 ? "没有按模板输出" : undefined});
        const failed = await harness.start();
        expect(failed.status).toBe("partial-failed");
        expect(unitStatuses(failed)["chapter-3:outline"]).toBe("failed");
        // 跳过会让部分失败的任务自动继续。
        await harness.manager.skipUnit(failed.id, "chapter-3:outline");
        await harness.manager.whenIdle();
        const task = await harness.manager.get(failed.id);
        expect(task.status).toBe("completed");

        // 第 2 卷不受影响，先于第 1 卷生成；只看第 1 卷的汇总请求。
        const volumePrompt = harness.model.requests.filter(request => stepOf(request.prompt) === "volume" && request.prompt.includes("卷1的章节大纲"))[0]!.prompt;
        expect(volumePrompt).toContain(MISSING_ITEM_TEXT);
        expect(volumePrompt).toContain("第1章目标");
        expect(volumePrompt).not.toContain("第3章目标");
        const {layout, entry} = await layoutOf(harness, readOutlineExtractionOutcome(task).planId);
        expect(entry(layout.chapterIds[2]!).body).toBe("");
        expect(entry(layout.volumeIds[0]!)).toMatchObject({status: "adopted"});
        expect(entry(layout.totalId).body).not.toBe("");
    });

    it("取消后继续只做未完成单元，已完成的不重复调用模型也不重复写入", async () => {
        const gate = createGate();
        const harness = setup({script: async ({step, chapter, attempt}) => {
            if (step === "outline" && chapter === 3 && attempt === 1) await gate.wait;
            return validOutput(step, chapter, "");
        }});
        const started = await harness.manager.start({kind: "outline", source: SOURCE, params: paramsOf()});
        while (!harness.attempts.has("outline:3")) await new Promise(resolve => setTimeout(resolve, 5));
        const cancelled = await harness.manager.cancel(started.id);
        expect(cancelled.status).toBe("cancelled");
        const doneBefore = cancelled.units.filter(unit => unit.status === "done").map(unit => unit.id);
        expect(doneBefore).toContain("chapter-3:detail");
        expect(doneBefore).not.toContain("chapter-3:outline");

        const requestsBefore = harness.model.requests.length;
        await harness.manager.resume(started.id);
        await harness.manager.whenIdle();
        const task = await harness.manager.get(started.id);
        expect(task.status).toBe("completed");
        // 取消时进行中的第 3 章大纲整体重做；其余 23 - 已发出的请求 + 1 次重做。
        expect(harness.model.requests.length).toBe(23 + 1);
        const resumed = harness.model.requests.slice(requestsBefore);
        expect(resumed.filter(request => stepOf(request.prompt) === "detail")).toHaveLength(10 - doneBefore.filter(id => id.endsWith(":detail")).length);
        const {layout} = await layoutOf(harness, readOutlineExtractionOutcome(task).planId);
        for (const chapterId of layout.chapterIds) {
            expect(layout.childrenOf(chapterId).filter(({value}) => value.kind === "detail")).toHaveLength(1);
        }
    });

    it("写入中途失败后重试：条目已有正文只补上采用，不再调用模型", async () => {
        const harness = setup();
        // 第一个 adopt-entry 属于第 1 章大纲：正文已写入但采用失败。
        harness.planning.failNext(write => write.kind === "adopt-entry", "磁盘暂时不可写");
        const failed = await harness.start();
        expect(failed.status).toBe("partial-failed");
        expect(unitStatuses(failed)["chapter-1:outline"]).toBe("failed");
        const requestsBefore = harness.model.requests.length;
        await harness.manager.retryUnit(failed.id, "chapter-1:outline");
        await harness.manager.whenIdle();
        const task = await harness.manager.get(failed.id);
        // 重试只补上采用；其后依赖它的卷纲与总纲也一并完成，所以只会多出卷纲与总纲两次调用。
        expect(harness.model.requests.length - requestsBefore).toBe(2);
        expect(task.status).toBe("completed");
        const {layout, entry} = await layoutOf(harness, readOutlineExtractionOutcome(task).planId);
        expect(entry(layout.chapterIds[0]!)).toMatchObject({status: "adopted"});
    });
});

describe("大纲提取流水线：补充", () => {
    async function completedPlan(harness: Harness) {
        const first = await harness.start();
        const outcome = readOutlineExtractionOutcome(first);
        return {first, planId: outcome.planId};
    }

    it("补充只填空缺，不改动已有内容，并提示卷纲与总纲已过期", async () => {
        const harness = setup();
        const {planId} = await completedPlan(harness);
        const before = await layoutOf(harness, planId);
        const userOutline = before.entry(before.layout.chapterIds[1]!);
        const detail4 = before.layout.childrenOf(before.layout.chapterIds[3]!).find(({value}) => value.kind === "detail")!;
        await harness.planning.removeEntry(detail4.value.id);
        await harness.planning.removeEntry(before.layout.chapterIds[9]!);
        harness.tag.current = "补充版";
        const requestsBefore = harness.model.requests.length;

        const task = await harness.start({kind: "supplement", planId});
        expect(task.status).toBe("completed");
        // 缺的是第 4 章细纲，以及重建的第 10 章细纲与章节大纲；卷纲和总纲已有内容，不生成。
        expect(harness.model.requests.slice(requestsBefore).map(request => `${stepOf(request.prompt)}:${chapterOfPrompt(request.prompt)}`))
            .toEqual(["detail:4", "detail:10", "outline:10"]);

        const after = await layoutOf(harness, planId);
        expect(after.layout.chapterIds).toHaveLength(10);
        expect(after.entry(after.layout.chapterIds[1]!)).toEqual(userOutline);
        expect(after.layout.childrenOf(after.layout.chapterIds[3]!).filter(({value}) => value.kind === "detail")).toHaveLength(1);
        expect(after.entry(after.layout.chapterIds[9]!).body).toContain("补充版第10章目标");
        expect(after.entry(after.layout.volumeIds[1]!).body).toBe(before.entry(before.layout.volumeIds[1]!).body);

        const outcome = readOutlineExtractionOutcome(task);
        expect(outcome.staleVolumes).toEqual([2]);
        expect(outcome.staleTotal).toBe(true);
        expect(outcome.staleNotice).toBe(STALE_NOTICE);
        expect(outcome.canResummarize).toBe(true);
    });

    it("重新汇总本卷与总纲：只重做过期的卷纲与总纲并清除过期标志", async () => {
        const harness = setup();
        const {planId} = await completedPlan(harness);
        const before = await layoutOf(harness, planId);
        await harness.planning.removeEntry(before.layout.chapterIds[9]!);
        harness.tag.current = "补充版";
        const task = await harness.start({kind: "supplement", planId});

        const resummarizeModel = createScriptedModel(request => validOutput(stepOf(request.prompt), 0, "重新汇总版"));
        const result = await resummarizeVolumesAndTotal({task, store: harness.store, planning: harness.planning, model: resummarizeModel, signal: new AbortController().signal});
        expect(result.volumes).toEqual([2]);
        expect(resummarizeModel.requests.map(request => stepOf(request.prompt))).toEqual(["volume", "total"]);
        // 卷纲输入来自库内的章节大纲，含刚补充的第 10 章。
        expect(resummarizeModel.requests[0]!.prompt).toContain("补充版第10章目标");
        expect(resummarizeModel.requests[0]!.prompt).not.toContain(ORIGINAL_MARK);

        const after = await layoutOf(harness, planId);
        expect(after.entry(after.layout.volumeIds[1]!)).toMatchObject({status: "adopted", body: expect.stringContaining("重新汇总版目标")});
        expect(after.entry(after.layout.volumeIds[0]!).body).toBe(before.entry(before.layout.volumeIds[0]!).body);
        expect(after.entry(after.layout.totalId).body).toContain("重新汇总版冲突");
        const stored = (await harness.store.read(task.id))!;
        expect(readOutlineExtractionOutcome(stored)).toMatchObject({staleVolumes: [], staleTotal: false, canResummarize: false});
        await expect(resummarizeVolumesAndTotal({task: stored, store: harness.store, planning: harness.planning, model: resummarizeModel, signal: new AbortController().signal}))
            .rejects.toMatchObject({code: "INVALID_STATE"});
    });
});

describe("大纲提取流水线：覆盖", () => {
    it("确认之前不写入任何内容；只覆盖被确认的项，其余保持原样，并返回过期提示", async () => {
        const harness = setup();
        const first = await harness.start();
        const planId = readOutlineExtractionOutcome(first).planId;
        const filesBefore = JSON.stringify([...harness.planning.fixture.files.entries()]);
        const writesBefore = harness.planning.writes.length;

        // 第二次提取复用同一个库与任务存储，只换模型：第 1-3 章内容变化，其余章节与原有内容一致。
        const model = createScriptedModel(request => {
            const step = stepOf(request.prompt);
            const chapter = step === "detail" || step === "outline" ? chapterOfPrompt(request.prompt) : 0;
            return validOutput(step, chapter, chapter >= 1 && chapter <= 3 ? "新版" : "");
        });
        const pipeline = createOutlinePipeline({planning: harness.planning, loadParagraphs: async () => paragraphsOf(10), listTasks: () => harness.store.list()});
        const manager = new ExtractionTaskManager({store: harness.store, model, verifySource: async () => undefined, resolvePipeline: () => pipeline, launch: createTestLaunch().launch});
        const started = await manager.start({kind: "outline", source: SOURCE, params: paramsOf({kind: "overwrite", planId})});
        await manager.whenIdle();
        const task = await manager.get(started.id);

        expect(task.status).toBe("awaiting-input");
        expect(task.awaitingInput).toBe("等待确认覆盖");
        expect(JSON.stringify([...harness.planning.fixture.files.entries()])).toBe(filesBefore);
        expect(harness.planning.writes).toHaveLength(writesBefore);

        const outcome = readOutlineExtractionOutcome(task);
        expect(outcome.comparison).toHaveLength(20);
        expect(outcome.comparison!.filter(item => item.changed).map(item => `${item.chapterIndex}:${item.kind}`).sort())
            .toEqual(["1:detail", "1:outline", "2:detail", "2:outline", "3:detail", "3:outline"]);
        const sample = outcome.comparison!.find(item => item.chapterIndex === 1 && item.kind === "outline")!;
        expect(sample.oldText).toContain("第1章目标");
        expect(sample.newText).toContain("新版第1章目标");
        expect(sample.locator).toBe("P1-P4");

        // 非法确认（对比里没有的项）被拒绝，任务仍在等待。
        await expect(manager.provideInput(task.id, {confirmedItems: [{chapterIndex: 99, kind: "outline"}]}))
            .rejects.toMatchObject({code: "INVALID_INPUT"});
        expect((await manager.get(task.id)).status).toBe("awaiting-input");

        const before = await layoutOf(harness, planId);
        const oldDetail2 = before.layout.childrenOf(before.layout.chapterIds[1]!).find(({value}) => value.kind === "detail")!.value;
        await manager.provideInput(task.id, {confirmedItems: [
            {chapterIndex: 1, kind: "outline"}, {chapterIndex: 1, kind: "detail"}, {chapterIndex: 2, kind: "outline"},
            // 内容一致的项即使被确认也不会产生写入。
            {chapterIndex: 5, kind: "outline"},
        ]});
        await manager.whenIdle();
        const done = await manager.get(task.id);
        expect(done.status).toBe("completed");
        expect(done.units.filter(unit => unit.step.startsWith("apply")).map(unit => unit.id).sort())
            .toEqual(["chapter-1:apply-detail", "chapter-1:apply-outline", "chapter-2:apply-outline"]);

        const after = await layoutOf(harness, planId);
        const outlineBody = (position: number) => after.entry(after.layout.chapterIds[position]!).body;
        expect(outlineBody(0)).toContain("新版第1章目标");
        expect(outlineBody(1)).toContain("新版第2章目标");
        // 未确认的第 3 章保持原样。
        expect(outlineBody(2)).toContain("第3章目标");
        expect(outlineBody(2)).not.toContain("新版");
        const details1 = after.layout.childrenOf(after.layout.chapterIds[0]!).filter(({value}) => value.kind === "detail");
        expect(details1).toHaveLength(1);
        expect(details1[0]!.value.body).toContain("新版第1章事件");
        expect(details1[0]!.value).toMatchObject({status: "adopted", basis: {kind: "source-extraction"}});
        // 第 2 章细纲没有被确认，仍是原来的那一份。
        const details2 = after.layout.childrenOf(after.layout.chapterIds[1]!).filter(({value}) => value.kind === "detail");
        expect(details2.map(({value}) => value.id)).toEqual([oldDetail2.id]);

        const result = readOutlineExtractionOutcome(done);
        expect(result.confirmed).toHaveLength(4);
        expect(result.staleVolumes).toEqual([1]);
        expect(result.staleTotal).toBe(true);
        expect(result.canResummarize).toBe(true);
        expect(result.failedOverwrites).toEqual([]);
    });

    it("覆盖写入失败保留原内容并点名失败项，其余项照常写入，重试可补上", async () => {
        const harness = setup();
        const first = await harness.start();
        const planId = readOutlineExtractionOutcome(first).planId;
        const model = createScriptedModel(request => {
            const step = stepOf(request.prompt);
            const chapter = step === "detail" || step === "outline" ? chapterOfPrompt(request.prompt) : 0;
            return validOutput(step, chapter, "新版");
        });
        const pipeline = createOutlinePipeline({planning: harness.planning, loadParagraphs: async () => paragraphsOf(10), listTasks: () => harness.store.list()});
        const manager = new ExtractionTaskManager({store: harness.store, model, verifySource: async () => undefined, resolvePipeline: () => pipeline, launch: createTestLaunch().launch});
        const started = await manager.start({kind: "outline", source: SOURCE, params: paramsOf({kind: "overwrite", planId})});
        await manager.whenIdle();
        const before = await layoutOf(harness, planId);
        const originalBody = before.entry(before.layout.chapterIds[1]!).body;

        // 第 2 章大纲：正文写入后采用失败，必须恢复为原正文。
        harness.planning.failNext(write => write.kind === "adopt-entry" && write.entryId === before.layout.chapterIds[1]!, "磁盘暂时不可写");
        await manager.provideInput(started.id, {confirmedItems: [{chapterIndex: 1, kind: "outline"}, {chapterIndex: 2, kind: "outline"}]});
        await manager.whenIdle();
        const partial = await manager.get(started.id);
        expect(partial.status).toBe("partial-failed");
        const outcome = readOutlineExtractionOutcome(partial);
        expect(outcome.failedOverwrites).toHaveLength(1);
        expect(outcome.failedOverwrites[0]).toMatchObject({chapterIndex: 2, kind: "outline"});
        expect(outcome.failedOverwrites[0]!.error).toContain("第2章");
        expect(outcome.failedOverwrites[0]!.error).toContain("原内容已保留");

        const mid = await layoutOf(harness, planId);
        expect(mid.entry(mid.layout.chapterIds[1]!)).toMatchObject({body: originalBody, status: "adopted"});
        expect(mid.entry(mid.layout.chapterIds[0]!).body).toContain("新版第1章目标");

        await manager.retryUnit(started.id, "chapter-2:apply-outline");
        await manager.whenIdle();
        const retried = await manager.get(started.id);
        expect(retried.status).toBe("completed");
        const end = await layoutOf(harness, planId);
        expect(end.entry(end.layout.chapterIds[1]!).body).toContain("新版第2章目标");
    });
});

describe("大纲提取流水线：数据去向", () => {
    it("来源内容变化后补充或覆盖被拒绝（不产生任何写入），只允许新建", async () => {
        const harness = setup();
        const first = await harness.start();
        const planId = readOutlineExtractionOutcome(first).planId;
        const changedSource = testSource("reference/novel.md", "b".repeat(64));
        const changedStructure = structureOf(10, [[1, 5], [6, 10]], "b".repeat(64));

        const options = listOutlineDestinations({snapshot: await harness.planning.snapshot(), tasks: await harness.store.list(), source: changedSource});
        expect(options).toEqual([expect.objectContaining({planId, sourceChanged: true, canSupplement: false, canOverwrite: false})]);
        const unchanged = listOutlineDestinations({snapshot: await harness.planning.snapshot(), tasks: await harness.store.list(), source: SOURCE});
        expect(unchanged).toEqual([expect.objectContaining({planId, sourceChanged: false, canSupplement: true, canOverwrite: true, reason: null})]);

        const writesBefore = harness.planning.writes.length;
        for (const kind of ["supplement", "overwrite"] as const) {
            await expect(harness.manager.start({kind: "outline", source: changedSource, params: paramsOf({kind, planId}, changedStructure)}))
                .rejects.toThrow(/只允许新建方案/u);
        }
        expect(harness.planning.writes).toHaveLength(writesBefore);
        const created = await harness.start({kind: "new"}, changedStructure, changedSource);
        expect(created.status).toBe("completed");
        expect(readOutlineExtractionOutcome(created).planTitle).toBe("提取方案2·测试作品");
    });

    it("目标方案不是提取方案或提取自另一部作品时拒绝；结构基于旧哈希时拒绝", async () => {
        const harness = setup();
        const manual = await harness.planning.apply({kind: "create-plan", title: "手工方案"});
        await expect(harness.manager.start({kind: "outline", source: SOURCE, params: paramsOf({kind: "supplement", planId: manual.planId!})}))
            .rejects.toThrow(/不是由大纲提取创建/u);
        await expect(harness.manager.start({kind: "outline", source: SOURCE, params: paramsOf({kind: "overwrite", planId: "不存在"})}))
            .rejects.toThrow(/目标方案不存在/u);
        await expect(harness.manager.start({kind: "outline", source: SOURCE, params: paramsOf({kind: "new"}, structureOf(10, [[1, 5], [6, 10]], "c".repeat(64)))}))
            .rejects.toMatchObject({code: "SOURCE_CHANGED"});
        await expect(harness.manager.start({kind: "outline", source: SOURCE, params: paramsOf({kind: "new"}, structureOf(10, [[1, 4], [6, 10]]))}))
            .rejects.toBeInstanceOf(ExtractionTaskError);
        expect((await harness.planning.snapshot()).manifest.plans).toHaveLength(1);
    });
});
