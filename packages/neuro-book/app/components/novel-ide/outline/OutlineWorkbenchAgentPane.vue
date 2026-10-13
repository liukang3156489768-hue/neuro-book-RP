<script setup lang="ts">
import {computed, ref, watch} from "vue";
import {IconButton, SegmentedControl} from "@notnotype/nb-ui/components";
import FormSelect from "nbook/app/components/common/form/FormSelect.vue";
import AgentChatFlow from "nbook/app/components/novel-ide/agent/flow/AgentChatFlow.vue";
import AgentCompactionStatus from "nbook/app/components/novel-ide/agent/AgentCompactionStatus.vue";
import AgentChatEmptyState, {type PromptSuggestionItem} from "nbook/app/components/novel-ide/agent/flow/AgentChatEmptyState.vue";
import AgentComposerInput from "nbook/app/components/novel-ide/agent/composer/AgentComposerInput.vue";
import AgentUserInputPrompt from "nbook/app/components/novel-ide/agent/composer/AgentUserInputPrompt.vue";
import OutlineAgentSessionList from "nbook/app/components/novel-ide/outline/OutlineAgentSessionList.vue";
import {useOutlineWorkbenchAgent} from "nbook/app/composables/useOutlineWorkbenchAgent";
import {
    buildAgentPendingResolutions,
    pendingQuestionKey,
    type AgentPendingResolutionDraft,
    type AgentPendingSubmissionIssue,
} from "nbook/app/components/novel-ide/agent/agent-pending-resolution";
import type {AgentPendingUserInputSession} from "nbook/app/components/novel-ide/agent/agent-message";
import type {AgentTriggerMenuState} from "nbook/app/components/novel-ide/agent/trigger-menu";
import type {OutlineWorkbenchPatch, OutlineWorkbenchSession} from "nbook/app/utils/outline/outline-workbench-session";
import type {OutlineWorkbenchCreationMode} from "nbook/shared/storage/outline-workbench";
import {projectOutlineWorkbenchMessage} from "nbook/app/utils/outline/outline-workbench-message";

/**
 * 大纲规划工作台左栏：外观与主 Agent 侧栏保持一致（头部 → 对话流 → 圆角输入卡片），
 * 直接复用主 Agent 的对话流、空状态、输入框和待确认面板这几个纯受控组件。
 * 设计合同要求的四个控件（思考、模型、温度、讨论/自动）收进输入卡片底部的一行工具条；
 * 它们只改后续请求，持久化由宿主通过 `update:settings` 写入 Project 工作台记录。
 */
const props = defineProps<{
    projectRoot: string | null;
    planId: string | null;
    creationMode: OutlineWorkbenchCreationMode;
    mode: "discuss" | "auto";
    modelKey?: string;
    temperature: number;
    thinkingEnabled: boolean;
    modelOptions: readonly {value: string; label: string}[];
    workbenchSession?: Pick<OutlineWorkbenchSession, "state" | "loading" | "commit">;
}>();
const emit = defineEmits<{
    (event: "update:error", value: string | null): void;
    (event: "update:settings", patch: OutlineWorkbenchPatch): void;
}>();

const prompt = ref("");
const pendingError = ref<string | null>(null);
const inputGeneration = ref(0);
const showSessionList = ref(false);

const agent = useOutlineWorkbenchAgent(() => props.projectRoot, {
    mode: () => props.mode,
    modelKey: () => props.modelKey,
    temperature: () => props.temperature,
    thinkingEnabled: () => props.thinkingEnabled,
    creationMode: () => props.creationMode,
    planId: () => props.planId,
}, {
    workbenchSession: props.workbenchSession,
});

const sessions = computed(() => props.workbenchSession?.state.value.sessions || []);
const displayMessages = computed(() => agent.messages.value.map(projectOutlineWorkbenchMessage));

async function handleCreateSession(): Promise<void> {
    const newSessionId = await agent.createNewSession();
    if (newSessionId) {
        showSessionList.value = false;
    }
}

async function handleSelectSession(sessionId: number): Promise<void> {
    const success = await agent.switchSession(sessionId);
    if (success) {
        showSessionList.value = false;
    }
}

async function handleDeleteSession(sessionId: number): Promise<void> {
    await agent.deleteSession(sessionId);
}

