<script setup lang="ts">
import {computed, nextTick, ref, useId} from "vue";
import {Button, FormInput, FormSelect, FormTextarea, IconButton, Switch} from "@notnotype/nb-ui/components";
import {PromptPresetSchema, type PromptCatalogDto, type PromptEntry, type PromptMutationDto, type PromptPreset, type PromptPurposeDto} from "nbook/shared/dto/prompt-management.dto";
import {resolveApiErrorMessage} from "nbook/app/utils/api-error";
import {TavernWriterPresetSchema, type TavernPreviewRequest, type TavernPreviewResult} from "nbook/shared/dto/tavern-preset.dto";
import {createMappedTavernImport, defaultTavernOutputPolicy} from "nbook/shared/prompt-management/tavern-bindings";
import TavernPresetEditor from "./TavernPresetEditor.vue";
import {parseEditableTavernSource} from "./tavern-editor";

const props = withDefaults(defineProps<{
    catalog: PromptCatalogDto;
    saving?: boolean;
    mutate: (mutation: PromptMutationDto) => Promise<PromptCatalogDto>;
    preview?: (request: TavernPreviewRequest) => Promise<TavernPreviewResult>;
    download?: (name: string, contents: string) => void;
}>(), {saving: false});

const modules = [
    {id: "design", name: "设计工作台", note: "原创、改编与作品提取"},
    {id: "outline", name: "大纲规划工作台", note: "规划助手与专用专家"},
    {id: "writing", name: "写作模块", note: "主创、助手与写手流程"},
];
const roles = ["system", "user", "assistant"].map((role) => ({value: role, label: role}));
const instanceId = useId();
const root = ref<HTMLElement | null>(null);
const editor = ref<HTMLElement | null>(null);
const search = ref("");
const moduleFilter = ref("all");
const editorPurposeId = ref<string | null>(null);
const draft = ref<PromptPreset | null>(null);
const baseline = ref("");
const draftRevision = ref(0);
const creating = ref(false);
const expanded = ref<Set<string>>(new Set());
const deleteTarget = ref<PromptPurposeDto | null>(null);
const notice = ref("");
const error = ref("");
const dragId = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const importPurpose = ref<PromptPurposeDto | null>(null);
const currentPurpose = computed(() => props.catalog.purposes.find((purpose) => purpose.purposeId === editorPurposeId.value));
const savedEntryIds = computed(() => new Set(baseline.value ? (JSON.parse(baseline.value) as PromptPreset).entries.map(entry => entry.id) : []));
const readonly = computed(() => Boolean(draft.value?.builtin));
const liveWriter = computed(() => editorPurposeId.value === "writing.writer.scene" || editorPurposeId.value === "writing.writer.rewrite");
const dirty = computed(() => Boolean(draft.value && !readonly.value && (creating.value || JSON.stringify(draft.value) !== baseline.value)));
const groups = computed(() => {
    const query = search.value.trim().toLocaleLowerCase();
    return modules.map((module) => ({
        ...module,
        items: props.catalog.purposes.filter((purpose) => purpose.module === module.id
            && (moduleFilter.value === "all" || purpose.module === moduleFilter.value)
            && (!query || `${purpose.label} ${purpose.description}`.toLocaleLowerCase().includes(query))),
    })).filter((group) => group.items.length);
});
const total = computed(() => groups.value.reduce((sum, group) => sum + group.items.length, 0));

function copyPreset(preset: PromptPreset): PromptPreset {
    return PromptPresetSchema.parse(preset);
}

function isWriter(purposeId: string): boolean {return purposeId === "writing.writer.scene" || purposeId === "writing.writer.rewrite";}

function requestImport(purpose: PromptPurposeDto): void {
    if (props.saving) return;
    importPurpose.value = purpose;
    fileInput.value?.click();
}

