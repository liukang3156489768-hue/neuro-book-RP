<script setup lang="ts">
import {computed} from "vue";
import FormSelect, {type SelectOption} from "nbook/app/components/common/form/FormSelect.vue";
import type {EnabledModelOptionDto} from "nbook/shared/dto/app-settings.dto";
import ProfileRuntimeSettingsFields from "nbook/app/components/novel-ide/settings/sections/agent-profile/components/ProfileRuntimeSettingsFields.vue";
import type {ProfileRuntimeSettingsDraft, ProfileRuntimeSettingsErrors, ProfileRuntimeSettingsSources} from "nbook/app/components/novel-ide/settings/sections/agent-profile/profile-runtime-settings";
import type {ProfileRuntimeSettingsDto} from "nbook/shared/dto/config.dto";

const props = withDefaults(defineProps<{
    modelValue: string | null;
    enabledModels: EnabledModelOptionDto[];
    runtimeDefaults?: ProfileRuntimeSettingsDraft | null;
    runtimeEffective?: ProfileRuntimeSettingsDto | null;
    runtimeSources?: ProfileRuntimeSettingsSources | null;
    runtimeErrors?: ProfileRuntimeSettingsErrors;
    disabled?: boolean;
}>(), {disabled: false});

const emit = defineEmits<{
    (event: "update:modelValue", value: string | null): void;
    (event: "update:runtimeDefaults", value: ProfileRuntimeSettingsDraft): void;
}>();

const options = computed<SelectOption[]>(() => [
    {value: "", label: "跟随默认模型", description: "未单独指定时使用摘要 Profile 或全局默认模型。"},
    ...props.enabledModels.map((model) => ({
        value: model.key,
        label: model.label,
        description: `${model.providerId} / ${model.modelId}`,
    })),
]);

function update(value: string): void {
    emit("update:modelValue", value.trim() || null);
}
</script>

<template>
    <div class="summarizer-settings-view flex min-w-0 flex-col" data-lab-subject>
        <header>
            <h2 class="text-[var(--text-base)] [font-weight:var(--weight-strong)] text-[var(--text-main)]">摘要模型</h2>
            <p class="mt-[var(--space-2)] text-[var(--text-xs)] leading-[var(--leading-ui)] text-[var(--text-secondary)]">
                为上下文摘要单独选择模型。这里复用 Provider 管理中已经配置并启用的模型，不会新增 API 配置。
            </p>
        </header>

        <section class="mt-[var(--space-5)] border-t border-[var(--divider)] pt-[var(--space-4)]">
            <label class="block max-w-[42rem]">
                <span class="block text-[var(--text-xs)] [font-weight:var(--weight-medium)] text-[var(--text-secondary)]">摘要模型</span>
                <FormSelect
                    class="mt-[var(--space-2)]"
                    :model-value="props.modelValue ?? ''"
                    :options="options"
                    :disabled="props.disabled"
                    dropdown-direction="down"
                    @update:model-value="update"
                />
            </label>
            <p v-if="props.enabledModels.length === 0" class="mt-[var(--space-3)] text-[var(--text-xs)] leading-[var(--leading-ui)] text-[var(--status-warning)]">
                当前没有可选模型，请先在 Provider 区段启用至少一个模型。
            </p>
            <p class="mt-[var(--space-3)] text-[var(--text-xs)] leading-[var(--leading-ui)] text-[var(--text-muted)]">
                配置保存后对新的摘要运行生效；已经开始的摘要任务继续使用启动时的模型。
            </p>
        </section>

        <section v-if="props.runtimeDefaults && props.runtimeEffective && props.runtimeSources" class="mt-[var(--space-5)] border-t border-[var(--divider)] pt-[var(--space-4)]">
            <h3 class="text-[var(--text-sm)] [font-weight:var(--weight-strong)] text-[var(--text-main)]">摘要与上下文压缩</h3>
            <p class="mt-[var(--space-2)] text-[var(--text-xs)] leading-[var(--leading-ui)] text-[var(--text-secondary)]">
                在这里设置自动摘要频率，以及上下文达到阈值时如何压缩。空字段表示沿用系统默认值。
            </p>
            <div class="mt-[var(--space-4)]">
                <ProfileRuntimeSettingsFields
                    :model-value="props.runtimeDefaults"
                    :inherited="props.runtimeEffective"
                    :sources="props.runtimeSources"
                    :errors="props.runtimeErrors"
                    :disabled="props.disabled"
                    :show-file-change-notice="false"
                    @update:model-value="emit('update:runtimeDefaults', $event)"
                />
            </div>
        </section>
    </div>
</template>
