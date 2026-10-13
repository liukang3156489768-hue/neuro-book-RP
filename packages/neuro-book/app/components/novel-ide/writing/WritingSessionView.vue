<script setup lang="ts">
import {computed, ref, watch} from "vue";
import {Badge, Button, EmptyState, IconButton} from "@notnotype/nb-ui/components";
import FormSelect from "nbook/app/components/common/form/FormSelect.vue";
import AgentChatFlow from "nbook/app/components/novel-ide/agent/flow/AgentChatFlow.vue";
import AgentComposerInput from "nbook/app/components/novel-ide/agent/composer/AgentComposerInput.vue";
import AgentUserInputPrompt from "nbook/app/components/novel-ide/agent/composer/AgentUserInputPrompt.vue";
import {
    buildAgentPendingResolutions,
    pendingQuestionKey,
    type AgentPendingResolutionDraft,
    type AgentPendingSubmissionIssue,
} from "nbook/app/components/novel-ide/agent/agent-pending-resolution";
import type {AgentPendingUserInputSession} from "nbook/app/components/novel-ide/agent/agent-message";
import type {AgentTriggerMenuState} from "nbook/app/components/novel-ide/agent/trigger-menu";
import WritingRoleModelsPopover from "nbook/app/components/novel-ide/writing/WritingRoleModelsPopover.vue";
import WritingRunCard from "nbook/app/components/novel-ide/writing/WritingRunCard.vue";
import WritingWriterOutput from "nbook/app/components/novel-ide/writing/WritingWriterOutput.vue";
import {useWritingChapterAgent} from "nbook/app/composables/useWritingChapterAgent";
import {useNotification} from "nbook/app/composables/useNotification";
import {useWritingWorkspaceStore} from "nbook/app/stores/writing-workspace";
import {resolveApiErrorMessage} from "nbook/app/utils/api-error";
import type {WritingUserDecision} from "nbook/app/utils/writing/writing-api";
import type {WritingRole} from "nbook/shared/dto/writing.dto";
import {chapterBlockReasons, chapterStatusLabel, chapterStatusTone} from "nbook/app/utils/writing/writing-tree";

const store = useWritingWorkspaceStore();
const notification = useNotification();
store.ensureLoaded();

const chapter = computed(() => store.selectedChapter);
const agent = useWritingChapterAgent(() => store.projectRoot, () => chapter.value?.entryId ?? null);

const prompt = ref("");
const inputGeneration = ref(0);
const pendingError = ref<string | null>(null);
const pendingRunId = ref<string | null>(null);
const showEarlierRuns = ref(false);
const runsOpen = ref(true);

const blockReasons = computed(() => (chapter.value ? chapterBlockReasons(chapter.value) : []));
const statusTone = computed(() => {
    const tone = chapter.value ? chapterStatusTone(chapter.value.status) : "neutral";
    return tone === "muted" ? "neutral" : tone;
});
const pendingSessions = computed(() => agent.pendingUserInputSessions.value as readonly AgentPendingUserInputSession[]);
const submissionIssue = computed<AgentPendingSubmissionIssue | null>(() => pendingError.value ? {kind: "error", message: pendingError.value} : null);
const busy = computed(() => agent.running.value || agent.pendingSubmission.value);
const readonly = computed(() => busy.value || !chapter.value?.writable);
const canSend = computed(() => Boolean(prompt.value.trim()) && !readonly.value);
const placeholder = computed(() => (chapter.value?.writable === false
    ? `这一章暂不能写作：${blockReasons.value.join("、")}`
    : "告诉主创你想怎么写…（Enter 发送，Shift+Enter 换行）"));