async function importFile(event: Event): Promise<void> {
    const input = event.target;
    const purpose = importPurpose.value;
    if (!(input instanceof HTMLInputElement) || !purpose) return;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    error.value = "";
    try {
        if (file.size > 2_000_000) throw new Error("预设文件不能超过 2 MB。");
        const text = await file.text();
        const parsed: unknown = JSON.parse(text);
        const complete = TavernWriterPresetSchema.safeParse(parsed);
        if (!complete.success) parseEditableTavernSource(text);
        const tavern = complete.success ? complete.data : {
            sourceJson: text, ...createMappedTavernImport(purpose.purposeId, text), macroEngine: "legacy" as const, extensionPolicy: "prompt-only" as const,
            outputPolicy: defaultTavernOutputPolicy(text),
        };
        openEditor(purpose, true);
        if (!draft.value) return;
        draft.value.name = file.name.replace(/(?:\.neurobook)?\.json$/iu, "").slice(0, 120) || "酒馆预设";
        draft.value.tavern = tavern;
        draft.value.entries = [];
        notice.value = "酒馆预设已载入草稿。检查资料绑定和编译预览，保存后供写手使用。";
    } catch (cause) {error.value = resolveApiErrorMessage(cause, "导入酒馆预设失败。");}
}

function selectedPreset(purpose: PromptPurposeDto): PromptPreset | undefined {
    return purpose.presets.find((preset) => preset.id === purpose.selectedPresetId);
}

function leaveEditor(): void {
    if (props.saving) return;
    const purposeId = editorPurposeId.value;
    if (dirty.value) notice.value = "未保存的修改已丢弃。";
    editorPurposeId.value = null;
    draft.value = null;
    creating.value = false;
    expanded.value = new Set();
    dragId.value = null;
    error.value = "";
    void nextTick(() => {
        const row = Array.from(root.value?.querySelectorAll<HTMLElement>("[data-purpose]") ?? [])
            .find((element) => element.dataset.purpose === purposeId);
        row?.querySelector<HTMLElement>("[data-edit-preset]")?.focus();
    });
}

function openEditor(purpose: PromptPurposeDto, create = false): void {
    if (props.saving) return;
    const base = selectedPreset(purpose);
    if (!base) return;
    notice.value = "";
    error.value = "";
    deleteTarget.value = null;
    editorPurposeId.value = purpose.purposeId;
    creating.value = create;
    const next = copyPreset(base);
    if (create) {
        next.id = "";
        next.builtin = false;
        next.revision = 0;
        const baseName = base.builtin ? "我的预设" : `${base.name} · 副本`;
        next.name = baseName;
        let suffix = 2;
        while (purpose.presets.some((preset) => preset.name === next.name)) {
            next.name = `${baseName} ${suffix++}`;
        }
    }
    draft.value = next;
    baseline.value = JSON.stringify(next);
    draftRevision.value = props.catalog.revision;
    expanded.value = new Set(next.entries.slice(0, 1).map((entry) => entry.id));
    void nextTick(() => root.value?.querySelector<HTMLInputElement>("[data-preset-name]")?.focus());
}

