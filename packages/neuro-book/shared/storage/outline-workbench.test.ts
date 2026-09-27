import {effectScope, nextTick, ref, type EffectScope} from "vue";
import {describe, expect, it} from "vitest";
import type {StorageActionRequest, StorageActionResponse} from "nbook/shared/storage/action";
import type {StorageCredential} from "nbook/shared/storage/contract";
import {StorageAdapterError, type StorageValueTransport} from "nbook/app/utils/storage/value-transport";
import {openStorageOwnerHandle, type StorageOwnerHandle} from "nbook/app/utils/storage/owner-handle";
import type {StorageProjectContextTarget} from "nbook/app/utils/storage/host-context-client";
import type {WorkbenchLayoutSurface} from "nbook/app/utils/workbench/layout-session";
import type {WorkbenchStorageAdapters} from "nbook/app/utils/workbench/storage-context";
import {useOutlineWorkbenchSession} from "nbook/app/utils/outline/outline-workbench-session";
import {defineOutlineWorkbenchState, isOutlineWorkbenchRecord, OUTLINE_WORKBENCH_OWNER, OUTLINE_WORKBENCH_LAYOUT_KEY} from "nbook/shared/storage/outline-workbench";

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

describe("outline workbench storage definition", () => {
    it("uses an isolated project/local owner and single record", () => {
        const definition = defineOutlineWorkbenchState();
        expect(definition).toMatchObject({
            owner: "outline.workbench",
            key: "layout",
            scope: "project",
            locality: "local",
            records: "single",
            schemaVersion: 1,
        });
    });

    it("accepts partial preferences and rejects invalid boundaries", () => {
        expect(isOutlineWorkbenchRecord({agentWidth: 220, activeView: "lines", temperature: 2})).toBe(true);
        expect(isOutlineWorkbenchRecord({agentWidth: 219})).toBe(false);
        expect(isOutlineWorkbenchRecord({temperature: 2.1})).toBe(false);
        expect(isOutlineWorkbenchRecord({activeView: "unknown"})).toBe(false);
        expect(isOutlineWorkbenchRecord({modelKey: ""})).toBe(false);
    });
});

