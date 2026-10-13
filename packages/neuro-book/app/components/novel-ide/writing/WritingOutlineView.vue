<script setup lang="ts">
import {computed, nextTick, ref} from "vue";
import {Button, IconButton} from "@notnotype/nb-ui/components";
import FormInput from "nbook/app/components/common/form/FormInput.vue";
import FormSelect from "nbook/app/components/common/form/FormSelect.vue";
import WritingOutlineTree from "nbook/app/components/novel-ide/writing/WritingOutlineTree.vue";
import {useNotification} from "nbook/app/composables/useNotification";
import {useWritingWorkspaceStore} from "nbook/app/stores/writing-workspace";
import {resolveApiErrorMessage} from "nbook/app/utils/api-error";
import {groupChaptersByVolume, issuesByChapter} from "nbook/app/utils/writing/writing-tree";

const store = useWritingWorkspaceStore();
const notification = useNotification();
store.ensureLoaded();

const pending = ref(false);
const overview = computed(() => store.overview);
const plan = computed(() => overview.value?.plan ?? null);
const planOptions = computed(() => [{value: "", label: "不使用写作方案"}, ...(overview.value?.plans ?? []).map(({id, title}) => ({value: id, label: title}))]);
const styleOptions = computed(() => [{value: "", label: "未选择（写作前必须选择）"}, ...store.styles.map(({path, title}) => ({value: path, label: title}))]);
const groups = computed(() => groupChaptersByVolume(overview.value?.chapters ?? []));
const issues = computed(() => issuesByChapter(store.issues));
const linkTargets = computed(() => (overview.value?.chapters ?? []).filter(({prose}) => prose.length === 0)
    .map(({entryId, title}) => ({value: entryId, label: title})));
const planNotice = computed(() => {
    const value = plan.value;
    if (!value || value.state === "ready") return null;
    if (value.state === "unset") return "选择一个写作方案后，这里会列出它的卷与章节。";
    if (value.state === "missing") return "之前选的写作方案已不存在，请重新选择。";
    return `大纲暂时无法读取：${value.message}`;
});

async function write(operation: () => Promise<void>, failure: string): Promise<void> {
    pending.value = true;
    try {
        await operation();
    } catch (cause) {
        notification.error(resolveApiErrorMessage(cause, failure), {title: failure});
    } finally {
        pending.value = false;
    }
}
const setPlan = (value: string) => write(() => store.setPlan(value || null), "切换写作方案失败");
const setStyle = (value: string) => write(() => store.setStyle(value || null), "设置文风失败");
const link = (path: string, chapterEntryId: string) => write(() => store.linkProse(path, chapterEntryId), "关联正文失败");
const unlink = (path: string) => write(() => store.unlinkProse(path), "解除关联失败");
const ignoreIssue = (chapterEntryId: string, issueId: string) => write(() => store.ignoreIssue(chapterEntryId, issueId), "忽略问题失败");

const stylePath = computed(() => overview.value?.settings.stylePath ?? null);
const styleTitle = computed(() => store.styles.find(({path}) => path === stylePath.value)?.title ?? stylePath.value ?? "");
const running = computed(() => store.activeRuns.length > 0);
const creating = ref(false);
const newTitle = ref("");
const createForm = ref<HTMLFormElement | null>(null);
const confirmingDelete = ref(false);

async function startCreate(): Promise<void> {
    confirmingDelete.value = false;
    newTitle.value = "";
    creating.value = true;
    await nextTick();
    createForm.value?.querySelector("input")?.focus();
}
async function createStyle(): Promise<void> {
    const title = newTitle.value.trim();
    if (title === "") return;
    await write(async () => {
        await store.createStyle(title);
        creating.value = false;
    }, "新增文风失败");
}
async function deleteStyle(): Promise<void> {
    const target = stylePath.value;
    if (target === null) return;
    await write(async () => {
        await store.deleteStyle(target);
        confirmingDelete.value = false;
    }, "删除文风失败");
}
</script>