function toggleEntry(id: string): void {
    const next = new Set(expanded.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded.value = next;
}

async function setEntryEnabled(entry: PromptEntry, enabled: boolean): Promise<void> {
    const current = draft.value;
    const purpose = currentPurpose.value;
    if (!current || !purpose || readonly.value || props.saving) return;
    if (!liveWriter.value) {entry.enabled = enabled; return;}
    if (creating.value || !savedEntryIds.value.has(entry.id)) return;
    error.value = "";
    try {
        const catalog = await props.mutate({action: "toggle", purposeId: purpose.purposeId, presetId: current.id,
            entryId: entry.id, enabled, expectedRevision: draftRevision.value});
        const saved = catalog.purposes.find(item => item.purposeId === purpose.purposeId)?.presets.find(item => item.id === current.id);
        if (!saved) throw new Error("无法读取保存后的预设。");
        // Rebase only the switch: text and ordering edits must remain unsaved.
        entry.enabled = enabled;
        current.revision = saved.revision;
        baseline.value = JSON.stringify(copyPreset(saved));
        draftRevision.value = catalog.revision;
        notice.value = "启用状态已即时保存，下一次写手调用生效；未保存的正文修改仍保留为草稿。";
    } catch (cause) {
        error.value = resolveApiErrorMessage(cause, "保存提示词启用状态失败。");
    }
}

function entryToggleDisabled(entry: PromptEntry): boolean {
    return readonly.value || props.saving || (liveWriter.value && (creating.value
        || !savedEntryIds.value.has(entry.id)));
}

async function selectPreset(purpose: PromptPurposeDto, presetId: string): Promise<void> {
    if (props.saving || presetId === purpose.selectedPresetId) return;
    error.value = "";
    deleteTarget.value = null;
    try {
        await props.mutate({action: "select", purposeId: purpose.purposeId, presetId, expectedRevision: props.catalog.revision});
        notice.value = purpose.purposeId.startsWith("writing.writer.") ? "已选择预设，下一次写手调用将使用该预设。" : "已选择预设。新建会话和任务将使用该预设，已有记录保留原版本。";
    } catch (cause) {
        error.value = resolveApiErrorMessage(cause, "切换提示词预设失败。");
    }
}

async function savePreset(): Promise<void> {
    const current = draft.value;
    const purpose = currentPurpose.value;
    if (!current || !purpose || readonly.value || !dirty.value || props.saving) return;
    if (!current.name.trim()) {
        error.value = "请输入预设名称。";
        return;
    }
    if (current.entries.some((entry) => !entry.name.trim() || !entry.content.trim())) {
        error.value = "请为每个条目填写名称和提示词正文。";
        return;
    }
    error.value = "";
    try {
        const mutation: PromptMutationDto = current.tavern ? {
            action: "import-tavern", purposeId: purpose.purposeId, expectedRevision: draftRevision.value,
            ...(creating.value ? {} : {presetId: current.id}), name: current.name.trim(), tavern: current.tavern,
        } : {
            action: "save",
            purposeId: purpose.purposeId,
            expectedRevision: draftRevision.value,
            ...(creating.value ? {} : {presetId: current.id}),
            name: current.name.trim(),
            entries: current.entries.map((entry) => ({...entry})),
        };
        const catalog = await props.mutate(mutation);
        const updatedPurpose = catalog.purposes.find((item) => item.purposeId === purpose.purposeId);
        const updated = updatedPurpose && selectedPreset(updatedPurpose);
        if (updated) {
            draft.value = copyPreset(updated);
            baseline.value = JSON.stringify(draft.value);
            draftRevision.value = catalog.revision;
            creating.value = false;
        }
        notice.value = liveWriter.value ? "已保存预设的全部改动，下一次写手调用使用此版本。" : "已保存预设的全部改动。仅新建会话和任务使用此版本。";
    } catch (cause) {
        error.value = resolveApiErrorMessage(cause, "保存提示词预设失败。");
    }
}

function addEntry(): void {
    if (!draft.value || readonly.value || props.saving) return;
    const entry: PromptEntry = {id: crypto.randomUUID(), name: "新提示词", role: "user", content: "", enabled: true};
    draft.value.entries.push(entry);
    expanded.value = new Set([...expanded.value, entry.id]);
    void nextTick(() => editor.value?.querySelector<HTMLElement>(`[data-message="${entry.id}"] input`)?.focus());
}

function removeEntry(id: string): void {
    if (!draft.value || readonly.value || props.saving) return;
    draft.value.entries = draft.value.entries.filter((entry) => entry.id !== id);
    expanded.value.delete(id);
}

function askDelete(purpose: PromptPurposeDto): void {
    if (props.saving || selectedPreset(purpose)?.builtin) return;
    deleteTarget.value = purpose;
    notice.value = "";
    error.value = "";
}

async function deletePreset(): Promise<void> {
    const purpose = deleteTarget.value;
    const preset = purpose && selectedPreset(purpose);
    if (!purpose || !preset || preset.builtin || props.saving) return;
    error.value = "";
    try {
        await props.mutate({action: "delete", purposeId: purpose.purposeId, presetId: preset.id, expectedRevision: props.catalog.revision});
        deleteTarget.value = null;
        notice.value = "预设已删除，历史会话和任务使用的版本仍保留。";
    } catch (cause) {
        error.value = resolveApiErrorMessage(cause, "删除提示词预设失败。");
    }
}

function moveEntry(id: string, offset: number): void {
    if (!draft.value || readonly.value || props.saving) return;
    const entries = draft.value.entries;
    const from = entries.findIndex((entry) => entry.id === id);
    const to = Math.max(0, Math.min(entries.length - 1, from + offset));
    if (from >= 0 && to !== from) {
        const entry = entries.splice(from, 1)[0];
        if (entry) entries.splice(to, 0, entry);
    }
}

function startDrag(event: PointerEvent, id: string): void {
    if (event.button !== 0 || readonly.value || props.saving) return;
    const handle = event.currentTarget;
    if (!(handle instanceof HTMLElement)) return;
    event.preventDefault();
    // Capture on the stable scroll owner: moving the row must not end the pointer gesture.
    editor.value?.setPointerCapture(event.pointerId);
    dragId.value = id;
}

function drag(event: PointerEvent): void {
    if (!dragId.value || !draft.value || props.saving) return;
    const target = editor.value?.ownerDocument.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-message]");
    if (!target || !editor.value?.contains(target) || target.dataset.message === dragId.value) return;
    const from = draft.value.entries.findIndex((entry) => entry.id === dragId.value);
    const to = draft.value.entries.findIndex((entry) => entry.id === target.dataset.message);
    if (from >= 0 && to >= 0) moveEntry(dragId.value, to - from);
}
</script>