const confirmingDelete = ref(false);
const sessionPending = ref(false);
const sessionOptions = computed(() => agent.sessions.value.map(({sessionId, title, updatedAt}, index) => ({
    value: String(sessionId),
    label: `${index === 0 ? "最近 · " : ""}${title}（${new Date(updatedAt).toLocaleString("zh-CN", {month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"})}）`,
})));
const hasPendingQuestion = computed(() => pendingSessions.value.length > 0);
const chapterRunning = computed(() => (chapter.value ? store.lockedChapters.has(chapter.value.entryId) : false));
const sessionLocked = computed(() => busy.value || hasPendingQuestion.value || agent.loading.value || sessionPending.value);
const deleteBlocker = computed(() => {
    if (agent.activeSessionId.value === null) return "还没有会话";
    if (chapterRunning.value) return "这一章有写作运行正在进行，停止后再删除会话";
    if (busy.value || hasPendingQuestion.value) return "主创正在回复或等待回答，结束后再删除会话";
    return null;
});

async function sessionAction(operation: () => Promise<void>, failure: string): Promise<void> {
    sessionPending.value = true;
    try {
        await operation();
    } catch (cause) {
        notification.error(resolveApiErrorMessage(cause, failure), {title: failure});
    } finally {
        sessionPending.value = false;
    }
}
const switchSession = (value: string) => sessionAction(() => agent.switchSession(Number(value)), "切换会话失败");
const newSession = () => sessionAction(async () => {
    confirmingDelete.value = false;
    await agent.newSession();
}, "新建会话失败");
const deleteSession = () => sessionAction(async () => {
    const sessionId = agent.activeSessionId.value;
    if (sessionId === null) return;
    await agent.deleteSession(sessionId);
    confirmingDelete.value = false;
}, "删除会话失败");

/** 主创会话绑定了创建时的模型，保存主创设置后让当前会话改为跟随角色设置。 */
async function onRoleSaved(role: WritingRole): Promise<void> {
    if (role !== "lead") return;
    try {
        await agent.followRoleSettings();
    } catch (cause) {
        notification.error(resolveApiErrorMessage(cause, "当前会话未能切换到新模型"), {title: "模型设置已保存"});
    }
}

const runs = computed(() => store.chapterRuns.filter((run) => store.runProgress.has(run.runId)));
const latestRunId = computed(() => store.chapterRuns.at(-1)?.runId ?? null);
const earlierRuns = computed(() => runs.value.slice(0, -1));
const shownRuns = computed(() => (showEarlierRuns.value ? runs.value : runs.value.slice(-1)));
const writerOutputs = computed(() => shownRuns.value.flatMap(run => {
    const progress = store.runProgress.get(run.runId)!;
    const running = progress.status === "running" && !progress.interrupted;
    if (progress.kind === "rewrite") return progress.attempts.map((attempt, index) => ({
        key: `${run.runId}:rewrite:${index}`, runId: run.runId, attempt,
        title: `写手 · 局部改写 · 第 ${index + 1} 次`,
        active: running && index === progress.attempts.length - 1 && attempt.output === null,
    }));
    return progress.scenes.flatMap(scene => scene.attempts.map((attempt, index) => ({
        key: `${run.runId}:${scene.index}:${index}`, runId: run.runId, attempt,
        title: `写手 · ${scene.heading} · 第 ${index + 1} 次`,
        active: running && index === scene.attempts.length - 1 && attempt.output === null
            && (scene.state === "writing" || scene.state === "retrying"),
    })));
}));
/** 用户确认只能在卡片上完成；收起的抽屉在出现待确认项时自动展开，避免确认被藏住而让运行一直等待。 */
const runsAwaitingUser = computed(() => runs.value.some((run) => store.runProgress.get(run.runId)!.asks
    .some(({role}) => role === "user-confirm" || role === "rewrite-confirm")));
watch(runsAwaitingUser, (waiting) => {
    if (waiting) runsOpen.value = true;
});

/** 主创没有 @ 引用与技能菜单；返回空分组时输入框不会弹出菜单。 */
const EMPTY_MENU: AgentTriggerMenuState = {title: "", prefix: "", sections: []};
const resolveMenu = (): AgentTriggerMenuState => EMPTY_MENU;

watch(() => chapter.value?.entryId, () => {
    confirmingDelete.value = false;
    prompt.value = "";
    inputGeneration.value += 1;
    pendingError.value = null;
    showEarlierRuns.value = false;
});

