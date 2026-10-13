import {computed, onScopeDispose, ref, watch} from "vue";
import {useAgentSessionApi} from "nbook/app/composables/useAgentSessionApi";
import {useAgentSession} from "nbook/app/components/novel-ide/agent/useAgentSession";
import {useAgentSessionStream} from "nbook/app/components/novel-ide/agent/useAgentSessionStream";
import {resolveApiErrorMessage} from "nbook/app/utils/api-error";
import {createWritingApi} from "nbook/app/utils/writing/writing-api";
import type {WritingWriterOutputDto} from "nbook/shared/dto/writing.dto";

type Source = {projectRoot: string; runId: string; sessionId: number | null; open: boolean; active: boolean};

/** 只读写手输出：展开才读取／订阅，收起与来源切换使旧异步结果失效。 */
export function useWritingWriterOutput(source: () => Source) {
    const api = useAgentSessionApi();
    const session = useAgentSession();
    const activeSessionId = ref<number | null>(null);
    const loading = ref(false);
    const error = ref<string | null>(null);
    const full = ref<WritingWriterOutputDto | null>(null);
    let generation = 0;
    const stream = useAgentSessionStream({session, api, activeSessionId,
        onError: (cause, fallback) => { error.value = resolveApiErrorMessage(cause, fallback); },
    });
    const liveMessages = computed(() => session.messages.value.filter(message => message.type === "ai"));
    const thinking = computed(() => full.value?.thinking ?? liveMessages.value.map(message => message.thinking ?? "").filter(Boolean).join("\n\n"));
    const output = computed(() => full.value?.output ?? liveMessages.value.map(message => message.content).filter(Boolean).join("\n\n"));

    async function loadFull(current: number, target: Source): Promise<void> {
        if (target.sessionId === null) return;
        const result = await createWritingApi(target.projectRoot).readWriterOutput(target.runId, target.sessionId);
        if (current === generation && result.sessionId === target.sessionId) full.value = result;
    }

    async function load(): Promise<void> {
        const target = source();
        const current = ++generation;
        stream.stop();
        session.reset();
        activeSessionId.value = null;
        full.value = null;
        error.value = null;
        loading.value = false;
        if (!target.open || target.sessionId === null) return;
        loading.value = true;
        try {
            if (!target.active) {
                await loadFull(current, target);
                return;
            }
            const recovery = await api.getSessionRecovery(target.sessionId);
            if (current !== generation) return;
            activeSessionId.value = target.sessionId;
            session.applyRecovery(recovery);
            await stream.start(target.sessionId);
        } catch (cause) {
            if (current === generation) error.value = resolveApiErrorMessage(cause, "写手输出读取失败");
        } finally {
            if (current === generation) loading.value = false;
        }
    }

    // 进度轮询会替换 attempt 对象；只有连接身份或开合／运行状态变化才重建订阅。
    watch([() => source().projectRoot, () => source().runId, () => source().sessionId,
        () => source().open, () => source().active], () => { void load(); }, {immediate: true});

    // SSE 的 durable history 是有界预览；生成结束后回读完整内容，刷新后也不会丢失长思考与正文。
    watch(session.running, (running, previous) => {
        if (running || !previous || activeSessionId.value === null) return;
        const current = generation;
        const target = source();
        stream.stop();
        void loadFull(current, target).catch(cause => {
            if (current === generation) error.value = resolveApiErrorMessage(cause, "写手输出读取失败");
        });
    });
    onScopeDispose(() => {
        generation += 1;
        activeSessionId.value = null;
        stream.stop();
    });
    return {thinking, output, loading, error, running: session.running, reload: load};
}