<template>
    <section ref="root" class="prompt-management" aria-label="提示词管理" :aria-busy="props.saving">
        <input ref="fileInput" type="file" accept=".json,application/json" class="file-input" tabindex="-1" aria-label="选择酒馆预设文件" @change="importFile" />
        <header class="page-header">
            <div>
                <Button v-if="currentPurpose" class="back" size="sm" variant="ghost" icon-class="i-lucide-arrow-left" :disabled="props.saving" @click="leaveEditor">返回提示词列表</Button>
                <h2>{{ currentPurpose?.label ?? '提示词管理' }}</h2>
                <p v-if="currentPurpose">{{ currentPurpose.description }}</p>
            </div>
            <span class="global-label">所有作品共用</span>
        </header>
        <p class="lifecycle-note"><span class="i-lucide-info" aria-hidden="true" />写手使用每次调用前的最新配置；其他用途仅对新建会话和任务生效。</p>
        <p v-if="notice" class="notice" role="status">{{ notice }}</p>

        <template v-if="!draft">
            <div class="list-toolbar">
                <FormInput v-model="search" type="search" size="sm" icon-class="i-lucide-search" placeholder="搜索名称或作用" aria-label="搜索调用用途" :disabled="props.saving" />
                <FormSelect v-model="moduleFilter" size="sm" aria-label="按模块筛选" :options="[{value: 'all', label: '全部模块'}, ...modules.map((module) => ({value: module.id, label: module.name}))]" :disabled="props.saving" />
            </div>
            <div class="purpose-scroll custom-scrollbar">
                <section v-for="group in groups" :key="group.id" class="module-group">
                    <div class="module-heading"><h3>{{ group.name }}</h3><span>{{ group.items.length }} 项 · {{ group.note }}</span></div>
                    <article v-for="purpose in group.items" :key="purpose.purposeId" class="purpose-row" :data-purpose="purpose.purposeId">
                        <div class="purpose-description"><strong>{{ purpose.label }}</strong><p>{{ purpose.description }}</p></div>
                        <div class="preset-controls">
                            <FormSelect :model-value="purpose.selectedPresetId" size="sm" :aria-label="purpose.label + '预设'" :options="purpose.presets.map((preset) => ({value: preset.id, label: preset.name, description: preset.builtin ? '内置默认 · 不可删除或修改' : `自定义 · 版本 ${preset.revision}`}))" :disabled="props.saving" @update:model-value="(id) => selectPreset(purpose, id)" />
                            <IconButton size="sm" icon-class="i-lucide-trash-2" :disabled="props.saving || Boolean(selectedPreset(purpose)?.builtin)" :title="selectedPreset(purpose)?.builtin ? '内置默认预设不可删除' : '删除预设'" :aria-label="'删除' + purpose.label + '预设'" @click="askDelete(purpose)" />
                            <Button size="sm" variant="secondary" icon-class="i-lucide-plus" :disabled="props.saving" @click="openEditor(purpose, true)">新建</Button>
                            <Button size="sm" variant="secondary" :icon-class="selectedPreset(purpose)?.builtin ? 'i-lucide-eye' : 'i-lucide-pencil'" :disabled="props.saving" data-edit-preset @click="openEditor(purpose)">{{ selectedPreset(purpose)?.builtin ? '查看' : '编辑' }}</Button>
                            <Button v-if="isWriter(purpose.purposeId)" class="tavern-import" size="sm" variant="secondary" icon-class="i-lucide-upload" :disabled="props.saving" @click="requestImport(purpose)">导入酒馆</Button>
                        </div>
                        <div v-if="deleteTarget?.purposeId === purpose.purposeId" class="delete-confirm">
                            <span>删除“{{ selectedPreset(purpose)?.name }}”？已有记录的版本仍保留。</span>
                            <Button size="sm" variant="danger" :disabled="props.saving" @click="deletePreset">确认删除</Button>
                            <Button size="sm" variant="ghost" :disabled="props.saving" @click="deleteTarget = null">取消</Button>
                        </div>
                    </article>
                </section>
                <p v-if="!total" class="empty">没有找到对应的调用用途。</p>
            </div>
        </template>

        <template v-else>
            <div class="editor-toolbar">
                <div class="preset-name">
                    <label :for="instanceId + '-preset-name'">预设名称</label>
                    <FormInput :id="instanceId + '-preset-name'" v-model="draft.name" size="sm" aria-label="预设名称" data-preset-name :readonly="readonly" :disabled="props.saving" />
                </div>
                <span class="save-state" :class="{dirty}">{{ readonly ? '内置默认 · 只读' : dirty ? '未保存' : `已保存 · 版本 ${draft.revision}` }}</span>
                <Button v-if="!draft.tavern" size="sm" variant="secondary" icon-class="i-lucide-plus" :disabled="readonly || props.saving" @click="addEntry">新建提示词</Button>
            </div>
            <div ref="editor" class="editor-scroll custom-scrollbar" :class="{'is-dragging': dragId}" @pointermove="drag" @pointerup="dragId = null" @pointercancel="dragId = null" @lostpointercapture="dragId = null">
                <TavernPresetEditor v-if="draft.tavern && currentPurpose" v-model="draft.tavern" :purpose-id="currentPurpose.purposeId" :name="draft.name" :disabled="props.saving" :preview="props.preview" :download="props.download" />
                <template v-else>
                <p class="sequence-hint">{{ readonly ? '内置默认不可修改。返回列表点击“新建”，复制后编辑自己的预设。' : liveWriter ? '已保存条目的开关即时保存，下一次写手调用生效；正文仍需保存。新预设或新条目请先保存再切换开关。' : '按列表顺序提供上下文；按住左侧手柄可拖动排序。开关修改需保存预设后生效。' }}</p>
                <p v-if="currentPurpose?.variables.length" class="variable-hint">可用动态变量：<code v-for="variable in currentPurpose.variables" :key="variable">{{ variable }}</code></p>
                <article v-for="(entry, index) in draft.entries" :key="entry.id" class="message-entry" :class="{expanded: expanded.has(entry.id), dragged: dragId === entry.id, 'is-disabled': entry.enabled === false}" :data-message="entry.id">
                    <div class="entry-header">
                        <IconButton class="drag-handle" size="sm" icon-class="i-lucide-grip-vertical" :aria-label="'拖动' + entry.name + '排序'" title="按住左键拖动；方向键上下移动" :disabled="readonly || props.saving" @pointerdown="(event: PointerEvent) => startDrag(event, entry.id)" @keydown.up.prevent="moveEntry(entry.id, -1)" @keydown.down.prevent="moveEntry(entry.id, 1)" />
                        <Button variant="ghost" size="sm" class="entry-name" :aria-expanded="expanded.has(entry.id)" :aria-controls="instanceId + '-body-' + entry.id" @click="toggleEntry(entry.id)">
                            <span class="sequence-number">{{ String(index + 1).padStart(2, '0') }}</span><span>{{ entry.name }}</span><span v-if="entry.enabled === false" class="disabled-label">已停用</span><span :class="expanded.has(entry.id) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" aria-hidden="true" />
                        </Button>
                        <FormSelect v-model="entry.role" size="sm" :aria-label="entry.name + '角色'" :options="roles" :disabled="readonly || props.saving" />
                        <Switch size="sm" :model-value="entry.enabled !== false" :aria-label="entry.name + '启用状态'" :title="readonly ? '内置默认不可修改，请新建副本' : entryToggleDisabled(entry) ? '请先保存预设和新条目' : entry.enabled === false ? '已停用；点击启用' : '已启用；点击停用'" :disabled="entryToggleDisabled(entry)" @update:model-value="(enabled) => setEntryEnabled(entry, enabled)" />
                        <IconButton size="sm" icon-class="i-lucide-trash-2" :aria-label="'删除' + entry.name" title="删除提示词条目" :disabled="readonly || props.saving" @click="removeEntry(entry.id)" />
                    </div>
                    <div v-if="expanded.has(entry.id)" :id="instanceId + '-body-' + entry.id" class="entry-body">
                        <div class="entry-label"><label :for="instanceId + '-name-' + entry.id">名称</label><FormInput :id="instanceId + '-name-' + entry.id" v-model="entry.name" size="sm" :aria-label="'条目' + (index + 1) + '名称'" :readonly="readonly" :disabled="props.saving" /></div>
                        <FormTextarea v-model="entry.content" :rows="entry.role === 'system' ? 11 : 6" :aria-label="entry.name + '正文'" placeholder="输入提示词正文，可保留模板中的动态变量。" :readonly="readonly" :disabled="props.saving" />
                        <div class="entry-save"><span>{{ entry.content.length.toLocaleString() }} 字符<span class="save-explanation"> · 保存当前预设全部改动</span></span><Button size="sm" :disabled="!dirty || props.saving" @click="savePreset">保存</Button></div>
                    </div>
                </article>
                <p v-if="!draft.entries.length" class="empty">暂时没有提示词条目。点击右上角“新建提示词”添加。</p>
                </template>
            </div>
        </template>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <footer class="page-footer">
            <template v-if="draft"><span>{{ draft.tavern ? '酒馆原生预设' : `${draft.entries.length} 条提示词 · ${draft.entries.filter(entry => entry.enabled !== false).length} 条启用` }}<span class="footer-explanation"> · {{ readonly ? '内置默认永久保留' : '未保存的修改在离开后丢弃' }}</span></span><Button size="sm" :disabled="!dirty || props.saving" @click="savePreset">{{ props.saving ? '保存中…' : '保存预设' }}</Button></template>
            <template v-else><span>{{ total }} 个调用用途 · 3 个模块</span><span class="footer-explanation">选择预设供后续新会话使用</span></template>
        </footer>
    </section>
