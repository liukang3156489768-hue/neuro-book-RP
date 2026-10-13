<script setup lang="ts">
import {computed, ref, watch} from "vue";
import {z} from "zod";
import {Button, FormCheckbox, FormInput, FormSelect, FormTextarea, IconButton, Switch} from "@notnotype/nb-ui/components";
import {TavernBindingsSchema, TavernGenerationSchema, TavernPostProcessingSchema, TavernPreviewRequestSchema, TavernWriterPresetSchema, type TavernBindings, type TavernOutputPolicy, type TavernWriterPreset, type TavernPreviewRequest, type TavernPreviewResult} from "nbook/shared/dto/tavern-preset.dto";
import {resolveApiErrorMessage} from "nbook/app/utils/api-error";
import {changeWriterSectionMode, moveTavernPromptGroup, parseEditableTavernSource, removeTavernPrompts, tavernEditorOrder, type EditableTavernSource} from "./tavern-editor";
import {discoverWriterMappingFields, enableWriterMappings, mappingTargetKey, writerMappingSections} from "nbook/shared/prompt-management/tavern-writer-mapping";

const props = withDefaults(defineProps<{modelValue: TavernWriterPreset; purposeId: string; disabled?: boolean; name: string;
    preview?: (request: TavernPreviewRequest) => Promise<TavernPreviewResult>; download?: (name: string, contents: string) => void}>(), {disabled: false});
const emit = defineEmits<{'update:modelValue': [value: TavernWriterPreset]}>();
const roles = ["system", "user", "assistant"].map(value => ({value, label: value}));
const macroEngines = [{value: "legacy", label: "酒馆旧宏引擎"}, {value: "native", label: "酒馆新宏引擎"}]
    .filter(option => TavernWriterPresetSchema.shape.macroEngine.safeParse(option.value).success);