async function handleRenameSession(sessionId: number, newTitle: string): Promise<void> {
    await agent.renameSession(sessionId, newTitle);
}

function handleViewSpecialistSession(sessionId: number): void {
    // 切换到专家会话
    void agent.switchSession(sessionId);
    showSessionList.value = true;
}

const effectiveError = computed(() => pendingError.value || agent.error.value);
const pendingSessions = computed(() => agent.pendingUserInputSessions.value as readonly AgentPendingUserInputSession[]);
const submissionIssue = computed<AgentPendingSubmissionIssue | null>(() => pendingError.value ? {kind: "error", message: pendingError.value} : null);
const busy = computed(() => agent.running.value || agent.pendingSubmission.value || agent.loading.value || props.workbenchSession?.loading.value === true);
const canSend = computed(() => Boolean(prompt.value.trim()) && !busy.value);
const statusText = computed(() => {
    if (agent.session.compaction.value?.status === "running") return "正在整理上下文…";
    if (agent.running.value) return "正在规划…";
    if (pendingSessions.value.length) return "等待你的确认";
    return agent.messages.value.length ? `${agent.messages.value.length} 条消息` : "暂无消息";
});

/** 规划 Agent 没有 @ 引用与技能菜单；返回空分组时输入框不会弹出菜单。 */
const EMPTY_MENU: AgentTriggerMenuState = {title: "", prefix: "", sections: []};
const resolveMenu = (): AgentTriggerMenuState => EMPTY_MENU;

const originalSuggestions: PromptSuggestionItem[] = [
    {id: "master", icon: "i-lucide-library", iconColorClass: "text-sky-500", prompt: "根据我的故事方向生成一份总纲草案，包含核心冲突、主题、主要阶段和结局方向。"},
    {id: "foreshadow", icon: "i-lucide-book-marked", iconColorClass: "text-amber-500", prompt: "检查当前伏笔库：哪些伏笔还没有埋设，哪些已埋设但迟迟没有回收？"},
    {id: "lines", icon: "i-lucide-git-branch", iconColorClass: "text-emerald-500", prompt: "分析当前线路规划，找出断链、停滞过久或与主线冲突的节点。"},
];
const adaptationSuggestions: PromptSuggestionItem[] = [
    {id: "adapt-structure", icon: "i-lucide-library", iconColorClass: "text-sky-500", prompt: "我想参考已提取大纲进行结构改编。请先确认来源与保留项，按需了解已有角色的人设、经历和关系；写作手法与素材先读索引再读选中的正文，然后讨论新的规划。"},
    {id: "adapt-plot", icon: "i-lucide-book-marked", iconColorClass: "text-amber-500", prompt: "我想在原作剧情基础上改编。请先询问我要基于哪个来源章节，以及想改变哪些内容，再结合当前方案已有大纲和相关角色经历、关系检查衔接。"},
    {id: "adapt-insert", icon: "i-lucide-git-branch", iconColorClass: "text-emerald-500", prompt: "我想在原作的两个章节之间新增原创章节。请先确认前后来源章节及当前方案中的插入位置，再按需读取已有改编大纲，规划能够衔接前后剧情的新章节。"},
];
const suggestions = computed(() => props.creationMode === "adaptation" ? adaptationSuggestions : originalSuggestions);
const creationModeOptions = computed(() => [
    {value: "original", label: "原创", title: "原创规划：按需借鉴提取素材", disabled: busy.value || pendingSessions.value.length > 0 || agent.creationModeLocked.value},
    {value: "adaptation", label: "改编", title: "改编规划：支持结构改编、剧情改编和插入原创章节", disabled: busy.value || pendingSessions.value.length > 0 || agent.creationModeLocked.value},
]);

function changeCreationMode(value: unknown): void {
    if (agent.creationModeLocked.value || busy.value || pendingSessions.value.length > 0) return;
    emit("update:settings", {creationMode: value === "adaptation" ? "adaptation" : "original"});
}

const modeOptions = [
    {value: "discuss", label: "讨论", title: "讨论模式：正式变更先展示，确认后再写入"},
    {value: "auto", label: "自动", title: "自动模式：非删除操作直接执行，可撤销"},
];
const selectOptions = computed(() => props.modelOptions.map((option) => ({value: option.value, label: option.label})));

