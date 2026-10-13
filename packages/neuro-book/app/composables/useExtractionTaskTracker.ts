import {computed, getCurrentInstance, onBeforeUnmount, ref, shallowRef} from "vue";
import type {ExtractionStartRequestDto} from "nbook/shared/dto/inspiration-extraction-api.dto";
import type {ExtractionProgress, ExtractionTask} from "nbook/shared/dto/inspiration-extraction-task.dto";
import type {ExtractionApi, ExtractionInput} from "nbook/app/utils/inspiration/extraction-api";
import {describeExtractionError, type DescribedError} from "nbook/app/utils/inspiration/extraction-labels";

/**
 * 单个提取任务（大纲或素材）的跟踪器：保存任务与进度、发起控制操作，并在任务运行期间轮询。
 *
 * 轮询只在任务状态为 `running` 时进行；进入等待输入、完成、取消、中断等任何非运行状态都会停止，
 * 离开组件时也会清理定时器。任务进入非运行状态或任务记录更新时回调 `onSettled`，
 * 由调用方决定要补取哪些结果数据（覆盖对比、归类候选、待写入清单）。
 */

export type TrackerOptions = Readonly<{
    api: ExtractionApi;
    projectRoot: () => string | null;
    pollIntervalMs: number;
    /** 任务不再运行时调用；`changed` 表示相对上一次已处理的记录有更新。 */
    onSettled?: (detail: {task: ExtractionTask; progress: ExtractionProgress}, changed: boolean) => Promise<void> | void;
}>;

export function useExtractionTaskTracker(options: TrackerOptions) {
    const task = shallowRef<ExtractionTask | null>(null);
    const progress = shallowRef<ExtractionProgress | null>(null);
    const error = ref<DescribedError | null>(null);
    const busy = ref(false);
    const running = computed(() => task.value?.status === "running");

    let timer: ReturnType<typeof setTimeout> | null = null;
    // 来源切换或清空后，迟到的响应不能写回新状态。
    let generation = 0;
    let settledStamp = "";

    function stopPolling(): void {
        if (timer !== null) clearTimeout(timer);
        timer = null;
    }

    function schedulePoll(): void {
        stopPolling();
        if (!running.value) return;
        timer = setTimeout(() => { void refresh(); }, options.pollIntervalMs);
    }

    /** 读取任务详情并更新进度；运行中则安排下一次轮询。 */
    async function refresh(): Promise<void> {
        const root = options.projectRoot();
        const id = task.value?.id;
        if (!root || !id) return;
        const current = generation;
        try {
            const detail = await options.api.getTask(root, id);
            if (current !== generation) return;
            task.value = detail.task;
            progress.value = detail.progress;
            error.value = null;
            if (detail.task.status !== "running") {
                const stamp = `${detail.task.id}:${detail.task.status}:${detail.task.updatedAt}`;
                const changed = stamp !== settledStamp;
                settledStamp = stamp;
                await options.onSettled?.({task: detail.task, progress: detail.progress}, changed);
            }
        } catch (cause) {
            if (current !== generation) return;
            // 轮询失败不再自动重试，避免服务不可用时无休止请求；用户可手动刷新。
            error.value = describeExtractionError(cause);
            stopPolling();
            return;
        }
        if (current === generation) schedulePoll();
    }

    /** 接管一个已存在的任务（恢复来源上次的任务）。 */
    async function adopt(taskId: string): Promise<void> {
        const root = options.projectRoot();
        if (!root) return;
        const current = generation;
        try {
            const detail = await options.api.getTask(root, taskId);
            if (current !== generation) return;
            task.value = detail.task;
            progress.value = detail.progress;
            settledStamp = "";
            error.value = null;
            if (detail.task.status === "running") schedulePoll();
            else await options.onSettled?.({task: detail.task, progress: detail.progress}, true);
        } catch (cause) {
            if (current === generation) error.value = describeExtractionError(cause);
        }
    }

    /** 执行一个会改变任务的请求，然后立即刷新；失败时保留当前状态并显示原因。 */
    async function mutate(action: () => Promise<unknown>): Promise<boolean> {
        busy.value = true;
        error.value = null;
        const current = generation;
        try {
            await action();
            if (current !== generation) return false;
            await refresh();
            return error.value === null;
        } catch (cause) {
            if (current === generation) error.value = describeExtractionError(cause);
            return false;
        } finally {
            if (current === generation) busy.value = false;
        }
    }

    async function start(request: ExtractionStartRequestDto): Promise<boolean> {
        busy.value = true;
        error.value = null;
        const current = generation;
        try {
            const created = await options.api.startTask(request);
            if (current !== generation) return false;
            task.value = created.task;
            progress.value = null;
            settledStamp = "";
            await refresh();
            return true;
        } catch (cause) {
            if (current === generation) error.value = describeExtractionError(cause);
            return false;
        } finally {
            if (current === generation) busy.value = false;
        }
    }

    const withIds = <T>(call: (root: string, id: string) => Promise<T>) => (): Promise<boolean> => {
        const root = options.projectRoot();
        const id = task.value?.id;
        return root && id ? mutate(() => call(root, id)) : Promise.resolve(false);
    };

    const cancel = withIds((root, id) => options.api.cancel(root, id));
    const resume = withIds((root, id) => options.api.resume(root, id));

    function retryUnit(unitId: string): Promise<boolean> {
        return withIds((root, id) => options.api.retryUnit(root, id, unitId))();
    }

    function skipUnit(unitId: string): Promise<boolean> {
        return withIds((root, id) => options.api.skipUnit(root, id, unitId))();
    }

    function changeFailedUnits(action: "retry" | "skip", unitIds: readonly string[]): Promise<boolean> {
        if (busy.value || !unitIds.length) return Promise.resolve(false);
        const ids = [...new Set(unitIds)];
        return withIds((root, id) => options.api.changeFailedUnits(root, id, action, ids))();
    }

    function provideInput(input: ExtractionInput): Promise<boolean> {
        return withIds((root, id) => options.api.provideInput(root, id, input))();
    }

    function clear(): void {
        generation += 1;
        stopPolling();
        task.value = null;
        progress.value = null;
        error.value = null;
        busy.value = false;
        settledStamp = "";
    }

    function dispose(): void {
        generation += 1;
        stopPolling();
    }
    // 脱离组件使用（单元测试）时没有卸载钩子，调用方自行 dispose。
    if (getCurrentInstance()) onBeforeUnmount(dispose);

    return {task, progress, error, busy, running, refresh, adopt, start, cancel, resume, retryUnit, skipUnit, changeFailedUnits, provideInput, mutate, clear, dispose};
}

export type ExtractionTaskTracker = ReturnType<typeof useExtractionTaskTracker>;
