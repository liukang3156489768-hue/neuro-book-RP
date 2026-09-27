import {readonly, ref, toValue, type MaybeRefOrGetter, type Ref} from "vue";
import {resolveApiErrorMessage} from "nbook/app/utils/api-error";

export type OutlineWorkbenchActions = Readonly<{
    pending: Readonly<Ref<boolean>>;
    error: Readonly<Ref<string | null>>;
    /**
     * 调用 `/api/projects/outline/<segment>`。失败时记录错误并返回 `null`，
     * 写入成功后触发 `onChanged` 重新读取规范快照；预览类只读调用传 `refresh: false`。
     */
    run<T>(segment: string, body: unknown, options?: Readonly<{refresh?: boolean; fallback?: string}>): Promise<T | null>;
    clearError(): void;
}>;

/**
 * 工作台所有编辑都走服务端动作：CAS 版本、共享分叉、删除影响都由服务端按同一快照判定，
 * 客户端只负责收集输入和展示结果，不在本地推导资格。
 */
export function useOutlineWorkbenchActions(
    projectRoot: MaybeRefOrGetter<string | null>,
    onChanged: () => Promise<void> | void,
): OutlineWorkbenchActions {
    const pending = ref(false);
    const error = ref<string | null>(null);

    async function run<T>(segment: string, body: unknown, options: Readonly<{refresh?: boolean; fallback?: string}> = {}): Promise<T | null> {
        const root = toValue(projectRoot);
        if (!root) { error.value = "当前没有打开的作品"; return null; }
        pending.value = true;
        error.value = null;
        try {
            const result = await $fetch<T>(`/api/projects/outline/${segment}`, {method: "POST", query: {projectRoot: root}, body: body as Record<string, unknown>});
            if (options.refresh !== false) await onChanged();
            return result;
        } catch (cause) {
            // 失败不自动刷新：刷新会用新快照重置编辑表单，版本冲突时用户需要先保留自己的输入。
            error.value = resolveApiErrorMessage(cause, options.fallback ?? "操作失败");
            return null;
        } finally {
            pending.value = false;
        }
    }

    return {pending: readonly(pending), error: readonly(error), run, clearError: () => { error.value = null; }};
}