watch(pendingSessions, (sessions) => {
    const current = agent.pendingDraft.value;
    const next: AgentPendingResolutionDraft = {answers: {}, forms: {}};
    for (const session of sessions) {
        if (session.form && session.formToolCallId) {
            const key = `form:${session.formToolCallId}`;
            next.forms[key] = current.forms[key] ?? {data: {}, confirmed: false};
        }
        for (const question of session.questions) {
            const key = pendingQuestionKey(question.toolCallId ?? question.toolNodeId, question.questionIndex);
            next.answers[key] = current.answers[key] ?? {note: ""};
        }
    }
    agent.pendingDraft.value = next;
}, {deep: true, immediate: true});

// 预填文字要等这一章的会话载入完再取走，否则发送可能落到切换前的会话。
watch([() => store.composerDraft, () => chapter.value?.entryId, agent.loading], ([draft, chapterEntryId, loading]) => {
    if (!draft || loading || draft.chapterEntryId !== chapterEntryId) return;
    store.consumeComposerDraft(draft.token);
    prompt.value = draft.text;
    inputGeneration.value += 1;
    if (draft.send) void send();
}, {immediate: true});

async function send(): Promise<void> {
    const text = prompt.value.trim();
    if (!text || readonly.value) return;
    prompt.value = "";
    // 输入框是 TipTap 编辑器，外部清空需要换代才会重建文档。
    inputGeneration.value += 1;
    if (await agent.sendPrompt(text)) store.pollSoon();
}

function onSubmitButton(): void {
    if (agent.running.value) {
        void agent.abort();
        return;
    }
    void send();
}

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
        pendingError.value = "请先回答所有问题";
        return;
    }
    await agent.submitPending(result.resolutions);
    store.pollSoon();
}

async function runAction(runId: string, operation: () => Promise<void>, failure: string): Promise<void> {
    pendingRunId.value = runId;
    try {
        await operation();
    } catch (cause) {
        notification.error(resolveApiErrorMessage(cause, failure), {title: failure});
    } finally {
        pendingRunId.value = null;
    }
}
const stopRun = (runId: string) => runAction(runId, () => store.stopRun(runId), "停止写作失败");
const continueRun = (runId: string, chapterEntryId: string) => runAction(runId, () => store.continueChapter(chapterEntryId), "继续写作失败");
const answerRun = (runId: string, key: string, decision: WritingUserDecision) =>
    runAction(runId, () => store.answerRun(runId, key, decision), "提交确认失败");

async function copyMessage(message: Parameters<typeof agent.copyMessage>[0]): Promise<void> {
    try {
        await agent.copyMessage(message);
        notification.success("消息已复制");
    } catch (cause) {
        notification.error(resolveApiErrorMessage(cause, "复制消息失败"), {title: "复制消息失败"});
    }
}

async function editMessage(message: Parameters<typeof agent.startEditingMessage>[0]): Promise<void> {
    try {
        await agent.startEditingMessage(message);
    } catch (cause) {
        notification.error(resolveApiErrorMessage(cause, "读取消息失败"), {title: "编辑消息失败"});
    }
}

async function saveEditedMessage(payload: Parameters<typeof agent.saveEditedMessage>[0]): Promise<void> {
    try {
        await agent.saveEditedMessage(payload);
    } catch (cause) {
        notification.error(resolveApiErrorMessage(cause, "保存修改失败"), {title: "保存修改失败"});
    }
}

async function retryMessage(message: Parameters<typeof agent.retryMessage>[0]): Promise<void> {
    try {
        await agent.retryMessage(message);
    } catch (cause) {
        notification.error(resolveApiErrorMessage(cause, "重新生成失败"), {title: "重新生成失败"});
    }
}

async function branchFromMessage(message: Parameters<typeof agent.branchFromMessage>[0]): Promise<void> {
    try {
        await agent.branchFromMessage(message);
    } catch (cause) {
        notification.error(resolveApiErrorMessage(cause, "新开分支失败"), {title: "新开分支失败"});
    }
}
</script>

