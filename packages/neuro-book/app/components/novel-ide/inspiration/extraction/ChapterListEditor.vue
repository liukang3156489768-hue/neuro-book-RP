<script setup lang="ts">
import {computed, ref} from "vue";
import {Badge, Button, EmptyState, FormField, FormInput, Table, type TableColumn} from "@notnotype/nb-ui/components";
import type {ChapterCorrectionDto} from "nbook/shared/dto/inspiration-outline-structure.dto";
import ExtractionNotice from "nbook/app/components/novel-ide/inspiration/extraction/ExtractionNotice.vue";
import type {StructurePreview} from "nbook/app/utils/inspiration/extraction-api";
import {paragraphRange} from "nbook/app/utils/inspiration/extraction-labels";

type ChapterRow = {index: number; title: string; range: string; characterCount: string; headingParagraphId: string | null; last: boolean};

const props = withDefaults(defineProps<{
    preview: StructurePreview | null;
    corrections: readonly ChapterCorrectionDto[];
    loading?: boolean;
    error?: string;
    paragraphText?: (paragraphId: string) => string | null;
}>(), {loading: false, error: "", paragraphText: undefined});

const emit = defineEmits<{
    (event: "correct", correction: ChapterCorrectionDto): void;
    (event: "undo"): void;
    (event: "clear"): void;
}>();

const columns: TableColumn<ChapterRow>[] = [
    {key: "index", label: "序号", width: "56px"},
    {key: "title", label: "标题"},
    {key: "range", label: "P 范围", width: "120px"},
    {key: "characterCount", label: "字数", width: "88px", align: "right"},
    {key: "headingParagraphId", label: "操作", width: "220px"},
];

const paragraphInput = ref("");
const titleInput = ref("");

const chapterMode = computed(() => props.preview?.mode === "chapters");
const rows = computed<ChapterRow[]>(() => {
    const preview = props.preview;
    if (!preview) return [];
    if (preview.mode === "chunks") {
        return preview.chapters.map(chunk => ({
            index: chunk.index, title: chunk.title, range: paragraphRange(chunk.firstParagraphId, chunk.lastParagraphId),
            characterCount: String(chunk.characterCount), headingParagraphId: null, last: true,
        }));
    }
    const chapters = preview.recognition.chapters;
    return chapters.map((chapter, position) => ({
        index: chapter.index, title: chapter.title || "（章前文字）", range: paragraphRange(chapter.firstParagraphId, chapter.lastParagraphId),
        characterCount: String(chapter.characterCount), headingParagraphId: chapter.headingParagraphId, last: position === chapters.length - 1,
    }));
});

/** 接受 `P12` 或 `12`，统一成 `P12`；格式不对返回 null。 */
const paragraphId = computed(() => {
    const matched = /^p?\s*([1-9]\d*)$/iu.exec(paragraphInput.value.trim());
    return matched ? `P${matched[1]}` : null;
});
const paragraphPreview = computed(() => paragraphId.value ? props.paragraphText?.(paragraphId.value) ?? null : null);
const paragraphProblem = computed(() => {
    if (!paragraphInput.value.trim()) return "";
    if (!paragraphId.value) return "段落编号写成 P12 或 12 的形式。";
    if (props.paragraphText && paragraphPreview.value === null) return `来源里没有 ${paragraphId.value} 这一段。`;
    return "";
});
const canSubmit = computed(() => Boolean(paragraphId.value) && !paragraphProblem.value && !props.loading);

function describe(correction: ChapterCorrectionDto): string {
    if (correction.kind === "set-heading") return `把 ${correction.paragraphId} 设为章标题${correction.title ? `“${correction.title}”` : ""}`;
    if (correction.kind === "unset-heading") return `取消 ${correction.paragraphId} 的章标题`;
    if (correction.kind === "merge") return `合并第 ${correction.chapterIndex} 章与下一章`;
    return `在 ${correction.paragraphId} 处拆分章节${correction.title ? `“${correction.title}”` : ""}`;
}

function submit(kind: "set-heading" | "split"): void {
    if (!canSubmit.value || !paragraphId.value) return;
    const title = titleInput.value.trim();
    emit("correct", {kind, paragraphId: paragraphId.value, ...(title ? {title} : {})});
    paragraphInput.value = "";
    titleInput.value = "";
}