describe("大纲工作台会话的 Project/local Storage 合同", () => {
    it("缺失记录只显示默认值；显式提交仅持久化本次字段，相同提交不重复写盘", async () => {
        const harness = createHarness();
        const scope = effectScope();
        const current = ref<WorkbenchLayoutSurface>(surface(projectA));
        const session = scope.run(() => useOutlineWorkbenchSession({surface: current, adapters: harness.adapters}))!;
        try {
            await waitUntil(scope, () => !session.loading.value);
            // null 表示没有用户偏好；像素宽度由 UI 按视口比例换算，不落盘。
            expect(session.state.value).toMatchObject({agentWidth: null, activeView: "library", mode: "discuss"});
            expect(harness.records.has(harness.key(projectA))).toBe(false);
            expect(harness.saves).toEqual([]);
            expect(await session.commit({agentWidth: 440})).toMatchObject({status: "saved"});
            expect(harness.records.get(harness.key(projectA))?.value).toEqual({agentWidth: 440});
            expect(await session.commit({agentWidth: 440})).toMatchObject({status: "unchanged"});
            expect(harness.saves).toEqual([harness.key(projectA)]);
        } finally {
            scope.stop();
            await session.release();
        }
    });

    it("损坏记录只能显示默认值；提交及重试均不修复或覆盖损坏原件", async () => {
        const harness = createHarness();
        harness.write(projectA, {agentWidth: 99, mode: "invalid", extension: "retain"});
        const original = harness.records.get(harness.key(projectA));
        const scope = effectScope();
        const current = ref<WorkbenchLayoutSurface>(surface(projectA));
        const session = scope.run(() => useOutlineWorkbenchSession({surface: current, adapters: harness.adapters}))!;
        try {
            await waitUntil(scope, () => !session.loading.value);
            expect(session.state.value.agentWidth).toBeNull();
            expect(session.notice.value?.retryable).toBe(false);
            expect(await session.commit({agentWidth: 460})).toMatchObject({status: "unsaved"});
            expect(await session.retry()).toMatchObject({status: "unsaved"});
            expect(session.notice.value?.retryable).toBe(false);
            expect(harness.records.get(harness.key(projectA))).toEqual(original);
            expect(harness.saves).toHaveLength(0);
        } finally {
            scope.stop();
            await session.release();
        }
    });

    it("连续条件冲突保留意图；显式重试重读并合并外部字段", async () => {
        const harness = createHarness();
        harness.write(projectA, {agentWidth: 320, extension: "initial"});
        const scope = effectScope();
        const current = ref<WorkbenchLayoutSurface>(surface(projectA));
        const session = scope.run(() => useOutlineWorkbenchSession({surface: current, adapters: harness.adapters}))!;
        try {
            await waitUntil(scope, () => !session.loading.value);
            harness.conflicts.remaining = 2;
            expect(await session.commit({activeView: "lines"})).toMatchObject({status: "unsaved"});
            expect(session.notice.value).toMatchObject({retryable: true});
            expect(session.state.value.activeView).toBe("lines");
            expect(harness.saves).toHaveLength(0);
            harness.write(projectA, {agentWidth: 510, extension: "external"});
            expect(await session.retry()).toMatchObject({status: "saved"});
            expect(harness.records.get(harness.key(projectA))?.value).toEqual({agentWidth: 510, extension: "external", activeView: "lines"});
            expect(session.notice.value).toBeNull();
            expect(await session.retry()).toMatchObject({status: "unchanged"});
            expect(harness.saves).toEqual([harness.key(projectA)]);
        } finally {
            scope.stop();
            await session.release();
        }
    });

    it("相同 publicId 的不同 Project 根各自保存和恢复，不向另一 Project 写入", async () => {
        const harness = createHarness();
        const sameIdOtherRoot = {...projectB, publicId: projectA.publicId};
        const scope = effectScope();
        const current = ref<WorkbenchLayoutSurface>(surface(projectA));
        const session = scope.run(() => useOutlineWorkbenchSession({surface: current, adapters: harness.adapters}))!;
        try {
            await waitUntil(scope, () => !session.loading.value);
            expect(await session.commit({agentWidth: 420})).toMatchObject({status: "saved"});
            current.value = surface(sameIdOtherRoot);
            await waitUntil(scope, () => !session.loading.value && session.state.value.agentWidth === null);
            expect(harness.records.has(harness.key(sameIdOtherRoot))).toBe(false);
            expect(await session.commit({agentWidth: 620})).toMatchObject({status: "saved"});
            expect(harness.records.get(harness.key(projectA))?.value).toEqual({agentWidth: 420});
            expect(harness.records.get(harness.key(sameIdOtherRoot))?.value).toEqual({agentWidth: 620});
            current.value = surface(projectA);
            await waitUntil(scope, () => !session.loading.value && session.state.value.agentWidth === 420);
            expect(harness.saves).toEqual([harness.key(projectA), harness.key(sameIdOtherRoot)]);
        } finally {
            scope.stop();
            await session.release();
        }
    });

    it("idle 与 user-assets 不创建 Project 记录，也不能在离开 Project 后继续保存", async () => {
        const harness = createHarness();
        const scope = effectScope();
        const current = ref<WorkbenchLayoutSurface>({kind: "idle"});
        const session = scope.run(() => useOutlineWorkbenchSession({surface: current, adapters: harness.adapters}))!;
        try {
            await waitUntil(scope, () => !session.loading.value);
            expect(await session.commit({agentWidth: 410})).toMatchObject({status: "rejected"});
            current.value = {kind: "user-assets"};
            await settle();
            expect(await session.commit({agentWidth: 430})).toMatchObject({status: "rejected"});
            expect(harness.records.size).toBe(0);
            expect(harness.saves).toEqual([]);
            current.value = surface(projectA);
            await waitUntil(scope, () => !session.loading.value);
            expect(await session.commit({agentWidth: 470})).toMatchObject({status: "saved"});
            current.value = {kind: "idle"};
            await waitUntil(scope, () => !session.loading.value && session.state.value.agentWidth === null);
            expect(await session.commit({agentWidth: 690})).toMatchObject({status: "rejected"});
            expect(harness.saves).toEqual([harness.key(projectA)]);
            expect(harness.records.get(harness.key(projectA))?.value).toEqual({agentWidth: 470});
        } finally {
            scope.stop();
            await session.release();
        }
    });
});
