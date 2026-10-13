import type {ExtractionTask} from "nbook/shared/dto/inspiration-extraction-task.dto";
import {ExtractionTaskError} from "./errors";
import {parseOutlineParams, readOutlineState, STALE_TOTAL_KEY, staleVolumeKey} from "./outline-params";
import type {OutlinePlanningPort} from "./outline-planning";
import {totalSummaryRequest, volumeSummaryRequest} from "./outline-summary";
import {replaceEntryBody} from "./outline-writer";
import {callWithRepair} from "./repair";
import type {ExtractionModelPort, ExtractionTaskStore} from "./types";

/**
 * “重新汇总本卷与总纲”：章节大纲被补充或覆盖后，按大纲库里现有的下级大纲重新生成过期的卷纲与总纲。
 *
 * 这是任务管理器之外的服务：任务结束后才可用，不属于任何运行中的任务。它直接读写任务记录来清除过期标志，
 * 因此调用方必须保证此刻没有该任务的活动执行者——传入的 `task` 应取自管理器（读取时已把
 * “运行中但无执行者”归一化为已中断），状态为运行中或等待输入时本函数拒绝执行。
 * 与管理器的 `resume`／`retryUnit` 并发调用不受保护，路由层应对同一任务串行化。
 */

export type ResummarizeResult = Readonly<{
    task: ExtractionTask;
    volumes: readonly number[];
    total: boolean;
}>;

export async function resummarizeVolumesAndTotal(input: Readonly<{
    task: ExtractionTask;
    store: ExtractionTaskStore;
    planning: OutlinePlanningPort;
    model: ExtractionModelPort;
    signal: AbortSignal;
}>): Promise<ResummarizeResult> {
    const {planning, model, signal, store} = input;
    let task = input.task;
    if (task.kind !== "outline") throw new ExtractionTaskError("INVALID_STATE", "只有大纲提取任务可以重新汇总。");
    if (task.status === "running" || task.status === "awaiting-input") {
        throw new ExtractionTaskError("INVALID_STATE", "任务还在运行或等待确认，请结束后再重新汇总。");
    }
    const plan = readOutlineState(task);
    const workTitle = parseOutlineParams(task.params, task.source).workTitle;
    const staleVolumes = plan.volumeIds.flatMap((_, position) => task.state[staleVolumeKey(position + 1)] === true ? [position + 1] : []);
    const needsTotal = staleVolumes.length > 0 || task.state[STALE_TOTAL_KEY] === true;
    if (!needsTotal) throw new ExtractionTaskError("INVALID_STATE", "没有过期的卷纲或总纲，无需重新汇总。");
    const writer = {port: planning, planId: plan.planId};
    const modelKey = task.modelKey ?? undefined;
    const done: number[] = [];

    /** 每完成一项就落盘清除对应标志：中途失败后再次触发只会重做剩下的。 */
    async function clear(patch: Record<string, boolean>): Promise<void> {
        task = {...task, state: {...task.state, ...patch}, updatedAt: new Date().toISOString()};
        await store.write(task);
    }

    for (const volume of staleVolumes) {
        const entryId = plan.volumeIds[volume - 1]!;
        const body = await callWithRepair({model, signal, modelKey, promptSnapshotId: task.promptSnapshotId, ...volumeSummaryRequest(await planning.snapshot(), plan.planId, entryId)});
        await replaceEntryBody(writer, entryId, body);
        await clear({[staleVolumeKey(volume)]: false});
        done.push(volume);
    }
    // 总纲汇总各卷卷纲，所以任何一卷重新汇总后总纲都要跟着重新汇总。
    const request = totalSummaryRequest(await planning.snapshot(), plan.planId, workTitle);
    const body = await callWithRepair({model, signal, modelKey, promptSnapshotId: task.promptSnapshotId, ...request});
    await replaceEntryBody(writer, plan.totalId, body);
    await clear({[STALE_TOTAL_KEY]: false});
    return {task, volumes: done, total: true};
}