</template>

<style scoped>
.prompt-management {display:flex; flex-direction:column; min-height:0; min-width:0; height:100%; container-type:inline-size;}
.file-input {display:none;}
.tavern-import {grid-column:1/-1; justify-self:end;}
.page-header {display:flex; justify-content:space-between; align-items:center; gap:var(--space-3); padding:var(--space-6); border-bottom:var(--border-w) solid var(--divider); flex-shrink:0;}
.page-header h2 {font-size:var(--text-sm); font-weight:var(--weight-semibold);}
.page-header p {color:var(--text-secondary); margin-top:var(--space-2); font-size:var(--text-xs); line-height:1.5;}
.global-label {color:var(--text-muted); font-size:var(--text-xs); white-space:nowrap;}
.lifecycle-note {display:flex; align-items:center; gap:var(--space-2); margin:var(--space-3) var(--space-6) 0; color:var(--text-secondary); font-size:var(--text-xs); line-height:1.6; flex-shrink:0;}
.lifecycle-note > span {color:var(--accent-main); flex-shrink:0;}
.notice {color:var(--status-success); margin:var(--space-2) var(--space-6) 0; font-size:var(--text-xs); flex-shrink:0;}
.list-toolbar {display:grid; grid-template-columns:minmax(0,1fr) 190px; gap:var(--space-3); padding:var(--space-4) var(--space-6) var(--space-2); flex-shrink:0;}
.purpose-scroll,.editor-scroll {min-height:0; overflow-y:auto; overflow-x:hidden; flex:1; padding:0 var(--space-6) var(--space-4); scrollbar-gutter:stable; overscroll-behavior:contain;}
.module-heading {display:flex; align-items:center; justify-content:space-between; gap:var(--space-2); padding:var(--space-4) 0 var(--space-2); border-bottom:var(--border-w) solid var(--divider);}
.module-heading h3 {font-size:var(--text-sm); font-weight:var(--weight-semibold);}
.module-heading > span {color:var(--text-muted); font-size:var(--text-2xs);}
.purpose-row {display:grid; grid-template-columns:minmax(160px,1fr) 340px; column-gap:var(--space-5); padding:var(--space-4) 0; border-bottom:var(--border-w) solid var(--divider); align-items:center;}
.purpose-description {min-width:0;}
.purpose-description strong {font-size:var(--text-sm); font-weight:var(--weight-medium);}
.purpose-description p {color:var(--text-muted); font-size:var(--text-xs); line-height:1.6; margin-top:var(--space-1); overflow-wrap:anywhere;}
.preset-controls {display:grid; grid-template-columns:minmax(90px,1fr) 26px 65px 65px; gap:var(--space-1); align-items:center; min-width:0;}
.delete-confirm {grid-column:1/-1; display:flex; align-items:center; gap:var(--space-2); flex-wrap:wrap; margin-top:var(--space-2); padding:var(--space-2); color:var(--status-danger); font-size:var(--text-xs);}
.delete-confirm > span {flex:1;}
.page-footer {display:flex; align-items:center; justify-content:space-between; gap:var(--space-3); flex-shrink:0; padding:var(--space-3) var(--space-6); border-top:var(--border-w) solid var(--divider); font-size:var(--text-xs); color:var(--text-muted);}
.back {margin-left:calc(-1 * var(--space-2)); margin-bottom:var(--space-2);}
.editor-toolbar {padding:var(--space-4) var(--space-6) var(--space-3); display:flex; align-items:center; gap:var(--space-3); flex-shrink:0;}
.preset-name {display:flex; align-items:center; gap:var(--space-2); min-width:0; flex:1;}
.preset-name label {white-space:nowrap; font-size:var(--text-xs); color:var(--text-secondary);}
.save-state {font-size:var(--text-xs); color:var(--text-muted); white-space:nowrap;}
.save-state.dirty {color:var(--status-warning);}
.sequence-hint,.variable-hint {font-size:var(--text-xs); color:var(--text-muted); margin:var(--space-1) 0 var(--space-3); overflow-wrap:anywhere;}
.variable-hint code {display:inline-block; margin-right:var(--space-2);}
.message-entry {border:var(--border-w) solid var(--control-outline); border-radius:var(--radius-control); margin-bottom:var(--space-3); overflow:hidden; background:var(--bg-panel);}
.message-entry.dragged {outline:2px solid var(--accent-main);}
.entry-header {display:grid; grid-template-columns:26px minmax(0,1fr) 125px 28px 26px; align-items:center; gap:var(--space-2); padding:var(--space-2);}
.is-disabled .entry-name {color:var(--text-muted);}
.disabled-label {font-size:var(--text-2xs); color:var(--text-muted); flex-shrink:0;}
.drag-handle {cursor:grab; touch-action:none;}
.is-dragging {user-select:none;}
.is-dragging .drag-handle {cursor:grabbing;}
.entry-name {min-width:0; justify-content:flex-start; width:100%; padding-inline:var(--space-1);}
.entry-name > span:nth-child(2) {overflow:hidden; text-overflow:ellipsis;}
.entry-name > span:last-child {margin-left:auto; flex-shrink:0;}
.sequence-number {color:var(--text-muted); font-size:var(--text-2xs); font-variant-numeric:tabular-nums; flex-shrink:0;}
.entry-body {padding:var(--space-3); border-top:var(--border-w) solid var(--divider);}
.entry-label {display:flex; align-items:center; gap:var(--space-2); margin-bottom:var(--space-3);}
.entry-label label {font-size:var(--text-xs); color:var(--text-muted);}
.entry-body :deep(textarea) {display:block; width:100%; font-size:var(--text-xs); line-height:1.8; min-height:130px; max-height:390px; resize:vertical; overflow:auto; overflow-wrap:anywhere;}
.entry-save {display:flex; justify-content:space-between; align-items:center; gap:var(--space-2); margin-top:var(--space-3); color:var(--text-muted); font-size:var(--text-2xs);}
.empty {padding:var(--space-6); color:var(--text-muted); text-align:center;}
.error {padding:var(--space-2) var(--space-6); color:var(--status-danger); font-size:var(--text-xs); flex-shrink:0;}
@container (max-width:760px) {
    .purpose-row {grid-template-columns:1fr; gap:var(--space-2);}
    .preset-controls {max-width:400px;}
    .global-label {display:none;}
    .editor-toolbar {flex-wrap:wrap;}
    .preset-name {flex-basis:100%;}
    .save-state {margin-right:auto;}
}
@container (max-width:420px) {
    .page-header {padding:var(--space-3);}
    .lifecycle-note,.notice {margin-inline:var(--space-3);}
    .list-toolbar {padding:var(--space-3); grid-template-columns:minmax(0,1fr) 112px; gap:var(--space-2);}
    .purpose-scroll,.editor-scroll {padding-inline:var(--space-3);}
    .module-heading {align-items:flex-start; flex-direction:column; gap:var(--space-1);}
    .preset-controls {grid-template-columns:minmax(70px,1fr) 26px 60px 60px; gap:var(--space-1);}
    .page-footer,.editor-toolbar {padding:var(--space-3);}
    .entry-header {grid-template-columns:24px minmax(0,1fr) 87px 28px 24px; gap:var(--space-1); padding:var(--space-1);}
    .disabled-label {display:none;}
    .entry-body {padding:var(--space-2);}
    .entry-body :deep(textarea) {max-height:270px;}
    .entry-name {font-size:var(--text-xs); gap:var(--space-1);}
    .save-explanation,.footer-explanation {display:none;}
}
</style>
