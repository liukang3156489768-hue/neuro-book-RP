import {createHash} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
    canonicalJson, WorkflowBackendConflictError, WorkflowRunNotFoundError, WorkflowValueIntegrityError, WorkflowValueNotFoundError,
    type BackendCapabilities, type JsonValue, type ValueRef, type ValueStore, type WorkflowBackend, type WorkflowRunState,
} from "@notnotype/nb-workflow";
import {absoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {writeStorageRecordFile} from "nbook/server/storage/record-file";

export const WRITING_RUNS_ROOT = "writing/runs";

const RUN_ID = /^[A-Za-z0-9_-]+$/u;
const VALUE_KEY = /^values\/[0-9a-f]{64}$/u;

/** 运行记录只在单进程内推进；重启后由宿主按记录重放，因此声明 processRestart。 */
export const writingRunBackendCapabilities: BackendCapabilities = Object.freeze({
    durability: "durable",
    processRestart: true,
    concurrentExecution: false,
    multiWorker: false,
    leases: false,
    durableSignals: false,
    durableTimers: false,
    childWorkflows: false,
    externalReceipts: false,
    outbox: false,
    valueReferences: true,
});

async function readTextOrNull(filePath: string): Promise<string | null> {
    try {
        return await fs.readFile(filePath, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

/**
 * 先写临时文件再改名：进程在写入中途退出时，旧记录保持完整。
 * 进程外的读取方（杀毒、索引）仍可能短暂占用目标文件，复用存储层对占用错误的有界重试。
 */
async function writeAtomic(filePath: string, content: string): Promise<void> {
    await writeStorageRecordFile({target: absoluteFsPath(filePath), content});
}

function identityOf(run: WorkflowRunState): string {
    return JSON.stringify({runId: run.runId, definition: run.definition, input: run.input,
        extensionContext: run.extensionContext, createdAt: run.createdAt});
}

/**
 * 写作运行记录：每个 Run 一个 JSON 文件。
 *
 * 不经过项目历史：Kernel 每完成一步就保存一次，走历史会让作品历史被运行过程刷满；
 * 运行记录本身就是逐步可审查的过程数据，需要的是崩溃安全，而不是可撤销。
 */
export class FileWorkflowBackend implements WorkflowBackend {
    readonly capabilities = writingRunBackendCapabilities;
    /**
     * 同一进程内按 Run 串行读取、比较与写入：revision 比较与写盘之间不被插队；
     * Windows 上读取方占用目标文件会让改名失败，界面轮询进度的读取也排进同一队列。
     */
    private readonly queues = new Map<string, Promise<unknown>>();

    constructor(private readonly directory: string) {}

    private filePath(runId: string): string {
        if (!RUN_ID.test(runId)) throw new Error(`运行记录 id 非法：${runId}`);
        return path.join(this.directory, `${runId}.json`);
    }

    private serialize<T>(runId: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.queues.get(runId) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(operation);
        this.queues.set(runId, next);
        void next.finally(() => {
            if (this.queues.get(runId) === next) this.queues.delete(runId);
        }).catch(() => undefined);
        return next;
    }

    private async read(runId: string): Promise<WorkflowRunState | null> {
        const filePath = this.filePath(runId);
        const content = await readTextOrNull(filePath);
        if (content === null) return null;
        try {
            return JSON.parse(content) as WorkflowRunState;
        } catch (error) {
            throw new Error(`运行记录已损坏：${WRITING_RUNS_ROOT}/${runId}.json（${error instanceof Error ? error.message : String(error)}）`);
        }
    }

    createRun(initial: WorkflowRunState): Promise<WorkflowRunState> {
        return this.serialize(initial.runId, async () => {
            if (initial.revision !== 0) throw new Error("A new workflow run must start at revision 0.");
            if (await this.read(initial.runId) !== null) throw new WorkflowBackendConflictError(initial.runId, -1, 0);
            await writeAtomic(this.filePath(initial.runId), JSON.stringify(initial));
            return structuredClone(initial);
        });
    }

    loadRun(runId: string): Promise<WorkflowRunState | null> {
        return this.serialize(runId, () => this.read(runId));
    }

    saveRun(next: WorkflowRunState, expectedRevision: number): Promise<WorkflowRunState> {
        return this.serialize(next.runId, async () => {
            const current = await this.read(next.runId);
            if (current === null) throw new WorkflowRunNotFoundError(next.runId);
            if (current.revision !== expectedRevision) {
                throw new WorkflowBackendConflictError(next.runId, expectedRevision, current.revision);
            }
            if (identityOf(current) !== identityOf(next)) {
                throw new Error(`Workflow run ${next.runId} immutable identity fields cannot change.`);
            }
            const stored = {...structuredClone(next), revision: expectedRevision + 1};
            await writeAtomic(this.filePath(next.runId), JSON.stringify(stored));
            return stored;
        });
    }

    async listRuns(): Promise<readonly WorkflowRunState[]> {
        let names: string[];
        try {
            names = await fs.readdir(this.directory);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
        }
        const runs: WorkflowRunState[] = [];
        for (const name of names) {
            if (!name.endsWith(".json")) continue;
            const run = await this.loadRun(name.slice(0, -".json".length));
            if (run !== null) runs.push(run);
        }
        return runs.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    }
}

/** 超过内联上限的值（例如较长的已通过正文）按内容寻址另存；文件一经写入不再改变。 */
export class FileValueStore implements ValueStore {
    constructor(private readonly directory: string) {}

    async put(value: JsonValue): Promise<ValueRef> {
        const canonical = canonicalJson(value);
        const hex = createHash("sha256").update(canonical).digest("hex");
        const key = `values/${hex}`;
        const filePath = path.join(this.directory, `${key}.json`);
        if (await readTextOrNull(filePath) === null) await writeAtomic(filePath, canonical);
        return {key, hash: `sha256:${hex}`, byteSize: Buffer.byteLength(canonical, "utf8"), mediaType: "application/json"};
    }

    async get(reference: ValueRef): Promise<JsonValue> {
        if (!VALUE_KEY.test(reference.key)) throw new WorkflowValueNotFoundError(reference);
        const canonical = await readTextOrNull(path.join(this.directory, `${reference.key}.json`));
        if (canonical === null) throw new WorkflowValueNotFoundError(reference);
        const hex = createHash("sha256").update(canonical).digest("hex");
        if (reference.hash !== `sha256:${hex}` || reference.byteSize !== Buffer.byteLength(canonical, "utf8")
            || reference.mediaType !== "application/json") {
            throw new WorkflowValueIntegrityError(reference);
        }
        return JSON.parse(canonical) as JsonValue;
    }
}
