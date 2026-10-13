<script setup lang="ts">
import {computed, onBeforeUnmount, ref, watch} from "vue";
import {EditorContent, useEditor} from "@tiptap/vue-3";
import {BubbleMenu} from "@tiptap/vue-3/menus";
import {Placeholder} from "@tiptap/extension-placeholder";
import type {Editor} from "@tiptap/core";
import type {EditorState} from "@tiptap/pm/state";
import {createMarkdownDialectExtensions} from "nbook/app/components/markdown-studio/tiptap/markdown-dialect-extensions";
import {THEME_HOST_SELECTOR} from "nbook/app/utils/theme/host";
import type {ForeshadowMarkerAction, OutlineAnchorKind} from "nbook/shared/markdown-workbench";
import {
    applyOutlineMark,
    creatableMarkKinds,
    findOutlineMark,
    formatProblem,
    OutlineMarkIntegrity,
    outlineMarksAtCursor,
    removeOutlineMark,
    updateForeshadowMark,
    type OutlineMarkKind,
    type OutlineMarkRange,
    type OutlineRichTextAnnotations,
} from "nbook/app/components/novel-ide/outline/outline-rich-text";

const props = withDefaults(defineProps<{
    modelValue: string;
    annotations?: OutlineRichTextAnnotations;
    foreshadowOptions?: readonly Readonly<{value: string; label: string}>[];
    placeholder?: string;
    readonly?: boolean;
    ariaLabel?: string;
}>(), {annotations: "none", foreshadowOptions: () => [], placeholder: "", readonly: false, ariaLabel: "正文"});
const emit = defineEmits<{
    "update:modelValue": [value: string];
    annotate: [kind: OutlineAnchorKind, marker: string];
    "focus-mark": [kind: OutlineAnchorKind, marker: string];
}>();

const markLabels: Record<OutlineMarkKind, string> = {guidance: "写作指导", reference: "段落参考", foreshadow: "伏笔"};
const actionOptions: readonly {value: ForeshadowMarkerAction; label: string}[] = [
    {value: "plant", label: "埋设"}, {value: "reinforce", label: "强化"}, {value: "recover", label: "回收"},
];

/**
 * 序列化并不逐字还原原文（空行、列表符号等会规范化）。记住载入时的原文与它的序列化结果，
 * 编辑后若回到同一序列化结果就发回原文，打开即保存或撤销回原样都不会被宿主当成修改。
 */
let loadedRaw = props.modelValue;
let loadedSerialized: string | null = null;
let lastEmitted = props.modelValue;

const menuVisible = ref(true);
const revision = ref(0);
const menuError = ref<string | null>(null);
const pickerOpen = ref(false);
const pickerAction = ref<ForeshadowMarkerAction>("plant");
const retargetMarker = ref<string | null>(null);

const editor = useEditor({
    content: props.modelValue,
    contentType: "markdown",
    editable: !props.readonly,
    extensions: [
        ...createMarkdownDialectExtensions(),
        Placeholder.configure({placeholder: () => props.placeholder}),
        OutlineMarkIntegrity,
    ],
    editorProps: {
        attributes: {class: "outline-rich-text__content", role: "textbox", "aria-multiline": "true", "aria-label": props.ariaLabel, spellcheck: "false"},
    },
    onCreate: ({editor: instance}) => {
        loadedSerialized = instance.getMarkdown();
    },
    onUpdate: ({editor: instance}) => {
        const markdown = instance.getMarkdown();
        const value = markdown === loadedSerialized ? loadedRaw : markdown;
        if (value === lastEmitted) return;
        lastEmitted = value;
        emit("update:modelValue", value);
    },
    onFocus: () => {
        menuVisible.value = true;
    },
    onBlur: () => {
        closeMenus();
        menuVisible.value = false;
    },
    onSelectionUpdate: () => {
        menuError.value = null;
        revision.value += 1;
    },
    onTransaction: () => {
        revision.value += 1;
    },
});

