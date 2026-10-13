import {computed, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter} from "vue";
import {resolveApiErrorMessage} from "nbook/app/utils/api-error";
import {useAgentSessionApi} from "nbook/app/composables/useAgentSessionApi";
import {useAgentSession} from "nbook/app/components/novel-ide/agent/useAgentSession";
import {useAgentSessionStream} from "nbook/app/components/novel-ide/agent/useAgentSessionStream";
import type {AgentMessage} from "nbook/app/components/novel-ide/agent/agent-message";
import {agentMessageMarkdown} from "nbook/app/components/novel-ide/agent/agent-user-message-markdown";
import type {AgentPendingResolutionDraft} from "nbook/app/components/novel-ide/agent/agent-pending-resolution";
import {createWritingApi} from "nbook/app/utils/writing/writing-api";
import type {WritingChapterSessionItemDto} from "nbook/shared/dto/writing.dto";

/**
 * 写作会话：一章可以有多个主创会话，由服务端按章节标签查找或创建，Profile 由服务端决定。
 * 默认打开最近更新的会话；章节、项目或会话切换时换代，旧会话的恢复、流与发送结果在发布前都要经过代号检查。
 * 这一章还没有会话时只显示空状态，第一次发送才创建。
 */
export function useWritingChapterAgent(projectRoot: MaybeRefOrGetter<string | null>, chapterEntryId: MaybeRefOrGetter<string | null>) {
    const api = useAgentSessionApi();
    const session = useAgentSession();
    const activeSessionId = ref<number | null>(null);
    const loading = ref(false);
    const error = ref<string | null>(null);
    const pendingSubmission = ref(false);
    const pendingDraft = ref<AgentPendingResolutionDraft>({answers: {}, forms: {}});
    const sessions = ref<WritingChapterSessionItemDto[]>([]);
    const messageActionId = ref<string | null>(null);
    const editingMessageId = ref<string | null>(null);
    const editingMessageText = ref("");
    const savingEdit = ref(false);
    let generation = 0;

    const stream = useAgentSessionStream({
        session,
        api,
        activeSessionId,
        onError: (cause, fallback) => { error.value = resolveApiErrorMessage(cause, fallback); },
    });

    async function attach(sessionId: number, current: number): Promise<boolean> {
        const recovery = await api.getSessionRecovery(sessionId);
        if (current !== generation) return false;
        activeSessionId.value = sessionId;
        session.applyRecovery(recovery);
        await stream.start(sessionId);
        return current === generation;
    }

    function detach(): number {
        const current = ++generation;
        stream.stop();
        session.reset();
        activeSessionId.value = null;
        pendingDraft.value = {answers: {}, forms: {}};
        pendingSubmission.value = false;
        error.value = null;
        messageActionId.value = null;
        editingMessageId.value = null;
        editingMessageText.value = "";
        savingEdit.value = false;
        return current;
    }

    /** 载入这一章的会话列表并打开 target（缺省为最近更新的一个）；没有会话不是错误。 */
    async function load(target?: number): Promise<void> {
        const root = toValue(projectRoot);
        const chapter = toValue(chapterEntryId);
        const current = detach();
        if (target === undefined) sessions.value = [];
        if (!root || !chapter) {
            sessions.value = [];
            return;
        }
        loading.value = true;
        try {
            const list = await createWritingApi(root).chapterSessions(chapter);
            if (current !== generation) return;
            sessions.value = list;
            const sessionId = list.find(({sessionId: id}) => id === target)?.sessionId ?? list[0]?.sessionId;
            if (sessionId === undefined) return;
            await attach(sessionId, current);
        } catch (cause) {
            if (current === generation) error.value = resolveApiErrorMessage(cause, "写作会话读取失败");
        } finally {
            if (current === generation) loading.value = false;
        }
    }

    async function ensureSession(): Promise<number | null> {
        if (activeSessionId.value !== null) return activeSessionId.value;
        const root = toValue(projectRoot);
        const chapter = toValue(chapterEntryId);
        if (!root || !chapter) return null;
        const current = generation;
        loading.value = true;
        try {
            const {sessionId} = await createWritingApi(root).ensureChapterSession(chapter);
            if (current !== generation || sessionId === null) return null;
            const list = await createWritingApi(root).chapterSessions(chapter);
            if (current !== generation) return null;
            sessions.value = list;
            return await attach(sessionId, current) ? sessionId : null;
        } catch (cause) {
            if (current === generation) error.value = resolveApiErrorMessage(cause, "创建写作会话失败");
            return null;
        } finally {
            if (current === generation) loading.value = false;
        }
    }

    const idle = () => !session.running.value && !pendingSubmission.value && session.pendingUserInputSessions.value.length === 0;

    function switchSession(sessionId: number): Promise<void> {
        return sessionId === activeSessionId.value ? Promise.resolve() : load(sessionId);
    }

    /** 新建后立即打开；旧会话保留在列表里。 */
    async function newSession(): Promise<void> {
        const root = toValue(projectRoot);
        const chapter = toValue(chapterEntryId);
        if (!root || !chapter || !idle()) return;
        try {
            const {sessionId} = await createWritingApi(root).startChapterSession(chapter);
            await load(sessionId ?? undefined);
        } catch (cause) {
            error.value = resolveApiErrorMessage(cause, "新建会话失败");
        }
    }

    /** 删除当前会话时改开剩下的最近一个；失败时抛给调用方提示。 */
    async function deleteSession(sessionId: number): Promise<void> {
        const root = toValue(projectRoot);
        const chapter = toValue(chapterEntryId);
        if (!root || !chapter) return;
        const list = await createWritingApi(root).deleteChapterSession(chapter, sessionId);
        if (sessionId === activeSessionId.value) {
            await load();
        } else {
            sessions.value = list;
        }
    }

    /**
     * 会话创建时会绑定当时的模型，并可能带有单独的思考档位；清掉这两项后，
     * 下一轮按角色设置重新解析。主创回复中不能改运行参数，此时不做。
     */
    async function followRoleSettings(): Promise<void> {
        const sessionId = activeSessionId.value;
        if (!sessionId || !idle()) return;
        await api.runCommand(sessionId, {command: "model", modelKey: null});
        await api.runCommand(sessionId, {command: "thinking", thinkingLevel: null});
    }

    async function sendPrompt(text: string): Promise<boolean> {
        const message = text.trim();
        if (!message || session.running.value || pendingSubmission.value) return false;
        const current = generation;
        const sessionId = await ensureSession();
        if (!sessionId || current !== generation) return false;
        const clientMessageId = crypto.randomUUID();
        session.appendOptimisticUserMessage(clientMessageId, message, [], "prompt");
        error.value = null;
        try {
            await stream.ensure();
            if (current !== generation) return false;
            const result = await api.invokeSession(sessionId, {mode: "prompt", clientMessageId, message: {text: message}});
            if (current !== generation) return false;
            if (result.status === "error") {
                session.markOptimisticUserMessageUnknown(clientMessageId);
                error.value = result.error ?? "主创调用失败";
            }
            await stream.refreshRecovery(result.status === "error" ? "invoke_error_fallback" : "active_path_changed");
            return result.status !== "error";
        } catch (cause) {
            if (current !== generation) return false;
            session.markOptimisticUserMessageUnknown(clientMessageId);
            error.value = resolveApiErrorMessage(cause, "发送失败");
            return false;
        }
    }

    async function abort(): Promise<void> {
        const sessionId = activeSessionId.value;
        if (!sessionId) return;
        try {
            await api.abortSession(sessionId, {reason: "user abort", clearQueue: true});
            await stream.refreshRecovery("manual_refresh");
        } catch (cause) {
            error.value = resolveApiErrorMessage(cause, "停止主创失败");
        }
    }

    async function submitPending(resolutions: Parameters<typeof api.invokeSession>[1]["resolutions"]): Promise<void> {
        const sessionId = activeSessionId.value;
        if (!sessionId || !resolutions?.length || pendingSubmission.value) return;
        const current = generation;
        pendingSubmission.value = true;
        try {
            await stream.ensure();
            if (current !== generation) return;
            const result = await api.invokeSession(sessionId, {mode: "continue", resolutions});
            if (current !== generation) return;
            if (result.status === "error") error.value = result.error ?? "提交确认失败";
            await stream.refreshRecovery(result.status === "error" ? "invoke_error_fallback" : "active_path_changed");
        } catch (cause) {
            if (current === generation) error.value = resolveApiErrorMessage(cause, "提交确认失败");
        } finally {
            if (current === generation) pendingSubmission.value = false;
        }
    }

    // 写作视图直接承载 AgentChatFlow，历史动作必须在这里补齐会话树写入与 SSE recovery；不能只把气泡事件留在视图边界。
    const messageActionDisabled = computed(() => !activeSessionId.value
        || messageActionId.value !== null
        || session.recoveryShell.value?.summary.interaction?.canMutateHistory !== true);
    const runActionDisabled = computed(() => messageActionDisabled.value || session.running.value || pendingSubmission.value);

    async function resolveMessageText(message: AgentMessage): Promise<string | null> {
        const local = agentMessageMarkdown(message);
        if (local !== null) return local;
        if (activeSessionId.value && message.type === "user" && !message.id.startsWith("optimistic-user-")) {
            return (await api.getSessionUserContent(activeSessionId.value, message.id)).text;
        }
        return null;
    }

    async function copyMessage(message: AgentMessage): Promise<void> {
        const text = await resolveMessageText(message);
        if (!text?.trim()) return;
        await navigator.clipboard.writeText(text);
    }

    async function startEditingMessage(message: AgentMessage): Promise<void> {
        if (runActionDisabled.value || message.type !== "user") return;
        messageActionId.value = message.id;
        try {
            const text = await resolveMessageText(message);
            if (text === null) return;
            editingMessageText.value = text;
            editingMessageId.value = message.id;
        } finally {
            messageActionId.value = null;
        }
    }

    function cancelEditingMessage(): void {
        editingMessageId.value = null;
        editingMessageText.value = "";
    }

    async function saveEditedMessage(payload: {message: AgentMessage; content: string}): Promise<void> {
        const sessionId = activeSessionId.value;
        if (!sessionId || runActionDisabled.value || savingEdit.value) return;
        messageActionId.value = payload.message.id;
        savingEdit.value = true;
        try {
            await stream.ensure();
            const result = await api.moveTree(sessionId, {
                targetEntryId: payload.message.id,
                position: "before",
                next: {type: "invoke", mode: "prompt", clientMessageId: crypto.randomUUID(), message: {text: payload.content}},
            });
            session.applyLiveState(result.state);
            await stream.refreshRecovery(result.invocation?.status === "error" ? "invoke_error_fallback" : "active_path_changed");
            cancelEditingMessage();
        } finally {
            savingEdit.value = false;
            messageActionId.value = null;
        }
    }

    async function retryMessage(message: AgentMessage): Promise<void> {
        const sessionId = activeSessionId.value;
        if (!sessionId || runActionDisabled.value) return;
        messageActionId.value = message.id;
        try {
            await stream.ensure();
            const result = await api.moveTree(sessionId, {
                targetEntryId: message.id,
                position: message.type === "user" ? "at" : "before",
                next: {type: "invoke", mode: "continue"},
            });
            session.applyLiveState(result.state);
            await stream.refreshRecovery(result.invocation?.status === "error" ? "invoke_error_fallback" : "active_path_changed");
        } finally {
            messageActionId.value = null;
        }
    }

    async function branchFromMessage(message: AgentMessage): Promise<void> {
        const sessionId = activeSessionId.value;
        if (!sessionId || runActionDisabled.value) return;
        messageActionId.value = message.id;
        try {
            const result = await api.moveTree(sessionId, {targetEntryId: message.id, position: "at"});
            session.applyLiveState(result.state);
            await stream.refreshRecovery("active_path_changed");
        } finally {
            messageActionId.value = null;
        }
    }

    watch([() => toValue(projectRoot), () => toValue(chapterEntryId)], () => { void load(); }, {immediate: true});

    onScopeDispose(() => {
        generation += 1;
        stream.stop();
    });

    return {
        activeSessionId,
        sessions,
        loading,
        error,
        pendingDraft,
        pendingSubmission,
        messages: session.messages,
        running: session.running,
        pendingUserInputSessions: session.pendingUserInputSessions,
        messageActionId,
        editingMessageId,
        editingMessageText,
        savingEdit,
        messageActionDisabled,
        runActionDisabled,
        reload: () => load(activeSessionId.value ?? undefined),
        switchSession,
        newSession,
        deleteSession,
        followRoleSettings,
        sendPrompt,
        abort,
        submitPending,
        copyMessage,
        startEditingMessage,
        cancelEditingMessage,
        saveEditedMessage,
        retryMessage,
        branchFromMessage,
    };
}