<template>
    <div class="writing-outline-view">
        <p v-if="store.loading && !overview" class="view-loading" role="status" aria-busy="true">正在读取大纲…</p>

        <div v-else-if="store.error && !overview" class="view-error" role="alert">
            <span class="i-lucide-circle-alert"></span><span>{{ store.error }}</span>
            <Button size="sm" variant="ghost" @click="void store.refresh()">重试</Button>
        </div>

        <template v-else-if="overview">
            <div class="view-settings">
                <label class="setting-row">
                    <span>写作方案</span>
                    <FormSelect size="sm" :model-value="overview.settings.writingPlanId ?? ''" :options="planOptions" :disabled="pending"
                        aria-label="写作方案" @update:model-value="setPlan" />
                </label>
                <div class="setting-row">
                    <span>文风</span>
                    <div class="style-control">
                        <FormSelect size="sm" :model-value="stylePath ?? ''" :options="styleOptions" :disabled="pending"
                            aria-label="文风" @update:model-value="setStyle" />
                        <IconButton size="sm" title="编辑当前文风" aria-label="编辑当前文风" icon-class="i-lucide-pencil"
                            :disabled="stylePath === null" @click="stylePath && store.openStyle(stylePath)" />
                        <IconButton size="sm" title="新增文风" aria-label="新增文风" icon-class="i-lucide-plus" :disabled="pending" @click="startCreate" />
                        <IconButton size="sm" :title="running ? '写作运行进行中，停止后才能删除文风' : '删除当前文风'" aria-label="删除当前文风"
                            icon-class="i-lucide-trash-2" :disabled="pending || stylePath === null || running"
                            @click="creating = false; confirmingDelete = true" />
                    </div>
                </div>
                <form v-if="creating" ref="createForm" class="style-inline" @submit.prevent="createStyle">
                    <FormInput v-model="newTitle" placeholder="新文风名称" aria-label="新文风名称" :disabled="pending" />
                    <Button size="sm" type="submit" :disabled="pending || newTitle.trim() === ''">创建</Button>
                    <Button size="sm" variant="ghost" :disabled="pending" @click="creating = false">取消</Button>
                </form>
                <div v-if="confirmingDelete && stylePath" class="style-inline style-confirm" role="group" aria-label="确认删除文风">
                    <span>删除文风“{{ styleTitle }}”？可在文件历史中恢复。</span>
                    <Button size="sm" variant="danger" :disabled="pending || running" @click="deleteStyle">删除</Button>
                    <Button size="sm" variant="ghost" :disabled="pending" @click="confirmingDelete = false">取消</Button>
                </div>
                <p v-else-if="stylePath === null && !creating" class="view-hint">写作前需要选择文风；没有合适的可以点“+”新增。</p>
                <p v-if="overview.settingsError" class="view-notice" role="status">写作设置格式有误，已按未设置处理：{{ overview.settingsError }}</p>
                <p v-if="planNotice" class="view-hint">{{ planNotice }}</p>
                <div v-if="store.error" class="view-error" role="alert">
                    <span class="i-lucide-circle-alert"></span><span>{{ store.error }}</span>
                    <Button size="sm" variant="ghost" @click="void store.refresh()">重试</Button>
                </div>
            </div>

            <p v-if="store.issuesError" class="view-notice" role="status">问题记录读取失败，暂不显示问题。</p>

            <div class="view-tree">
                <WritingOutlineTree
                    v-if="plan?.state === 'ready' || overview.unlinkedProse.length"
                    :groups="plan?.state === 'ready' ? groups : null"
                    :unlinked="overview.unlinkedProse"
                    :link-targets="linkTargets"
                    :issues="issues"
                    :selected-key="store.selectedKey"
                    :collapsed-volumes="store.collapsedVolumes"
                    :expanded-chapters="store.expandedChapters"
                    :running-chapters="store.lockedChapters"
                    :pending="pending"
                    @select="store.select"
                    @toggle-volume="store.toggleVolume"
                    @toggle-chapter="store.toggleChapter"
                    @link="link"
                    @unlink="unlink"
                    @ignore-issue="ignoreIssue"
                    @open-outline="store.openInOutlineWorkbench"
                />
            </div>
        </template>
    </div>
</template>

<style scoped>
.writing-outline-view { display: flex; height: 100%; min-height: 0; min-width: 0; flex-direction: column; font-size: var(--text-xs); }
.view-loading { margin: var(--space-6) auto; color: var(--text-muted); }
.view-settings { display: grid; gap: var(--space-2); border-bottom: 1px solid var(--border-color); padding: var(--space-3) var(--space-4); }
.setting-row { display: grid; grid-template-columns: 4.5em minmax(0, 1fr); align-items: center; gap: var(--space-2); color: var(--text-secondary); }
.style-control { display: flex; min-width: 0; align-items: center; gap: var(--space-1); }
.style-control > :first-child { min-width: 0; flex: 1; }
.style-inline { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.style-inline > :first-child { min-width: 8em; flex: 1; }
.style-confirm { border: 1px solid var(--status-danger-border); border-radius: var(--radius-control); background: var(--status-danger-bg); padding: var(--space-2) var(--space-3); color: var(--text-main); }
.style-confirm > span { overflow-wrap: anywhere; }
.view-hint { margin: 0; color: var(--text-muted); }
.view-notice { margin: var(--space-2) var(--space-4) 0; border: 1px solid var(--status-warning-border); border-radius: var(--radius-control); background: var(--status-warning-bg); padding: var(--space-2) var(--space-3); color: var(--text-main); }
.view-settings .view-notice { margin: 0; }
.view-error { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin: var(--space-3); border: 1px solid var(--status-danger-border); border-radius: var(--radius-control); background: var(--status-danger-bg); padding: var(--space-2) var(--space-3); color: var(--status-danger); }
.view-settings .view-error { margin: 0; }
.view-error > span:nth-child(2) { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.view-tree { min-height: 0; flex: 1; overflow-x: hidden; overflow-y: auto; padding: var(--space-2) var(--space-2) var(--space-4); }
</style>
