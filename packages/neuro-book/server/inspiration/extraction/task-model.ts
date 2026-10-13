import {ExtractionUnitSchema, type ExtractionTask, type ExtractionUnit} from "nbook/shared/dto/inspiration-extraction-task.dto";
import {ExtractionTaskError} from "./errors";
import type {ExtractionTaskPatch, NewExtractionUnit} from "./types";

/** 新单元一律从“等待”开始；经 schema 解析，让越界字段在流水线边界就失败而不是落盘时才失败。 */
export function createUnit(next: NewExtractionUnit): ExtractionUnit {
    return ExtractionUnitSchema.parse({
        id: next.id, step: next.step, label: next.label, group: next.group ?? null,
        status: "pending", attempts: 0, error: null, data: next.data ?? {},
    });
}

/** 原地应用流水线的增量变更：追加单元（ID 不得重复）、浅合并状态。 */
export function applyTaskPatch(task: ExtractionTask, patch: ExtractionTaskPatch): void {
    const existing = new Set(task.units.map(unit => unit.id));
    for (const next of patch.appendUnits ?? []) {
        if (existing.has(next.id)) throw new Error(`追加的单元 ID 重复：${next.id}`);
        existing.add(next.id);
        task.units.push(createUnit(next));
    }
    if (patch.state) task.state = {...task.state, ...patch.state};
}

function requireUnit(task: ExtractionTask, unitId: string, allowed: readonly ExtractionUnit["status"][], message: string): ExtractionUnit {
    const unit = task.units.find(candidate => candidate.id === unitId);
    if (!unit) throw new ExtractionTaskError("NOT_FOUND", `任务中没有单元：${unitId}`);
    if (!allowed.includes(unit.status)) throw new ExtractionTaskError("INVALID_STATE", `${message}（当前状态：${unit.status}）`);
    return unit;
}

/** 失败或已跳过的单元回到等待；重试次数清零，使手动重试重新享有两次校验机会。 */
export function resetUnitForRetry(task: ExtractionTask, unitId: string): void {
    const unit = requireUnit(task, unitId, ["failed", "skipped"], "只有失败或已跳过的单元可以重试");
    unit.status = "pending";
    unit.attempts = 0;
    unit.error = null;
}

/** 明确放弃失败单元，让依赖它的后续汇总按已完成部分继续。 */
export function markUnitSkipped(task: ExtractionTask, unitId: string): void {
    requireUnit(task, unitId, ["failed"], "只有失败的单元可以跳过").status = "skipped";
}

/**
 * 读取时的状态归一化：持久化为“运行中”却没有活动执行者的任务（进程重启、项目关闭、写入被拒绝）
 * 呈现为“已中断”，其“运行中”单元回到等待。不写回存储；用户继续任务时才落盘。
 */
export function normalizeInactiveTask(task: ExtractionTask): ExtractionTask {
    if (task.status !== "running") return task;
    return {
        ...task,
        status: "interrupted",
        units: task.units.map(unit => unit.status === "running" ? {...unit, status: "pending"} : unit),
    };
}