function unsetHeading(paragraph: string | null): void {
    if (paragraph) emit("correct", {kind: "unset-heading", paragraphId: paragraph});
}
</script>

<template>
    <section class="chapter-editor" aria-label="章节列表">
        <EmptyState v-if="!props.preview" icon-class="i-lucide-list-tree" title="选择来源后显示章节" />
        <template v-else>
            <div class="summary">
                <Badge tone="accent" variant="soft">{{ chapterMode ? `${props.preview.recognition.chapters.length} 章` : `${props.preview.chapters.length} 块` }}</Badge>
                <Badge v-if="props.preview.recognition.volumeHeadings.length" tone="neutral" variant="soft">{{ props.preview.recognition.volumeHeadings.length }} 个卷标题行</Badge>
                <span v-if="!chapterMode" class="summary-hint">没有识别到章节标题，已按字数切块；可以用下方“设为章标题”补出章节。</span>
            </div>
            <div class="table-scroll">
                <Table :columns="columns" :rows="rows" row-key="index" density="compact" empty-text="没有可显示的章节">
                    <template #cell-headingParagraphId="{row}">
                        <div v-if="chapterMode" class="row-actions">
                            <Button size="sm" variant="ghost" :disabled="!row.headingParagraphId || props.loading" @click="unsetHeading(row.headingParagraphId)">取消章标题</Button>
                            <Button size="sm" variant="ghost" :disabled="row.last || props.loading" @click="emit('correct', {kind: 'merge', chapterIndex: row.index})">与下一章合并</Button>
                        </div>
                    </template>
                </Table>
            </div>
            <div class="correction-form">
                <FormField label="段落编号" :error="paragraphProblem" class="form-cell">
                    <FormInput v-model="paragraphInput" placeholder="例如 P12" />
                </FormField>
                <FormField label="章标题（可选）" class="form-cell">
                    <FormInput v-model="titleInput" placeholder="留空则沿用段落原文" />
                </FormField>
                <div class="form-buttons">
                    <Button variant="secondary" :disabled="!canSubmit" @click="submit('set-heading')">设为章标题</Button>
                    <Button variant="secondary" :disabled="!canSubmit" @click="submit('split')">在此拆分</Button>
                </div>
            </div>
            <p v-if="paragraphPreview" class="paragraph-preview">{{ paragraphPreview.trim().slice(0, 120) }}</p>
            <ExtractionNotice v-if="props.error" tone="danger">{{ props.error }}</ExtractionNotice>
            <div v-if="props.corrections.length" class="history">
                <div class="history-head">
                    <strong>已做 {{ props.corrections.length }} 项修正</strong>
                    <span class="history-actions">
                        <Button size="sm" variant="ghost" :disabled="props.loading" @click="emit('undo')">撤销上一项</Button>
                        <Button size="sm" variant="ghost" :disabled="props.loading" @click="emit('clear')">全部还原</Button>
                    </span>
                </div>
                <ol class="history-list">
                    <li v-for="(correction, position) in props.corrections" :key="position">{{ describe(correction) }}</li>
                </ol>
            </div>
        </template>
    </section>
</template>

<style scoped>
.chapter-editor {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
}

.summary {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
}

.summary-hint {
    color: var(--text-muted);
    font-size: var(--text-xs);
}

.table-scroll {
    overflow-x: auto;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-control);
    background: var(--bg-panel);
}

.table-scroll :deep(td:nth-child(3)), .table-scroll :deep(th:nth-child(3)) { white-space: nowrap; }

.row-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
}

.correction-form {
    display: flex;
    align-items: flex-start;
    flex-wrap: wrap;
    gap: var(--space-2);
}

.form-cell {
    flex: 1 1 180px;
    min-width: 0;
}

.form-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-self: flex-end;
}

.paragraph-preview {
    margin: 0;
    padding-left: var(--space-3);
    border-left: 2px solid var(--accent-main);
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: 1.6;
    overflow-wrap: anywhere;
}

.history {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font-size: var(--text-xs);
}

.history-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--space-2);
}

.history-list {
    margin: 0;
    padding-left: var(--space-5);
    color: var(--text-secondary);
}
</style>
