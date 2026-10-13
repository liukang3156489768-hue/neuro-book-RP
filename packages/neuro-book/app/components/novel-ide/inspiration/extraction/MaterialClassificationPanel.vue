<script setup lang="ts">
import {computed, ref, watch} from "vue";
import {Badge, Button, EmptyState, FormCheckbox} from "@notnotype/nb-ui/components";
import type {ClassificationView} from "nbook/app/utils/inspiration/extraction-api";
import ExtractionNotice from "nbook/app/components/novel-ide/inspiration/extraction/ExtractionNotice.vue";
import type {MaterialParagraphReference} from "nbook/shared/dto/inspiration-material.dto";

type ClassificationGroup = {category: string; folders: string[]};

const props = withDefaults(defineProps<{
    classification: ClassificationView;
    busy?: boolean;
}>(), {busy: false});

const emit = defineEmits<{
    (event: "submit", groups: ClassificationGroup[]): void;
    (event: "skip"): void;
}>();

/**
 * 选择状态使用结构化编码，不能用 `category/folder` 再按斜杠拆分：模型生成的文件夹 key
 * 可能包含斜杠，字符串拼接会让第二次合并时把一个文件夹误拆成多个字段。
 */
const token = (category: string, folder: string): string => JSON.stringify([category, folder]);

const checked = ref<Set<string>>(new Set());
const groups = ref<ClassificationGroup[]>([]);
const expanded = ref<Set<string>>(new Set());
// 轮询会不断创建新的 classification 对象；只有实体结构真的变化时才清空选择。
const classificationSignature = computed(() => JSON.stringify(props.classification.categories.map(category => [
    category.category,
    category.folders.map(folder => folder.key),
])));
watch(classificationSignature, () => {
    checked.value = new Set();
    groups.value = [];
    expanded.value = new Set();
});

const grouped = computed(() => new Set(groups.value.flatMap(group => group.folders.map(folder => token(group.category, folder)))));
const nameOf = computed(() => {
    const names = new Map<string, string>();
    for (const category of props.classification.categories) {
        for (const folder of category.folders) names.set(token(category.category, folder.key), folder.name);
    }
    return names;
});
const labelOf = computed(() => new Map(props.classification.categories.map(category => [category.category, category.label])));

const selection = computed(() => [...checked.value].flatMap(item => {
    try {
        const parsed: unknown = JSON.parse(item);
        if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") return [];
        return [{category: parsed[0], folder: parsed[1]}];
    } catch {
        // 旧状态或异常数据不能让整个归类面板崩溃；丢弃这一个无效选择即可。
        return [];
    }
}));
const mergeProblem = computed(() => {
    if (selection.value.length < 2) return "至少勾选两个文件夹才能合并。";
    if (new Set(selection.value.map(item => item.category)).size > 1) return "只能合并同一类别的文件夹。";
    return "";
});

function setChecked(category: string, folder: string, value: boolean | "indeterminate"): void {
    const next = new Set(checked.value);
    if (value === true) next.add(token(category, folder));
    else next.delete(token(category, folder));
    checked.value = next;
}

function selectCandidate(category: string, folders: readonly string[]): void {
    checked.value = new Set(folders.filter(folder => !grouped.value.has(token(category, folder))).map(folder => token(category, folder)));
}

function mergeSelected(): void {
    const selected = selection.value;
    if (selected.length < 2 || mergeProblem.value) return;
    const first = selected[0];
    if (!first) return;
    const folders = [...new Set(selected.filter(item => item.category === first.category).map(item => item.folder))];
    if (folders.length < 2) return;
    groups.value = [...groups.value, {category: first.category, folders}];
    checked.value = new Set();
}

function ungroup(position: number): void {
    groups.value = groups.value.filter((_, index) => index !== position);
}

function describeFolders(category: string, folders: readonly string[]): string {
    return folders.map(folder => nameOf.value.get(token(category, folder)) ?? folder).join("、");
}

function toggleDetails(category: string, folder: string): void {
    const next = new Set(expanded.value);
    const key = token(category, folder);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expanded.value = next;
}

function referenceText(citations: readonly MaterialParagraphReference[]): string {
    return citations.map(({firstParagraphId, lastParagraphId}) => firstParagraphId === lastParagraphId ? firstParagraphId : `${firstParagraphId}-${lastParagraphId}`).join("、");
}

const roleLabels = {main: "基本设定", experience: "经历", relationship: "人际关系"} as const;
</script>

