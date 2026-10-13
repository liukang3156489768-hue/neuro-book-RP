import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {useInspirationExtraction} from "nbook/app/composables/useInspirationExtraction";
import type {ExtractionApi} from "nbook/app/utils/inspiration/extraction-api";

const source = {path: "reference/book.txt", sha256: "a".repeat(64)};
const preview = {
    mode: "chapters", source, chapters: [{index: 1}, {index: 2}, {index: 3}],
    recognition: {chapters: [], volumeHeadings: []},
    suggestedVolumes: [{title: null, firstChapterIndex: 1, lastChapterIndex: 3}],
};
const runningTask = {id: "task-1", kind: "outline", status: "running", updatedAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z"};
const taskDetail = (status: string, kind = "outline") => ({task: {...runningTask, kind, status}, progress: {taskId: "task-1", status, kind}});

function createApi(overrides: Partial<Record<keyof ExtractionApi, unknown>> = {}) {
    const api = {
        listSources: vi.fn(async () => ({sources: [{path: source.path, name: "book.txt"}]})),
        prepareSource: vi.fn(async () => ({source: {path: source.path, name: "book.txt", bytes: 3, mtimeMs: 1, sha256: source.sha256}, paragraphs: [{id: "P1", text: "第一章"}], chunks: [{index: 1, firstParagraphId: "P1", lastParagraphId: "P1", characterCount: 3}], warnings: []})),
        previewStructure: vi.fn(async () => preview),
        confirmStructure: vi.fn(async () => ({structure: {volumes: []}})),
        listDestinations: vi.fn(async () => ({source, options: []})),
        listTasks: vi.fn(async () => ({tasks: []})),
        startTask: vi.fn(async () => ({task: runningTask})),
        getTask: vi.fn(async () => taskDetail("running")),
        removeTask: vi.fn(async () => ({deleted: true, taskId: "task-1"})),
        cancel: vi.fn(async () => ({})),
        provideInput: vi.fn(async () => ({})),
        getOutlineOutcome: vi.fn(async () => ({})),
        getReview: vi.fn(async () => ({items: []})),
        getConflicts: vi.fn(async () => []),
        confirmWrite: vi.fn(async () => ({review: {items: []}, outcomes: [], conflicts: []})),
        ...overrides,
    };
    return {api: api as unknown as ExtractionApi, mocks: api as unknown as Record<"confirmStructure" | "startTask" | "getTask" | "previewStructure" | "confirmWrite" | "getConflicts", ReturnType<typeof vi.fn>>};
}

const flush = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0); };

