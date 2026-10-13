import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {useExtractionTaskTracker} from "nbook/app/composables/useExtractionTaskTracker";
import type {ExtractionApi} from "nbook/app/utils/inspiration/extraction-api";

type Status = "running" | "awaiting-input" | "completed" | "cancelled" | "interrupted";

const detail = (status: Status, updatedAt = "2026-01-01T00:00:00.000Z") => ({
    task: {id: "task-1", kind: "outline", status, updatedAt},
    progress: {taskId: "task-1", status},
}) as never;

function createApi(sequence: Status[]) {
    let call = 0;
    const getTask = vi.fn(async () => detail(sequence[Math.min(call++, sequence.length - 1)]!));
    const api = {
        getTask,
        startTask: vi.fn(async () => ({task: {id: "task-1", kind: "outline", status: "running", updatedAt: "2026-01-01T00:00:00.000Z"}})),
        cancel: vi.fn(async () => ({})),
    } as unknown as ExtractionApi;
    return {api, getTask};
}

const request = {kind: "outline"} as never;

describe("useExtractionTaskTracker", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("只在任务运行期间轮询，进入非运行状态后停止并通知调用方", async () => {
        const {api, getTask} = createApi(["running", "running", "completed"]);
        const onSettled = vi.fn();
        const tracker = useExtractionTaskTracker({api, projectRoot: () => "project", pollIntervalMs: 1000, onSettled});

        await tracker.start(request);
        expect(getTask).toHaveBeenCalledTimes(1);
        expect(tracker.running.value).toBe(true);

        await vi.advanceTimersByTimeAsync(1000);
        expect(getTask).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1000);
        expect(getTask).toHaveBeenCalledTimes(3);
        expect(tracker.running.value).toBe(false);
        expect(onSettled).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(10_000);
        expect(getTask).toHaveBeenCalledTimes(3);
        tracker.dispose();
    });

    it("等待输入与中断状态不轮询", async () => {
        for (const status of ["awaiting-input", "interrupted"] as const) {
            const {api, getTask} = createApi([status]);
            const tracker = useExtractionTaskTracker({api, projectRoot: () => "project", pollIntervalMs: 1000});
            await tracker.start(request);
            await vi.advanceTimersByTimeAsync(5000);
            expect(getTask).toHaveBeenCalledTimes(1);
            tracker.dispose();
        }
    });

    it("dispose 后清理定时器，迟到的响应不再写回", async () => {
        const {api, getTask} = createApi(["running"]);
        const tracker = useExtractionTaskTracker({api, projectRoot: () => "project", pollIntervalMs: 1000});
        await tracker.start(request);
        tracker.dispose();
        await vi.advanceTimersByTimeAsync(5000);
        expect(getTask).toHaveBeenCalledTimes(1);
    });

    it("轮询失败后停止并显示友好错误，不无休止重试", async () => {
        const {api, getTask} = createApi(["running"]);
        getTask.mockResolvedValueOnce(detail("running"));
        getTask.mockRejectedValueOnce({data: {message: "服务暂时不可用"}});
        const tracker = useExtractionTaskTracker({api, projectRoot: () => "project", pollIntervalMs: 1000});
        await tracker.start(request);
        await vi.advanceTimersByTimeAsync(1000);
        expect(tracker.error.value?.message).toBe("服务暂时不可用");
        await vi.advanceTimersByTimeAsync(10_000);
        expect(getTask).toHaveBeenCalledTimes(2);
        tracker.dispose();
    });

    it("控制操作失败时保留当前任务并给出原因", async () => {
        const {api} = createApi(["running"]);
        (api.cancel as ReturnType<typeof vi.fn>).mockRejectedValueOnce({data: {message: "任务已经结束"}});
        const tracker = useExtractionTaskTracker({api, projectRoot: () => "project", pollIntervalMs: 1000});
        await tracker.start(request);
        expect(await tracker.cancel()).toBe(false);
        expect(tracker.error.value?.message).toBe("任务已经结束");
        expect(tracker.task.value?.id).toBe("task-1");
        tracker.dispose();
    });

    it("一键处理去重后只发一次请求和一次刷新，请求中阻止重复点击", async () => {
        const {api, getTask} = createApi(["awaiting-input"]);
        let release!: () => void;
        const changeFailedUnits = vi.fn(() => new Promise<void>(resolve => {release = resolve;}));
        api.changeFailedUnits = changeFailedUnits;
        const tracker = useExtractionTaskTracker({api, projectRoot: () => "project", pollIntervalMs: 1000});
        await tracker.adopt("task-1");
        const changing = tracker.changeFailedUnits("retry", ["u1", "u2", "u1"]);
        expect(tracker.busy.value).toBe(true);
        expect(await tracker.changeFailedUnits("skip", ["u1"])).toBe(false);
        expect(changeFailedUnits).toHaveBeenCalledExactlyOnceWith("project", "task-1", "retry", ["u1", "u2"]);
        release();
        expect(await changing).toBe(true);
        expect(getTask).toHaveBeenCalledTimes(2);
        expect(tracker.busy.value).toBe(false);
        expect(await tracker.changeFailedUnits("skip", [])).toBe(false);
        tracker.dispose();
    });

    it("批量请求返回前切换任务，旧响应不刷新或覆盖新任务", async () => {
        const {api, getTask} = createApi(["awaiting-input"]);
        let release!: () => void;
        api.changeFailedUnits = vi.fn(() => new Promise<void>(resolve => {release = resolve;}));
        const tracker = useExtractionTaskTracker({api, projectRoot: () => "project", pollIntervalMs: 1000});
        await tracker.adopt("task-1");
        const changing = tracker.changeFailedUnits("skip", ["u1"]);
        tracker.clear();
        getTask.mockResolvedValueOnce({task: {id: "task-2", status: "completed"}, progress: {taskId: "task-2", status: "completed"}} as never);
        await tracker.adopt("task-2");
        release();
        expect(await changing).toBe(false);
        expect(tracker.task.value?.id).toBe("task-2");
        expect(getTask).toHaveBeenCalledTimes(2);
        expect(tracker.busy.value).toBe(false);
        tracker.dispose();
    });
});
