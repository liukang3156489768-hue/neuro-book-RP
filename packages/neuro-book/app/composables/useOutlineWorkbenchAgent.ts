import {computed, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter} from "vue";
import type {ConfigBootstrapDto} from "nbook/shared/dto/config.dto";
import {resolveApiErrorMessage} from "nbook/app/utils/api-error";
import {useAgentSessionApi} from "nbook/app/composables/useAgentSessionApi";
import {useAgentSession} from "nbook/app/components/novel-ide/agent/useAgentSession";
import {useAgentSessionStream} from "nbook/app/components/novel-ide/agent/useAgentSessionStream";
import type {AgentPendingUserInputSession} from "nbook/app/components/novel-ide/agent/agent-message";
import type {AgentPendingResolutionDraft} from "nbook/app/components/novel-ide/agent/agent-pending-resolution";
import type {OutlineWorkbenchCreationMode} from "nbook/shared/storage/outline-workbench";
import type {OutlineWorkbenchSession} from "nbook/app/utils/outline/outline-workbench-session";
import {formatOutlineWorkbenchPrompt} from "nbook/app/utils/outline/outline-workbench-message";

export type OutlinePlannerSessionState = Readonly<{
    activeSessionId: number | null;
    projectRoot: string | null;
    generation: number;
}>;

/**
 * 工作台专用规划会话。Project 身份是这个 composable 的所有权边界，旧会话的
 * SSE、恢复结果和 invoke 结果都必须在发布前经过 generation 检查。
 *
 * 会话持久化：会话 ID 保存到工作台记录中，退出工作台或重启项目后仍然保留。
 */