<template>
    <div class="writing-session-view">
        <EmptyState v-if="!chapter" class="session-empty" icon-class="i-lucide-feather" title="还没有选中章节" description="在左侧大纲中选一章，这里会显示它的写作会话。" />

        <template v-else>
            <header class="session-header">
                <div class="session-title">
                    <strong>{{ chapter.title }}</strong>
                    <Badge size="sm" variant="soft" :tone="statusTone">{{ chapterStatusLabel(chapter.status) }}</Badge>
                </div>
                <p v-if="blockReasons.length" class="session-block">不能写作：{{ blockReasons.join("、") }}</p>
                <span v-else class="session-status">主创{{ agent.running.value ? "正在回复…" : "" }}</span>
                <div class="session-controls">
                    <div v-if="sessionOptions.length" class="session-picker">
                        <FormSelect size="sm" :model-value="String(agent.activeSessionId.value ?? '')"
                            :options="sessionOptions" aria-label="本章会话" :disabled="sessionLocked" @update:model-value="switchSession" />
                    </div>
                    <span v-else class="session-picker session-picker-empty">还没有会话</span>
                    <IconButton size="sm" title="新建会话" aria-label="新建会话" icon-class="i-lucide-plus"
                        :disabled="sessionLocked || !chapter.writable" @click="void newSession()" />
                    <IconButton size="sm" :title="deleteBlocker ?? '删除当前会话'" aria-label="删除当前会话" icon-class="i-lucide-trash-2"
                        :disabled="deleteBlocker !== null || sessionPending" @click="confirmingDelete = true" />
                </div>
                <div v-if="confirmingDelete && agent.activeSessionId.value !== null" class="session-confirm" role="group" aria-label="确认删除会话">
                    <span>删除当前会话？会话会归档，可在会话列表中恢复。</span>
                    <Button size="sm" variant="danger" :disabled="deleteBlocker !== null || sessionPending" @click="void deleteSession()">删除</Button>
                    <Button size="sm" variant="ghost" :disabled="sessionPending" @click="confirmingDelete = false">取消</Button>
                </div>
            </header>

            <div class="session-stream" aria-live="polite">
                <p v-if="agent.loading.value && !agent.messages.value.length" class="session-loading" role="status" aria-busy="true">正在载入会话…</p>
                <AgentChatFlow
                    v-else
                    :messages="agent.messages.value"
                    :session-id="agent.activeSessionId.value"
                    :running="agent.running.value"
                    :editing-message-id="agent.editingMessageId.value"
                    :editing-message-text="agent.editingMessageText.value"
                    :message-action-disabled="agent.messageActionDisabled.value"
                    :run-action-disabled="agent.runActionDisabled.value"
                    :saving-edit="agent.savingEdit.value"
                    mode="main"
                    :project-root="store.projectRoot"
                    @copy="void copyMessage($event)"
                    @start-edit="void editMessage($event)"
                    @cancel-edit="agent.cancelEditingMessage"
                    @save-edit="void saveEditedMessage($event)"
                    @retry="void retryMessage($event)"
                    @branch-from-here="void branchFromMessage($event)"
                >
                    <template #empty>
                        <p class="session-hint">这一章还没有对话。告诉主创你的想法，或让它开始写这一章。</p>
                    </template>
                </AgentChatFlow>

                <section v-if="writerOutputs.length && store.projectRoot" class="session-writer-outputs" aria-label="写手输出">
                    <WritingWriterOutput v-for="item in writerOutputs" :key="item.key"
                        :project-root="store.projectRoot" :run-id="item.runId" :title="item.title"
                        :attempt="item.attempt" :active="item.active" />
                </section>

                <section v-if="runs.length || store.chapterRunsError" class="session-runs" aria-label="写作进度">
                    <button type="button" class="runs-toggle nb-ui-focus-ring" :aria-expanded="runsOpen" aria-controls="writing-runs-body"
                        @click="runsOpen = !runsOpen">
                        <span :class="runsOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"></span>
                        <span>写作进度</span>
                        <Badge v-if="!runsOpen && runsAwaitingUser" size="sm" variant="soft" tone="warning">等待确认</Badge>
                    </button>
                    <div v-show="runsOpen" id="writing-runs-body" class="runs-body">
                        <div v-if="store.chapterRunsError" class="session-error" role="alert">
                            <span class="i-lucide-circle-alert"></span><span>{{ store.chapterRunsError }}</span>
                            <Button size="sm" variant="ghost" @click="void store.refreshRuns()">重试</Button>
                        </div>
                        <button v-if="earlierRuns.length" type="button" class="earlier-toggle nb-ui-focus-ring" :aria-expanded="showEarlierRuns"
                            @click="showEarlierRuns = !showEarlierRuns">
                            {{ showEarlierRuns ? "收起更早的运行" : `更早的运行（${earlierRuns.length}）` }}
                        </button>
                        <WritingRunCard
                            v-for="run in shownRuns"
                            :key="run.runId"
                            :progress="store.runProgress.get(run.runId)!"
                            :latest="run.runId === latestRunId"
                            :connection-lost="store.connectionLost && run.runId === latestRunId"
                            :pending="pendingRunId === run.runId"
                            @stop="stopRun"
                            @continue="continueRun(run.runId, $event)"
                            @answer="answerRun"
                        />
                    </div>
                </section>
            </div>

            <div class="session-footer">
                <div v-if="agent.error.value && !pendingSessions.length" class="session-error" role="alert">
                    <span class="i-lucide-circle-alert"></span><span>{{ agent.error.value }}</span>
                    <Button size="sm" variant="ghost" @click="void agent.reload()">重试</Button>
                </div>

                <AgentUserInputPrompt
                    v-if="pendingSessions.length"
                    :sessions="pendingSessions"
                    :draft="agent.pendingDraft.value"
                    :submitting="agent.pendingSubmission.value"
                    :can-resolve="!agent.pendingSubmission.value"
                    :can-abort="true"
                    :submission-issue="submissionIssue"
                    menu-refresh-key="writing"
                    :resolve-menu="resolveMenu"
                    @update:draft="updateDraft"
                    @submit="void submitPending()"
                    @cancel="void agent.abort()"
                    @resync="pendingError = null"
                />

                <div v-else class="composer-card" :data-disabled="!chapter.writable">
                    <AgentComposerInput
                        v-model="prompt"
                        borderless
                        :generation="inputGeneration"
                        :placeholder="placeholder"
                        aria-label="写作会话输入"
                        :readonly="readonly"
                        :enable-image-files="false"
                        :resolve-menu="resolveMenu"
                        @submit="void send()"
                    />
                    <div class="composer-toolbar">
                        <span class="composer-profile"><span class="i-lucide-feather"></span>主创</span>
                        <button
                            type="button"
                            class="send-button nb-ui-focus-ring"
                            :disabled="!agent.running.value && !canSend"
                            :title="agent.running.value ? '停止回复' : '发送'"
                            :aria-label="agent.running.value ? '停止回复' : '发送'"
                            @click="onSubmitButton"
                        >
                            <span :class="agent.running.value ? 'i-lucide-square' : 'i-lucide-send-horizontal'"></span>
                        </button>
                    </div>
                </div>
                <div class="session-bottom-toolbar">
                    <WritingRoleModelsPopover :project-root="store.projectRoot" :disabled="busy" @saved="onRoleSaved" />
                    <span>模型设置</span>
                </div>
            </div>
        </template>
    </div>
