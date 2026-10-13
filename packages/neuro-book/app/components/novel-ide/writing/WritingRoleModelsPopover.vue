<script setup lang="ts">
import {computed, ref} from "vue";
import {Button, IconButton, Popover} from "@notnotype/nb-ui/components";
import FormNumberInput from "nbook/app/components/common/form/FormNumberInput.vue";
import FormSelect from "nbook/app/components/common/form/FormSelect.vue";
import {resolveApiErrorMessage} from "nbook/app/utils/api-error";
import {createWritingApi} from "nbook/app/utils/writing/writing-api";
import type {ThinkingLevelDto} from "nbook/shared/dto/app-settings.dto";
import type {WritingRole, WritingRoleModelsDto, WritingRoleModelSettingsDto} from "nbook/shared/dto/writing.dto";

const props = withDefaults(defineProps<{
    projectRoot: string | null;
    disabled?: boolean;
}>(), {
    disabled: false,
});

const emit = defineEmits<{
    /** 某个角色的设置已保存；主创需要让当前会话跟随新设置。 */
    (e: "saved", role: WritingRole): void;
}>();

type Draft = {modelKey: string; reasoningEffort: string; temperature: string};

const open = ref(false);
const loading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);
const data = ref<WritingRoleModelsDto | null>(null);
const drafts = ref<Partial<Record<WritingRole, Draft>>>({});

const THINKING: readonly {value: ThinkingLevelDto; label: string}[] = [
    {value: "off", label: "关闭思考"},
    {value: "minimal", label: "极少"},
    {value: "low", label: "低"},
    {value: "medium", label: "中"},
    {value: "high", label: "高"},
    {value: "xhigh", label: "很高"},
    {value: "max", label: "最高"},
];

const toDraft = (settings: WritingRoleModelSettingsDto): Draft => ({
    modelKey: settings.modelKey ?? "",
    reasoningEffort: settings.reasoningEffort ?? "",
    temperature: settings.temperature === null ? "" : String(settings.temperature),
});

function fromDraft(draft: Draft): WritingRoleModelSettingsDto | string {
    const temperature = draft.temperature.trim() === "" ? null : Number(draft.temperature);
    if (temperature !== null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) return "温度需在 0 到 2 之间";
    return {modelKey: draft.modelKey || null, reasoningEffort: (draft.reasoningEffort || null) as ThinkingLevelDto | null, temperature};
}

const modelLabel = (key: string | null) => data.value?.models.find((model) => model.key === key)?.label ?? key;

function modelOptions(effective: WritingRoleModelSettingsDto) {
    const inherited = modelLabel(effective.modelKey) ?? data.value?.defaultModelLabel ?? "默认模型";
    return [{value: "", label: `沿用默认（${inherited}）`}, ...(data.value?.models ?? []).map(({key, label}) => ({value: key, label}))];
}

function thinkingOptions(effective: WritingRoleModelSettingsDto) {
    const inherited = THINKING.find(({value}) => value === effective.reasoningEffort)?.label ?? "关闭思考";
    return [{value: "", label: `沿用默认（${inherited}）`}, ...THINKING];
}

const dirtyRoles = computed(() => (data.value?.roles ?? []).filter(({role, override}) => {
    const draft = drafts.value[role];
    return draft !== undefined && JSON.stringify(draft) !== JSON.stringify(toDraft(override));
}).map(({role}) => role));

async function load(): Promise<void> {
    if (!props.projectRoot) return;
    loading.value = true;
    error.value = null;
    try {
        const next = await createWritingApi(props.projectRoot).roleModels();
        data.value = next;
        drafts.value = Object.fromEntries(next.roles.map(({role, override}) => [role, toDraft(override)]));
    } catch (cause) {
        error.value = resolveApiErrorMessage(cause, "读取模型设置失败");
    } finally {
        loading.value = false;
    }
}

function onOpen(value: boolean): void {
    open.value = value;
    if (value) void load();
}

function update(role: WritingRole, patch: Partial<Draft>): void {
    const current = drafts.value[role];
    if (current) drafts.value = {...drafts.value, [role]: {...current, ...patch}};
}