const postProcessingOptions = [{value: "preset", label: "使用预设设置"}, ...TavernPostProcessingSchema.options.map(value => ({value: value || "native-empty", label: value || "酒馆空后处理"}))];
const expanded = ref(new Set<string>());
const selected = ref(new Set<string>());
const sequenceRoot = ref<HTMLElement | null>(null);
const dragIds = ref<string[]>([]);
const raw = ref(props.modelValue.sourceJson);
const bindingJson = ref(JSON.stringify(props.modelValue.bindings, null, 2));
const generationJson = ref(JSON.stringify(props.modelValue.generationOverride ?? {}, null, 2));
const budgetEnabled = ref(Boolean(props.modelValue.bindings.contextBudget));
const budgetTokenizer = ref<string>(props.modelValue.bindings.contextBudget?.tokenizer ?? "claude");
const budgetTokens = ref(props.modelValue.bindings.contextBudget ? String(props.modelValue.bindings.contextBudget.contextTokens) : "");
const budgetPinExamples = ref(props.modelValue.bindings.contextBudget?.pinExamples ?? false);
const exampleJson = ref("{}");
const error = ref("");
const previewing = ref(false);
const result = ref<TavernPreviewResult | null>(null);
const source = computed(() => {try {return parseEditableTavernSource(props.modelValue.sourceJson);} catch {return null;}});
const rows = computed(() => source.value ? tavernEditorOrder(source.value).map(order => ({order, prompt: source.value!.prompts.find(prompt => prompt.identifier === order.identifier)!})) : []);
const unlisted = computed(() => source.value?.prompts.filter(prompt => !rows.value.some(row => row.prompt.identifier === prompt.identifier)) ?? []);
const mappingSections = computed(() => writerMappingSections(props.purposeId));
const mappingGroups = computed(() => [...new Set(mappingSections.value.map(section => section.category))].map(name => ({name, sections: mappingSections.value.filter(section => section.category === name)})));
const mappingDiscovery = computed(() => {try {return discoverWriterMappingFields(props.modelValue.sourceJson, props.modelValue.bindings.generationType);} catch {return {fields: [], dynamicNames: []};}});
const mappingOptions = computed(() => [{value: "unmapped", label: "不映射"}, ...mappingDiscovery.value.fields.filter(field => field.name !== "dialogueExamples").map(field => ({
    value: mappingTargetKey(field), label: `${field.kind === "slot" ? "资料" : field.kind === "local" ? "局部变量" : "全局变量"} · ${field.name}${!field.active ? "（未启用）" : !field.read ? "（仅定义，未读取）" : ""}`,
    disabled: !field.active || !field.read,
}))]);
function sectionMappingOptions(id: string) {
    const target = props.modelValue.writerMappings?.[id];
    return target && !mappingOptions.value.some(option => option.value === mappingTargetKey(target))
        ? [...mappingOptions.value, {value: mappingTargetKey(target), label: `目标已缺失 · ${target.kind}.${target.name}`, disabled: true}] : mappingOptions.value;
}
function updateSectionMapping(id: string, value: string): void {
    if (props.disabled || props.modelValue.writerMappings === undefined) return;
    const target = mappingDiscovery.value.fields.find(field => mappingTargetKey(field) === value);
    if (value !== "unmapped" && (!target?.active || !target.read)) return;
    emit("update:modelValue", {...props.modelValue, writerMappings: {...props.modelValue.writerMappings, [id]: target ? {kind: target.kind, name: target.name} : null}});
}
function activateMappings(): void {
    if (props.disabled) return;
    emit("update:modelValue", {...props.modelValue, ...enableWriterMappings(props.purposeId, props.modelValue.sourceJson, props.modelValue.bindings)});
}
function setSectionMode(id: string, mode: "prompt" | "mapping"): void {
    if (props.disabled) return;
    try {emit("update:modelValue", changeWriterSectionMode(props.modelValue, props.purposeId, id, mode, crypto.randomUUID()));}
    catch (cause) {error.value = resolveApiErrorMessage(cause, "写作条目方式切换失败。");}
}
function selectPrompt(id: string, value: boolean): void {
    if (props.disabled) return;
    const next = new Set(selected.value); if (value) next.add(id); else next.delete(id); selected.value = next;
}
function selectAll(value: boolean): void {
    if (props.disabled) return;
    selected.value = value ? new Set(source.value?.prompts.map(prompt => prompt.identifier)) : new Set();
}
function deletePrompts(ids: string[]): void {
    if (props.disabled || !ids.length) return;
    emit("update:modelValue", removeTavernPrompts(props.modelValue, ids));
    selected.value = new Set([...selected.value].filter(id => !ids.includes(id)));
    expanded.value = new Set([...expanded.value].filter(id => !ids.includes(id)));
    dragIds.value = [];
}
function startDrag(event: PointerEvent, id: string): void {
    if (event.button !== 0 || props.disabled || !sequenceRoot.value) return;
    event.preventDefault();
    sequenceRoot.value.setPointerCapture(event.pointerId);
    dragIds.value = selected.value.has(id) ? rows.value.filter(row => selected.value.has(row.prompt.identifier)).map(row => row.prompt.identifier) : [id];
}
function drag(event: PointerEvent): void {
    if (!dragIds.value.length || props.disabled) return;
    const target = sequenceRoot.value?.ownerDocument.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-tavern-entry]");
    if (target && sequenceRoot.value?.contains(target) && target.dataset.tavernEntry && !dragIds.value.includes(target.dataset.tavernEntry)) {
        updateSource(next => moveTavernPromptGroup(next, dragIds.value, target.dataset.tavernEntry!));
    }
}
let previewGeneration = 0;
watch(() => props.modelValue.sourceJson, (value, previous) => {
    if (raw.value === previous) raw.value = value;
    const ids = new Set(source.value?.prompts.map(prompt => prompt.identifier));
    selected.value = new Set([...selected.value].filter(id => ids.has(id)));
});
watch(() => props.disabled, value => {if (value) dragIds.value = [];});
watch(() => props.modelValue.bindings, (value, previous) => {if (bindingJson.value === JSON.stringify(previous, null, 2)) bindingJson.value = JSON.stringify(value, null, 2);});
watch(() => props.modelValue.generationOverride, (value, previous) => {if (generationJson.value === JSON.stringify(previous ?? {}, null, 2)) generationJson.value = JSON.stringify(value ?? {}, null, 2);});
watch(() => props.modelValue.bindings.contextBudget, value => {
    budgetEnabled.value = Boolean(value);
    budgetTokenizer.value = value?.tokenizer ?? "claude";
    budgetTokens.value = value ? String(value.contextTokens) : "";
    budgetPinExamples.value = value?.pinExamples ?? false;
});
watch([() => props.modelValue, exampleJson], () => {result.value = null; previewGeneration++;});

