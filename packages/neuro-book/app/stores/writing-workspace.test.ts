import {createPinia, setActivePinia, type Pinia} from "pinia";
import {reactive} from "vue";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {WritingChapterDto, WritingOverviewDto, WritingRunSummaryDto} from "nbook/shared/dto/writing.dto";

const novelIde = reactive({
    currentProjectRoot: "demo",
    workspaceDiskEvents: {sequence: 0, events: [] as {kind: "change"; path: string}[]},
    selectWorkspacePath: vi.fn(async () => null),
});
vi.mock("nbook/app/stores/novel-ide", () => ({useNovelIdeStore: () => novelIde}));

const {useWritingWorkspaceStore, WRITING_SESSION_VIEW_ID} = await import("./writing-workspace");

const chapter = (entryId: string, prose: string[] = []): WritingChapterDto => ({
    entryId, title: entryId, version: 1, contentHash: "h", volume: {entryId: "ol-vol", title: "第一卷"},
    details: [{entryId: `${entryId}-d`, title: "细纲", version: 1, contentHash: "h"}],
    status: prose.length ? "written" : "unwritten", writable: true,
    prose: prose.map((path) => ({path, title: path, empty: false, hasSource: true})),
});
const overview = (chapters: WritingChapterDto[]): WritingOverviewDto => ({
    settings: {schema: "nbook.writing-settings/v1", writingPlanId: "plan-a", stylePath: null},
    plans: [{id: "plan-a", title: "方案甲"}],
    plan: {state: "ready", planId: "plan-a", title: "方案甲", revision: 1},
    chapters, unlinkedProse: [],
});
const run = (chapterEntryId: string, status: WritingRunSummaryDto["status"]): WritingRunSummaryDto => ({
    runId: `run-${chapterEntryId}`, kind: "chapter", chapterEntryId, status, interrupted: false, error: null, createdAt: "t", updatedAt: "t",
});

let responses: Record<string, unknown>;
const fetchMock = vi.fn(async (url: string) => {
    const segment = url.split("/").pop()!;
    const value = responses[segment];
    if (value instanceof Error) throw value;
    return typeof value === "function" ? (value as () => unknown)() : value;
});
const calls = (segment: string) => fetchMock.mock.calls.filter(([url]) => url === `/api/projects/writing/${segment}`).length;