export function useOutlineWorkbenchAgent(projectRoot: MaybeRefOrGetter<string | null>, settings: {
    mode: MaybeRefOrGetter<"discuss" | "auto">;
    modelKey: MaybeRefOrGetter<string | undefined>;
    temperature: MaybeRefOrGetter<number>;
    thinkingEnabled: MaybeRefOrGetter<boolean>;
    creationMode?: MaybeRefOrGetter<OutlineWorkbenchCreationMode>;
    planId?: MaybeRefOrGetter<string | null>;
}, options?: {
    workbenchSession?: Pick<OutlineWorkbenchSession, "state" | "loading" | "commit">;
}) {
    const api = useAgentSessionApi();
    const session = useAgentSession();
    const activeSessionId = ref<number | null>(null);
    const activeProjectRoot = ref<string | null>(null);
    const generation = ref(0);
    const loading = ref(false);
    const error = ref<string | null>(null);
    const pendingSubmission = ref(false);
    const pendingDraft = ref<AgentPendingResolutionDraft>({answers: {}, forms: {}});
    /** 创作模式是会话初始合同；当前设置只在创建新会话时读取。 */
    const sessionCreationMode = ref<OutlineWorkbenchCreationMode>(toValue(settings.creationMode) ?? "original");
    let operationGeneration = 0;

    const stream = useAgentSessionStream({
        session,
        api,
        activeSessionId,
        onError: (cause, fallback) => {
            if (operationGeneration === generation.value) error.value = resolveApiErrorMessage(cause, fallback);
        },
    });

    const messages = session.messages;
    const running = session.running;
    const connectionStatus = session.connectionStatus;
    const runPhase = session.runPhase;
    const pendingUserInputSessions = session.pendingUserInputSessions;
    const pendingUserInputSession = session.pendingUserInputSession;

    const currentState = computed<OutlinePlannerSessionState>(() => ({
        activeSessionId: activeSessionId.value,
        projectRoot: activeProjectRoot.value,
        generation: generation.value,
    }));

    function savedSession(sessionId: number) {
        return options?.workbenchSession?.state.value.sessions.find((item) => item.sessionId === sessionId);
    }

    function creationModeForSession(sessionId: number): OutlineWorkbenchCreationMode {
        return savedSession(sessionId)?.creationMode ?? sessionCreationMode.value;
    }

    const creationModeLocked = computed(() => Boolean(activeSessionId.value && (savedSession(activeSessionId.value)?.started === true
        || messages.value.some((message) => message.type === "user"))));

    function isCurrent(root: string, currentGeneration: number): boolean {
        // 创建新会话时尚未绑定 activeProjectRoot；generation 已经隔离了切换期间的旧异步结果。
        return (activeProjectRoot.value === null || activeProjectRoot.value === root)
            && generation.value === currentGeneration
            && toValue(projectRoot) === root;
    }

    async function resolveModel(root: string): Promise<string> {
        const bootstrap = await $fetch<ConfigBootstrapDto>("/api/config/bootstrap", {
            query: {workspaceKind: "novel", projectRoot: root},
        });
        const requested = toValue(settings.modelKey);
        const enabled = bootstrap.modelSettings.enabledModels.map((model) => model.key);
        const candidate = requested
            || bootstrap.modelSettings.enabledModels.find((model) => model.label === bootstrap.modelSettings.defaultModelLabel)?.key;
        if (candidate && enabled.includes(candidate)) return candidate;
        const fallback = enabled[0];
        if (!fallback) throw new Error("当前没有可用的 Agent 模型，请先在设置中启用模型");
        return fallback;
    }

    async function createNewSession(): Promise<number | null> {
        const root = toValue(projectRoot);
        if (!root) return null;

        const currentGeneration = generation.value;
        loading.value = true;
        error.value = null;

        try {
            const model = await resolveModel(root);
            if (!isCurrent(root, currentGeneration)) return null;

            const created = await api.createSession({
                profileKey: "outline.planner",
                currentProjectRoot: root,
                initial: {
                    projectRoot: root,
                    scope: {includeAnalysis: true},
                    mode: toValue(settings.mode),
                    model,
                    temperature: toValue(settings.temperature),
                    thinking: toValue(settings.thinkingEnabled) ? "medium" : "off",
                    creationMode: toValue(settings.creationMode) ?? "original",
                },
            });
            if (!isCurrent(root, currentGeneration)) return null;

            // 同步运行时设置
            await api.runCommand(created.sessionId, {command: "mode", mode: toValue(settings.mode) === "auto" ? "normal" : "discuss"});
            if (!isCurrent(root, currentGeneration)) return null;
            await api.runCommand(created.sessionId, {command: "model", modelKey: model});
            if (!isCurrent(root, currentGeneration)) return null;
            await api.runCommand(created.sessionId, {command: "thinking", thinkingLevel: toValue(settings.thinkingEnabled) ? "medium" : "off"});
            if (!isCurrent(root, currentGeneration)) return null;

            // 停止旧会话的流
            if (activeSessionId.value) {
                stream.stop();
            }

            activeSessionId.value = created.sessionId;
            activeProjectRoot.value = root;
            sessionCreationMode.value = toValue(settings.creationMode) ?? "original";

            const recovery = await api.getSessionRecovery(created.sessionId);
            if (!isCurrent(root, currentGeneration)) return null;
            session.applyRecovery(recovery);
            pendingDraft.value = {answers: {}, forms: {}};
            await stream.start(created.sessionId);

            // 保存新会话到工作台记录
            if (options?.workbenchSession) {
                const existingSessions = options.workbenchSession.state.value.sessions || [];
                await options.workbenchSession.commit({
                    activeSessionId: created.sessionId,
                    sessions: [
                        ...existingSessions,
                        {
                            sessionId: created.sessionId,
                            title: "新会话",
                            creationMode: toValue(settings.creationMode) ?? "original",
                            started: false,
                            createdAt: Date.now(),
                            lastActiveAt: Date.now(),
                        }
                    ]
                });
            }

            return created.sessionId;
        } catch (cause) {
            if (isCurrent(root, currentGeneration)) error.value = resolveApiErrorMessage(cause, "创建新会话失败");
            return null;
        } finally {
            if (isCurrent(root, currentGeneration)) loading.value = false;
        }
    }

    async function switchSession(sessionId: number): Promise<boolean> {
        const root = toValue(projectRoot);
        if (!root) return false;
        if (activeSessionId.value === sessionId) return true;

        const currentGeneration = generation.value;
        loading.value = true;
        error.value = null;

        try {
            // 停止当前会话的流
            stream.stop();

            // 加载目标会话
            const recovery = await api.getSessionRecovery(sessionId);
            if (!isCurrent(root, currentGeneration)) return false;

            activeSessionId.value = sessionId;
            activeProjectRoot.value = root;
            sessionCreationMode.value = creationModeForSession(sessionId);
            session.applyRecovery(recovery);
            pendingDraft.value = {answers: {}, forms: {}};

            // 更新运行时设置
            await api.runCommand(sessionId, {command: "mode", mode: toValue(settings.mode) === "auto" ? "normal" : "discuss"});
            if (!isCurrent(root, currentGeneration)) return false;

            const model = await resolveModel(root);
            await api.runCommand(sessionId, {command: "model", modelKey: model});
            if (!isCurrent(root, currentGeneration)) return false;

            await api.runCommand(sessionId, {command: "thinking", thinkingLevel: toValue(settings.thinkingEnabled) ? "medium" : "off"});
            if (!isCurrent(root, currentGeneration)) return false;

            await stream.start(sessionId);

            // 更新工作台记录
            if (options?.workbenchSession) {
                const sessions = options.workbenchSession.state.value.sessions || [];
                const updatedSessions = sessions.map(s =>
                    s.sessionId === sessionId ? {...s, lastActiveAt: Date.now()} : s
                );
                await options.workbenchSession.commit({
                    activeSessionId: sessionId,
                    creationMode: sessionCreationMode.value,
                    sessions: updatedSessions
                });
            }

            loading.value = false;
            return true;
        } catch (cause) {
            if (isCurrent(root, currentGeneration)) {
                error.value = resolveApiErrorMessage(cause, "切换会话失败");
                loading.value = false;
            }
            return false;
        }
    }

    async function deleteSession(sessionId: number): Promise<boolean> {
        if (!options?.workbenchSession) return false;

        try {
            const sessions = options.workbenchSession.state.value.sessions || [];
            const filteredSessions = sessions.filter(s => s.sessionId !== sessionId);

            // 如果删除的是当前活动会话，需要切换到其他会话或创建新会话
            let newActiveSessionId: number | null = null;
            if (activeSessionId.value === sessionId) {
                if (filteredSessions.length > 0) {
                    // 切换到最近活动的会话
                    const mostRecent = [...filteredSessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
                    newActiveSessionId = mostRecent?.sessionId ?? null;
                    if (newActiveSessionId !== null) {
                        await switchSession(newActiveSessionId);
                    }
                } else {
                    // 没有其他会话，清空当前会话并在下次需要时创建新的
                    stream.stop();
                    activeSessionId.value = null;
                    activeProjectRoot.value = null;
                    session.reset();
                }
            }

            await options.workbenchSession.commit({
                activeSessionId: newActiveSessionId,
                sessions: filteredSessions
            });

            return true;
        } catch (cause) {
            error.value = resolveApiErrorMessage(cause, "删除会话失败");
            return false;
        }
    }

    async function renameSession(sessionId: number, newTitle: string): Promise<boolean> {
        if (!options?.workbenchSession) return false;

        try {
            const sessions = options.workbenchSession.state.value.sessions || [];
            const updatedSessions = sessions.map(s =>
                s.sessionId === sessionId ? {...s, title: newTitle} : s
            );

            await options.workbenchSession.commit({
                sessions: updatedSessions
            });

            return true;
        } catch (cause) {
            error.value = resolveApiErrorMessage(cause, "重命名会话失败");
            return false;
        }
    }

    async function ensureSession(): Promise<number | null> {
        const root = toValue(projectRoot);
        if (!root || options?.workbenchSession?.loading.value) return null;

        // 尝试恢复已保存的会话
        const savedSessionId = options?.workbenchSession?.state.value.activeSessionId;
        if (savedSessionId && (!activeSessionId.value || activeSessionId.value !== savedSessionId)) {
            const currentGeneration = generation.value;
            loading.value = true;
            error.value = null;
            try {
                // 验证保存的会话是否仍然存在
                const recovery = await api.getSessionRecovery(savedSessionId);
                if (!isCurrent(root, currentGeneration)) return null;

                activeSessionId.value = savedSessionId;
                activeProjectRoot.value = root;
                sessionCreationMode.value = creationModeForSession(savedSessionId);
                session.applyRecovery(recovery);
                pendingDraft.value = {answers: {}, forms: {}};

                // 更新运行时设置
                await api.runCommand(savedSessionId, {command: "mode", mode: toValue(settings.mode) === "auto" ? "normal" : "discuss"});
                if (!isCurrent(root, currentGeneration)) return null;

                const model = await resolveModel(root);
                await api.runCommand(savedSessionId, {command: "model", modelKey: model});
                if (!isCurrent(root, currentGeneration)) return null;

                await api.runCommand(savedSessionId, {command: "thinking", thinkingLevel: toValue(settings.thinkingEnabled) ? "medium" : "off"});
                if (!isCurrent(root, currentGeneration)) return null;

                await stream.start(savedSessionId);
                loading.value = false;
                return savedSessionId;
            } catch (cause) {
                // 会话不存在或已失效，清除保存的 ID 并创建新会话
                if (isCurrent(root, currentGeneration)) {
                    await options?.workbenchSession?.commit({activeSessionId: null});
                }
            } finally {
                if (isCurrent(root, currentGeneration)) loading.value = false;
            }
        }

        // 如果已有活动会话且与当前项目匹配，直接返回
        if (activeSessionId.value && activeProjectRoot.value === root) return activeSessionId.value;

        // 创建新会话
        const currentGeneration = generation.value;
        loading.value = true;
        error.value = null;
        try {
            const model = await resolveModel(root);
            if (!isCurrent(root, currentGeneration)) return null;
            const created = await api.createSession({
                profileKey: "outline.planner",
                currentProjectRoot: root,
                initial: {
                    projectRoot: root,
                    scope: {includeAnalysis: true},
                    mode: toValue(settings.mode),
                    model,
                    temperature: toValue(settings.temperature),
                    thinking: toValue(settings.thinkingEnabled) ? "medium" : "off",
                },
            });
            if (!isCurrent(root, currentGeneration)) return null;

            // 同步运行时设置
            await api.runCommand(created.sessionId, {command: "mode", mode: toValue(settings.mode) === "auto" ? "normal" : "discuss"});
            if (!isCurrent(root, currentGeneration)) return null;
            await api.runCommand(created.sessionId, {command: "model", modelKey: model});
            if (!isCurrent(root, currentGeneration)) return null;
            await api.runCommand(created.sessionId, {command: "thinking", thinkingLevel: toValue(settings.thinkingEnabled) ? "medium" : "off"});
            if (!isCurrent(root, currentGeneration)) return null;

            activeSessionId.value = created.sessionId;
            activeProjectRoot.value = root;
            sessionCreationMode.value = toValue(settings.creationMode) ?? "original";

            const recovery = await api.getSessionRecovery(created.sessionId);
            if (!isCurrent(root, currentGeneration)) return null;
            session.applyRecovery(recovery);
            pendingDraft.value = {answers: {}, forms: {}};
            await stream.start(created.sessionId);

            // 保存新会话到工作台记录
            if (options?.workbenchSession) {
                const existingSessions = options.workbenchSession.state.value.sessions || [];
                await options.workbenchSession.commit({
                    activeSessionId: created.sessionId,
                    sessions: [
                        ...existingSessions,
                        {
                            sessionId: created.sessionId,
                            title: "新会话",
                            creationMode: sessionCreationMode.value,
                            started: false,
                            createdAt: Date.now(),
                            lastActiveAt: Date.now(),
                        }
                    ]
                });
            }

            return created.sessionId;
        } catch (cause) {
            if (isCurrent(root, currentGeneration)) error.value = resolveApiErrorMessage(cause, "创建规划 Agent 会话失败");
            return null;
        } finally {
            if (isCurrent(root, currentGeneration)) loading.value = false;
        }
    }

    async function sendPrompt(text: string): Promise<void> {
        const userText = text.trim();
        if (!userText || running.value || pendingSubmission.value) return;
        const root = toValue(projectRoot);
        const currentGeneration = generation.value;
        if (!root) return;
        const requestedCreationMode = toValue(settings.creationMode) ?? "original";
        // 已创建但尚未开始对话的空会话可以随创作方式重建；首条用户消息后由锁定合同阻止此路径。
        if (activeSessionId.value && !creationModeLocked.value && sessionCreationMode.value !== requestedCreationMode) {
            stream.stop();
            activeSessionId.value = null;
            activeProjectRoot.value = null;
            session.reset();
            if (options?.workbenchSession) await options.workbenchSession.commit({activeSessionId: null});
        }
        // 上下文属于本次提交，不能从恢复的会话 initial 或异步创建后的新选择推导。
        const context = {
            creationMode: sessionCreationMode.value,
            targetPlanId: toValue(settings.planId) ?? null,
        };
        const message = formatOutlineWorkbenchPrompt(userText, context);
        const sessionId = await ensureSession();
        if (!sessionId || !isCurrent(root, currentGeneration)) return;
        const clientMessageId = crypto.randomUUID();
        if (options?.workbenchSession) {
            const sessions = options.workbenchSession.state.value.sessions || [];
            try {
                await options.workbenchSession.commit({sessions: sessions.map((item) => item.sessionId === sessionId ? {...item, started: true, lastActiveAt: Date.now()} : item)});
            } catch (cause) {
                error.value = resolveApiErrorMessage(cause, "保存规划会话状态失败");
                return;
            }
        }
        session.appendOptimisticUserMessage(clientMessageId, message, [], "prompt");
        try {
            await stream.ensure();
            if (!isCurrent(root, currentGeneration)) return;
            const result = await api.invokeSession(sessionId, {
                mode: "prompt",
                clientMessageId,
                message: {text: message},
                temperature: toValue(settings.temperature),
            });
            if (!isCurrent(root, currentGeneration)) return;
            if (result.status === "error") {
                session.markOptimisticUserMessageUnknown(clientMessageId);
                error.value = result.error ?? "规划 Agent 调用失败";
            }
            await stream.refreshRecovery(result.status === "error" ? "invoke_error_fallback" : "active_path_changed");
        } catch (cause) {
            if (!isCurrent(root, currentGeneration)) return;
            session.markOptimisticUserMessageUnknown(clientMessageId);
            error.value = resolveApiErrorMessage(cause, "发送规划请求失败");
        }
    }

    async function abort(): Promise<void> {
        const sessionId = activeSessionId.value;
        if (!sessionId) return;
        try {
            await api.abortSession(sessionId, {reason: "user abort", clearQueue: true});
            await stream.refreshRecovery("manual_refresh");
        } catch (cause) {
            error.value = resolveApiErrorMessage(cause, "取消规划 Agent 运行失败");
        }
    }

    async function submitPending(resolutions: Parameters<typeof api.invokeSession>[1]["resolutions"]): Promise<void> {
        const sessionId = activeSessionId.value;
        const root = activeProjectRoot.value;
        if (!sessionId || !root || !resolutions?.length || pendingSubmission.value) return;
        const currentGeneration = generation.value;
        pendingSubmission.value = true;
        try {
            await stream.ensure();
            if (!isCurrent(root, currentGeneration)) return;
            const result = await api.invokeSession(sessionId, {mode: "continue", resolutions, temperature: toValue(settings.temperature)});
            if (!isCurrent(root, currentGeneration)) return;
            if (result.status === "error") error.value = result.error ?? "提交规划审批失败";
            await stream.refreshRecovery(result.status === "error" ? "invoke_error_fallback" : "active_path_changed");
        } catch (cause) {
            if (isCurrent(root, currentGeneration)) error.value = resolveApiErrorMessage(cause, "提交规划审批失败");
        } finally {
            if (isCurrent(root, currentGeneration)) pendingSubmission.value = false;
        }
    }

    async function updateRuntime(command: {command: "mode"; mode: "normal" | "discuss" | "plan"} | {command: "model"; modelKey: string | null} | {command: "thinking"; thinkingLevel: "off" | "low" | "medium" | "high" | null}): Promise<void> {
        const sessionId = activeSessionId.value;
        if (!sessionId) return;
        try {
            await api.runCommand(sessionId, command);
            await stream.refreshRecovery("manual_refresh");
        } catch (cause) {
            error.value = resolveApiErrorMessage(cause, "更新规划 Agent 设置失败");
        }
    }

    function resetForProject(): void {
        operationGeneration += 1;
        generation.value += 1;
        stream.stop();
        // 持久化 ID 由各 Project 的工作台记录保留；内存绑定不能跨 Project 复用。
        activeSessionId.value = null;
        activeProjectRoot.value = null;
        sessionCreationMode.value = toValue(settings.creationMode) ?? "original";
        loading.value = false;
        pendingDraft.value = {answers: {}, forms: {}};
        pendingSubmission.value = false;
        session.reset();
    }

    watch(() => toValue(projectRoot), (newRoot, oldRoot) => {
        // 只在项目真正切换时重置，相同项目的重新挂载不清空会话
        if (newRoot !== oldRoot) {
            resetForProject();
            error.value = null;
        }
    }, {immediate: true});

    onScopeDispose(() => {
        resetForProject();
    });

    return {
        activeSessionId,
        activeProjectRoot,
        currentState,
        connectionStatus,
        error,
        loading,
        messages,
        pendingDraft,
        pendingSubmission,
        sessionCreationMode,
        creationModeLocked,
        pendingUserInputSession,
        pendingUserInputSessions,
        runPhase,
        running,
        session,
        sendPrompt,
        abort,
        ensureSession,
        submitPending,
        updateRuntime,
        createNewSession,
        switchSession,
        deleteSession,
        renameSession,
    };
}

