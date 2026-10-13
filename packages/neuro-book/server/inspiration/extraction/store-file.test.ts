import {mkdir, readFile, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import {absoluteFsPath, type AbsoluteFsPath} from "nbook/server/runtime/paths/file-path";
import type {ExtractionTask} from "nbook/shared/dto/inspiration-extraction-task.dto";
import {createFileExtractionStore} from "./store-file";
import {createMemoryExtractionStore} from "./store-memory";

const mutation = vi.hoisted(() => vi.fn(async (_target: unknown, action: (handles: undefined) => Promise<unknown>) => action(undefined)));
vi.mock("nbook/server/workspace-files/project-open-guard", () => ({withProjectTargetMutation: mutation}));

function task(id: string, createdAt: string): ExtractionTask {
    return {
        version: 1, id, kind: "outline", source: {path: "reference/novel.md", sha256: "a".repeat(64)}, modelKey: null,
        params: {layout: {v1: ["c1"]}}, state: {}, status: "running", awaitingInput: null, stopReason: null,
        units: [{id: "chapter:c1", step: "chapter", label: "章节", group: "v1", status: "pending", attempts: 0, error: null, data: {}}],
        createdAt, updatedAt: createdAt,
    };
}

const ID_A = "00000000-0000-4000-8000-00000000000a";
const ID_B = "00000000-0000-4000-8000-00000000000b";

describe("提取任务存储", () => {
    let root: AbsoluteFsPath;
    const cleanup: string[] = [];

    beforeEach(async () => {
        mutation.mockClear();
        root = absoluteFsPath(await createTestTmpRoot("inspiration-extraction", "store-file-tests"));
        cleanup.push(root);
    });

    afterEach(async () => {
        await Promise.all(cleanup.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
    });

    it("写入 .nbook/inspiration/extractions/<id>/task.json，经项目 mutation gate，读回等价且重建存储后仍在", async () => {
        const store = createFileExtractionStore({kind: "user-assets", root});
        await store.write(task(ID_A, "2026-01-01T00:00:00.000Z"));
        expect(mutation).toHaveBeenCalledTimes(1);
        const onDisk = JSON.parse(await readFile(path.join(root, ".nbook", "inspiration", "extractions", ID_A, "task.json"), "utf8"));
        expect(onDisk).toMatchObject({id: ID_A, version: 1, status: "running"});
        expect(await createFileExtractionStore({kind: "user-assets", root}).read(ID_A)).toEqual(task(ID_A, "2026-01-01T00:00:00.000Z"));
    });

    it("不存在的任务读为 null；list 按创建时间排序并跳过损坏记录", async () => {
        const store = createFileExtractionStore({kind: "user-assets", root});
        expect(await store.read(ID_A)).toBeNull();
        expect(await store.list()).toEqual([]);
        await store.write(task(ID_B, "2026-01-02T00:00:00.000Z"));
        await store.write(task(ID_A, "2026-01-01T00:00:00.000Z"));
        const broken = path.join(root, ".nbook", "inspiration", "extractions", "00000000-0000-4000-8000-00000000000c");
        await mkdir(broken, {recursive: true});
        await writeFile(path.join(broken, "task.json"), "{ 不是 JSON");
        await mkdir(path.join(root, ".nbook", "inspiration", "extractions", "not-a-task"), {recursive: true});
        expect((await store.list()).map(item => item.id)).toEqual([ID_A, ID_B]);
        await expect(store.read("00000000-0000-4000-8000-00000000000c")).rejects.toBeDefined();
    });

    it("任务 ID 必须是 UUID，不能借路径越出任务目录", async () => {
        const store = createFileExtractionStore({kind: "user-assets", root});
        await expect(store.read("../../escape")).rejects.toThrow("格式无效");
        await expect(store.write(task("../../escape", "2026-01-01T00:00:00.000Z"))).rejects.toBeDefined();
    });

    it("拒绝不符合 schema 的记录，不把它写到磁盘", async () => {
        const store = createFileExtractionStore({kind: "user-assets", root});
        await expect(store.write({...task(ID_A, "2026-01-01T00:00:00.000Z"), status: "bogus" as never})).rejects.toBeDefined();
        expect(await store.read(ID_A)).toBeNull();
    });

    it("删除任务时递归清理任务目录及中间产物，并保持幂等", async () => {
        const store = createFileExtractionStore({kind: "user-assets", root});
        await store.write(task(ID_A, "2026-01-01T00:00:00.000Z"));
        const taskDirectory = path.join(root, ".nbook", "inspiration", "extractions", ID_A);
        await mkdir(path.join(taskDirectory, "material", "characters"), {recursive: true});
        await writeFile(path.join(taskDirectory, "material", "characters", "candidate.json"), "{}", "utf8");
        await store.remove(ID_A);
        expect(await store.read(ID_A)).toBeNull();
        await expect(readFile(path.join(taskDirectory, "material", "characters", "candidate.json"), "utf8")).rejects.toMatchObject({code: "ENOENT"});
        await expect(store.remove(ID_A)).resolves.toBeUndefined();
    });

    it("内存实现与文件实现语义一致：读写都是副本，非法记录被拒绝", async () => {
        const store = createMemoryExtractionStore();
        const original = task(ID_A, "2026-01-01T00:00:00.000Z");
        await store.write(original);
        original.status = "completed";
        const read = (await store.read(ID_A))!;
        expect(read.status).toBe("running");
        read.status = "cancelled";
        expect((await store.read(ID_A))!.status).toBe("running");
        expect(await store.read(ID_B)).toBeNull();
        await expect(store.write({...original, units: [original.units[0]!, original.units[0]!]})).rejects.toBeDefined();
    });
});