watch(effectiveError, (value) => emit("update:error", value));
watch(pendingSessions, (sessions) => {
    const current = agent.pendingDraft.value;
    const next: AgentPendingResolutionDraft = {answers: {}, forms: {}};
    for (const session of sessions) {
        if (session.form && session.formToolCallId) {
            const key = `form:${session.formToolCallId}`;
            next.forms[key] = current.forms[key] ?? {data: {}, confirmed: false};
        }
        for (const question of session.questions) {
            const toolCallId = question.toolCallId ?? question.toolNodeId;
            next.answers[pendingQuestionKey(toolCallId, question.questionIndex)] = current.answers[pendingQuestionKey(toolCallId, question.questionIndex)] ?? {note: ""};
        }
    }
    agent.pendingDraft.value = next;
}, {deep: true, immediate: true});

function updateDraft(next: AgentPendingResolutionDraft): void {
    agent.pendingDraft.value = next;
    pendingError.value = null;
}

async function submitPending(): Promise<void> {
    pendingError.value = null;
    const result = buildAgentPendingResolutions(pendingSessions.value, agent.pendingDraft.value, {
        otherAnswer: "其他答案",
        addSuggestion: "补充建议",
        continueLabel: "继续",
        noteLabel: (note) => `备注：${note}`,
    });
    if (result.status === "incomplete") {
        pendingError.value = "请先完成所有审批或问题回答";
        return;
    }
    await agent.submitPending(result.resolutions);
}

async function send(): Promise<void> {
    const text = prompt.value.trim();
    if (!text || busy.value) return;
    prompt.value = "";
    // 输入框是 TipTap 编辑器，外部清空需要换代才会重建文档。
    inputGeneration.value += 1;
    await agent.sendPrompt(text);
}

function onSubmitButton(): void {
    if (agent.running.value) {
        void agent.abort();
        return;
    }
    void send();
}

function fillStarter(text: string): void {
    prompt.value = text;
    inputGeneration.value += 1;
}

function stepTemperature(delta: number): void {
    const next = props.temperature + delta;
    emit("update:settings", {temperature: Math.min(2, Math.max(0, Number(next.toFixed(1))))});
}

async function changeRuntime(command: Parameters<typeof agent.updateRuntime>[0]): Promise<void> {
    await agent.updateRuntime(command);
}

watch(() => props.mode, (mode) => { void changeRuntime({command: "mode", mode: mode === "auto" ? "normal" : "discuss"}); });
watch(() => props.modelKey, (modelKey) => { void changeRuntime({command: "model", modelKey: modelKey ?? null}); });
watch(() => props.thinkingEnabled, (enabled) => { void changeRuntime({command: "thinking", thinkingLevel: enabled ? "medium" : "off"}); });
</script>