watch(() => props.modelValue, (value) => {
    const instance = editor.value;
    if (!instance || value === lastEmitted) return;
    // 外部重载不是作者的编辑：不进撤销历史，也不回发更新。
    instance.chain().setMeta("addToHistory", false).setContent(value, {emitUpdate: false, contentType: "markdown"}).run();
    loadedRaw = value;
    lastEmitted = value;
    loadedSerialized = instance.getMarkdown();
});
watch(() => props.readonly, (readonly) => editor.value?.setEditable(!readonly, false));

onBeforeUnmount(() => editor.value?.destroy());

const creatable = computed(() => creatableMarkKinds(props.annotations));
const foreshadowLabels = computed(() => new Map(props.foreshadowOptions.map(({value, label}) => [value, label])));

function snapshot<T>(read: (state: EditorState) => T, fallback: T): T {
    void revision.value;
    const state = editor.value?.state;
    return state ? read(state) : fallback;
}
const selectionEmpty = computed(() => snapshot((state) => state.selection.empty, true));
const cursorMarks = computed(() => snapshot((state) => state.selection.empty ? outlineMarksAtCursor(state) : [], [] as OutlineMarkRange[]));
const formatBlocked = computed(() => snapshot((state) => formatProblem(state), null));
const active = (name: string): boolean => snapshot(() => editor.value?.isActive(name) ?? false, false);

const bubbleOptions = {
    strategy: "fixed" as const,
    placement: "top" as const,
    offset: 10,
    shift: {padding: 10},
    flip: {padding: 10},
    inline: true,
};

function appendToThemeHost(): HTMLElement {
    return document.querySelector<HTMLElement>(THEME_HOST_SELECTOR) ?? document.body;
}

function shouldShowMenu(options: {editor: Editor; state: EditorState; from: number; to: number}): boolean {
    if (!menuVisible.value || props.readonly || !options.editor.isEditable || !options.editor.isFocused) return false;
    if (options.from !== options.to) return true;
    return outlineMarksAtCursor(options.state).length > 0;
}

function closeMenus(): void {
    pickerOpen.value = false;
    retargetMarker.value = null;
}

function toggleFormat(mark: "bold" | "italic"): void {
    const instance = editor.value;
    if (!instance) return;
    if (formatBlocked.value) {
        menuError.value = formatBlocked.value;
        return;
    }
    const chain = instance.chain().focus();
    (mark === "bold" ? chain.toggleBold() : chain.toggleItalic()).run();
}

function addAnchor(kind: OutlineAnchorKind): void {
    const instance = editor.value;
    if (!instance) return;
    const result = applyOutlineMark(instance, kind);
    if (typeof result === "string") {
        menuError.value = result;
        return;
    }
    emit("annotate", kind, result.marker);
}

function addForeshadow(foreshadowId: string): void {
    const instance = editor.value;
    if (!instance) return;
    const result = applyOutlineMark(instance, "foreshadow", {foreshadowId, action: pickerAction.value});
    if (typeof result === "string") {
        menuError.value = result;
        return;
    }
    closeMenus();
}

function setAction(marker: string, action: ForeshadowMarkerAction): void {
    if (editor.value) updateForeshadowMark(editor.value, marker, {action});
}

function retarget(marker: string, foreshadowId: string): void {
    if (editor.value) updateForeshadowMark(editor.value, marker, {foreshadowId});
    retargetMarker.value = null;
}

function removeMark(kind: OutlineMarkKind, marker: string): void {
    if (editor.value) removeOutlineMark(editor.value, kind, marker);
}

function markTitle(range: OutlineMarkRange): string {
    if (range.kind !== "foreshadow") return markLabels[range.kind];
    const id = String(range.attrs.foreshadowId ?? "");
    return `伏笔：${foreshadowLabels.value.get(id) ?? `未找到的伏笔 ${id}`}`;
}

