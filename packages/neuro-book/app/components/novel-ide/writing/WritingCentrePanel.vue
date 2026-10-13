<script setup lang="ts">
import {computed, ref, watch} from "vue";
import {Badge, Button, EmptyState, IconButton} from "@notnotype/nb-ui/components";
import OutlineEntryForm from "nbook/app/components/novel-ide/outline/OutlineEntryForm.vue";
import type {WritingChapterDto, WritingEntryDto} from "nbook/shared/dto/writing.dto";
import {entryHasHandoffMetadata, entryToForm, type OutlineEntryFormValue} from "nbook/app/utils/outline/outline-entry-form";
import {chapterBlockReasons} from "nbook/app/utils/writing/writing-tree";

const props = defineProps<{
    view:
        | Readonly<{kind: "entry"; entryId: string; entry: WritingEntryDto | null; loading: boolean; error: string | null}>
        | Readonly<{kind: "empty-prose"; chapter: WritingChapterDto}>;
}>();
const emit = defineEmits<{
    "open-outline": [entryId: string];
    "start-writing": [chapterEntryId: string];
    retry: [entryId: string];
    close: [];
}>();

const KIND_LABELS: Record<WritingEntryDto["kind"], string> = {total: "总纲", volume: "卷纲", chapter: "章节大纲", detail: "细纲"};

const entry = computed(() => (props.view.kind === "entry" ? props.view.entry : null));
/** 表单要求 v-model；只读显示时这份副本只随条目更新，不会被改动。 */
const form = ref<OutlineEntryFormValue | null>(null);
watch(entry, (value) => { form.value = value ? entryToForm(value) : null; }, {immediate: true});

const outlineTarget = computed(() => (props.view.kind === "entry" ? props.view.entryId : props.view.chapter.entryId));
const title = computed(() => {
    if (props.view.kind === "empty-prose") return props.view.chapter.title;
    return entry.value?.title ?? "";
});
const kindLabel = computed(() => (props.view.kind === "empty-prose" ? "正文" : entry.value ? KIND_LABELS[entry.value.kind] : ""));
const blockReasons = computed(() => (props.view.kind === "empty-prose" ? chapterBlockReasons(props.view.chapter) : []));
</script>

<template>
    <section class="writing-centre-panel" :aria-label="title || '大纲条目'">
        <header class="centre-header">
            <Badge v-if="kindLabel" size="sm" variant="soft">{{ kindLabel }}</Badge>
            <strong class="centre-title">{{ title }}</strong>
            <div class="centre-actions">
                <Button size="sm" variant="secondary" icon-class="i-lucide-square-arrow-out-up-right" @click="emit('open-outline', outlineTarget)">
                    在大纲工作台中打开
                </Button>
                <IconButton size="sm" title="关闭" aria-label="关闭" icon-class="i-lucide-x" @click="emit('close')" />
            </div>
        </header>

        <div class="centre-body">
            <template v-if="props.view.kind === 'entry'">
                <div v-if="props.view.error" class="centre-error" role="alert">
                    <span class="i-lucide-circle-alert"></span><span>{{ props.view.error }}</span>
                    <Button size="sm" variant="ghost" @click="emit('retry', props.view.entryId)">重试</Button>
                </div>
                <p v-else-if="!form" class="centre-loading" role="status" aria-busy="true">正在载入…</p>
                <OutlineEntryForm
                    v-if="form && entry"
                    v-model="form"
                    readonly
                    :with-metadata="entryHasHandoffMetadata(entry.kind)"
                    :annotations="entry.kind === 'detail' ? 'detail' : 'none'"
                />
            </template>

            <EmptyState
                v-else
                class="centre-empty"
                icon-class="i-lucide-file-pen-line"
                title="这一章还没有正文"
                :description="props.view.chapter.writable ? '让主创按细纲把这一章写出来。' : `暂不能写作：${blockReasons.join('、')}`"
            >
                <template v-if="props.view.chapter.writable" #action>
                    <Button size="sm" variant="primary" icon-class="i-lucide-feather" @click="emit('start-writing', props.view.chapter.entryId)">开始写作</Button>
                </template>
            </EmptyState>
        </div>
    </section>
</template>

<style scoped>
.writing-centre-panel { display: flex; height: 100%; min-height: 0; min-width: 0; flex-direction: column; background: var(--bg-main); }
.centre-header { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); border-bottom: 1px solid var(--border-color); padding: var(--space-3) var(--space-5); }
.centre-title { min-width: 0; flex: 1 1 160px; overflow-wrap: anywhere; font-size: var(--text-sm); font-weight: var(--weight-strong); }
.centre-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin-left: auto; }
.centre-body { display: flex; min-height: 0; flex: 1; flex-direction: column; overflow-x: hidden; overflow-y: auto; padding: var(--space-5); }
.centre-body > :deep(*) { width: 100%; max-width: 880px; margin-inline: auto; }
.centre-loading { color: var(--text-muted); font-size: var(--text-xs); text-align: center; }
.centre-error { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); border: 1px solid var(--status-danger-border); border-radius: var(--radius-control); background: var(--status-danger-bg); padding: var(--space-2) var(--space-4); color: var(--status-danger); font-size: var(--text-xs); }
.centre-error > span:nth-child(2) { min-width: 0; flex: 1; }
.centre-empty { margin: auto; }
</style>