<template>
    <div class="outline-agent-pane">
        <header class="pane-header">
            <span class="pane-avatar"><span class="i-lucide-sparkles"></span></span>
            <div class="pane-title">
                <div><strong>规划 Agent</strong><span class="pane-badge" :data-mode="props.mode">{{ props.mode === 'auto' ? '自动' : '讨论' }}</span></div>
                <span class="pane-status" :data-running="agent.running.value">{{ statusText }}</span>
            </div>
            <IconButton
                title="会话历史"
                icon-class="i-lucide-history"
                size="sm"
                :variant="showSessionList ? 'accent' : 'default'"
                :aria-pressed="showSessionList"
                @click="showSessionList = !showSessionList"
            />
        </header>

        <AgentCompactionStatus :state="agent.session.compaction.value" />

        <OutlineAgentSessionList
            v-if="showSessionList"
            :sessions="sessions"
            :active-session-id="agent.activeSessionId.value"
            :loading="agent.loading.value"
            @select="handleSelectSession"
            @create="handleCreateSession"
            @delete="handleDeleteSession"
            @rename="handleRenameSession"
        />

        <div v-else class="outline-agent-stream" aria-live="polite">
            <AgentChatFlow
                :messages="displayMessages"
                :session-id="agent.activeSessionId.value"
                :running="agent.running.value"
                mode="main"
                :project-root="props.projectRoot"
                @view-specialist-session="handleViewSpecialistSession"
            >
                <template #empty>
                    <div class="pane-empty">
                        <AgentChatEmptyState :suggestions="suggestions" @select-starter="fillStarter" />
                    </div>
                </template>
            </AgentChatFlow>
        </div>

        <div class="pane-footer">
            <div v-if="effectiveError && !pendingSessions.length" class="pane-error" role="alert"><span class="i-lucide-circle-alert"></span>{{ effectiveError }}</div>

            <!-- 待确认时由主 Agent 同款面板替换输入卡片，与主创侧栏的审批体验一致。 -->
            <AgentUserInputPrompt
                v-if="pendingSessions.length"
                :sessions="pendingSessions"
                :draft="agent.pendingDraft.value"
                :submitting="agent.pendingSubmission.value"
                :can-resolve="!agent.pendingSubmission.value"
                :can-abort="true"
                :submission-issue="submissionIssue"
                menu-refresh-key="outline"
                :resolve-menu="resolveMenu"
                @update:draft="updateDraft"
                @submit="void submitPending()"
                @cancel="void agent.abort()"
                @resync="pendingError = null"
            />

            <div v-else class="composer-card">
                <div class="creation-toolbar">
                    <span>创作方式</span>
                    <SegmentedControl
                        size="sm"
                        aria-label="创作方式"
                        :model-value="props.creationMode"
                        :options="creationModeOptions"
                        @update:model-value="changeCreationMode"
                    />
                </div>
                <AgentComposerInput
                    v-model="prompt"
                    borderless
                    :generation="inputGeneration"
                    placeholder="描述你想规划的内容…（Enter 发送，Shift+Enter 换行）"
                    aria-label="规划 Agent 输入"
                    :readonly="busy"
                    :enable-image-files="false"
                    :resolve-menu="resolveMenu"
                    @submit="void send()"
                />
                <div class="composer-toolbar">
                    <FormSelect
                        class="toolbar-model"
                        size="sm"
                        dropdown-direction="up"
                        :model-value="props.modelKey ?? ''"
                        :options="selectOptions"
                        @update:model-value="emit('update:settings', {modelKey: $event || undefined})"
                    />
                    <IconButton
                        size="sm"
                        :variant="props.thinkingEnabled ? 'accent' : 'default'"
                        :aria-pressed="props.thinkingEnabled"
                        :title="props.thinkingEnabled ? '思考：开启（点击关闭）' : '思考：关闭（点击开启）'"
                        :aria-label="props.thinkingEnabled ? '关闭思考' : '开启思考'"
                        @click="emit('update:settings', {thinkingEnabled: !props.thinkingEnabled})"
                    >
                        <span class="i-lucide-brain h-3.5 w-3.5"></span>
                    </IconButton>
                    <div class="temperature" role="group" aria-label="温度" title="温度（0–2）">
                        <button type="button" aria-label="降低温度" :disabled="props.temperature <= 0" @click="stepTemperature(-0.1)"><span class="i-lucide-minus"></span></button>
                        <output>{{ props.temperature.toFixed(1) }}</output>
                        <button type="button" aria-label="提高温度" :disabled="props.temperature >= 2" @click="stepTemperature(0.1)"><span class="i-lucide-plus"></span></button>
                    </div>
                    <SegmentedControl
                        size="sm"
                        aria-label="Agent 模式"
                        :model-value="props.mode"
                        :options="modeOptions"
                        @update:model-value="emit('update:settings', {mode: $event === 'auto' ? 'auto' : 'discuss'})"
                    />
                    <button
                        type="button"
                        class="send-button nb-ui-focus-ring"
                        :disabled="!agent.running.value && !canSend"
                        :title="agent.running.value ? '停止运行' : '发送'"
                        :aria-label="agent.running.value ? '停止运行' : '发送'"
                        @click="onSubmitButton"
                    >
                        <span :class="agent.running.value ? 'i-lucide-square' : 'i-lucide-send-horizontal'"></span>
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
/* 变量名必须存在于 nb-ui 配色契约与 tokens.css；写错的变量会让整条声明静默失效。 */
.outline-agent-pane { display: flex; min-height: 0; flex: 1; flex-direction: column; }