function selectMark(kind: OutlineMarkKind, marker: string): void {
    const instance = editor.value;
    if (!instance) return;
    const range = findOutlineMark(instance.state.doc, kind, marker);
    if (range) instance.chain().focus().setTextSelection({from: range.from, to: range.to}).scrollIntoView().run();
}

defineExpose({
    focus: () => editor.value?.commands.focus("end"),
    selectMark,
    removeMark,
});
</script>

<template>
    <div class="outline-rich-text" :class="{'is-readonly': props.readonly}">
        <EditorContent :editor="editor" />
        <BubbleMenu
            v-if="editor"
            class="outline-rich-text-menu-layer"
            :class="menuVisible ? '' : 'is-hidden'"
            :editor="editor"
            plugin-key="outline-rich-text-menu"
            :append-to="appendToThemeHost"
            :should-show="shouldShowMenu"
            :options="bubbleOptions"
            :update-delay="80"
            :resize-delay="80"
        >
            <div class="outline-rich-text-menu" @mousedown.prevent>
                <template v-if="!selectionEmpty">
                    <div class="menu-row">
                        <button type="button" class="menu-button is-icon" :class="{'is-active': active('bold')}" :disabled="Boolean(formatBlocked)" :title="formatBlocked ?? '加粗'" aria-label="加粗" @click="toggleFormat('bold')">
                            <span class="i-lucide-bold"></span>
                        </button>
                        <button type="button" class="menu-button is-icon" :class="{'is-active': active('italic')}" :disabled="Boolean(formatBlocked)" :title="formatBlocked ?? '斜体'" aria-label="斜体" @click="toggleFormat('italic')">
                            <span class="i-lucide-italic"></span>
                        </button>
                        <template v-if="creatable.length">
                            <span class="menu-divider"></span>
                            <button v-if="creatable.includes('guidance')" type="button" class="menu-button" @click="addAnchor('guidance')">
                                <span class="i-lucide-message-square-text"></span>写作指导
                            </button>
                            <button v-if="creatable.includes('reference')" type="button" class="menu-button" @click="addAnchor('reference')">
                                <span class="i-lucide-book-marked"></span>段落参考
                            </button>
                            <button v-if="creatable.includes('foreshadow')" type="button" class="menu-button" :class="{'is-active': pickerOpen}" :aria-expanded="pickerOpen" @click="pickerOpen = !pickerOpen">
                                <span class="i-lucide-bookmark-plus"></span>伏笔<span class="i-lucide-chevron-down"></span>
                            </button>
                        </template>
                    </div>
                    <div v-if="pickerOpen" class="menu-picker" aria-label="选择伏笔">
                        <div class="menu-segment" role="radiogroup" aria-label="标记动作">
                            <button v-for="option in actionOptions" :key="option.value" type="button" role="radio" class="menu-button"
                                :class="{'is-active': pickerAction === option.value}" :aria-checked="pickerAction === option.value" @click="pickerAction = option.value">
                                {{ option.label }}
                            </button>
                        </div>
                        <p v-if="!props.foreshadowOptions.length" class="menu-hint">伏笔库还没有伏笔，先到伏笔库新建后再回来标记。</p>
                        <div v-else class="menu-list">
                            <button v-for="option in props.foreshadowOptions" :key="option.value" type="button" class="menu-list-item" @click="addForeshadow(option.value)">
                                {{ option.label }}
                            </button>
                        </div>
                    </div>
                </template>
                <template v-else>
                    <div v-for="range in cursorMarks" :key="`${range.kind}:${range.marker}`" class="menu-mark">
                        <div class="menu-row">
                            <span class="menu-mark-title" :class="`is-${range.kind}`">{{ markTitle(range) }}</span>
                            <template v-if="range.kind === 'foreshadow'">
                                <div class="menu-segment" role="radiogroup" aria-label="标记动作">
                                    <button v-for="option in actionOptions" :key="option.value" type="button" role="radio" class="menu-button"
                                        :class="{'is-active': range.attrs.action === option.value}" :aria-checked="range.attrs.action === option.value" @click="setAction(range.marker, option.value)">
                                        {{ option.label }}
                                    </button>
                                </div>
                                <button type="button" class="menu-button" :class="{'is-active': retargetMarker === range.marker}" :aria-expanded="retargetMarker === range.marker"
                                    @click="retargetMarker = retargetMarker === range.marker ? null : range.marker">
                                    换伏笔
                                </button>
                            </template>
                            <button v-else type="button" class="menu-button" @click="emit('focus-mark', range.kind, range.marker)">
                                <span class="i-lucide-pencil-line"></span>填写说明
                            </button>
                            <button type="button" class="menu-button is-icon" :title="`移除${markLabels[range.kind]}（保留文字）`" :aria-label="`移除${markLabels[range.kind]}`" @click="removeMark(range.kind, range.marker)">
                                <span class="i-lucide-x"></span>
                            </button>
                        </div>
                        <div v-if="range.kind === 'foreshadow' && retargetMarker === range.marker" class="menu-list">
                            <p v-if="!props.foreshadowOptions.length" class="menu-hint">伏笔库还没有伏笔。</p>
                            <button v-for="option in props.foreshadowOptions" :key="option.value" type="button" class="menu-list-item"
                                :class="{'is-active': range.attrs.foreshadowId === option.value}" @click="retarget(range.marker, option.value)">
                                {{ option.label }}
                            </button>
                        </div>
                    </div>
                </template>
                <p v-if="menuError" class="menu-error" role="alert">{{ menuError }}</p>
            </div>
        </BubbleMenu>
    </div>