</template>

<style scoped>
/* 变量名必须存在于 nb-ui 配色契约与 tokens.css；写错的变量会让整条声明静默失效。 */
.writing-session-view { display: flex; height: 100%; min-height: 0; min-width: 0; flex-direction: column; background: var(--bg-sidebar); }
.session-empty { margin: auto; padding: var(--space-6); }

.session-header { display: grid; flex: 0 0 auto; gap: var(--space-1); border-bottom: 1px solid var(--border-color); padding: var(--space-4) var(--space-5); }
.session-title { display: flex; min-width: 0; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
.session-title strong { min-width: 0; overflow-wrap: anywhere; font-size: var(--text-sm); font-weight: var(--weight-strong); }
.session-block { margin: 0; color: var(--status-warning); font-size: var(--text-2xs); }
.session-status { color: var(--text-muted); font-size: var(--text-2xs); }
/* 下拉触发器默认占满父级；先限定可收缩的网格列，长会话标题才不会挤掉两侧操作。 */
.session-controls { display: grid; min-width: 0; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: var(--space-1); }
.session-picker { min-width: 0; }
.session-picker-empty { color: var(--text-muted); font-size: var(--text-2xs); }
.session-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); border: 1px solid var(--status-danger-border); border-radius: var(--radius-control); background: var(--status-danger-bg); padding: var(--space-2) var(--space-3); color: var(--text-main); font-size: var(--text-2xs); }
.session-confirm > span { min-width: 0; flex: 1; overflow-wrap: anywhere; }

