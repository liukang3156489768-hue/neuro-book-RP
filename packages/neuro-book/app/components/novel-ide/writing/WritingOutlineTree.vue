<script setup lang="ts">
import {computed, ref} from "vue";
import {Badge, Button} from "@notnotype/nb-ui/components";
import FormSelect from "nbook/app/components/common/form/FormSelect.vue";
import type {WritingChapterDto, WritingChapterIssuesDto, WritingIssueDto, WritingUnlinkedProseDto} from "nbook/shared/dto/writing.dto";
import {
    chapterBlockReasons, chapterStatusLabel, chapterStatusTone, issueBadge, selectionKey, unlinkedReasonLabel,
    type WritingSelection, type WritingVolumeGroup,
} from "nbook/app/utils/writing/writing-tree";

const props = withDefaults(defineProps<{
    /** null 表示还没有可用的写作方案，此时只显示未关联正文 */
    groups: readonly WritingVolumeGroup[] | null;
    unlinked: readonly WritingUnlinkedProseDto[];
    linkTargets: readonly {value: string; label: string}[];
    issues: ReadonlyMap<string, WritingChapterIssuesDto>;
    selectedKey: string | null;
    collapsedVolumes: ReadonlySet<string>;
    expandedChapters: ReadonlySet<string>;
    runningChapters: ReadonlySet<string>;
    pending?: boolean;
}>(), {pending: false});
const emit = defineEmits<{
    select: [selection: WritingSelection];
    "toggle-volume": [key: string];
    "toggle-chapter": [entryId: string];
    link: [path: string, chapterEntryId: string];
    unlink: [path: string];
    "ignore-issue": [chapterEntryId: string, issueId: string];
    "open-outline": [entryId: string];
}>();

const UNLINKED_KEY = "unlinked";
const openIssues = ref(new Set<string>());
const linkChoice = ref<Record<string, string>>({});
const linkOptions = computed(() => props.linkTargets.map(({value, label}) => ({value, label})));

const isSelected = (selection: WritingSelection) => selectionKey(selection) === props.selectedKey;
const toneOf = (chapter: WritingChapterDto) => {
    const tone = chapterStatusTone(chapter.status);
    return tone === "muted" ? "neutral" : tone;
};

function selectChapter(chapter: WritingChapterDto): void {
    if (!props.expandedChapters.has(chapter.entryId)) emit("toggle-chapter", chapter.entryId);
    emit("select", {kind: "entry", entryId: chapter.entryId});
}

function toggleIssues(entryId: string): void {
    const next = new Set(openIssues.value);
    if (!next.delete(entryId)) next.add(entryId);
    openIssues.value = next;
}

function visibleIssues(entryId: string): WritingIssueDto[] {
    return (props.issues.get(entryId)?.issues ?? []).filter(({status}) => status === "open" || status === "pending-review");
}

function link(path: string): void {
    const target = linkChoice.value[path];
    if (target) emit("link", path, target);
}

/** 文件头里有 writing 字段才有东西可解除：格式错误的、或归属章节不在方案中的。 */
const canUnlink = (item: WritingUnlinkedProseDto) => item.reason === "invalid-link" || item.chapterEntryId !== undefined;
</script>