</template>

<style scoped>
.outline-rich-text {
    border: 1px solid var(--border-color);
    border-radius: var(--radius-control);
    background: var(--bg-main);
    transition: border-color 0.15s ease;
}
.outline-rich-text:focus-within { border-color: var(--accent-main); }
.outline-rich-text.is-readonly { background: var(--bg-subtle); }

:deep(.outline-rich-text__content) {
    min-height: 9rem;
    padding: var(--space-4) var(--space-5);
    outline: none;
    color: var(--text-main);
    font-size: var(--text-sm);
    line-height: 1.75;
    white-space: pre-wrap;
    word-break: break-word;
}
:deep(.outline-rich-text__content > * + *) { margin-top: 0.6em; }
:deep(.outline-rich-text__content p) { margin: 0; }
:deep(.outline-rich-text__content h1),
:deep(.outline-rich-text__content h2),
:deep(.outline-rich-text__content h3),
:deep(.outline-rich-text__content h4) { margin: 0.9em 0 0.3em; font-weight: var(--weight-strong); line-height: 1.35; }
:deep(.outline-rich-text__content > :first-child) { margin-top: 0; }
:deep(.outline-rich-text__content h1) { font-size: 1.4em; }
:deep(.outline-rich-text__content h2) { font-size: 1.22em; }
:deep(.outline-rich-text__content h3) { font-size: 1.08em; }
:deep(.outline-rich-text__content ul),
:deep(.outline-rich-text__content ol) { margin-block: 0.3em; padding-left: 1.5em; white-space: normal; }
:deep(.outline-rich-text__content ul) { list-style: disc; }
:deep(.outline-rich-text__content ol) { list-style: decimal; }
:deep(.outline-rich-text__content li > p) { white-space: pre-wrap; }
:deep(.outline-rich-text__content blockquote) { margin-inline: 0; border-left: 3px solid var(--border-color); padding-left: var(--space-4); color: var(--text-secondary); }
:deep(.outline-rich-text__content strong) { font-weight: 700; }
:deep(.outline-rich-text__content em) { font-style: italic; }
:deep(.outline-rich-text__content p.is-editor-empty:first-child::before) {
    content: attr(data-placeholder);
    float: left;
    height: 0;
    pointer-events: none;
    color: var(--text-muted);
}

