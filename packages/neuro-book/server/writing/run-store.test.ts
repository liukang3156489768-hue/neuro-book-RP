import fs from "node:fs/promises";
import path from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import {valueStoreConformanceCases, workflowBackendConformanceCases, workflowRunnerBackendConformanceCases, type WorkflowRunState} from "@notnotype/nb-workflow";
import {FileValueStore, FileWorkflowBackend} from "./run-store";

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

async function directory(name: string): Promise<string> {
    const root = await createTestTmpRoot("writing-run-store", name);
    roots.push(root);
    return path.join(root, "writing", "runs");
}

function initialRun(runId: string): WorkflowRunState {
    return {
        runId, definition: {key: "k", version: "1", manifestHash: "sha256:x"},
        input: {kind: "inline", value: {}}, extensionContext: {}, status: "running", cancelRequestedAt: null,
        budget: null, checkpoint: null, pendingAsks: [], pendingWaits: [], logs: [], progress: null, journal: [],
        revision: 0, createdAt: "2026-09-29T00:00:00.000Z", updatedAt: "2026-09-29T00:00:00.000Z",
    };
}

describe("FileWorkflowBackend", () => {
    for (const testCase of [...workflowBackendConformanceCases, ...workflowRunnerBackendConformanceCases]) {
        it(testCase.name, async () => {
            await testCase.run(async () => new FileWorkflowBackend(await directory("backend")));
        });
    }

    it("另一个实例能读到已保存的记录，且不留下临时文件", async () => {
        const dir = await directory("reopen");
        const first = new FileWorkflowBackend(dir);
        await first.createRun(initialRun("run_a"));
        const loaded = await first.loadRun("run_a");
        await first.saveRun({...loaded!, status: "completed"}, 0);
        const reopened = await new FileWorkflowBackend(dir).loadRun("run_a");
        expect(reopened).toMatchObject({status: "completed", revision: 1});
        expect(await fs.readdir(dir)).toEqual(["run_a.json"]);
    });

    it("读取与保存同时进行时保存不失败（Windows 上读取方占用会让改名失败）", async () => {
        const backend = new FileWorkflowBackend(await directory("concurrent"));
        let current = await backend.createRun(initialRun("run_c"));
        let saving = true;
        const reading = (async () => {
            while (saving) await Promise.all([backend.loadRun("run_c"), backend.listRuns()]);
        })();
        try {
            for (let step = 0; step < 60; step += 1) {
                current = await backend.saveRun({...current, logs: [...current.logs, `第 ${step} 步`]}, current.revision);
            }
        } finally {
            saving = false;
            await reading;
        }
        expect(await backend.loadRun("run_c")).toMatchObject({revision: 60});
    });

    it("损坏的记录报错而不是当作不存在", async () => {
        const dir = await directory("corrupt");
        await fs.mkdir(dir, {recursive: true});
        await fs.writeFile(path.join(dir, "run_b.json"), "{", "utf8");
        await expect(new FileWorkflowBackend(dir).loadRun("run_b")).rejects.toThrow("运行记录已损坏");
    });
});

describe("FileValueStore", () => {
    for (const testCase of valueStoreConformanceCases) {
        it(testCase.name, async () => {
            await testCase.run(async () => new FileValueStore(await directory("values")));
        });
    }

    it("文件内容被改动时拒绝读取", async () => {
        const dir = await directory("tamper");
        const store = new FileValueStore(dir);
        const reference = await store.put({text: "原文"});
        await fs.writeFile(path.join(dir, `${reference.key}.json`), JSON.stringify({text: "改过"}), "utf8");
        await expect(store.get(reference)).rejects.toThrow("integrity");
    });
});