<template>
    <section class="classification" aria-label="实体归类">
        <p class="intro">同一个实体可能被记成了几个文件夹。勾选同类别的几个再点“合并所选”即可归为一个；疑似同一实体的候选只做提示，不会自动合并。</p>
        <EmptyState v-if="!props.classification.categories.length" icon-class="i-lucide-folder-tree" title="没有需要归类的实体" />
        <template v-else>
            <ul v-if="props.classification.candidates.length" class="candidate-list" aria-label="疑似同一实体">
                <li v-for="(candidate, position) in props.classification.candidates" :key="position" class="candidate">
                    <Badge tone="warning" variant="soft" size="sm">{{ labelOf.get(candidate.category) ?? candidate.category }}</Badge>
                    <span class="candidate-text">{{ describeFolders(candidate.category, candidate.folders) }}（{{ candidate.reason }}）</span>
                    <Button size="sm" variant="ghost" :disabled="props.busy" @click="selectCandidate(candidate.category, candidate.folders)">选中这几项</Button>
                </li>
            </ul>
            <div v-for="category in props.classification.categories" :key="category.category" class="category">
                <h4 class="category-title">{{ category.label }}（{{ category.folders.length }}）</h4>
                <div class="folder-list">
                    <div v-for="folder in category.folders" :key="folder.key" class="folder">
                        <div class="folder-main">
                            <FormCheckbox
                                class="folder-checkbox"
                                :model-value="checked.has(token(category.category, folder.key))" :disabled="props.busy || grouped.has(token(category.category, folder.key))"
                                :label="folder.name"
                                :description="[folder.aliases.length ? `别称：${folder.aliases.join('、')}` : '', folder.blocks.length ? `出现在第 ${folder.blocks.join('、')} 块` : '', grouped.has(token(category.category, folder.key)) ? '已并入分组' : ''].filter(Boolean).join(' · ') || undefined"
                                @update:model-value="setChecked(category.category, folder.key, $event)"
                            />
                            <Button size="sm" variant="ghost" class="detail-trigger" :aria-expanded="expanded.has(token(category.category, folder.key))" :aria-label="`${expanded.has(token(category.category, folder.key)) ? '收起' : '查看'}${folder.name}详情`" @click.stop="toggleDetails(category.category, folder.key)">
                                {{ expanded.has(token(category.category, folder.key)) ? "收起详情" : "查看详情" }}
                            </Button>
                        </div>
                        <div v-if="expanded.has(token(category.category, folder.key))" class="folder-details">
                            <template v-if="folder.preview?.fragments.length">
                                <section v-for="(fragment, position) in folder.preview.fragments" :key="position" class="preview-fragment" :aria-label="`第 ${fragment.block} 块${roleLabels[fragment.role]}`">
                                    <h5>第 {{ fragment.block }} 块 · {{ roleLabels[fragment.role] }}</h5>
                                    <dl class="preview-fields">
                                        <template v-for="(value, label) in fragment.fields" :key="label">
                                            <dt>{{ label }}</dt><dd>{{ value }}</dd>
                                        </template>
                                    </dl>
                                    <p v-if="fragment.citations.length" class="preview-citations">来源：{{ referenceText(fragment.citations) }}</p>
                                </section>
                            </template>
                            <p v-else class="empty-detail">暂无可展示的提取详情。</p>
                        </div>
                    </div>
                </div>
            </div>
            <div v-if="groups.length" class="group-block">
                <strong>已建立 {{ groups.length }} 个分组</strong>
                <ul class="group-list">
                    <li v-for="(group, position) in groups" :key="position" class="group-row">
                        <Badge tone="accent" variant="soft" size="sm">{{ labelOf.get(group.category) ?? group.category }}</Badge>
                        <span class="candidate-text">{{ describeFolders(group.category, group.folders) }}</span>
                        <Button size="sm" variant="ghost" :disabled="props.busy" @click="ungroup(position)">拆开</Button>
                    </li>
                </ul>
            </div>
            <ExtractionNotice v-if="checked.size" tone="info">已勾选 {{ checked.size }} 项。{{ mergeProblem }}</ExtractionNotice>
        </template>
        <div class="actions">
            <Button variant="secondary" :disabled="props.busy || Boolean(mergeProblem)" @click="mergeSelected()">合并所选</Button>
            <Button variant="primary" :loading="props.busy" @click="emit('submit', groups)">确认归类并继续</Button>
            <Button variant="ghost" :disabled="props.busy" @click="emit('skip')">跳过归类</Button>
        </div>
    </section>
</template>

<style scoped>
.classification {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
}

.intro {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-xs);
    line-height: 1.6;
}

.candidate-list,
.group-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin: 0;
    padding: 0;
    list-style: none;
}

.candidate,
.group-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-control);
    background: var(--bg-panel);
    font-size: var(--text-xs);
}

.candidate-text {
    flex: 1 1 160px;
    min-width: 0;
    color: var(--text-main);
    overflow-wrap: anywhere;
}

.category-title {
    margin: 0 0 var(--space-1);
    color: var(--text-main);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
}

.folder-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    max-height: 220px;
    padding: var(--space-2) var(--space-3);
    overflow: auto;
    overscroll-behavior: contain;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-control);
    background: var(--bg-panel);
}

.folder {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
}

.folder-main {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
}

.folder-checkbox {
    flex: 1 1 auto;
    min-width: 0;
}

.folder-checkbox :deep(span) {
    min-width: 0;
    overflow-wrap: anywhere;
}

.detail-trigger {
    flex: 0 0 auto;
}

.folder-details {
    margin: 0 0 var(--space-1) var(--space-6);
    padding: var(--space-2) var(--space-3);
    border-left: var(--border-w) solid var(--divider);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    line-height: 1.55;
}

.preview-fields {
    display: grid;
    grid-template-columns: minmax(4em, max-content) minmax(0, 1fr);
    gap: var(--space-1) var(--space-2);
    margin: 0;
}

.preview-fields dt {
    color: var(--text-main);
    font-weight: var(--weight-medium);
}

.preview-fields dd {
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
}

.preview-fragment + .preview-fragment {
    margin-top: var(--space-3);
}

.preview-fragment h5 {
    margin: 0 0 var(--space-2);
    color: var(--text-main);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
}

.preview-citations,
.empty-detail {
    margin: var(--space-2) 0 0;
}

.group-block {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    color: var(--text-main);
    font-size: var(--text-sm);
}

.actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
}
</style>