function updateSource(change: (source: EditableTavernSource) => void): void {
    if (props.disabled || !source.value) return;
    const next = parseEditableTavernSource(props.modelValue.sourceJson);
    change(next);
    emit("update:modelValue", {...props.modelValue, sourceJson: JSON.stringify(next, null, 2)});
}
function updateBinding(change: Partial<TavernBindings>): void {
    if (props.disabled) return;
    emit("update:modelValue", {...props.modelValue, bindings: {...props.modelValue.bindings, ...change}});
}
function updateMacroEngine(macroEngine: string): void {
    if (props.disabled) return;
    error.value = "";
    try {emit("update:modelValue", TavernWriterPresetSchema.parse({...props.modelValue, macroEngine}));}
    catch (cause) {error.value = resolveApiErrorMessage(cause, "宏引擎设置无效。");}
}
function updatePostProcessing(value: string): void {
    if (props.disabled) return;
    if (value === "preset") {const {requestPostProcessing: _postProcessing, ...bindings} = props.modelValue.bindings; emit("update:modelValue", {...props.modelValue, bindings});}
    else updateBinding({requestPostProcessing: TavernPostProcessingSchema.parse(value === "native-empty" ? "" : value)});
}
function updateOutput(change: Partial<TavernOutputPolicy>): void {
    if (props.disabled) return;
    emit("update:modelValue", {...props.modelValue, outputPolicy: {...(props.modelValue.outputPolicy ?? {mode: "full"}), ...change}});
}
function toggleBudget(enabled: boolean): void {
    if (props.disabled) return;
    budgetEnabled.value = enabled;
    if (!enabled) {const {contextBudget: _budget, ...bindings} = props.modelValue.bindings; emit("update:modelValue", {...props.modelValue, bindings});}
}
function applyBudget(): void {
    if (props.disabled || !budgetEnabled.value) return;
    error.value = "";
    try {
        if (!budgetTokens.value.trim()) throw new Error("请填写包含输出的上下文总预算。");
        const bindings = TavernBindingsSchema.parse({...props.modelValue.bindings, contextBudget: {tokenizer: budgetTokenizer.value, contextTokens: Number(budgetTokens.value), pinExamples: budgetPinExamples.value}});
        emit("update:modelValue", {...props.modelValue, bindings});
    } catch (cause) {error.value = resolveApiErrorMessage(cause, "上下文预算无效。");}
}
function addPrompt(): void {
    const identifier = crypto.randomUUID();
    updateSource(next => {next.prompts.push({identifier, name: "新提示词", role: "system", content: "", marker: false}); tavernEditorOrder(next).push({identifier, enabled: true});});
    expanded.value = new Set([...expanded.value, identifier]);
}
function updatePrompt(id: string, change: Record<string, unknown>): void {
    updateSource(next => Object.assign(next.prompts.find(prompt => prompt.identifier === id)!, change));
}
function updateInteger(id: string, key: "injection_depth" | "injection_order", text: string): void {
    error.value = "";
    if (!text.trim()) {updateSource(next => {delete next.prompts.find(prompt => prompt.identifier === id)![key];}); return;}
    const value = Number(text);
    if (!Number.isSafeInteger(value) || (key === "injection_depth" && value < 0)) {error.value = key === "injection_depth" ? "插入深度须为非负整数。" : "插入顺序须为整数。"; return;}
    updatePrompt(id, {[key]: value});
}
function setEnabled(id: string, enabled: boolean): void {
    if (props.disabled || !source.value) return;
    const next = parseEditableTavernSource(props.modelValue.sourceJson);
    tavernEditorOrder(next).find(entry => entry.identifier === id)!.enabled = enabled;
    const needsSlot = enabled && next.prompts.find(prompt => prompt.identifier === id)?.marker && !Object.hasOwn(props.modelValue.bindings.slots, id);
    emit("update:modelValue", {...props.modelValue, sourceJson: JSON.stringify(next, null, 2),
        bindings: needsSlot ? {...props.modelValue.bindings, slots: {...props.modelValue.bindings.slots, [id]: []}} : props.modelValue.bindings});
}
function move(id: string, offset: number): void {
    updateSource(next => {const order = tavernEditorOrder(next), from = order.findIndex(entry => entry.identifier === id), to = from + offset;
        if (from < 0 || to < 0 || to >= order.length) return;
        order.splice(to, 0, order.splice(from, 1)[0]!);});
}
function toggleExpanded(id: string): void {const next = new Set(expanded.value); if (next.has(id)) next.delete(id); else next.add(id); expanded.value = next;}
function applyRaw(): void {
    error.value = "";
    try {parseEditableTavernSource(raw.value); emit("update:modelValue", {...props.modelValue, sourceJson: raw.value});}
    catch (cause) {error.value = resolveApiErrorMessage(cause, "原生 JSON 无效。");}
}
function applyBindings(): void {
    error.value = "";
    try {const bindings = TavernBindingsSchema.parse(JSON.parse(bindingJson.value)); bindingJson.value = JSON.stringify(bindings, null, 2); emit("update:modelValue", {...props.modelValue, bindings});}
    catch (cause) {error.value = resolveApiErrorMessage(cause, "身份、资料或变量配置无效。");}
}
function applyGeneration(): void {
    error.value = "";
    try {const generationOverride = TavernGenerationSchema.parse(JSON.parse(generationJson.value)); generationJson.value = JSON.stringify(generationOverride, null, 2); emit("update:modelValue", {...props.modelValue, generationOverride});}
    catch (cause) {error.value = resolveApiErrorMessage(cause, "生成参数覆盖无效。");}
}
async function runPreview(): Promise<void> {
    if (!props.preview || previewing.value) return;
    const generation = ++previewGeneration;
    previewing.value = true; error.value = ""; result.value = null;
    try {
        const values = z.record(z.string(), z.string()).parse(JSON.parse(exampleJson.value));
        const preview = await props.preview(TavernPreviewRequestSchema.parse({purposeId: props.purposeId, tavern: props.modelValue, variables: values}));
        if (generation === previewGeneration) result.value = preview;
    } catch (cause) {if (generation === previewGeneration) error.value = resolveApiErrorMessage(cause, "编译预览失败。");}
    finally {previewing.value = false;}
}
</script>