async function save(): Promise<void> {
    if (!props.projectRoot || saving.value) return;
    const payload: [WritingRole, WritingRoleModelSettingsDto][] = [];
    for (const role of dirtyRoles.value) {
        const settings = fromDraft(drafts.value[role]!);
        if (typeof settings === "string") {
            error.value = settings;
            return;
        }
        payload.push([role, settings]);
    }
    saving.value = true;
    error.value = null;
    try {
        const api = createWritingApi(props.projectRoot);
        for (const [role, settings] of payload) {
            data.value = await api.saveRoleModel(role, settings);
            emit("saved", role);
        }
        drafts.value = Object.fromEntries((data.value?.roles ?? []).map(({role, override}) => [role, toDraft(override)]));
        open.value = false;
    } catch (cause) {
        error.value = resolveApiErrorMessage(cause, "保存模型设置失败");
    } finally {
        saving.value = false;
    }
}
</script>

<template>
    <Popover :open="open" side="top" align="start" content-class="role-models-panel" @update:open="onOpen">
        <template #trigger>
            <IconButton size="sm" title="写作角色的模型设置" aria-label="写作角色的模型设置" icon-class="i-lucide-sliders-horizontal"
                :disabled="props.disabled || !props.projectRoot" />
        </template>
        <div class="role-models" role="group" aria-label="写作角色的模型设置">
            <p class="role-models-title">模型设置<span>（本作品）</span></p>
            <p v-if="loading && !data" class="role-models-hint" role="status" aria-busy="true">正在读取…</p>
            <template v-else-if="data">
                <p v-if="!data.models.length" class="role-models-hint">还没有启用的模型，请先在设置中配置模型。</p>
                <fieldset v-for="item in data.roles" :key="item.role" class="role-row">
                    <legend>{{ item.label }}</legend>
                    <FormSelect size="sm" :model-value="drafts[item.role]?.modelKey" :options="modelOptions(item.effective)"
                        :aria-label="`${item.label}模型`" :disabled="saving" @update:model-value="update(item.role, {modelKey: $event})" />
                    <div class="role-params">
                        <FormSelect size="sm" :model-value="drafts[item.role]?.reasoningEffort" :options="thinkingOptions(item.effective)"
                            :aria-label="`${item.label}思考`" :disabled="saving" @update:model-value="update(item.role, {reasoningEffort: $event})" />
                        <FormNumberInput size="sm" :model-value="drafts[item.role]?.temperature ?? ''" step="0.1" min="0" max="2"
                            :placeholder="item.effective.temperature === null ? '温度：默认' : `温度：默认 ${item.effective.temperature}`"
                            :title="`${item.label}温度`" :disabled="saving" @update:model-value="update(item.role, {temperature: $event})" />
                    </div>
                </fieldset>
                <p class="role-models-hint">空白表示沿用全局设置。主创的新设置从下一轮回复开始生效。</p>
            </template>
            <p v-if="error" class="role-models-error" role="alert">{{ error }}</p>
            <div class="role-models-actions">
                <Button size="sm" variant="ghost" :disabled="saving" @click="open = false">取消</Button>
                <Button size="sm" :loading="saving" :disabled="!dirtyRoles.length || saving" @click="void save()">保存</Button>
            </div>
        </div>
    </Popover>
</template>

<style scoped>
.role-models { display: grid; width: min(320px, calc(100vw - 48px)); gap: var(--space-3); font-size: var(--text-xs); }
.role-models-title { margin: 0; font-weight: var(--weight-strong); }
.role-models-title span { color: var(--text-muted); font-weight: normal; }
.role-models-hint { margin: 0; color: var(--text-muted); font-size: var(--text-2xs); }
.role-models-error { margin: 0; color: var(--status-danger); font-size: var(--text-2xs); overflow-wrap: anywhere; }
.role-row { display: grid; min-width: 0; gap: var(--space-2); margin: 0; border: 0; padding: 0; }
.role-row legend { margin-bottom: var(--space-1); padding: 0; color: var(--text-secondary); }
.role-params { display: grid; grid-template-columns: minmax(0, 1fr) 7.5em; gap: var(--space-2); }
.role-models-actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
</style>