describe("useInspirationExtraction", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("大纲任务列表恢复最近任务，切换时进度与方案结果对应，新建重置去向与章节设置", async () => {
        const older = {...runningTask, id: "outline-old", status: "completed"};
        const latest = {...older, id: "outline-latest", createdAt: "2026-02-01T00:00:00.000Z", status: "interrupted"};
        const {api} = createApi({
            listTasks: vi.fn(async () => ({tasks: [older, latest]})),
            getTask: vi.fn(async (_root, id) => {
                const task = id === older.id ? older : latest;
                return {task, progress: {taskId: task.id, status: task.status, kind: "outline"}};
            }),
            getOutlineOutcome: vi.fn(async (_root, id) => ({planId: `plan-${id}`})),
        });
        const extraction = useInspirationExtraction("project", {api});
        await extraction.selectSource(source.path);
        expect(extraction.outline.tasks).toHaveLength(2);
        expect(extraction.outline.task?.id).toBe(latest.id);
        expect(extraction.outline.outcome?.planId).toBe(`plan-${latest.id}`);
        await extraction.outline.selectTask(older.id);
        expect(extraction.outline.progress?.taskId).toBe(older.id);
        expect(extraction.outline.outcome?.planId).toBe(`plan-${older.id}`);
        extraction.outline.destination = {kind: "overwrite", planId: "previous-plan"};
        extraction.outline.corrections = [{kind: "merge", chapterIndex: 1}];
        extraction.outline.createTask();
        await flush();
        expect(extraction.outline.task).toBeNull();
        expect(extraction.outline.outcome).toBeNull();
        expect(extraction.outline.destination).toEqual({kind: "new"});
        expect(extraction.outline.corrections).toEqual([]);
        expect(extraction.outline.tasks).toHaveLength(2);
        expect(extraction.material.task).toBeNull();
        extraction.dispose();
    });

    it("切换大纲任务后，旧方案结果的迟到响应不能覆盖新任务", async () => {
        let completeOld!: (outcome: {planId: string}) => void;
        const oldResult = new Promise<{planId: string}>(resolve => { completeOld = resolve; });
        const {api} = createApi({
            getTask: vi.fn(async (_root, id) => ({task: {...runningTask, id, status: "completed"},
                progress: {taskId: id, status: "completed", kind: "outline"}})),
            getOutlineOutcome: vi.fn(async (_root, id) => id === "old" ? oldResult : {planId: "new-plan"}),
        });
        const extraction = useInspirationExtraction("project", {api});
        await extraction.selectSource(source.path);
        const adoptingOld = extraction.outline.selectTask("old");
        await flush();
        await extraction.outline.selectTask("newer");
        completeOld({planId: "old-plan"});
        await adoptingOld;
        expect(extraction.outline.task?.id).toBe("newer");
        expect(extraction.outline.outcome?.planId).toBe("new-plan");
        extraction.dispose();
    });

    it("来源任务列表迟到时，新建的大纲设置不会被最近历史任务接管", async () => {
        let completeList!: (listed: {tasks: typeof runningTask[]}) => void;
        const listed = new Promise<{tasks: typeof runningTask[]}>(resolve => { completeList = resolve; });
        const {api} = createApi({listTasks: vi.fn(async () => listed)});
        const extraction = useInspirationExtraction("project", {api});
        const selecting = extraction.selectSource(source.path);
        await flush();
        extraction.outline.createTask();
        await flush();
        completeList({tasks: [{...runningTask, status: "completed"}]});
        await selecting;
        expect(extraction.outline.tasks).toHaveLength(1);
        expect(extraction.outline.task).toBeNull();
        expect(extraction.outline.outcome).toBeNull();
        expect(extraction.outline.destination).toEqual({kind: "new"});
        extraction.dispose();
    });

    it("大纲任务删除失败保留结果并显示原因，成功后回到新任务设置", async () => {
        const task = {...runningTask, status: "completed"};
        let remaining = [task];
        const remove = vi.fn().mockRejectedValueOnce({data: {message: "删除失败"}}).mockImplementationOnce(async () => {
            remaining = [];
            return {deleted: true, taskId: task.id};
        });
        const {api} = createApi({listTasks: vi.fn(async () => ({tasks: remaining})),
            getTask: vi.fn(async () => taskDetail("completed")), removeTask: remove,
            getOutlineOutcome: vi.fn(async () => ({planId: "saved-plan"}))});
        const extraction = useInspirationExtraction("project", {api});
        await extraction.selectSource(source.path);
        expect(await extraction.outline.removeTask(task.id)).toBe(false);
        expect(extraction.outline.tasksError?.message).toBe("删除失败");
        expect(extraction.outline.outcome?.planId).toBe("saved-plan");
        expect(await extraction.outline.removeTask(task.id)).toBe(true);
        expect(remove).toHaveBeenLastCalledWith("project", task.id);
        expect(extraction.outline.tasks).toEqual([]);
        expect(extraction.outline.task).toBeNull();
        expect(extraction.outline.outcome).toBeNull();
        extraction.dispose();
    });

    it("选择来源后载入章节预览，并按服务端建议生成划卷草稿", async () => {
        const {api, mocks} = createApi();
        const extraction = useInspirationExtraction("project", {api, pollIntervalMs: 1000, validateDelayMs: 10});
        await flush();
        expect(extraction.sources.value).toHaveLength(1);

        await extraction.selectSource(source.path);
        expect(mocks.previewStructure).toHaveBeenCalledWith("project", {path: source.path, corrections: []});
        expect(extraction.outline.volumes).toEqual([{title: "", first: "1", last: "3"}]);
        expect(extraction.outline.workTitle).toBe("book");
        extraction.dispose();
    });

    it("划卷校验错误原样显示，修正后恢复", async () => {
        const {api, mocks} = createApi();
        const extraction = useInspirationExtraction("project", {api, pollIntervalMs: 1000, validateDelayMs: 10});
        await extraction.selectSource(source.path);
        await flush();

        mocks.confirmStructure.mockRejectedValueOnce({data: {message: "第 1 卷与第 2 卷的章节范围重叠"}});
        extraction.outline.volumes = [{title: "", first: "1", last: "2"}, {title: "", first: "2", last: "3"}];
        await vi.advanceTimersByTimeAsync(20);
        expect(extraction.outline.divisionError?.message).toBe("第 1 卷与第 2 卷的章节范围重叠");
        expect(extraction.outline.canStartOutline).toBe(false);

        extraction.outline.volumes = [{title: "", first: "1", last: "3"}];
        await vi.advanceTimersByTimeAsync(20);
        expect(extraction.outline.divisionError).toBeNull();
        extraction.dispose();
    });

    it("章节修正按累积的修正列表重放预览，撤销回退最后一项", async () => {
        const {api, mocks} = createApi();
        const extraction = useInspirationExtraction("project", {api, pollIntervalMs: 1000, validateDelayMs: 10});
        await extraction.selectSource(source.path);

        await extraction.outline.addCorrection({kind: "merge", chapterIndex: 1});
        await extraction.outline.addCorrection({kind: "set-heading", paragraphId: "P9"});
        expect(mocks.previewStructure).toHaveBeenLastCalledWith("project", {
            path: source.path, corrections: [{kind: "merge", chapterIndex: 1}, {kind: "set-heading", paragraphId: "P9"}], mode: "chapters",
        });
        await extraction.outline.undoCorrection();
        expect(extraction.outline.corrections).toEqual([{kind: "merge", chapterIndex: 1}]);
        extraction.dispose();
    });

    it("启动大纲提取：先校验划卷，请求里不带任何确认者字段", async () => {
        const {api, mocks} = createApi();
        const extraction = useInspirationExtraction("project", {api, pollIntervalMs: 1000, validateDelayMs: 10});
        await extraction.selectSource(source.path);

        expect(await extraction.outline.startOutline("model-a")).toBe(true);
        const request = mocks.startTask.mock.calls[0]![0] as Record<string, unknown>;
        expect(request).toMatchObject({kind: "outline", projectRoot: "project", workTitle: "book", modelKey: "model-a", destination: {kind: "new"}});
        expect(JSON.stringify(request)).not.toMatch(/confirm(er|edBy)|identity/iu);
        extraction.dispose();
    });

    it("划卷校验未通过时不启动任务并显示原因", async () => {
        const {api, mocks} = createApi({confirmStructure: vi.fn(async () => { throw {data: {message: "最后一卷没有覆盖到末章"}}; })});
        const extraction = useInspirationExtraction("project", {api, pollIntervalMs: 1000, validateDelayMs: 10});
        await extraction.selectSource(source.path);

        expect(await extraction.outline.startOutline()).toBe(false);
        expect(mocks.startTask).not.toHaveBeenCalled();
        expect(extraction.outline.startError?.message).toBe("最后一卷没有覆盖到末章");
        extraction.dispose();
    });

    it("素材提取按固定顺序提交所选类别，大纲与素材各有独立任务", async () => {
        const {api, mocks} = createApi();
        const extraction = useInspirationExtraction("project", {api, pollIntervalMs: 1000, validateDelayMs: 10});
        await extraction.selectSource(source.path);

        extraction.material.toggleCategory("character");
        expect(extraction.material.categories).not.toContain("character");
        expect(await extraction.material.startMaterial()).toBe(true);
        const request = mocks.startTask.mock.calls[0]![0] as {kind: string; categories: string[]; source: Record<string, unknown>};
        expect(request.kind).toBe("material");
        expect(request.source).toEqual({path: source.path, sha256: source.sha256});
        expect(request.categories).toHaveLength(8);
        expect(request.categories).not.toContain("character");
        expect(extraction.outline.task).toBeNull();
        extraction.dispose();
    });

    it("素材写入：有同名冲突时先交给用户决定，不直接写入", async () => {
        const conflict = {itemId: "i1", title: "林舟", path: "lorebook/characters/林舟.md", role: "main", overwriteAllowed: true, existing: {origin: "design", content: "旧"}, incoming: "新"};
        const {api, mocks} = createApi({getConflicts: vi.fn(async () => [conflict])});
        const extraction = useInspirationExtraction("project", {api, pollIntervalMs: 1000, validateDelayMs: 10});
        await extraction.selectSource(source.path);
        await extraction.material.startMaterial();

        expect(await extraction.material.requestWrite()).toBe(false);
        expect(mocks.confirmWrite).not.toHaveBeenCalled();
        expect(extraction.material.pendingConflicts).toHaveLength(1);

        await extraction.material.confirmWrite([{itemId: "i1", action: "skip"}]);
        expect(mocks.confirmWrite).toHaveBeenCalledWith("project", "task-1", [{itemId: "i1", action: "skip"}]);
        extraction.dispose();
    });

    it("恢复来源上次的未完成任务；非运行状态不启动轮询，dispose 后不再请求", async () => {
        const interrupted = {...runningTask, status: "interrupted"};
        const {api, mocks} = createApi({
            listTasks: vi.fn(async () => ({tasks: [interrupted]})),
            getTask: vi.fn(async () => taskDetail("interrupted")),
        });
        const extraction = useInspirationExtraction("project", {api, pollIntervalMs: 1000, validateDelayMs: 10});
        await extraction.selectSource(source.path);
        expect(extraction.outline.task?.status).toBe("interrupted");

        await vi.advanceTimersByTimeAsync(5000);
        expect(mocks.getTask).toHaveBeenCalledTimes(1);
        extraction.dispose();
    });

    it("运行中的任务持续轮询，dispose 后停止", async () => {
        const {api, mocks} = createApi();
        const extraction = useInspirationExtraction("project", {api, pollIntervalMs: 1000, validateDelayMs: 10});
        await extraction.selectSource(source.path);
        await extraction.outline.startOutline();
        const before = mocks.getTask.mock.calls.length;

        await vi.advanceTimersByTimeAsync(2000);
        expect(mocks.getTask.mock.calls.length).toBeGreaterThan(before);

        extraction.dispose();
        const after = mocks.getTask.mock.calls.length;
        await vi.advanceTimersByTimeAsync(5000);
        expect(mocks.getTask.mock.calls.length).toBe(after);
    });
});
