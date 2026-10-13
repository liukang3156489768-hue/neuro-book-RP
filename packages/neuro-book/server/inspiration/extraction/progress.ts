import type {ExtractionProgress, ExtractionTask, ExtractionUnit, ExtractionUnitCounts} from "nbook/shared/dto/inspiration-extraction-task.dto";

function emptyCounts(): ExtractionUnitCounts {
    return {total: 0, pending: 0, running: 0, done: 0, failed: 0, skipped: 0};
}

function addUnit(counts: ExtractionUnitCounts, unit: ExtractionUnit): void {
    counts.total += 1;
    counts[unit.status] += 1;
}

/**
 * 任务进度投影：整体、按分组（首次出现顺序）和逐单元状态。纯函数，不读写存储；
 * 传入读取时已归一化的任务（见 manager 的“已中断”推导）才能反映真实的运行状态。
 */
export function summarizeExtractionProgress(task: ExtractionTask): ExtractionProgress {
    const overall = emptyCounts();
    const groups = new Map<string, ExtractionUnitCounts>();
    for (const unit of task.units) {
        addUnit(overall, unit);
        if (unit.group === null) continue;
        let counts = groups.get(unit.group);
        if (!counts) {
            counts = emptyCounts();
            groups.set(unit.group, counts);
        }
        addUnit(counts, unit);
    }
    return {
        taskId: task.id,
        kind: task.kind,
        status: task.status,
        awaitingInput: task.awaitingInput,
        stopReason: task.stopReason,
        overall,
        groups: [...groups].map(([group, counts]) => ({group, counts})),
        units: task.units.map(({id, step, label, group, status, attempts, error}) => ({id, step, label, group, status, attempts, error})),
    };
}
