import {onScopeDispose, ref, shallowRef, watch} from "vue";
import {PromptCatalogDtoSchema, type PromptCatalogDto, type PromptMutationDto} from "nbook/shared/dto/prompt-management.dto";
import {resolveApiErrorMessage} from "nbook/app/utils/api-error";

type PromptManagementSettingsOptions = {
    enabled: () => boolean;
    read: () => Promise<unknown>;
    write: (mutation: PromptMutationDto) => Promise<unknown>;
};

/** 设置宿主持有请求生命周期；视图只持有未保存草稿。 */
export function usePromptManagementSettings(options: PromptManagementSettingsOptions) {
    const catalog = shallowRef<PromptCatalogDto | null>(null);
    const loading = ref(false);
    const saving = ref(false);
    const loadError = ref("");
    let generation = 0;

    async function load(): Promise<void> {
        const request = ++generation;
        loading.value = true;
        loadError.value = "";
        try {
            const result = PromptCatalogDtoSchema.parse(await options.read());
            if (request === generation) {
                catalog.value = result;
            }
        } catch (error) {
            if (request === generation) {
                loadError.value = resolveApiErrorMessage(error, "读取提示词配置失败。");
            }
        } finally {
            if (request === generation) {
                loading.value = false;
            }
        }
    }

    async function mutate(mutation: PromptMutationDto): Promise<PromptCatalogDto> {
        if (saving.value) {
            throw new Error("提示词配置正在保存，请稍后重试。");
        }
        saving.value = true;
        try {
            const result = PromptCatalogDtoSchema.parse(await options.write(mutation));
            catalog.value = result;
            return result;
        } finally {
            saving.value = false;
        }
    }

    watch(options.enabled, (enabled) => {
        if (enabled) {
            void load();
        } else {
            generation++;
            loading.value = false;
        }
    }, {immediate: true});
    onScopeDispose(() => { generation++; });

    return {catalog, loading, saving, loadError, load, mutate};
}