<template>
    <div class="writing-outline-tree">
        <p v-if="props.groups?.length === 0" class="tree-empty">这个写作方案里还没有章节。</p>

        <section v-for="group in props.groups ?? []" :key="group.key" class="tree-volume">
            <button type="button" class="volume-row nb-ui-focus-ring" :aria-expanded="!props.collapsedVolumes.has(group.key)"
                @click="emit('toggle-volume', group.key)">
                <span :class="props.collapsedVolumes.has(group.key) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'"></span>
                <span class="row-title">{{ group.title }}</span>
                <span class="row-count">{{ group.chapters.length }} 章</span>
            </button>

            <ul v-if="!props.collapsedVolumes.has(group.key)" class="chapter-list">
                <li v-for="chapter in group.chapters" :key="chapter.entryId" class="chapter-item" :data-blocked="!chapter.writable">
                    <div class="chapter-row" :data-selected="isSelected({kind: 'entry', entryId: chapter.entryId})">
                        <button type="button" class="chevron nb-ui-focus-ring" :aria-expanded="props.expandedChapters.has(chapter.entryId)"
                            :aria-label="props.expandedChapters.has(chapter.entryId) ? `收起${chapter.title}` : `展开${chapter.title}`"
                            @click="emit('toggle-chapter', chapter.entryId)">
                            <span :class="props.expandedChapters.has(chapter.entryId) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"></span>
                        </button>
                        <button type="button" class="chapter-main nb-ui-focus-ring" @click="selectChapter(chapter)">
                            <span class="row-title">{{ chapter.title }}</span>
                            <span v-if="!chapter.writable" class="block-reason">{{ chapterBlockReasons(chapter).join("、") }}</span>
                        </button>
                        <div class="chapter-marks">
                            <span v-if="props.runningChapters.has(chapter.entryId)" class="running-mark" title="写作进行中">
                                <span class="i-lucide-loader-circle animate-spin"></span>写作中
                            </span>
                            <Badge v-if="chapter.writable" size="sm" variant="soft" :tone="toneOf(chapter)">{{ chapterStatusLabel(chapter.status) }}</Badge>
                            <button v-if="issueBadge(props.issues.get(chapter.entryId))" type="button" class="issue-badge nb-ui-focus-ring"
                                :data-severity="issueBadge(props.issues.get(chapter.entryId))!.severity"
                                :aria-expanded="openIssues.has(chapter.entryId)"
                                :aria-label="`${issueBadge(props.issues.get(chapter.entryId))!.count} 个问题`"
                                @click="toggleIssues(chapter.entryId)">
                                <span class="i-lucide-triangle-alert"></span>{{ issueBadge(props.issues.get(chapter.entryId))!.count }}
                            </button>
                        </div>
                    </div>

                    <ul v-if="openIssues.has(chapter.entryId)" class="issue-list" :aria-label="`${chapter.title}的问题`">
                        <li v-for="issue in visibleIssues(chapter.entryId)" :key="issue.id" class="issue-item">
                            <div class="issue-head">
                                <Badge size="sm" variant="soft" :tone="issue.severity === 'blocking' ? 'danger' : 'warning'">
                                    {{ issue.severity === "blocking" ? "阻断" : "提示" }}
                                </Badge>
                                <span v-if="issue.status === 'pending-review'" class="issue-status">待复核</span>
                            </div>
                            <p class="issue-message">{{ issue.message }}</p>
                            <div class="row-actions">
                                <Button size="sm" variant="ghost" @click="emit('open-outline', issue.location.entryId ?? chapter.entryId)">在大纲工作台中打开</Button>
                                <Button size="sm" variant="ghost" :disabled="props.pending"
                                    @click="emit('ignore-issue', chapter.entryId, issue.id)">忽略</Button>
                            </div>
                        </li>
                    </ul>

                    <ul v-if="props.expandedChapters.has(chapter.entryId)" class="child-list">
                        <li v-for="detail in chapter.details" :key="detail.entryId">
                            <button type="button" class="child-row nb-ui-focus-ring" :data-selected="isSelected({kind: 'entry', entryId: detail.entryId})"
                                @click="emit('select', {kind: 'entry', entryId: detail.entryId})">
                                <span class="i-lucide-list-tree"></span><span class="row-title">{{ detail.title }}</span>
                            </button>
                        </li>
                        <li v-if="chapter.prose.length === 0">
                            <button type="button" class="child-row nb-ui-focus-ring" data-empty="true"
                                :data-selected="isSelected({kind: 'empty-prose', chapterEntryId: chapter.entryId})"
                                @click="emit('select', {kind: 'empty-prose', chapterEntryId: chapter.entryId})">
                                <span class="i-lucide-file-plus"></span><span class="row-title">正文（未写）</span>
                            </button>
                        </li>
                        <li v-for="prose in chapter.prose" :key="prose.path" class="prose-item">
                            <button type="button" class="child-row nb-ui-focus-ring" :data-selected="isSelected({kind: 'prose', path: prose.path})"
                                @click="emit('select', {kind: 'prose', path: prose.path})">
                                <span class="i-lucide-file-text"></span>
                                <span class="row-title">{{ chapter.prose.length > 1 ? prose.title : "正文" }}</span>
                            </button>
                            <Button v-if="chapter.status === 'ownership-conflict'" size="sm" variant="ghost" :disabled="props.pending"
                                @click="emit('unlink', prose.path)">解除关联</Button>
                        </li>
                    </ul>
                </li>
            </ul>
        </section>

        <section v-if="props.unlinked.length" class="tree-volume">
            <button type="button" class="volume-row nb-ui-focus-ring" :aria-expanded="!props.collapsedVolumes.has(UNLINKED_KEY)"
                @click="emit('toggle-volume', UNLINKED_KEY)">
                <span :class="props.collapsedVolumes.has(UNLINKED_KEY) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'"></span>
                <span class="row-title">未关联正文</span>
                <span class="row-count">{{ props.unlinked.length }}</span>
            </button>
            <ul v-if="!props.collapsedVolumes.has(UNLINKED_KEY)" class="chapter-list">
                <li v-for="item in props.unlinked" :key="item.path" class="unlinked-item">
                    <button type="button" class="child-row nb-ui-focus-ring" :data-selected="isSelected({kind: 'unlinked', path: item.path})"
                        @click="emit('select', {kind: 'unlinked', path: item.path})">
                        <span class="i-lucide-file-question"></span><span class="row-title">{{ item.title }}</span>
                    </button>
                    <p class="unlinked-reason">{{ unlinkedReasonLabel(item.reason) }}<template v-if="item.message">：{{ item.message }}</template></p>
                    <div class="row-actions">
                        <FormSelect
                            class="link-select"
                            size="sm"
                            :model-value="linkChoice[item.path] ?? ''"
                            :options="linkOptions"
                            :placeholder="linkOptions.length ? '选择章节' : '没有尚无正文的章节'"
                            :disabled="props.pending || linkOptions.length === 0"
                            :aria-label="`${item.title}关联到的章节`"
                            @update:model-value="linkChoice = {...linkChoice, [item.path]: $event}"
                        />
                        <Button size="sm" variant="secondary" :disabled="props.pending || !linkChoice[item.path]" @click="link(item.path)">关联</Button>
                        <Button v-if="canUnlink(item)" size="sm" variant="ghost" :disabled="props.pending" @click="emit('unlink', item.path)">解除关联</Button>
                    </div>
                </li>
            </ul>
        </section>
    </div>