<template>
    <div class="tavern-editor">
        <div class="actions">
            <strong>酒馆原生预设</strong>
            <Button size="sm" variant="secondary" :disabled="disabled || !download" @click="download?.(name + '.json', modelValue.sourceJson)">导出酒馆 JSON</Button>
            <Button size="sm" variant="secondary" :disabled="disabled || !download" @click="download?.(name + '.neurobook.json', JSON.stringify(modelValue, null, 2))">导出完整配置</Button>
        </div>
        <p class="hint">条目按酒馆全局顺序编排。启停、角色、正文与排序修改均需保存预设后生效。</p>
        <p class="hint plugin-note" role="note">兼容范围为预设提示词。插件脚本、EJS 和 SPreset 增强等字段会原样保留，导入、预览和写手调用均不会执行插件。</p>
        <section class="bindings">
            <h3>身份与变量延续</h3>
            <div class="identity">
                <label>宏引擎<FormSelect :model-value="modelValue.macroEngine" :options="macroEngines" size="sm" aria-label="酒馆宏引擎" :disabled="disabled" @update:model-value="updateMacroEngine" /></label>
                <label>用户身份 <code v-text="'{{user}}'" /><FormInput :model-value="modelValue.bindings.user" size="sm" aria-label="酒馆用户身份" :disabled="disabled" @update:model-value="updateBinding({user: $event})" /></label>
                <label>写手身份 <code v-text="'{{char}}'" /><FormInput :model-value="modelValue.bindings.char" size="sm" aria-label="酒馆写手身份" :disabled="disabled" @update:model-value="updateBinding({char: $event})" /></label>
                <label>请求后处理<FormSelect :model-value="modelValue.bindings.requestPostProcessing === undefined ? 'preset' : modelValue.bindings.requestPostProcessing || 'native-empty'" size="sm" aria-label="酒馆请求后处理" :options="postProcessingOptions" :disabled="disabled" @update:model-value="updatePostProcessing" /></label>
                <label>变量延续<FormSelect :model-value="modelValue.bindings.variablePersistence ?? 'writing-session'" size="sm" aria-label="酒馆变量延续" :options="[{value: 'writing-session', label: '在写作会话中延续'}, {value: 'isolated', label: '每次从初值开始'}]" :disabled="disabled" @update:model-value="updateBinding({variablePersistence: $event === 'isolated' ? 'isolated' : 'writing-session'})" /></label>
                <label>生成模式<FormSelect :model-value="modelValue.bindings.generationType ?? 'normal'" size="sm" aria-label="酒馆生成模式" :options="[{value: 'normal', label: '普通生成'}, {value: 'continue', label: '继续上一条回复'}]" :disabled="disabled" @update:model-value="updateBinding({generationType: $event === 'continue' ? 'continue' : 'normal'})" /></label>
            </div>
            <p class="hint">宏引擎需与酒馆中的设置一致。新宏引擎的额外上下文通过资料绑定提供；缺少环境的宏会在编译时明确报错。</p>
            <p v-if="modelValue.macroEngine === 'native'" class="hint">新宏环境位于下方绑定 JSON 的 nativeContext 字段，可填写 input、model、character、names 等上下文。日期与随机宏可显式设置 now 和 randomSeed；编译记录会冻结实际消息。</p>
            <p class="hint">资料绑定可使用本用途的动态变量。localVariables 和 globalVariables 分别设置局部与全局变量初值。选择延续时，前者跟随写作会话，后者限定当前作品与同一预设；编辑条目不会重置已有绑定。</p>
            <FormTextarea v-model="bindingJson" :rows="8" aria-label="酒馆身份资料与变量绑定 JSON" :disabled="disabled" />
            <Button size="sm" variant="secondary" :disabled="disabled || bindingJson === JSON.stringify(modelValue.bindings, null, 2)" @click="applyBindings">应用绑定 JSON</Button>
        </section>
        <section class="writer-mappings" aria-label="写作条目映射">
            <h3>写作条目映射</h3>
            <p class="hint">先初始化预设变量，再注入写作资料，最后展开提示词。职责与输出要求由酒馆预设提供。多个条目可映射到同一目标。</p>
            <template v-if="modelValue.writerMappings !== undefined">
                <div v-for="group in mappingGroups" :key="group.name" class="mapping-group">
                    <h4>{{ group.name }}</h4>
                    <div v-for="section in group.sections" :key="section.id" class="mapping-row">
                        <details><summary>{{ section.name }}</summary><pre class="mapping-template">{{ section.content }}</pre></details>
                        <div class="mapping-choice">
                            <div class="actions" :aria-label="section.name + '使用方式'">
                                <Button size="sm" :variant="modelValue.writerMappings[section.id]?.kind === 'prompt' ? 'secondary' : 'ghost'" :aria-pressed="modelValue.writerMappings[section.id]?.kind === 'prompt'" :aria-label="section.name + '直接排序'" :disabled="disabled" @click="setSectionMode(section.id, 'prompt')">直接排序</Button>
                                <Button size="sm" :variant="modelValue.writerMappings[section.id]?.kind !== 'prompt' ? 'secondary' : 'ghost'" :aria-pressed="modelValue.writerMappings[section.id]?.kind !== 'prompt'" :aria-label="section.name + '变量映射'" :disabled="disabled" @click="setSectionMode(section.id, 'mapping')">变量映射</Button>
                            </div>
                            <p v-if="modelValue.writerMappings[section.id]?.kind === 'prompt'" class="hint">已加入下方提示词序列，可拖动调整位置并编辑正文。</p>
                            <FormSelect v-else :model-value="modelValue.writerMappings[section.id] ? mappingTargetKey(modelValue.writerMappings[section.id]!) : 'unmapped'" :options="sectionMappingOptions(section.id)" :aria-label="section.name + '映射目标'" size="sm" :disabled="disabled" @update:model-value="updateSectionMapping(section.id, $event)" />
                        </div>
                    </div>
                </div>
                <p v-if="mappingDiscovery.dynamicNames.length" class="hint" role="note">存在动态变量名，无法静态确定映射目标。请在预设中使用固定变量名后映射。</p>
                <p class="hint">未启用或仅定义但未读取的字段不能接收资料。必需条目未映射、变量未实际进入提示词或资料被预算裁剪时，预览与保存会说明原因。</p>
            </template>
            <template v-else><p class="hint">当前使用旧版资料绑定。启用后可逐条设置映射，已有手工资料保留；保存前可预览检查。</p><Button size="sm" variant="secondary" :disabled="disabled" @click="activateMappings">启用写作条目映射</Button></template>
        </section>
        <section>
            <h3>上下文预算</h3>
            <div class="actions"><span>按预算裁剪旧历史和示例</span><Switch size="sm" aria-label="酒馆上下文预算" :model-value="budgetEnabled" :disabled="disabled" @update:model-value="toggleBudget" /></div>
            <div v-if="budgetEnabled" class="identity injection-options">
                <label>分词方式<FormSelect v-model="budgetTokenizer" size="sm" aria-label="酒馆预算分词方式" :disabled="disabled" :options="[{value: 'claude', label: 'Claude'}, {value: 'cl100k_base', label: 'cl100k_base'}, {value: 'o200k_base', label: 'o200k_base'}]" /></label>
                <label>上下文总预算（含输出）<FormInput v-model="budgetTokens" type="number" min="1" step="1" size="sm" aria-label="酒馆上下文总预算" placeholder="填写选定模型的实际窗口" :disabled="disabled" /></label>
                <div class="actions"><span>优先保留示例</span><Switch size="sm" aria-label="酒馆优先保留示例" v-model="budgetPinExamples" :disabled="disabled" /></div>
                <Button size="sm" variant="secondary" :disabled="disabled" @click="applyBudget">应用上下文预算</Button>
            </div>
            <p class="hint">{{ modelValue.bindings.contextBudget ? '已应用预算，保存预设后生效。' : budgetEnabled ? '预算尚未应用，请填写并点击应用。' : '未启用裁剪，保留完整提示词并检查模型窗口。' }} 总预算包含输出，不能超过模型窗口。普通提示条目不会被裁剪；裁剪导致必需作品资料缺失时，写手会拒绝发送。优先保留示例会先为示例分配预算，无法容纳完整示例组时仍不发送该组。</p>
        </section>
        <section ref="sequenceRoot" :class="{'is-dragging': dragIds.length}" @pointermove="drag" @pointerup="dragIds = []" @pointercancel="dragIds = []" @lostpointercapture="dragIds = []">
            <div class="actions"><h3>提示词序列 · {{ rows.length }} 条 · {{ rows.filter(row => row.order.enabled).length }} 条启用</h3><Button size="sm" variant="secondary" :disabled="disabled" @click="addPrompt">新建酒馆条目</Button></div>
            <div class="actions selection-actions">
                <FormCheckbox label="全选条目" :model-value="Boolean(source?.prompts.length) && selected.size === source?.prompts.length" :indeterminate="selected.size > 0 && selected.size !== source?.prompts.length" :disabled="disabled || !source?.prompts.length" @update:model-value="selectAll" />
                <span>已选择 {{ selected.size }} 条</span>
                <Button size="sm" variant="ghost" :disabled="disabled || !selected.size" @click="selected = new Set()">取消选择</Button>
                <Button size="sm" variant="secondary" :disabled="disabled || !selected.size" @click="deletePrompts([...selected])">删除所选条目</Button>
            </div>
            <p class="hint">按住手柄拖动排序，方向键也可移动。拖动选中条目可整体移动选中组；删除会彻底移除条目，保存后生效。</p>
            <article v-for="(row, index) in rows" :key="row.prompt.identifier" class="entry" :data-tavern-entry="row.prompt.identifier" :class="{'is-disabled': !row.order.enabled, 'is-selected': selected.has(row.prompt.identifier), 'is-dragged': dragIds.includes(row.prompt.identifier)}">
                <div class="entry-controls">
                    <FormCheckbox :label="'选择' + (row.prompt.name || row.prompt.identifier)" class="entry-selection" :model-value="selected.has(row.prompt.identifier)" :disabled="disabled" @update:model-value="selectPrompt(row.prompt.identifier, $event)" />
                    <IconButton size="sm" class="drag-handle" icon-class="i-lucide-grip-vertical" :aria-label="'拖动' + row.prompt.identifier + '排序'" title="拖动排序；方向键上下移动" :disabled="disabled" @pointerdown="(event: PointerEvent) => startDrag(event, row.prompt.identifier)" @keydown.up.prevent="move(row.prompt.identifier, -1)" @keydown.down.prevent="move(row.prompt.identifier, 1)" />
                    <Button size="sm" variant="ghost" class="entry-name" :aria-expanded="expanded.has(row.prompt.identifier)" @click="toggleExpanded(row.prompt.identifier)">{{ index + 1 }}. {{ row.prompt.name || row.prompt.identifier }}{{ row.prompt.marker ? ' · 资料槽位' : '' }}</Button>
                    <FormSelect :model-value="row.prompt.role ?? 'system'" :options="roles" size="sm" :aria-label="row.prompt.identifier + '角色'" :disabled="disabled || row.prompt.marker" @update:model-value="updatePrompt(row.prompt.identifier, {role: $event})" />
                    <Switch size="sm" :model-value="row.order.enabled" :disabled="disabled" :aria-label="row.prompt.identifier + '启用状态'" @update:model-value="setEnabled(row.prompt.identifier, $event)" />
                    <IconButton size="sm" icon-class="i-lucide-arrow-up" :aria-label="'上移' + row.prompt.identifier" :disabled="disabled || index === 0" @click="move(row.prompt.identifier, -1)" />
                    <IconButton size="sm" icon-class="i-lucide-arrow-down" :aria-label="'下移' + row.prompt.identifier" :disabled="disabled || index === rows.length - 1" @click="move(row.prompt.identifier, 1)" />
                    <IconButton size="sm" icon-class="i-lucide-trash-2" :aria-label="'删除' + row.prompt.identifier" :disabled="disabled" @click="deletePrompts([row.prompt.identifier])" />
                </div>
                <div v-if="expanded.has(row.prompt.identifier)" class="entry-body">
                    <FormInput :model-value="row.prompt.name ?? ''" size="sm" :aria-label="row.prompt.identifier + '名称'" :disabled="disabled" @update:model-value="updatePrompt(row.prompt.identifier, {name: $event})" />
                    <p class="hint">{{ row.prompt.identifier }}</p>
                    <FormTextarea v-if="!row.prompt.marker" :model-value="row.prompt.content ?? ''" :rows="6" :aria-label="row.prompt.identifier + '正文'" :disabled="disabled" @update:model-value="updatePrompt(row.prompt.identifier, {content: $event})" />
                    <div v-if="!row.prompt.marker" class="injection-options">
                        <div class="identity">
                            <label>插入位置<FormSelect :model-value="String(row.prompt.injection_position ?? 0)" size="sm" :aria-label="row.prompt.identifier + '插入位置'" :disabled="disabled" :options="[{value: '0', label: '按提示词序列'}, {value: '1', label: '按聊天历史深度'}]" @update:model-value="updatePrompt(row.prompt.identifier, {injection_position: Number($event)})" /></label>
                            <label v-if="row.prompt.injection_position === 1">插入深度<FormInput :model-value="row.prompt.injection_depth === undefined ? '' : String(row.prompt.injection_depth)" type="number" min="0" step="1" size="sm" placeholder="酒馆默认：4" :aria-label="row.prompt.identifier + '插入深度'" :disabled="disabled" @update:model-value="updateInteger(row.prompt.identifier, 'injection_depth', $event)" /></label>
                            <label v-if="row.prompt.injection_position === 1">同深度顺序<FormInput :model-value="row.prompt.injection_order === undefined ? '' : String(row.prompt.injection_order)" type="number" step="1" size="sm" placeholder="酒馆默认：100" :aria-label="row.prompt.identifier + '插入顺序'" :disabled="disabled" @update:model-value="updateInteger(row.prompt.identifier, 'injection_order', $event)" /></label>
                            <label>生成类型触发条件<FormInput :model-value="Array.isArray(row.prompt.injection_trigger) ? row.prompt.injection_trigger.join(', ') : row.prompt.injection_trigger ?? ''" size="sm" placeholder="留空表示全部类型" :aria-label="row.prompt.identifier + '生成类型触发条件'" :disabled="disabled" @update:model-value="updatePrompt(row.prompt.identifier, {injection_trigger: [...new Set($event.split(/[,，]/u).map(value => value.trim()).filter(Boolean))]})" /></label>
                        </div>
                        <p class="hint">深度从聊天末尾计数，默认 4；同深度顺序默认 100。触发条件可填写 normal、continue、impersonate、swipe、regenerate、quiet 等原生名称，以逗号分隔并保留其他名称；当前写手生成模式提供 normal 和 continue。</p>
                        <p v-if="typeof row.prompt.injection_trigger === 'string'" class="hint">此条目使用旧字符串触发字段，酒馆将其视为不限生成类型，当前原样保留；编辑后将保存为原生列表格式。</p>
                    </div>
                    <p v-else class="hint">此条目使用 bindings.slots.{{ row.prompt.identifier }} 中的消息和角色。请在上方绑定 JSON 中编辑。</p>
                    <Button size="sm" variant="ghost" :disabled="disabled" @click="updateSource(next => {const order = tavernEditorOrder(next); order.splice(order.findIndex(entry => entry.identifier === row.prompt.identifier), 1);})">移出序列</Button>
                </div>
            </article>
            <details v-if="unlisted.length"><summary>未加入序列的条目（{{ unlisted.length }}）</summary><div v-for="prompt in unlisted" :key="prompt.identifier" class="actions"><FormCheckbox :label="'选择' + (prompt.name || prompt.identifier)" :model-value="selected.has(prompt.identifier)" :disabled="disabled" @update:model-value="selectPrompt(prompt.identifier, $event)" /><span>{{ prompt.name || prompt.identifier }}</span><Button size="sm" variant="secondary" :disabled="disabled" @click="updateSource(next => tavernEditorOrder(next).push({identifier: prompt.identifier, enabled: false}))">加入序列</Button><IconButton size="sm" icon-class="i-lucide-trash-2" :aria-label="'删除' + prompt.identifier" :disabled="disabled" @click="deletePrompts([prompt.identifier])" /></div></details>
        </section>
        <section>
            <h3>正文输出</h3>
            <div class="identity">
                <label>正文范围<FormSelect :model-value="modelValue.outputPolicy?.mode ?? 'full'" size="sm" aria-label="酒馆正文范围" :disabled="disabled" :options="[{value: 'full', label: '完整回复'}, {value: 'tag', label: '提取标签内正文'}]" @update:model-value="updateOutput({mode: $event === 'tag' ? 'tag' : 'full', ...($event === 'tag' && !modelValue.outputPolicy?.tag ? {tag: 'content'} : {})})" /></label>
                <label v-if="modelValue.outputPolicy?.mode === 'tag'">正文标签名<FormInput :model-value="modelValue.outputPolicy.tag ?? ''" size="sm" aria-label="酒馆正文标签名" :disabled="disabled" @update:model-value="updateOutput({tag: $event})" /></label>
            </div>
            <div class="actions"><span>启用正文质检</span><Switch size="sm" aria-label="酒馆正文质检" :model-value="modelValue.outputPolicy?.qualityCheck !== false" :disabled="disabled" @update:model-value="updateOutput({qualityCheck: $event})" /></div>
            <p class="hint">标签模式仅将指定标签内的文本交给正文流程，分析说明仍保留在原始回复中。</p>
        </section>
        <details><summary>原生 JSON 与扩展数据</summary><p class="hint">保留所有原生字段，可直接编辑生成参数、正则与扩展配置。保存前使用编译预览检查支持情况。</p><FormTextarea v-model="raw" :rows="12" aria-label="酒馆原生 JSON" :disabled="disabled" /><Button size="sm" variant="secondary" :disabled="disabled || raw === modelValue.sourceJson" @click="applyRaw">应用 JSON</Button></details>
        <details><summary>生成参数覆盖</summary><p class="hint">默认采用预设参数。此对象仅覆盖指定参数，例如 {"reasoningEffort":"none"}；空对象恢复预设参数。实际请求还会按模型接口适配。</p><FormTextarea v-model="generationJson" :rows="5" aria-label="酒馆生成参数覆盖 JSON" :disabled="disabled" /><Button size="sm" variant="secondary" :disabled="disabled || generationJson === JSON.stringify(modelValue.generationOverride ?? {}, null, 2)" @click="applyGeneration">应用参数覆盖</Button></details>
        <section class="preview">
            <h3>提示词编译预览</h3>
            <p class="hint">变量示例格式为 {"requirements":"示例要求"}。留空对象时显示动态变量占位；预览不调用模型。</p>
            <FormTextarea v-model="exampleJson" :rows="3" aria-label="编译预览变量示例" :disabled="disabled || previewing" />
            <Button size="sm" variant="secondary" :disabled="disabled || previewing || !preview" @click="runPreview">{{ previewing ? '编译中…' : '预览最终请求结构' }}</Button>
            <div v-if="result" class="compatibility-report" aria-label="酒馆兼容报告">
                <strong>{{ result.report.promptSupported ? '原生提示词可编译' : '存在未支持的原生提示机制' }}</strong>
                <p class="hint">{{ result.report.active }} 条启用提示词 · {{ result.messages.length }} 条请求消息</p>
                <ul v-if="result.report.unsupported.length"><li v-for="item in result.report.unsupported" :key="item">{{ item }}</li></ul>
                <p v-if="result.report.extensionDependencies.length" class="hint">已保留的插件依赖（未执行）：{{ result.report.extensionDependencies.join('、') }}</p>
                <p v-if="result.budgetReport" class="hint">预算 {{ result.budgetReport.contextTokens }} tokens · 输出预留 {{ result.budgetReport.responseTokens }} · 编排占用（后处理前） {{ result.budgetReport.usedTokens }} · 裁剪历史消息（含深度注入） {{ result.budgetReport.droppedHistory }} 条 · 裁剪示例 {{ result.budgetReport.droppedExamples }} 组</p>
                <p class="hint">此报告检查原生预设编排；插件行为不属于当前兼容范围。</p>
            </div>
            <pre v-if="result" class="preview-result" aria-label="编译预览结果">{{ JSON.stringify(result, null, 2) }}</pre>
        </section>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
    </div>
