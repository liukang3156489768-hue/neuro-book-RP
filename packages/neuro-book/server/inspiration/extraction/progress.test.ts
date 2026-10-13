import {describe, expect, it} from "vitest";
import type {ExtractionTask, ExtractionUnit} from "nbook/shared/dto/inspiration-extraction-task.dto";
import {summarizeExtractionProgress} from "./progress";

function unit(id: string, group: string | null, status: ExtractionUnit["status"], attempts = 0, error: string | null = null): ExtractionUnit {
    return {id, step: "s", label: id, group, status, attempts, error, data: {}};
}

describe("提取进度汇总", () => {
    const task: ExtractionTask = {
        version: 1, id: "00000000-0000-4000-8000-000000000001", kind: "outline", source: {path: "a.md", sha256: "a".repeat(64)},
        modelKey: null, params: {}, state: {}, status: "running", awaitingInput: null, stopReason: null,
        units: [unit("a", "第一卷", "done", 1), unit("b", "第一卷", "failed", 2, "校验失败"), unit("c", "第二卷", "pending"), unit("d", null, "skipped"), unit("e", "第二卷", "running", 1)],
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };

    it("给出整体、按分组（首次出现顺序）与逐单元状态", () => {
        const progress = summarizeExtractionProgress(task);
        expect(progress.overall).toEqual({total: 5, pending: 1, running: 1, done: 1, failed: 1, skipped: 1});
        expect(progress.groups).toEqual([
            {group: "第一卷", counts: {total: 2, pending: 0, running: 0, done: 1, failed: 1, skipped: 0}},
            {group: "第二卷", counts: {total: 2, pending: 1, running: 1, done: 0, failed: 0, skipped: 0}},
        ]);
        expect(progress.units[1]).toEqual({id: "b", step: "s", label: "b", group: "第一卷", status: "failed", attempts: 2, error: "校验失败"});
        expect(progress.status).toBe("running");
    });

    it("不把单元 data 与任务 state 暴露在进度里", () => {
        const progress = summarizeExtractionProgress({...task, state: {secret: "x"}});
        expect(JSON.stringify(progress)).not.toContain("secret");
    });
});
