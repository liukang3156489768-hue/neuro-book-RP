<script setup lang="ts">
import {computed, onBeforeUnmount, ref, watch} from "vue";
import Dialog from "nbook/app/components/common/Dialog.vue";
import OutlineWorkbenchAgentPane from "nbook/app/components/novel-ide/outline/OutlineWorkbenchAgentPane.vue";
import OutlineLibraryPanel from "nbook/app/components/novel-ide/outline/OutlineLibraryPanel.vue";
import OutlineForeshadowingPanel from "nbook/app/components/novel-ide/outline/OutlineForeshadowingPanel.vue";
import OutlineLinePanel from "nbook/app/components/novel-ide/outline/OutlineLinePanel.vue";
import type {ConfigBootstrapDto} from "nbook/shared/dto/config.dto";
import {useOutlineWorkbenchData} from "nbook/app/composables/useOutlineWorkbenchData";
import {useOutlineWorkbenchSession} from "nbook/app/utils/outline/outline-workbench-session";
import {resolveOutlineAgentWidth} from "nbook/shared/storage/outline-workbench-width";
import type {WorkbenchLayoutSurface} from "nbook/app/utils/workbench/layout-session";

const props = defineProps<{
    modelValue: boolean;
    projectRoot: string | null;
    projectTitle?: string;
    surface: WorkbenchLayoutSurface;
}>();
const emit = defineEmits<{(event: "update:modelValue", value: boolean): void}>();

const session = useOutlineWorkbenchSession({surface: computed(() => props.surface)});
const data = useOutlineWorkbenchData(() => props.projectRoot);
const activeTab = computed(() => session.state.value.activeView);
const selectedPlanId = ref<string | null>(null);
const modelOptions = ref<readonly {value: string; label: string}[]>([{value: "", label: "默认模型"}]);
/**
 * 视口宽度。左栏默认宽度是它的五分之一、上限是它的中线，两者都必须随窗口变化重算，
 * 所以这里订阅 resize，而不是在挂载时取一次。
 */
const viewportWidth = ref(typeof window === "undefined" ? 0 : window.innerWidth);
const dragging = ref(false);
const dragWidth = ref<number | null>(null);
let dragStartX = 0;
let dragStartWidth = 0;

const viewOptions = [
    {value: "library", label: "大纲库", icon: "i-lucide-library"},
    {value: "foreshadowing", label: "伏笔库", icon: "i-lucide-book-marked"},
    {value: "lines", label: "线路规划", icon: "i-lucide-git-branch"},
] as const;

const selectedPlan = computed(() => {
    const plans = data.snapshot.value?.manifest.plans ?? [];
    return plans.find((plan) => plan.id === selectedPlanId.value) ?? plans[0] ?? null;
});

/**
 * 拖拽期间以拖拽目标为准，其余时候以会话里保存的宽度为准（`null` 表示还没有用户偏好）。
 * 边界统一交给 `resolveOutlineAgentWidth`，避免这里和 CSS 各算一套边界。
 */
const requestedAgentWidth = computed(() => dragWidth.value ?? session.state.value.agentWidth);
const resolvedAgentWidth = computed(() => resolveOutlineAgentWidth(requestedAgentWidth.value, viewportWidth.value));
const agentWidthStyle = computed(() => `${resolvedAgentWidth.value}px`);
const busy = computed(() => session.loading.value || data.loading.value);

async function loadModelOptions(): Promise<void> {
    const root = props.projectRoot;
    if (!root) { modelOptions.value = [{value: "", label: "默认模型"}]; return; }
    try {
        const bootstrap = await $fetch<ConfigBootstrapDto>("/api/config/bootstrap", {query: {workspaceKind: "novel", projectRoot: root}});
        modelOptions.value = [{value: "", label: `默认模型（${bootstrap.modelSettings.defaultModelLabel || "未配置"}）`}, ...bootstrap.modelSettings.enabledModels.map((model) => ({value: model.key, label: model.label}))];
    } catch { modelOptions.value = [{value: "", label: "默认模型"}]; }
}

watch(() => data.snapshot.value?.manifest.plans, (plans) => {
    if (!plans?.some((plan) => plan.id === selectedPlanId.value)) selectedPlanId.value = plans?.[0]?.id ?? null;
}, {immediate: true});
watch(() => props.modelValue, (open) => {
    if (open) { void data.refresh(); void loadModelOptions(); }
});
watch(() => props.projectRoot, () => { void loadModelOptions(); }, {immediate: true});