:deep(.nb-foreshadow-marker) {
    border-radius: 3px;
    text-decoration-line: underline;
    text-decoration-style: solid;
    text-decoration-thickness: 2px;
    text-underline-offset: 3px;
}
:deep(.nb-foreshadow-marker--plant) { text-decoration-color: var(--status-success); }
:deep(.nb-foreshadow-marker--reinforce) { text-decoration-color: var(--status-warning); }
:deep(.nb-foreshadow-marker--recover) { text-decoration-color: var(--accent-main); }
:deep(.nb-outline-anchor--guidance) {
    border-radius: 3px;
    background: color-mix(in srgb, var(--status-info) 12%, transparent);
}
:deep(.nb-outline-anchor--reference) {
    text-decoration-line: underline;
    text-decoration-style: dotted;
    text-decoration-thickness: 1.5px;
    text-decoration-color: color-mix(in srgb, var(--accent-main) 60%, transparent);
    text-underline-offset: 3px;
}

.outline-rich-text-menu-layer { z-index: 8500; pointer-events: auto; }
.outline-rich-text-menu-layer.is-hidden { display: none; }
.outline-rich-text-menu {
    display: grid;
    gap: 6px;
    max-width: min(26rem, calc(100vw - 20px));
    border: 1px solid color-mix(in srgb, var(--border-color) 82%, transparent);
    border-radius: 14px;
    background: color-mix(in srgb, var(--bg-panel) 96%, var(--bg-main));
    padding: 6px;
    color: var(--text-main);
    box-shadow: 0 18px 44px color-mix(in srgb, var(--shadow-color) 16%, transparent), 0 1px 2px color-mix(in srgb, var(--shadow-color) 14%, transparent);
}
.menu-row { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; }
.menu-divider { width: 1px; height: 18px; margin-inline: 4px; background: var(--border-color); }
.menu-button {
    display: inline-flex;
    height: 30px;
    align-items: center;
    justify-content: center;
    gap: 4px;
    border: 0;
    border-radius: 9px;
    background: transparent;
    padding: 0 8px;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    white-space: nowrap;
    transition: background-color 0.15s ease, color 0.15s ease;
}
.menu-button.is-icon { width: 30px; padding: 0; }
.menu-button:hover, .menu-button.is-active { background: var(--bg-hover); color: var(--text-main); }
.menu-button:disabled { cursor: default; opacity: 0.42; }
.menu-button:disabled:hover { background: transparent; color: var(--text-secondary); }
.menu-segment { display: inline-flex; gap: 2px; border-radius: 10px; background: color-mix(in srgb, var(--text-main) 5%, transparent); padding: 2px; }
.menu-segment .menu-button { height: 26px; }
.menu-picker { display: grid; gap: 6px; border-top: 1px solid var(--border-color); padding-top: 6px; }
.menu-list { display: grid; max-height: 12rem; gap: 2px; overflow-y: auto; }
.menu-list-item {
    border: 0;
    border-radius: 8px;
    background: transparent;
    padding: 6px 8px;
    color: var(--text-main);
    cursor: pointer;
    font-size: 13px;
    text-align: left;
}
.menu-list-item:hover, .menu-list-item.is-active { background: var(--bg-hover); }
.menu-mark + .menu-mark { border-top: 1px solid var(--border-color); padding-top: 6px; }
.menu-mark { display: grid; gap: 4px; }
.menu-mark-title { max-width: 12rem; overflow: hidden; padding: 0 6px; font-size: 12px; font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
.menu-mark-title.is-guidance { color: var(--status-info); }
.menu-mark-title.is-reference, .menu-mark-title.is-foreshadow { color: var(--accent-text); }
.menu-hint { margin: 0; padding: 4px 6px; color: var(--text-muted); font-size: 12px; }
.menu-error { margin: 0; padding: 2px 6px; color: var(--status-danger); font-size: 12px; }
</style>
