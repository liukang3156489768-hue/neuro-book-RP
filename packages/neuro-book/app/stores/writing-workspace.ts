import {defineStore} from "pinia";
import {computed, ref, watch} from "vue";
import type {
    WritingChapterDto, WritingEntryDto, WritingIssuesDto, WritingOverviewDto, WritingRunProgressDto, WritingRunSummaryDto, WritingStyleOptionDto,
} from "nbook/shared/dto/writing.dto";
import {useNovelIdeStore} from "nbook/app/stores/novel-ide";
import {resolveApiErrorMessage} from "nbook/app/utils/api-error";
import {createWritingApi, type WritingApi, type WritingUserDecision} from "nbook/app/utils/writing/writing-api";
import {
    chapterOfProsePath, chapterOfSelection, lockedChapterIds, rewriteRequestText, selectionKey, type WritingSelection,
} from "nbook/app/utils/writing/writing-tree";

export const WRITING_OUTLINE_VIEW_ID = "nbook.writing-outline";
export const WRITING_SESSION_VIEW_ID = "nbook.writing-session";

/** 运行中的进度轮询间隔；运行记录每完成一步才落盘，更密没有意义。 */
const POLL_INTERVAL_MS = 1500;
/** 同一批磁盘事件往往成串到达，合并后再读一次。 */
const DISK_REFRESH_DELAY_MS = 300;

type EntryView = Readonly<{entryId: string; entry: WritingEntryDto | null; error: string | null; loading: boolean}>;
/** 预填到写作会话输入框的内容；send 为真时会话就绪后直接发出。token 区分两次相同内容的请求。 */
export type WritingComposerDraft = Readonly<{chapterEntryId: string; text: string; send: boolean; token: number}>;