/* ---- 头部：与主创侧栏一致的「头像 + 标题 + 徽章 + 状态」 ---- */
.pane-header { display: flex; align-items: center; gap: var(--space-4); border-bottom: 1px solid var(--border-color); padding: var(--space-5) var(--space-6); }
.pane-avatar { display: flex; width: 28px; height: 28px; flex: 0 0 auto; align-items: center; justify-content: center; border: 1px solid var(--border-color); border-radius: var(--radius-control); background: var(--bg-main); color: var(--accent-text); }
.pane-title { display: grid; min-width: 0; gap: 1px; }
.pane-title > div { display: flex; align-items: center; gap: var(--space-3); }
.pane-title strong { font-size: var(--text-sm); font-weight: var(--weight-strong); }
.pane-badge { border-radius: var(--radius-pill); background: color-mix(in srgb, var(--text-main) 10%, transparent); padding: 0 var(--space-3); color: var(--text-secondary); font-size: var(--text-2xs); line-height: 18px; }
.pane-badge[data-mode="auto"] { background: var(--accent-bg); color: var(--accent-text); }
.pane-status { overflow: hidden; color: var(--text-muted); font-size: var(--text-2xs); text-overflow: ellipsis; white-space: nowrap; }
.pane-status[data-running="true"] { color: var(--accent-text); }

/* ---- 对话流 ---- */
.outline-agent-stream { display: flex; min-height: 0; flex: 1; flex-direction: column; overflow: auto; padding: var(--space-4) var(--space-5); }
.outline-agent-stream :deep(.agent-chat-flow) { min-height: 100%; }
.pane-empty { display: flex; min-height: 100%; }

/* ---- 底部：输入卡片（输入框 + 紧凑工具条） ---- */
.pane-footer { display: grid; flex: 0 0 auto; gap: var(--space-3); padding: 0 var(--space-4) var(--space-4); }
.pane-error { display: flex; align-items: flex-start; gap: var(--space-3); border: 1px solid var(--status-danger-border); border-radius: var(--radius-control); background: var(--status-danger-bg); padding: var(--space-3) var(--space-4); color: var(--status-danger); font-size: var(--text-2xs); line-height: var(--leading-ui); }
.pane-error span { flex: 0 0 auto; margin-top: 2px; }
.composer-card { display: flex; flex-direction: column; border: 1px solid var(--border-color); border-radius: 0.75rem; background: var(--bg-panel); transition: border-color var(--motion-fast) var(--ease-standard), box-shadow var(--motion-fast) var(--ease-standard); }
.composer-card:focus-within { border-color: var(--accent-main); box-shadow: 0 0 0 1px var(--accent-main); }
.creation-toolbar { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-3) var(--space-4); border-bottom: var(--border-w) solid var(--divider); }
.creation-toolbar > span { color: var(--text-secondary); font-size: var(--text-2xs); white-space: nowrap; }
.composer-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); border-top: 1px solid var(--border-color); padding: var(--space-3) var(--space-4); }
.toolbar-model { min-width: 96px; flex: 1 1 120px; }
.temperature { display: inline-flex; height: 26px; align-items: center; border-radius: var(--radius-control); background: color-mix(in srgb, var(--text-main) 8%, transparent); }
.temperature button { display: flex; width: 22px; height: 100%; align-items: center; justify-content: center; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 12px; }
.temperature button:hover:not(:disabled) { background: color-mix(in srgb, var(--text-main) 15%, transparent); color: var(--text-main); }
.temperature button:disabled { cursor: not-allowed; opacity: .4; }
.temperature output { min-width: 24px; color: var(--text-main); font-size: var(--text-2xs); font-variant-numeric: tabular-nums; text-align: center; }
.send-button { display: flex; width: 26px; height: 26px; flex: 0 0 auto; align-items: center; justify-content: center; margin-left: auto; border: 1px solid transparent; border-radius: var(--radius-control); background: var(--accent-main); color: var(--text-inverse); cursor: pointer; font-size: 14px; transition: background var(--motion-fast) var(--ease-standard); }
.send-button:hover:not(:disabled) { background: color-mix(in srgb, var(--accent-main) 86%, var(--text-main)); }
.send-button:disabled { cursor: not-allowed; opacity: .4; }
</style>
