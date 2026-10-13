<script setup lang="ts">
import {computed, ref, watch} from "vue";
import {Button, FormCheckbox, FormField, FormInput, FormTextarea, IconButton, TagInput} from "@notnotype/nb-ui/components";
import OutlineRichTextEditor from "nbook/app/components/novel-ide/outline/OutlineRichTextEditor.vue";
import type {OutlineRichTextAnnotations} from "nbook/app/components/novel-ide/outline/outline-rich-text";
import type {ChapterForeshadowMarker} from "nbook/app/utils/outline/chapter-foreshadow-markers";
import type {OutlineEntryFormValue} from "nbook/app/utils/outline/outline-entry-form";
import {analyzeDetailStructure, detailTemplate, FORBIDDEN_HEADING, sceneTemplate} from "nbook/shared/outline-detail-structure";

const props = withDefaults(defineProps<{
    withMetadata: boolean;
    readonly?: boolean;
    /** 细纲按正文模板检查结构，章节大纲可加伏笔标记 */
    annotations?: OutlineRichTextAnnotations;
    foreshadowOptions?: readonly Readonly<{value: string; label: string}>[];
    /** 细纲所属章节大纲里的伏笔标记，用来检查场景伏笔的标记与状态 */
    chapterMarkers?: readonly ChapterForeshadowMarker[];
}>(), {readonly: false, annotations: "none", foreshadowOptions: () => [], chapterMarkers: () => []});
const emit = defineEmits<{
    /** 焦点离开整个表单，宿主据此立即保存 */
    commit: [];
}>();
const form = defineModel<OutlineEntryFormValue>({required: true});
const materialUpdateLabels = {experience: "改编中的新经历", relationship: "改编中的新人际关系", item: "物品改编信息", location: "地点改编信息"} as const;

watch(() => [form.value, form.value.body] as const, ([current, body], [previous, previousBody]) => {
    // 切换条目的整体加载已经过服务端确认；只对当前草稿的正文改动重新要求核对。
    if (current === previous && body !== previousBody && current.materialUpdates?.length) current.materialUpdatesReviewed = false;
}, {flush: "sync"});

const root = ref<HTMLElement | null>(null);
const editor = ref<InstanceType<typeof OutlineRichTextEditor> | null>(null);
const detail = computed(() => props.annotations === "detail");
const bodyHint = computed(() => {
    if (props.readonly) return undefined;
    if (detail.value) return "细纲按模板写在正文里：章节总览、章节细纲（每个场景一个「## 场景N：名称」）和禁止事项。";
    if (props.annotations === "chapter") return "选中文字，在浮动菜单里标记伏笔的埋设、强化或回收；章节大纲正式采用后，标记才计入伏笔状态。";
    return undefined;
});

const structure = computed(() => detail.value && form.value.body.trim() !== ""
    ? analyzeDetailStructure(form.value, {chapterMarkers: new Map(props.chapterMarkers.map(({marker, action}) => [marker, action]))})
    : null);
const problems = computed(() => structure.value?.problems ?? []);
const markerHint = computed(() => props.chapterMarkers.map(({marker, action, text}) =>
    `${marker}（${action === "plant" ? "埋设" : action === "reinforce" ? "强化" : "回收"}）：${text}`));

function insertTemplate(): void {
    form.value.body = detailTemplate(form.value.title.trim());
}

/** 新场景放在禁止事项之前；没有禁止事项时接在正文末尾。 */
function insertScene(): void {
    const body = form.value.body.replace(/\s*$/u, "");
    const scene = sceneTemplate((structure.value?.scenes.length ?? 0) + 1);
    const forbidden = new RegExp(`^#[ \\t]+${FORBIDDEN_HEADING}[ \\t]*$`, "mu").exec(body);
    form.value.body = forbidden
        ? `${body.slice(0, forbidden.index).replace(/\s*$/u, "")}\n\n${scene}\n${body.slice(forbidden.index)}\n`
        : `${body}\n\n${scene}`;
}

function onFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget as Node | null;
    // 浮动菜单挂在主题宿主上，不在表单里；点菜单不算离开表单。
    if (next && (root.value?.contains(next) || (next as Element).closest?.(".outline-rich-text-menu-layer"))) return;
    emit("commit");
}

function addReference(): void {
    form.value.references.push({path: "", locator: "", purpose: "", pending: false});
}
function removeReference(index: number): void {
    form.value.references.splice(index, 1);
}
function removeMaterialUpdate(index: number): void {
    form.value.materialUpdates?.splice(index, 1);
}

defineExpose({
    focusTitle(): void {
        const input = root.value?.querySelector<HTMLInputElement>(".entry-title input");
        input?.focus();
        input?.select();
    },
    focusBody(): void {
        editor.value?.focus();
    },
});
</script>

