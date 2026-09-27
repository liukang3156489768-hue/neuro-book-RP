import {effectScope, nextTick, ref, type EffectScope} from "vue";
import {describe, expect, it} from "vitest";
import type {StorageActionRequest, StorageActionResponse} from "nbook/shared/storage/action";
import type {StorageCredential, StorageReadResult} from "nbook/shared/storage/contract";
import {StorageAdapterError, type StorageValueTransport} from "nbook/app/utils/storage/value-transport";
import {openStorageOwnerHandle, type StorageOwnerHandle} from "nbook/app/utils/storage/owner-handle";
import type {StorageProjectContextTarget} from "nbook/app/utils/storage/host-context-client";
import type {WorkbenchLayoutSurface} from "nbook/app/utils/workbench/layout-session";
import type {WorkbenchStorageAdapters} from "nbook/app/utils/workbench/storage-context";
import {useOutlineWorkbenchSession} from "nbook/app/utils/outline/outline-workbench-session";
import {OUTLINE_WORKBENCH_OWNER, OUTLINE_WORKBENCH_LAYOUT_KEY} from "nbook/shared/storage/outline-workbench";

const CLIENT_CREDENTIAL = "0123456789abcdef".repeat(4);
type Stored = {value: unknown; revision: string; schemaVersion: number};

type Harness = {
    readonly records: Map<string, Stored>;
    readonly adapters: WorkbenchStorageAdapters;
    readonly saves: string[];
    readonly conflicts: {remaining: number};
    key(target: StorageProjectContextTarget): string;
    write(target: StorageProjectContextTarget, value: unknown): void;
};

function createHarness(): Harness {
    const records = new Map<string, Stored>();
    const saves: string[] = [];
    const conflicts = {remaining: 0};
    let sequence = 0;
    const key = (target: StorageProjectContextTarget): string => `${target.projectRoot}/${target.publicId}/${OUTLINE_WORKBENCH_OWNER}/${OUTLINE_WORKBENCH_LAYOUT_KEY}`;
    const credential = (revision: string | null): StorageCredential => ({revision, partitionGeneration: 1});
    const transportFor = (projectRoot: string, publicId: string): StorageValueTransport => ({
        async send(action: StorageActionRequest): Promise<StorageActionResponse> {
            if (action.kind === "bind") return {kind: "bind", binding: {local: 1, shared: 1}};
            const recordKey = `${projectRoot}/${publicId}/${action.owner}/${action.key}`;
            if (action.kind === "read") {
                const record = records.get(recordKey);
                if (!record) return {kind: "read", result: {kind: "missing", credential: credential(null)}};
                if (record.schemaVersion !== action.schemaVersion) {
                    return {kind: "read", result: {kind: "legacy-value", value: record.value, schemaVersion: record.schemaVersion, credential: credential(record.revision)}};
                }
                return {kind: "read", result: {kind: "value", value: record.value, schemaVersion: record.schemaVersion, credential: credential(record.revision)}};
            }
            if (action.kind === "save") {
                if (conflicts.remaining > 0) {
                    conflicts.remaining -= 1;
                    throw new StorageAdapterError({code: "STORAGE_REVISION_CONFLICT", status: 409, message: "记录已被其它窗口改写", committed: false});
                }
                const current = records.get(recordKey);
                if ((current?.revision ?? null) !== action.expected.revision) {
                    throw new StorageAdapterError({code: "STORAGE_REVISION_CONFLICT", status: 409, message: "记录已被其它窗口改写", committed: false});
                }
                const revision = `revision-${++sequence}`;
                records.set(recordKey, {value: action.value, revision, schemaVersion: action.schemaVersion});
                saves.push(recordKey);
                return {kind: "save", credential: credential(revision)};
            }
            throw new Error(`未实现的 Storage action：${action.kind}`);
        },
    });
    const session = (target: StorageProjectContextTarget) => ({scope: "project" as const, contextId: `project-${target.publicId}`.padEnd(64, "p"), clientCredential: CLIENT_CREDENTIAL, projectRoot: target.projectRoot, publicId: target.publicId});
    const adapters: WorkbenchStorageAdapters = {
        openUserContext: async () => ({status: "ready", session: {scope: "user", contextId: "user".padEnd(64, "u"), clientCredential: CLIENT_CREDENTIAL}}),
        openProjectContext: async (target) => ({status: "ready", session: session(target)}),
        openOwnerHandle: async (options): Promise<StorageOwnerHandle> => openStorageOwnerHandle({
            ...options,
            transport: transportFor(
                options.session.scope === "project" ? options.session.projectRoot : "",
                options.session.scope === "project" ? options.session.publicId : "",
            ),
            subscribe: {intervalMs: 60_000, maxBackoffMs: 60_000},
        }),
        closeContext: async () => undefined,
    };
    return {records, adapters, saves, conflicts, key, write(target, value) {
        const revision = `revision-${++sequence}`;
        records.set(key(target), {value, revision, schemaVersion: 1});
    }};
}

