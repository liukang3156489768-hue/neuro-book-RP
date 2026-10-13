import {ExtractionTaskSchema, type ExtractionTask} from "nbook/shared/dto/inspiration-extraction-task.dto";
import type {ExtractionTaskStore} from "./types";

/**
 * 内存存储，供测试与不需要落盘的场景使用。读写都经 schema 解析并深拷贝，
 * 因此它和文件存储一样拒绝非 JSON 数据，调用方拿到的也不是存储内部对象。
 * `snapshot()` 额外暴露当前全部记录，方便测试断言“重启”后读到什么。
 */
export function createMemoryExtractionStore(): ExtractionTaskStore & {snapshot(): ExtractionTask[]} {
    const tasks = new Map<string, ExtractionTask>();
    const copy = (task: ExtractionTask) => ExtractionTaskSchema.parse(structuredClone(task));
    return {
        async read(taskId) {
            const task = tasks.get(taskId);
            return task ? copy(task) : null;
        },
        async list() {
            return [...tasks.values()].map(copy);
        },
        async write(task) {
            tasks.set(task.id, copy(task));
        },
        async remove(taskId) {
            tasks.delete(taskId);
        },
        snapshot() {
            return [...tasks.values()].map(copy);
        },
    };
}