async function save(patch: Parameters<typeof session.commit>[0]): Promise<void> {
    await session.commit(patch);
}

function setView(view: "library" | "foreshadowing" | "lines"): void {
    void save({activeView: view});
}

function startResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    dragging.value = true;
    dragStartX = event.clientX;
    dragStartWidth = resolvedAgentWidth.value;
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stopResize, {once: true});
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
}
function resize(event: PointerEvent): void {
    if (!dragging.value) return;
    dragWidth.value = dragStartWidth + event.clientX - dragStartX;
}
function stopResize(): void {
    if (!dragging.value) return;
    dragging.value = false;
    window.removeEventListener("pointermove", resize);
    const committed = resolvedAgentWidth.value;
    dragWidth.value = null;
    void save({agentWidth: committed});
}
function trackViewport(): void {
    viewportWidth.value = window.innerWidth;
}
if (typeof window !== "undefined") window.addEventListener("resize", trackViewport);


onBeforeUnmount(() => {
    window.removeEventListener("pointermove", resize);
    window.removeEventListener("resize", trackViewport);
    void session.release();
});
</script>

<template>
    <Dialog
        :model-value="props.modelValue"
        width="100vw"
        height="100dvh"
        max-height="100dvh"
        :show-footer="false"
        :close-on-overlay="false"
        :title="`${props.projectTitle || '当前作品'} · 大纲规划工作台`"
        :busy="busy"
        body-class="!gap-0 !overflow-hidden !p-0"
        @update:model-value="emit('update:modelValue', $event)"
    >
        <div class="outline-workbench" :style="{'--outline-agent-width': agentWidthStyle}">
            <aside class="outline-agent" aria-label="规划 Agent">
                <OutlineWorkbenchAgentPane
                    :project-root="props.projectRoot"
                    :mode="session.state.value.mode"
                    :model-key="session.state.value.modelKey ?? undefined"
                    :temperature="session.state.value.temperature"
                    :thinking-enabled="session.state.value.thinkingEnabled"
                    :model-options="modelOptions"
                    :workbench-session="session"
                    @update:settings="void save($event)"
                />
            </aside>
            <button type="button" class="outline-divider" aria-label="拖动调整 Agent 区宽度" @pointerdown="startResize"><span></span></button>
            <main class="outline-content">
                <header class="outline-toolbar"><div><strong>规划视图</strong><span v-if="data.snapshot.value">修订 {{ data.snapshot.value.manifest.revision }}</span></div><div class="view-tabs"><button v-for="view in viewOptions" :key="view.value" type="button" :class="{'is-active': activeTab === view.value}" @click="setView(view.value)"><span :class="view.icon"></span>{{ view.label }}</button><button type="button" class="refresh-button" title="刷新规划数据" @click="void data.refresh()"><span class="i-lucide-refresh-cw"></span></button></div></header>
                <div v-if="session.notice.value" class="workbench-notice" role="status"><span class="i-lucide-triangle-alert"></span>{{ session.notice.value.diagnosis }}<button v-if="session.notice.value.retryable" type="button" @click="void session.retry()">重试</button></div>
                <div v-if="data.error.value" class="workbench-notice is-danger" role="alert"><span class="i-lucide-circle-alert"></span>{{ data.error.value }}<button type="button" @click="void data.refresh()">重试</button></div>
                <section v-if="activeTab === 'library'" class="view-panel is-split" aria-label="大纲库">
                    <div class="view-heading"><div><h2>大纲库</h2><p>管理总纲、方案和各级大纲。所有修改先保存为草稿，确认后再正式采用。</p></div></div>
                    <OutlineLibraryPanel v-model:plan-id="selectedPlanId" :project-root="props.projectRoot" :snapshot="data.snapshot.value" :library-trees="data.libraryTrees.value" :refresh="data.refresh" />
                </section>
                <section v-else-if="activeTab === 'foreshadowing'" class="view-panel is-split" aria-label="伏笔库">
                    <div class="view-heading"><div><h2>伏笔库</h2><p>设计伏笔并追踪它在章节大纲中的埋设、强化与回收。状态由已采用章节中的标记自动计算。</p></div></div>
                    <OutlineForeshadowingPanel :project-root="props.projectRoot" :snapshot="data.snapshot.value" :foreshadowing="data.foreshadowing.value" :plan-id="selectedPlan?.id ?? null" :refresh="data.refresh" />
                </section>
                <section v-else class="view-panel is-split" aria-label="线路规划">
                    <div class="view-heading"><div><h2>线路规划</h2><p>把大纲条目串成主线、支线等故事线路。线路分析并固定后，正文写作按它的顺序读取大纲。</p></div></div>
                    <OutlineLinePanel :project-root="props.projectRoot" :snapshot="data.snapshot.value" :plan-id="selectedPlan?.id ?? null" :refresh="data.refresh" />
                </section>
            </main>
        </div>
    </Dialog>