const projectA = {projectRoot: "/workspace/outline-a", publicId: "runtime-a:1", revision: 1};
const projectB = {projectRoot: "/workspace/outline-b", publicId: "runtime-b:1", revision: 1};
function surface(ready: StorageProjectContextTarget): WorkbenchLayoutSurface { return {kind: "project", ready}; }

async function settle(): Promise<void> {
    for (let i = 0; i < 20; i += 1) await nextTick();
}

async function waitUntil(scope: EffectScope, predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 50; i += 1) {
        await settle();
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    scope.stop();
    throw new Error("工作台会话未在测试窗口内完成");
}

describe("大纲规划工作台 Project 会话", () => {
    it("缺失记录只回落默认值，主动提交后才写盘", async () => {
        const harness = createHarness();
        const scope = effectScope();
        const current = ref<WorkbenchLayoutSurface>(surface(projectA));
        const session = scope.run(() => useOutlineWorkbenchSession({surface: current, adapters: harness.adapters}))!;
        await waitUntil(scope, () => !session.loading.value);
        // agentWidth 为 null 表示「还没有用户偏好」，由 UI 按视口比例换算成像素。
        expect(session.state.value).toMatchObject({agentWidth: null, activeView: "library", thinkingEnabled: false, temperature: 0.7, mode: "discuss"});
        expect(harness.saves).toHaveLength(0);
        expect(await session.commit({agentWidth: 420, activeView: "lines"})).toMatchObject({status: "saved"});
        expect(harness.saves).toHaveLength(1);
        expect(harness.records.get(harness.key(projectA))?.value).toMatchObject({agentWidth: 420, activeView: "lines"});
        scope.stop();
    });

    it("Project 切换隔离布局，切回时恢复各自记录", async () => {
        const harness = createHarness();
        harness.write(projectA, {agentWidth: 512, modelKey: "model-a"});
        harness.write(projectB, {agentWidth: 640, modelKey: "model-b"});
        const scope = effectScope();
        const current = ref<WorkbenchLayoutSurface>(surface(projectA));
        const session = scope.run(() => useOutlineWorkbenchSession({surface: current, adapters: harness.adapters}))!;
        await waitUntil(scope, () => !session.loading.value);
        expect(session.state.value).toMatchObject({agentWidth: 512, modelKey: "model-a"});
        current.value = surface(projectB);
        await waitUntil(scope, () => !session.loading.value && session.state.value.agentWidth === 640);
        expect(session.state.value.modelKey).toBe("model-b");
        current.value = surface(projectA);
        await waitUntil(scope, () => !session.loading.value && session.state.value.agentWidth === 512);
        expect(session.state.value.modelKey).toBe("model-a");
        scope.stop();
    });

    it("损坏记录回落显示但不覆盖原件，保存结果明确不可用", async () => {
        const harness = createHarness();
        harness.write(projectA, {agentWidth: 99, mode: "not-a-mode"});
        const original = harness.records.get(harness.key(projectA));
        const scope = effectScope();
        const current = ref<WorkbenchLayoutSurface>(surface(projectA));
        const session = scope.run(() => useOutlineWorkbenchSession({surface: current, adapters: harness.adapters}))!;
        await waitUntil(scope, () => !session.loading.value);
        expect(session.state.value.agentWidth).toBeNull();
        expect(session.notice.value).toMatchObject({retryable: false});
        const result = await session.commit({agentWidth: 420});
        expect(result.status).toBe("unsaved");
        expect(harness.records.get(harness.key(projectA))).toEqual(original);
        expect(harness.saves).toHaveLength(0);
        scope.stop();
    });

    it("冲突保留待保存意图，重试成功后提交；非 Project 不写盘", async () => {
        const harness = createHarness();
        const scope = effectScope();
        const current = ref<WorkbenchLayoutSurface>(surface(projectA));
        const session = scope.run(() => useOutlineWorkbenchSession({surface: current, adapters: harness.adapters}))!;
        await waitUntil(scope, () => !session.loading.value);
        harness.conflicts.remaining = 2;
        const conflict = await session.commit({agentWidth: 480});
        expect(conflict.status).toBe("unsaved");
        expect(session.state.value.agentWidth).toBe(480);
        expect(session.notice.value?.retryable).toBe(true);
        expect(await session.retry()).toMatchObject({status: "saved"});
        expect(harness.records.get(harness.key(projectA))?.value).toMatchObject({agentWidth: 480});
        current.value = {kind: "user-assets"};
        await waitUntil(scope, () => !session.loading.value);
        const rejected = await session.commit({agentWidth: 700});
        expect(rejected.status).toBe("rejected");
        expect(harness.saves).toHaveLength(1);
        scope.stop();
    });
});