</template>

<style scoped>
.tavern-editor {min-width:0; font-size:var(--text-xs);}
.actions,.entry-controls {display:flex; align-items:center; gap:var(--space-2); flex-wrap:wrap;}
.actions strong {margin-right:auto;}
section,details {margin-block:var(--space-4); min-width:0;}
h3 {font-size:var(--text-xs); font-weight:var(--weight-semibold); margin-bottom:var(--space-3);}
.hint {color:var(--text-muted); line-height:1.7; margin-block:var(--space-2); overflow-wrap:anywhere;}
.identity {display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--space-3);}
.identity label {display:grid; gap:var(--space-2); color:var(--text-secondary);}
.entry {border:var(--border-w) solid var(--control-outline); border-radius:var(--radius-control); margin-bottom:var(--space-2);}
.entry-controls {padding:var(--space-2); flex-wrap:nowrap;}
.entry-name {flex:1; min-width:0; justify-content:flex-start; overflow:hidden; text-overflow:ellipsis;}
.entry-controls :deep([role=combobox]) {width:100px;}
.entry-body {padding:var(--space-3); border-top:var(--border-w) solid var(--divider);}
.is-disabled .entry-name {color:var(--text-muted);}
.tavern-editor :deep(textarea) {width:100%; font-size:var(--text-xs); line-height:1.7; max-height:420px; resize:vertical;}
summary {cursor:pointer; color:var(--text-secondary); padding-block:var(--space-2);}
.preview-result {white-space:pre-wrap; overflow-wrap:anywhere; background:var(--bg-panel); border:var(--border-w) solid var(--control-outline); border-radius:var(--radius-control); padding:var(--space-3); margin-top:var(--space-3); max-height:500px; overflow:auto;}
.error {color:var(--status-danger); overflow-wrap:anywhere;}
.injection-options,.compatibility-report {padding-top:var(--space-3);}
.plugin-note {color:var(--text-secondary);}
.compatibility-report ul {padding-left:var(--space-4); overflow-wrap:anywhere;}
.mapping-group h4 {color:var(--text-secondary); margin-block:var(--space-3); font-weight:var(--weight-semibold);}
.mapping-row {display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); align-items:start; gap:var(--space-3); padding-block:var(--space-2); border-bottom:var(--border-w) solid var(--divider);}
.mapping-row details {margin:0;}
.mapping-template {white-space:pre-wrap; overflow-wrap:anywhere; color:var(--text-muted);}
.mapping-choice {display:grid; gap:var(--space-2); min-width:0;}
.selection-actions {margin-block:var(--space-3);}
.is-selected {border-color:var(--text-secondary);}
.is-dragged {opacity:0.6;}
.drag-handle {touch-action:none; cursor:grab; flex-shrink:0;}
.is-dragging {user-select:none;}
.entry-selection {flex-shrink:0;}
.entry-selection :deep(> span:last-child) {position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%);}
@container (max-width:420px) {.mapping-row {grid-template-columns:1fr;}}
@container (max-width:420px) {.identity {grid-template-columns:1fr;} .entry-controls {flex-wrap:wrap;} .entry-name {flex-basis:100%;} .entry-controls :deep([role=combobox]) {flex:1;} .actions {align-items:flex-start;}}
</style>