</template>

<style scoped>
/*
 * 颜色只消费配色契约（nb-ui `nbColorwayVarKeys`）里的语义角色，间距/圆角只消费
 * `nb-ui/src/tokens.css` 的刻度。此前这里用的 `--bg-page` / `--text-primary` /
 * `--border-subtle` / `--warning` 等一批名字在主题里**从未定义**，整条声明会被浏览器静默丢弃，
 * 面板于是既没有底色也没有边框。改动本文件时请先确认变量名在契约里存在。
 */
.outline-workbench { display: flex; width: 100%; height: 100%; min-height: 0; overflow: hidden; background: var(--bg-main); color: var(--text-main); }

/* ---- 左栏：常驻规划 Agent ---- */
.outline-agent { display: flex; width: var(--outline-agent-width); min-width: 220px; max-width: 50vw; flex: 0 0 var(--outline-agent-width); flex-direction: column; border-right: 1px solid var(--border-color); background: var(--bg-panel); }
.outline-toolbar { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); border-bottom: 1px solid var(--border-color); padding: var(--space-5) var(--space-6); }
.outline-toolbar div { display: flex; align-items: center; gap: var(--space-3); }
.outline-toolbar span, .view-heading p { color: var(--text-muted); font-size: var(--text-2xs); }
.refresh-button { border: 1px solid transparent; border-radius: var(--radius-control); background: transparent; color: var(--text-secondary); cursor: pointer; }
.refresh-button:hover { background: color-mix(in srgb, var(--text-main) 15%, transparent); color: var(--text-main); }

/* ---- 分隔线：拖拽热区比可见线宽，并给出 hover/focus 反馈 ---- */
.outline-divider { position: relative; display: flex; width: var(--space-5); flex: 0 0 var(--space-5); align-items: center; justify-content: center; border: 0; border-right: 1px solid var(--border-color); background: var(--bg-panel); cursor: col-resize; padding: 0; }
.outline-divider::before { content: ""; position: absolute; inset-block: 0; inset-inline: -3px; }
.outline-divider span { display: block; width: 2px; height: 36px; border-radius: var(--radius-pill); background: var(--border-strong); transition: background var(--motion-fast) var(--ease-standard); }
.outline-divider:hover span, .outline-divider:focus-visible span { background: var(--accent-main); }

/* ---- 右栏：规划工作区 ---- */
.outline-content { display: flex; min-width: 0; min-height: 0; flex: 1; flex-direction: column; background: var(--bg-main); }
.view-tabs { display: flex; align-items: center; gap: var(--space-2); }
.view-tabs button { display: inline-flex; align-items: center; gap: var(--space-3); border: 1px solid transparent; border-radius: var(--radius-control); background: transparent; color: var(--text-muted); padding: var(--space-3) var(--space-5); cursor: pointer; font-size: var(--text-xs); }
.view-tabs button:hover { background: color-mix(in srgb, var(--text-main) 10%, transparent); color: var(--text-main); }
.view-tabs button.is-active { background: var(--accent-bg); color: var(--accent-text); }
.refresh-button { padding: var(--space-3); }

/* ---- 通知条 ---- */
.workbench-notice { display: flex; align-items: center; gap: var(--space-3); border-bottom: 1px solid var(--status-warning-border); background: var(--status-warning-bg); color: var(--status-warning); padding: var(--space-4) var(--space-6); font-size: var(--text-xs); }
.workbench-notice.is-danger { border-bottom-color: var(--status-danger-border); background: var(--status-danger-bg); color: var(--status-danger); }
.workbench-notice button { margin-left: auto; border: 0; background: transparent; color: inherit; cursor: pointer; text-decoration: underline; }

/* ---- 视图容器 ---- */
.view-panel { min-height: 0; flex: 1; overflow: auto; padding: var(--space-6); }
/* 三个视图都由面板内部的列表和详情分别滚动，外层不再整体滚动。 */
.view-panel.is-split { display: flex; flex-direction: column; overflow: hidden; }
.view-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-6); margin-bottom: var(--space-6); }
.view-heading h2 { margin: 0; font-size: var(--text-lg); font-weight: var(--weight-strong); }
.view-heading p { margin: var(--space-2) 0 0; }
</style>


