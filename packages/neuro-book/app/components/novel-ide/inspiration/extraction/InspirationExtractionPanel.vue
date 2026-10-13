<script setup lang="ts">
import {computed, ref} from "vue";
import {Button, FormField, FormSelect, SegmentedControl} from "@notnotype/nb-ui/components";
import ExtractionSourcePicker from "nbook/app/components/novel-ide/inspiration/extraction/ExtractionSourcePicker.vue";
import MaterialExtractionView from "nbook/app/components/novel-ide/inspiration/extraction/MaterialExtractionView.vue";
import OutlineExtractionView from "nbook/app/components/novel-ide/inspiration/extraction/OutlineExtractionView.vue";
import {useInspirationExtraction} from "nbook/app/composables/useInspirationExtraction";
import type {ExtractionApi} from "nbook/app/utils/inspiration/extraction-api";
import {TASK_STATUS_LABELS} from "nbook/app/utils/inspiration/extraction-labels";

const props = withDefaults(defineProps<{
    projectRoot: string | null;
    modelOptions?: ReadonlyArray<{key: string; label: string}>;
    modelKey?: string;
    api?: ExtractionApi;
    pollIntervalMs?: number;
}>(), {modelOptions: () => [], modelKey: undefined, api: undefined, pollIntervalMs: undefined});

const emit = defineEmits<{
    (event: "update:modelKey", key: string | undefined): void;
    (event: "open-outline-plan", plan: {planId: string; planTitle: string}): void;
}>();

const extraction = useInspirationExtraction(() => props.projectRoot, {api: props.api, pollIntervalMs: props.pollIntervalMs});
const {outline, material} = extraction;

const entry = ref<"outline" | "material">("outline");
const entryOptions = [{label: "大纲提取", value: "outline"}, {label: "素材提取", value: "material"}];

const DEFAULT_MODEL = "__default__";
const modelChoices = computed(() => [{label: "跟随默认模型", value: DEFAULT_MODEL}, ...props.modelOptions.map(model => ({label: model.label, value: model.key}))]);
const taskController = computed(() => entry.value === "outline" ? outline : material);
const taskLabel = computed(() => entry.value === "outline" ? "大纲" : "素材");
const deletingTask = ref(false);
const taskSelection = computed({
    get: () => taskController.value.task?.id ?? "new",
    set: value => { void taskController.value.selectTask(value); },
});
const taskOptions = computed(() => [
    {label: `新建${taskLabel.value}提取任务`, value: "new"},
    ...taskController.value.tasks.slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map(task => ({
        label: `${TASK_STATUS_LABELS[task.status]} · ${new Date(task.createdAt).toLocaleString("zh-CN")}`, value: task.id,
    })),
]);
async function deleteTask(): Promise<void> {
    const controller = taskController.value;
    const taskId = controller.task?.id;
    const message = entry.value === "outline"
        ? "确定删除当前大纲提取任务吗？任务记录和临时产物会一并删除，已写入大纲库的方案和条目会保留。运行中的任务将先停止。"
        : "确定删除当前素材提取任务吗？未写入文件的产物会一并删除，已写入的素材文件会保留。运行中的任务将先停止。";
    if (!taskId || !confirm(message)) return;
    deletingTask.value = true;
    try { await controller.removeTask(taskId); }
    finally { deletingTask.value = false; }
}
</script>

<template>
    <div class="extraction-panel">
        <p v-if="!props.projectRoot" class="no-project">请先打开一个作品，再使用作品提取。</p>
        <template v-else>
            <ExtractionSourcePicker
                :sources="extraction.sources.value" :model-value="extraction.selectedPath.value" :loading="extraction.sourcesLoading.value"
                :error="extraction.sourceError.value?.message ?? ''" :warnings="extraction.sourceWarnings.value"
                @update:model-value="extraction.selectSource($event)" @refresh="extraction.loadSources()"
            />
            <div class="control-row">
                <FormField v-if="props.modelOptions.length" label="提取模型" class="model-field">
                    <FormSelect :model-value="props.modelKey ?? DEFAULT_MODEL" :options="modelChoices" @update:model-value="emit('update:modelKey', $event === DEFAULT_MODEL ? undefined : $event)" />
                </FormField>
                <section v-if="extraction.selectedPath.value" class="task-manager" :aria-label="`${taskLabel}提取任务`">
                    <div class="task-manager-head">
                        <span class="task-manager-label">{{ taskLabel }}任务</span>
                        <span v-if="taskController.tasksLoading" class="task-manager-hint">刷新中…</span>
                        <span v-else class="task-manager-hint">{{ taskController.tasks.length }} 个任务</span>
                    </div>
                    <div class="task-manager-actions">
                        <FormSelect v-model="taskSelection" :options="taskOptions" class="task-select" :aria-label="`选择${taskLabel}提取任务`" :disabled="deletingTask || taskController.busy" />
                        <Button variant="secondary" size="sm" icon-class="i-lucide-plus" :disabled="deletingTask || taskController.busy" @click="taskController.createTask()">新建</Button>
                        <Button v-if="taskController.task" variant="secondary" size="sm" icon-class="i-lucide-trash-2" :loading="deletingTask" :disabled="deletingTask || taskController.busy" class="delete-task-button" @click="deleteTask">删除</Button>
                    </div>
                    <p v-if="taskController.tasksError" class="task-manager-error">{{ taskController.tasksError.message }}</p>
                </section>
            </div>
            <SegmentedControl v-model="entry" :options="entryOptions" aria-label="提取类型" />
            <OutlineExtractionView v-show="entry === 'outline'" :outline="outline" :model-key="props.modelKey" @open-plan="emit('open-outline-plan', $event)" />
            <MaterialExtractionView v-show="entry === 'material'" :material="material" :source-ready="Boolean(extraction.preparedSource.value)" :chunks="extraction.preparedSource.value?.chunks ?? []" :model-key="props.modelKey" />
        </template>
    </div>
</template>

<style scoped>
.extraction-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
    flex: 1 1 auto;
    padding: var(--space-4);
}

.no-project {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
}

.model-field { min-width: 0; flex: 0 1 360px; }

.control-row { display: flex; align-items: flex-end; gap: var(--space-4); min-width: 0; flex-wrap: wrap; }
.task-manager { min-width: min(100%, 360px); flex: 1 1 360px; }
.task-manager-head { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-1); color: var(--text-main); font-size: var(--text-sm); }
.task-manager-hint { color: var(--text-muted); font-size: var(--text-xs); }
.task-manager-actions { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.task-select { min-width: 0; flex: 1 1 auto; }
.delete-task-button { color: var(--status-danger); }
.task-manager-error { margin: var(--space-1) 0 0; color: var(--status-danger); font-size: var(--text-xs); }
@media (max-width: 700px) { .task-manager { flex-basis: 100%; } .task-manager-actions { flex-wrap: wrap; } .task-select { flex-basis: 100%; } }
</style>