.session-stream { display: flex; min-height: 0; flex: 1; flex-direction: column; gap: var(--space-4); overflow-x: hidden; overflow-y: auto; padding: var(--space-4) var(--space-5); }
.session-loading, .session-hint { margin: auto 0; color: var(--text-muted); font-size: var(--text-xs); text-align: center; }
.session-writer-outputs { display: grid; flex: 0 0 auto; min-width: 0; gap: var(--space-2); }
.session-runs { display: grid; flex: 0 0 auto; gap: var(--space-2); }
.runs-toggle { display: inline-flex; justify-self: start; align-items: center; gap: var(--space-2); border: 0; border-radius: var(--radius-control); background: transparent; padding: var(--space-1) var(--space-2); color: var(--text-secondary); cursor: pointer; font-size: var(--text-2xs); }
.runs-toggle:hover { background: var(--bg-subtle); }
/* 进度卡片内容随场景与尝试增长；限高后对话流始终保有可见区域。 */
.runs-body { display: grid; max-height: 45vh; gap: var(--space-3); overflow-x: hidden; overflow-y: auto; }
.earlier-toggle { justify-self: start; border: 0; background: transparent; padding: 0; color: var(--accent-text); cursor: pointer; font-size: var(--text-2xs); }

.session-footer { display: grid; flex: 0 0 auto; gap: var(--space-3); padding: 0 var(--space-4) var(--space-4); }
.session-bottom-toolbar { display: flex; min-width: 0; align-items: center; gap: var(--space-1); color: var(--text-muted); font-size: var(--text-2xs); }
.session-error { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); border: 1px solid var(--status-danger-border); border-radius: var(--radius-control); background: var(--status-danger-bg); padding: var(--space-2) var(--space-4); color: var(--status-danger); font-size: var(--text-2xs); line-height: var(--leading-ui); }
.session-error > span:nth-child(2) { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.composer-card { display: flex; flex-direction: column; border: 1px solid var(--border-color); border-radius: 0.75rem; background: var(--bg-panel); transition: border-color var(--motion-fast) var(--ease-standard), box-shadow var(--motion-fast) var(--ease-standard); }
.composer-card:focus-within { border-color: var(--accent-main); box-shadow: 0 0 0 1px var(--accent-main); }
.composer-card[data-disabled="true"] { background: var(--bg-subtle); }
.composer-toolbar { display: flex; align-items: center; gap: var(--space-3); border-top: 1px solid var(--border-color); padding: var(--space-3) var(--space-4); }
.composer-profile { display: inline-flex; align-items: center; gap: var(--space-2); color: var(--text-secondary); font-size: var(--text-2xs); }
.send-button { display: flex; width: 26px; height: 26px; flex: 0 0 auto; align-items: center; justify-content: center; margin-left: auto; border: 1px solid transparent; border-radius: var(--radius-control); background: var(--accent-main); color: var(--text-inverse); cursor: pointer; font-size: 14px; transition: background var(--motion-fast) var(--ease-standard); }
.send-button:hover:not(:disabled) { background: color-mix(in srgb, var(--accent-main) 86%, var(--text-main)); }
.send-button:disabled { cursor: not-allowed; opacity: .4; }
</style>
