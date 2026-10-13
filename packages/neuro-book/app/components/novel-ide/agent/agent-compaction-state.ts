import type {AgentCompactionStateDto} from "nbook/shared/dto/agent-session.dto";
import {promptCacheHitRate} from "nbook/app/utils/prompt-cache";

/** A restored running status is valid only while its owning invocation is active. */
export function restoreCompactionState(
    state: AgentCompactionStateDto | null | undefined,
    activeInvocationId: string | null,
): AgentCompactionStateDto | null {
    if (!state || (state.status === "running" && state.invocationId !== activeInvocationId)) return null;
    return state;
}

export function acceptsCompactionUpdate(
    current: AgentCompactionStateDto | null,
    next: AgentCompactionStateDto,
    activeInvocationId: string | null,
): boolean {
    if (next.invocationId !== activeInvocationId) return false;
    if (!current || current.invocationId !== next.invocationId) return true;
    if (next.startedAt < current.startedAt) return false;
    if (next.startedAt > current.startedAt) return true;
    if (next.updatedAt < current.updatedAt) return false;
    return current.status === "running" || next.status !== "running";
}

export function compactionPresentation(state: AgentCompactionStateDto, now: number) {
    const running = state.status === "running";
    const elapsedSeconds = Math.max(0, Math.floor(((running ? now : state.updatedAt) - state.startedAt) / 1000));
    const title = running
        ? state.stage === "pruning" ? "正在整理重复资料" : "正在压缩上下文"
        : state.status === "completed" ? "上下文已压缩"
            : state.status === "cancelled" ? "上下文压缩已停止" : "上下文压缩失败";
    const batch = state.stage === "summarizing"
        ? state.totalBatches === undefined
            ? `已完成 ${state.completedBatches} 批`
            : `已完成 ${state.completedBatches}/${state.totalBatches} 批`
        : "";
    const context = state.tokensAfter === undefined
        ? `压缩前 ${state.tokensBefore.toLocaleString()} tokens`
        : `${state.tokensBefore.toLocaleString()} → ${state.tokensAfter.toLocaleString()} tokens`;
    const usage = state.usage;
    const hitRate = usage ? promptCacheHitRate(usage) : null;
    const summaryUsage = usage
        ? `摘要用量：输入 ${usage.input.toLocaleString()}，输出 ${usage.output.toLocaleString()}，缓存读取 ${usage.cacheRead.toLocaleString()}，缓存写入 ${usage.cacheWrite.toLocaleString()}，命中率 ${hitRate === null ? "—" : `${hitRate.toFixed(1)}%`}，费用 $${usage.cost.total.toFixed(4)}`
        : "";
    return {running, title, elapsedSeconds, batch, context, summaryUsage};
}