let pinia: Pinia;
beforeEach(() => {
    vi.useFakeTimers();
    pinia = createPinia();
    setActivePinia(pinia);
    vi.stubGlobal("$fetch", fetchMock);
    fetchMock.mockClear();
    novelIde.selectWorkspacePath.mockClear();
    responses = {
        overview: overview([chapter("ch1", ["manuscript/ch1/index.md"]), chapter("ch2")]),
        issues: {chapters: [], unreadable: []},
        styles: [],
        "active-runs": [],
        runs: [],
        entry: {id: "ch1-d", kind: "detail", version: 1, status: "draft", title: "细纲", parentId: "ch1", chapterId: "ch1", body: "正文"},
    };
});
afterEach(() => {
    // 各用例的 store 都在观察同一个 novelIde 替身，不释放会互相串扰。
    useWritingWorkspaceStore(pinia).$dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("写作界面状态", () => {
    it("选中细纲在中间只读显示，刷新后保留选中项，条目移出方案后清除", async () => {
        const store = useWritingWorkspaceStore();
        await store.refresh();
        store.select({kind: "entry", entryId: "ch1-d"});
        await vi.runOnlyPendingTimersAsync();
        expect(store.centreOpen).toBe(true);
        expect(store.entryView?.entry?.title).toBe("细纲");
        expect(store.selectedChapter?.entryId).toBe("ch1");

        await store.refresh();
        expect(store.selectedKey).toBe("entry:ch1-d");

        responses.overview = overview([chapter("ch2")]);
        await store.refresh();
        expect(store.selection).toBeNull();
        expect(store.centreOpen).toBe(false);
    });

    it("选中正文在编辑器中打开，不盖中间页", async () => {
        const store = useWritingWorkspaceStore();
        await store.refresh();
        store.select({kind: "prose", path: "manuscript/ch1/index.md"});
        expect(novelIde.selectWorkspacePath).toHaveBeenCalledWith("manuscript/ch1/index.md", "preview");
        expect(store.centreOpen).toBe(false);
    });

    it("问题记录读取失败时仍显示目录", async () => {
        responses.issues = new Error("boom");
        const store = useWritingWorkspaceStore();
        await store.refresh();
        expect(store.overview?.chapters).toHaveLength(2);
        expect(store.issuesError).toBeTruthy();
        expect(store.error).toBeNull();
    });

    it("规划变化刷新目录，运行记录变化只刷新进度", async () => {
        const store = useWritingWorkspaceStore();
        await store.refresh();
        const before = calls("overview");
        novelIde.workspaceDiskEvents = {sequence: 1, events: [{kind: "change", path: "writing/runs/run-1.json"}]};
        await vi.advanceTimersByTimeAsync(400);
        expect(calls("overview")).toBe(before);
        expect(calls("active-runs")).toBeGreaterThan(1);

        novelIde.workspaceDiskEvents = {sequence: 2, events: [{kind: "change", path: "outline/entries/x.md"}, {kind: "change", path: "outline/y.md"}]};
        await vi.advanceTimersByTimeAsync(400);
        expect(calls("overview")).toBe(before + 1);
    });

    it("运行中锁定本章正文，结束后解锁并重读目录", async () => {
        responses["active-runs"] = [run("ch1", "running")];
        const store = useWritingWorkspaceStore();
        await store.refresh();
        expect(store.isProseLocked("manuscript/ch1/index.md")).toBe(true);
        expect(store.isProseLocked("manuscript/other.md")).toBe(false);

        responses["active-runs"] = new Error("offline");
        await vi.advanceTimersByTimeAsync(1600);
        expect(store.connectionLost).toBe(true);
        expect(store.isProseLocked("manuscript/ch1/index.md")).toBe(true);

        responses["active-runs"] = [];
        const before = calls("overview");
        await vi.advanceTimersByTimeAsync(1600);
        expect(store.connectionLost).toBe(false);
        expect(store.isProseLocked("manuscript/ch1/index.md")).toBe(false);
        expect(calls("overview")).toBe(before + 1);
    });

    it("进程已退出的运行不锁定正文", async () => {
        responses["active-runs"] = [{...run("ch1", "running"), interrupted: true}];
        const store = useWritingWorkspaceStore();
        await store.refresh();
        expect(store.isProseLocked("manuscript/ch1/index.md")).toBe(false);
    });

    it("改写选区预填到这一章的会话并切到右栏；未关联的正文不能改写", async () => {
        const store = useWritingWorkspaceStore();
        await store.refresh();
        expect(store.requestRewrite("manuscript/ch1/index.md", "第一段\n\n第二段")).toBe(true);
        expect(store.composerDraft).toMatchObject({chapterEntryId: "ch1", send: false,
            text: "改写选中内容：\n> 第一段\n>\n> 第二段\n\n修改要求："});
        expect(store.revealRequest?.viewId).toBe(WRITING_SESSION_VIEW_ID);
        expect(store.selectedChapter?.entryId).toBe("ch1");
        expect(store.requestRewrite("manuscript/other.md", "文字")).toBe(false);
    });

    it("在大纲工作台中打开带上当前写作方案", async () => {
        const store = useWritingWorkspaceStore();
        await store.refresh();
        store.openInOutlineWorkbench("ch1-d");
        const first = store.outlineFocus!.token;
        store.openInOutlineWorkbench("ch1-d");
        expect(store.outlineFocus).toMatchObject({entryId: "ch1-d", planId: "plan-a"});
        expect(store.outlineFocus!.token).toBeGreaterThan(first);
    });
});