/** 规划、正文与写作设置的变化会改变章节目录；运行记录的变化只影响进度。 */
function classifyDiskPath(raw: string): "overview" | "runs" | null {
    const path = raw.replace(/\\/gu, "/").replace(/^\.\//u, "");
    if (path.startsWith("writing/runs/")) return "runs";
    if (path.startsWith("outline/") || path.startsWith("manuscript/") || path.startsWith("writing/")) return "overview";
    return null;
}

/**
 * 写作界面（writing.workspace-ui）的共享状态：左栏大纲视图、中间只读条目与右栏写作会话共用。
 * 只保存界面状态；章节状态、问题与运行进度都来自服务端，刷新即重读。
 */
export const useWritingWorkspaceStore = defineStore("writingWorkspace", () => {
    const novelIde = useNovelIdeStore();
    const projectRoot = computed(() => novelIde.currentProjectRoot || null);
    let api: WritingApi | null = null;
    const apiFor = (root: string): WritingApi => (api ??= createWritingApi(root));

    const overview = ref<WritingOverviewDto | null>(null);
    const issues = ref<WritingIssuesDto | null>(null);
    const issuesError = ref<string | null>(null);
    const styles = ref<WritingStyleOptionDto[]>([]);
    const loading = ref(false);
    const error = ref<string | null>(null);
    const selection = ref<WritingSelection | null>(null);
    /** 卷默认展开、章节默认收起；这里各记与默认相反的那一侧。 */
    const collapsedVolumes = ref(new Set<string>());
    const expandedChapters = ref(new Set<string>());
    const entryView = ref<EntryView | null>(null);
    /** 中间只读页是否盖在编辑器上；用户在编辑器里打开别的文件时由页面收起。 */
    const centreOpen = ref(false);

    const activeRuns = ref<WritingRunSummaryDto[]>([]);
    const chapterRuns = ref<WritingRunSummaryDto[]>([]);
    const chapterRunsError = ref<string | null>(null);
    const runProgress = ref(new Map<string, WritingRunProgressDto>());
    /** 最近一次轮询失败；成功一次即恢复。失败期间保持上次的锁定，免得误放开编辑。 */
    const connectionLost = ref(false);

    const composerDraft = ref<WritingComposerDraft | null>(null);
    const outlineFocus = ref<Readonly<{entryId: string; planId: string | null; token: number}> | null>(null);
    const revealRequest = ref<Readonly<{viewId: string; token: number}> | null>(null);
    let token = 0;

    let loadGeneration = 0;
    let loaded = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let diskTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingDisk = {overview: false, runs: false};

    const selectedChapter = computed<WritingChapterDto | null>(() => chapterOfSelection(overview.value, selection.value));
    const lockedChapters = computed(() => lockedChapterIds(activeRuns.value));
    const selectedKey = computed(() => selectionKey(selection.value));
    /** 进程已退出的运行不会再推进，不为它轮询。 */
    const hasActiveRun = computed(() => lockedChapters.value.size > 0
        || lockedChapterIds(chapterRuns.value).size > 0);

    function reset(): void {
        loadGeneration += 1;
        api = null;
        loaded = false;
        overview.value = null;
        issues.value = null;
        issuesError.value = null;
        styles.value = [];
        error.value = null;
        selection.value = null;
        collapsedVolumes.value = new Set();
        expandedChapters.value = new Set();
        entryView.value = null;
        centreOpen.value = false;
        activeRuns.value = [];
        chapterRuns.value = [];
        chapterRunsError.value = null;
        runProgress.value = new Map();
        connectionLost.value = false;
        composerDraft.value = null;
        stopPolling();
        if (diskTimer) clearTimeout(diskTimer);
        diskTimer = null;
    }

    async function refresh(): Promise<void> {
        const root = projectRoot.value;
        if (!root) return;
        const generation = ++loadGeneration;
        const client = apiFor(root);
        loading.value = true;
        try {
            const [nextOverview, nextIssues, nextStyles] = await Promise.all([
                client.overview(),
                client.issues().then((value) => ({value, error: null}), (cause: unknown) => ({value: null, error: resolveApiErrorMessage(cause, "问题记录读取失败")})),
                client.styles().catch(() => [] as WritingStyleOptionDto[]),
            ]);
            if (generation !== loadGeneration) return;
            overview.value = nextOverview;
            issues.value = nextIssues.value;
            issuesError.value = nextIssues.error;
            styles.value = nextStyles;
            error.value = null;
            loaded = true;
            pruneSelection();
            if (entryView.value) void loadEntry(entryView.value.entryId);
        } catch (cause) {
            if (generation === loadGeneration) error.value = resolveApiErrorMessage(cause, "写作数据读取失败");
        } finally {
            if (generation === loadGeneration) loading.value = false;
        }
        await refreshRuns();
    }

    function ensureLoaded(): void {
        if (!loaded && !loading.value) void refresh();
    }

    /** 选中项在刷新后仍存在就保留；条目或正文已移出方案时清掉，免得右栏停在不存在的章节上。 */
    function pruneSelection(): void {
        const current = selection.value;
        const data = overview.value;
        if (!current || !data) return;
        const exists = current.kind === "unlinked"
            ? data.unlinkedProse.some(({path}) => path === current.path)
            : current.kind === "prose"
                ? data.chapters.some((chapter) => chapter.prose.some(({path}) => path === current.path))
                : current.kind === "empty-prose"
                    ? data.chapters.some((chapter) => chapter.entryId === current.chapterEntryId && chapter.prose.length === 0)
                    : data.chapters.some((chapter) => chapter.entryId === current.entryId || chapter.volume?.entryId === current.entryId
                        || chapter.details.some(({entryId}) => entryId === current.entryId));
        if (!exists) {
            selection.value = null;
            centreOpen.value = false;
        }
    }

    function select(next: WritingSelection): void {
        const previousChapter = selectedChapter.value?.entryId ?? null;
        selection.value = next;
        if (next.kind === "entry") {
            centreOpen.value = true;
            void loadEntry(next.entryId);
        } else {
            centreOpen.value = next.kind === "empty-prose";
            if (next.kind === "prose" || next.kind === "unlinked") void novelIde.selectWorkspacePath(next.path, "preview");
        }
        if ((selectedChapter.value?.entryId ?? null) !== previousChapter) void refreshChapterRuns();
    }

    function dismissCentre(): void {
        centreOpen.value = false;
    }

    async function loadEntry(entryId: string): Promise<void> {
        const root = projectRoot.value;
        if (!root) return;
        const previous = entryView.value?.entryId === entryId ? entryView.value.entry : null;
        entryView.value = {entryId, entry: previous, error: null, loading: true};
        try {
            const entry = await apiFor(root).entry(entryId);
            if (entryView.value?.entryId === entryId) entryView.value = {entryId, entry, error: null, loading: false};
        } catch (cause) {
            if (entryView.value?.entryId === entryId) {
                entryView.value = {entryId, entry: null, error: resolveApiErrorMessage(cause, "条目读取失败"), loading: false};
            }
        }
    }

    function toggleVolume(key: string): void {
        const next = new Set(collapsedVolumes.value);
        if (!next.delete(key)) next.add(key);
        collapsedVolumes.value = next;
    }
    function toggleChapter(entryId: string): void {
        const next = new Set(expandedChapters.value);
        if (!next.delete(entryId)) next.add(entryId);
        expandedChapters.value = next;
    }

    /** 写入类操作返回新的目录；失败时抛出服务端原因，由调用方提示。 */
    async function mutate(operation: (client: WritingApi) => Promise<WritingOverviewDto>): Promise<void> {
        const root = projectRoot.value;
        if (!root) return;
        overview.value = await operation(apiFor(root));
        pruneSelection();
        const nextIssues = await apiFor(root).issues().catch(() => null);
        if (nextIssues) {
            issues.value = nextIssues;
            issuesError.value = null;
        }
    }
    const setPlan = (planId: string | null) => mutate((client) => client.setPlan(planId));
    const setStyle = (stylePath: string | null) => mutate((client) => client.setStyle(stylePath));

    async function reloadStyles(root: string): Promise<void> {
        styles.value = await apiFor(root).styles().catch(() => styles.value);
    }

    /** 新文风的“文风要求”为空，建好后在编辑器里打开供用户补写。 */
    async function createStyle(title: string): Promise<void> {
        const root = projectRoot.value;
        if (!root) return;
        let stylePath = "";
        await mutate(async (client) => {
            const created = await client.createStyle(title);
            stylePath = created.stylePath;
            return created.overview;
        });
        await reloadStyles(root);
        openStyle(stylePath);
    }

    function openStyle(stylePath: string): void {
        centreOpen.value = false;
        void novelIde.selectWorkspacePath(stylePath, "permanent");
    }

    async function deleteStyle(stylePath: string): Promise<void> {
        const root = projectRoot.value;
        if (!root) return;
        await mutate((client) => client.deleteStyle(stylePath));
        await reloadStyles(root);
    }
    const linkProse = (path: string, chapterEntryId: string) => mutate((client) => client.linkProse(path, chapterEntryId));
    const unlinkProse = (path: string) => mutate((client) => client.unlinkProse(path));

    async function ignoreIssue(chapterEntryId: string, issueId: string): Promise<void> {
        const root = projectRoot.value;
        if (!root) return;
        const chapter = await apiFor(root).ignoreIssue(chapterEntryId, issueId);
        const current = issues.value ?? {chapters: [], unreadable: []};
        issues.value = {...current, chapters: [...current.chapters.filter((item) => item.chapterEntryId !== chapterEntryId), chapter]};
    }

    /* ---- 运行进度 ---- */

    async function refreshRuns(): Promise<void> {
        const root = projectRoot.value;
        if (!root || !overview.value) return;
        try {
            const previous = lockedChapters.value;
            activeRuns.value = await apiFor(root).activeRuns();
            connectionLost.value = false;
            // 有章节刚结束运行：章节状态与问题可能都变了。
            if ([...previous].some((id) => !lockedChapters.value.has(id))) void refresh();
        } catch {
            connectionLost.value = true;
        }
        await refreshChapterRuns();
        schedulePoll();
    }

    async function refreshChapterRuns(): Promise<void> {
        const root = projectRoot.value;
        const chapterEntryId = selectedChapter.value?.entryId;
        if (!root || !chapterEntryId) {
            chapterRuns.value = [];
            chapterRunsError.value = null;
            return;
        }
        try {
            const runs = await apiFor(root).runs(chapterEntryId);
            if (selectedChapter.value?.entryId !== chapterEntryId) return;
            chapterRuns.value = runs;
            chapterRunsError.value = null;
            // 最新一次运行总要显示完整进度；进行中的运行每次都重读。
            const latest = runs.at(-1);
            const targets = runs.filter((run) => run === latest || run.status === "running" || run.status === "waiting"
                || (runProgress.value.has(run.runId) && runProgress.value.get(run.runId)!.status !== run.status));
            await Promise.all(targets.map((run) => loadRunProgress(run.runId)));
            connectionLost.value = false;
        } catch (cause) {
            if (selectedChapter.value?.entryId !== chapterEntryId) return;
            if (chapterRuns.value.length === 0) chapterRunsError.value = resolveApiErrorMessage(cause, "运行记录读取失败");
            else connectionLost.value = true;
        }
    }

    async function loadRunProgress(runId: string): Promise<void> {
        const root = projectRoot.value;
        if (!root) return;
        storeProgress(await apiFor(root).run(runId));
    }

    function storeProgress(progress: WritingRunProgressDto): void {
        const next = new Map(runProgress.value);
        next.set(progress.runId, progress);
        runProgress.value = next;
        chapterRuns.value = chapterRuns.value.map((run) => run.runId === progress.runId
            ? {runId: run.runId, kind: progress.kind, chapterEntryId: progress.chapterEntryId, status: progress.status,
                interrupted: progress.interrupted, error: progress.error, createdAt: progress.createdAt, updatedAt: progress.updatedAt}
            : run);
    }

    function schedulePoll(delay = POLL_INTERVAL_MS): void {
        stopPolling();
        if (!projectRoot.value || (!hasActiveRun.value && !connectionLost.value)) return;
        pollTimer = setTimeout(() => {
            pollTimer = null;
            void refreshRuns();
        }, delay);
    }
    function stopPolling(): void {
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = null;
    }
    /** 主创可能刚发起运行（会话发送后），不等下一次磁盘事件，尽快读一次。 */
    function pollSoon(): void {
        stopPolling();
        pollTimer = setTimeout(() => {
            pollTimer = null;
            void refreshRuns();
        }, DISK_REFRESH_DELAY_MS);
    }

    async function runAction(operation: (client: WritingApi) => Promise<WritingRunProgressDto>): Promise<void> {
        const root = projectRoot.value;
        if (!root) return;
        storeProgress(await operation(apiFor(root)));
        await refreshRuns();
    }
    const stopRun = (runId: string) => runAction((client) => client.stop(runId));
    const continueChapter = (chapterEntryId: string) => runAction((client) => client.continue(chapterEntryId));
    const answerRun = (runId: string, key: string, decision: WritingUserDecision) => runAction((client) => client.answer(runId, key, decision));

    /** 正文编辑器是否只读：这一章有运行在执行或等待确认。 */
    function isProseLocked(path: string): boolean {
        const chapter = chapterOfProsePath(overview.value, path);
        return chapter !== null && lockedChapters.value.has(chapter.entryId);
    }

    /* ---- 跨视图请求 ---- */

    function reveal(viewId: string): void {
        revealRequest.value = {viewId, token: ++token};
    }

    function openInOutlineWorkbench(entryId: string): void {
        const plan = overview.value?.plan;
        outlineFocus.value = {entryId, planId: plan && plan.state !== "unset" ? plan.planId : null, token: ++token};
    }

    /** “开始写作”：切到右栏，把开写请求交给主创；可写与否仍由主创按服务端状态判断。 */
    function startWriting(chapterEntryId: string): void {
        composerDraft.value = {chapterEntryId, text: "请开始写这一章。", send: true, token: ++token};
        reveal(WRITING_SESSION_VIEW_ID);
    }

    /** 从编辑器选区发起改写；正文不属于任何章节时返回 false，由调用方提示。 */
    function requestRewrite(path: string, selectedText: string): boolean {
        const chapter = chapterOfProsePath(overview.value, path);
        if (!chapter || selectedText.trim() === "") return false;
        if (selectedChapter.value?.entryId !== chapter.entryId) {
            selection.value = {kind: "prose", path};
            centreOpen.value = false;
            void refreshChapterRuns();
        }
        composerDraft.value = {chapterEntryId: chapter.entryId, text: rewriteRequestText(selectedText), send: false, token: ++token};
        reveal(WRITING_SESSION_VIEW_ID);
        return true;
    }

    function consumeComposerDraft(draftToken: number): void {
        if (composerDraft.value?.token === draftToken) composerDraft.value = null;
    }

    watch(projectRoot, () => {
        reset();
    });

    watch(() => novelIde.workspaceDiskEvents.sequence, () => {
        if (!loaded) return;
        for (const event of novelIde.workspaceDiskEvents.events) {
            const kind = classifyDiskPath(event.path);
            if (kind) pendingDisk[kind] = true;
        }
        if (!pendingDisk.overview && !pendingDisk.runs) return;
        if (diskTimer) clearTimeout(diskTimer);
        diskTimer = setTimeout(() => {
            diskTimer = null;
            const pending = pendingDisk;
            pendingDisk = {overview: false, runs: false};
            void (pending.overview ? refresh() : refreshRuns());
        }, DISK_REFRESH_DELAY_MS);
    });

    return {
        projectRoot, overview, issues, issuesError, styles, loading, error,
        selection, selectedKey, selectedChapter, collapsedVolumes, expandedChapters, entryView, centreOpen,
        activeRuns, lockedChapters, chapterRuns, chapterRunsError, runProgress, connectionLost,
        composerDraft, outlineFocus, revealRequest,
        refresh, ensureLoaded, select, dismissCentre, loadEntry, toggleVolume, toggleChapter,
        setPlan, setStyle, createStyle, openStyle, deleteStyle, linkProse, unlinkProse, ignoreIssue,
        refreshRuns, loadRunProgress, pollSoon, stopRun, continueChapter, answerRun, isProseLocked,
        reveal, openInOutlineWorkbench, startWriting, requestRewrite, consumeComposerDraft,
    };
});
