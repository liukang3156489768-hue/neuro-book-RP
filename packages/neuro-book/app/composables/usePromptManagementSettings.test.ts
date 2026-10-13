import {effectScope, nextTick, ref} from "vue";
import {describe, expect, it, vi} from "vitest";
import {usePromptManagementSettings} from "./usePromptManagementSettings";
import type {PromptCatalogDto, PromptMutationDto} from "nbook/shared/dto/prompt-management.dto";

const catalog: PromptCatalogDto = {revision: 1, purposes: []};
const mutation: PromptMutationDto = {action: "select", purposeId: "design.character", presetId: "builtin", expectedRevision: 1};

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return {promise, resolve, reject};
}

describe("全局提示词设置请求生命周期", () => {
    it("离开区段后的旧读取不会覆盖重新进入取得的目录", async () => {
        const first = deferred<PromptCatalogDto>();
        const second = deferred<PromptCatalogDto>();
        const enabled = ref(true);
        const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const scope = effectScope();
        const state = scope.run(() => usePromptManagementSettings({enabled: () => enabled.value, read, write: async () => catalog}))!;
        try {
            enabled.value = false;
            await nextTick();
            enabled.value = true;
            await nextTick();
            second.resolve({revision: 3, purposes: []});
            await second.promise;
            await nextTick();
            first.resolve(catalog);
            await first.promise;
            await nextTick();
            expect(state.catalog.value?.revision).toBe(3);
            expect(state.loading.value).toBe(false);
        } finally { scope.stop(); }
    });

    it("写入失败保留已读取目录并释放保存锁", async () => {
        const scope = effectScope();
        const state = scope.run(() => usePromptManagementSettings({enabled: () => false, read: async () => catalog, write: async () => { throw new Error("版本冲突"); }}))!;
        try {
            await state.load();
            await expect(state.mutate(mutation)).rejects.toThrow("版本冲突");
            expect(state.catalog.value).toEqual(catalog);
            expect(state.saving.value).toBe(false);
        } finally { scope.stop(); }
    });

    it("保存中拒绝第二次写入，成功后使用服务端回声目录", async () => {
        const response = deferred<PromptCatalogDto>();
        const write = vi.fn(() => response.promise);
        const scope = effectScope();
        const state = scope.run(() => usePromptManagementSettings({enabled: () => false, read: async () => catalog, write}))!;
        try {
            const first = state.mutate(mutation);
            expect(state.saving.value).toBe(true);
            await expect(state.mutate(mutation)).rejects.toThrow("正在保存");
            expect(write).toHaveBeenCalledTimes(1);
            response.resolve({revision: 2, purposes: []});
            await first;
            expect(state.catalog.value?.revision).toBe(2);
            expect(state.saving.value).toBe(false);
        } finally { scope.stop(); }
    });

    it("拒绝不符合目录合同的响应，并将读取失败交给外壳", async () => {
        const scope = effectScope();
        const state = scope.run(() => usePromptManagementSettings({enabled: () => false, read: async () => ({revision: "bad"}), write: async () => catalog}))!;
        try {
            await state.load();
            expect(state.catalog.value).toBeNull();
            expect(state.loadError.value).not.toBe("");
            expect(state.loading.value).toBe(false);
        } finally { scope.stop(); }
    });
});