<template>
    <div ref="root" class="entry-form" @focusout="onFocusOut">
        <FormField label="标题" required class="entry-title">
            <FormInput v-model="form.title" :readonly="props.readonly" />
        </FormField>
        <div v-if="detail && !props.readonly" class="detail-tools">
            <Button v-if="form.body.trim() === ''" size="sm" variant="secondary" icon-class="i-lucide-file-plus" @click="insertTemplate">插入细纲模板</Button>
            <Button v-else size="sm" variant="ghost" icon-class="i-lucide-plus" @click="insertScene">插入场景</Button>
        </div>
        <FormField label="正文" :description="bodyHint">
            <OutlineRichTextEditor
                ref="editor"
                v-model="form.body"
                :annotations="props.annotations"
                :foreshadow-options="props.foreshadowOptions"
                :readonly="props.readonly"
                placeholder="直接在这里写正文；支持 # 标题、- 列表、> 引用等 Markdown 快捷输入。"
                aria-label="正文"
            />
        </FormField>
        <section v-if="detail && problems.length" class="detail-problems" aria-label="细纲结构问题">
            <strong>细纲结构问题</strong>
            <ul>
                <li v-for="(problem, index) in problems" :key="index" :data-severity="problem.severity">
                    <span :class="problem.severity === 'blocking' ? 'i-lucide-circle-alert' : 'i-lucide-info'"></span>
                    <span>{{ problem.message }}</span>
                </li>
            </ul>
        </section>
        <details v-if="detail && markerHint.length" class="detail-markers">
            <summary>章节大纲的伏笔标记（{{ markerHint.length }}）</summary>
            <ul>
                <li v-for="item in markerHint" :key="item">{{ item }}</li>
            </ul>
        </details>
        <template v-if="props.withMetadata">
            <div class="entry-form-grid">
                <FormField label="目标字数" description="留空表示不限定。">
                    <FormInput v-model="form.targetWords" inputmode="numeric" :readonly="props.readonly" />
                </FormField>
                <FormField label="素材索引" description="作品内的资料文件路径，回车添加。">
                    <TagInput v-model="form.materialRefs" placeholder="例如 lorebook/人物/林默.md" :disabled="props.readonly" />
                </FormField>
            </div>
            <FormField label="写作指导" description="交给正文写作的整体要求，例如节奏、视角和语气。">
                <FormTextarea v-model="form.writingGuidance" :rows="3" :readonly="props.readonly" />
            </FormField>
            <section class="reference-editor" aria-label="参考资料">
                <div class="reference-heading">
                    <strong>参考资料</strong>
                    <Button v-if="!props.readonly" size="sm" variant="ghost" icon-class="i-lucide-plus" @click="addReference">添加</Button>
                </div>
                <p v-if="!form.references.length" class="reference-empty">还没有参考资料。尚未找到的资料可以先标记为「待补」。</p>
                <article v-for="(item, index) in form.references" :key="index" class="reference-row">
                    <FormInput v-model="item.path" placeholder="文件路径" :readonly="props.readonly" aria-label="参考文件路径" />
                    <FormInput v-model="item.locator" placeholder="定位（章节、段落或所需资料说明）" :readonly="props.readonly" aria-label="参考定位" />
                    <FormInput v-model="item.purpose" placeholder="用途" :readonly="props.readonly" aria-label="参考用途" />
                    <FormCheckbox v-model="item.pending" label="待补" :disabled="props.readonly" />
                    <IconButton v-if="!props.readonly" title="移除这条参考资料" icon-class="i-lucide-x" variant="danger" size="sm" @click="removeReference(index)" />
                </article>
            </section>
        </template>
        <section v-if="form.materialUpdates?.length" class="material-updates" aria-label="关联新信息">
            <strong>关联新信息</strong>
            <p>修改正文后，请同步核对下方信息。保存时一并更新当前方案的记录，基础资料保持原样。</p>
            <article v-for="(item, index) in form.materialUpdates" :key="`${item.materialPath}:${item.kind}`" class="material-update-row">
                <div class="material-update-heading">
                    <span>{{ materialUpdateLabels[item.kind] }}</span>
                    <IconButton v-if="!props.readonly" title="移除这条关联新信息" icon-class="i-lucide-x" variant="danger" size="sm" @click="removeMaterialUpdate(index)" />
                </div>
                <code>{{ item.materialPath }}</code>
                <FormTextarea v-model="item.body" :rows="3" :readonly="props.readonly" :aria-label="`关联新信息正文 ${index + 1}`" />
            </article>
            <FormCheckbox v-if="!props.readonly" v-model="form.materialUpdatesReviewed" label="已核对关联新信息与当前正文一致" />
        </section>
    </div>
</template>

<style scoped>
.entry-form { display: grid; gap: var(--space-5); }
.entry-form-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: var(--space-5); }
.detail-tools { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.detail-problems { display: grid; gap: var(--space-2); border: 1px solid var(--border-color); border-radius: var(--radius-control); padding: var(--space-3) var(--space-4); font-size: var(--text-xs); }
.detail-problems ul, .detail-markers ul { display: grid; gap: var(--space-1); margin: 0; padding: 0; list-style: none; }
.detail-problems li { display: flex; align-items: flex-start; gap: var(--space-2); overflow-wrap: anywhere; }
.detail-problems li span:first-child { flex: 0 0 auto; margin-top: 2px; }
.detail-problems li[data-severity="blocking"] { color: var(--status-danger); }
.detail-problems li[data-severity="hint"] { color: var(--text-secondary); }
.detail-markers { color: var(--text-secondary); font-size: var(--text-xs); }
.detail-markers summary { cursor: pointer; }
.detail-markers ul { margin-top: var(--space-2); overflow-wrap: anywhere; }
.reference-editor { display: grid; gap: var(--space-3); }
.reference-heading { display: flex; align-items: center; justify-content: space-between; font-size: var(--text-sm); }
.reference-empty { margin: 0; color: var(--text-muted); font-size: var(--text-2xs); }
.reference-row { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1.4fr) minmax(0, 1fr) auto auto; align-items: center; gap: var(--space-3); }
.material-updates, .material-update-row { display: grid; min-width: 0; gap: var(--space-3); }
.material-updates > strong, .material-update-heading { font-size: var(--text-sm); }
.material-updates > p { margin: 0; color: var(--text-secondary); font-size: var(--text-xs); }
.material-update-heading { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.material-update-row code { color: var(--text-muted); font-size: var(--text-2xs); overflow-wrap: anywhere; }
@media (max-width: 640px) {
    .entry-form-grid, .reference-row { grid-template-columns: minmax(0, 1fr); }
}
</style>