</template>

<style scoped>
.writing-outline-tree { display: grid; min-width: 0; gap: var(--space-2); font-size: var(--text-xs); line-height: var(--leading-ui); }
.tree-empty, .unlinked-reason { margin: 0; color: var(--text-muted); }
.tree-empty { padding: var(--space-4); text-align: center; }
.tree-volume { display: grid; gap: var(--space-1); }
.chapter-list, .child-list, .issue-list { display: grid; gap: 1px; margin: 0; padding: 0; list-style: none; }
.child-list { padding-left: var(--space-6); }
.volume-row, .child-row, .chapter-main, .chevron { border: 0; background: transparent; color: var(--text-main); cursor: pointer; text-align: left; }
.volume-row { display: flex; width: 100%; align-items: center; gap: var(--space-2); border-radius: var(--radius-control); padding: var(--space-2); color: var(--text-secondary); font-weight: var(--weight-strong); }
.volume-row:hover, .child-row:hover, .chapter-row:hover { background: var(--bg-hover); }
.row-title { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.row-count { color: var(--text-muted); font-size: var(--text-2xs); font-weight: normal; }
.chapter-row { display: flex; min-width: 0; align-items: flex-start; gap: var(--space-1); border-radius: var(--radius-control); padding: var(--space-1) var(--space-2) var(--space-1) var(--space-3); }
.chapter-row[data-selected="true"], .child-row[data-selected="true"] { background: var(--selection-bg); }
.chevron { display: flex; width: 20px; height: 22px; flex: 0 0 auto; align-items: center; justify-content: center; border-radius: var(--radius-control); color: var(--text-muted); }
.chapter-main { display: grid; min-width: 0; flex: 1; gap: 1px; border-radius: var(--radius-control); padding: 2px 0; }
.chapter-item[data-blocked="true"] .chapter-main .row-title { color: var(--text-muted); }
.block-reason { color: var(--status-warning); font-size: var(--text-2xs); }
.chapter-marks { display: flex; flex: 0 1 auto; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--space-1); padding-top: 2px; }
.running-mark { display: inline-flex; align-items: center; gap: 2px; color: var(--accent-text); font-size: var(--text-2xs); }
.issue-badge { display: inline-flex; align-items: center; gap: 2px; border: 1px solid var(--status-warning-border); border-radius: var(--radius-pill); background: var(--status-warning-bg); padding: 0 var(--space-2); color: var(--text-main); cursor: pointer; font-size: var(--text-2xs); }
.issue-badge[data-severity="blocking"] { border-color: var(--status-danger-border); background: var(--status-danger-bg); color: var(--status-danger); }
.issue-list { gap: var(--space-2); margin: var(--space-1) 0 var(--space-2) var(--space-6); }
.issue-item { display: grid; gap: var(--space-1); border-left: 2px solid var(--border-color); padding-left: var(--space-3); }
.issue-head { display: flex; align-items: center; gap: var(--space-2); }
.issue-status { color: var(--text-muted); font-size: var(--text-2xs); }
.issue-message { margin: 0; overflow-wrap: anywhere; }
.row-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.child-row { display: flex; width: 100%; min-width: 0; align-items: center; gap: var(--space-2); border-radius: var(--radius-control); padding: var(--space-1) var(--space-2); }
.child-row > span:first-child { flex: 0 0 auto; color: var(--text-muted); }
.child-row[data-empty="true"] { color: var(--text-muted); }
.prose-item { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1); }
.prose-item > .child-row { flex: 1 1 140px; }
.unlinked-item { display: grid; gap: var(--space-1); padding: var(--space-1) var(--space-2) var(--space-2) var(--space-3); }
.unlinked-reason { font-size: var(--text-2xs); }
.link-select { min-width: 0; flex: 1 1 140px; }
</style>
