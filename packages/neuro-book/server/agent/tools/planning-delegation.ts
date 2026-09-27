/**
 * 规划专家的写入授权只在一次经批准的委派调用期间存在。
 *
 * 专家 Profile 是 public 的，用户也能在普通会话里直接创建它；授权绑定到“正在执行的委派调用”，
 * 而不是 Profile 或会话本身，才能保证规划与 lorebook 写入始终来自规划助手按讨论/自动模式放行的任务。
 * 授权只存于当前进程内存：进程重启会中断委派调用本身，不需要持久化。
 */
const activeGrants = new Map<number, number>();

export async function withPlanningWriteGrant<T>(specialistSessionId: number, run: () => Promise<T>): Promise<T> {
    activeGrants.set(specialistSessionId, (activeGrants.get(specialistSessionId) ?? 0) + 1);
    try {
        return await run();
    } finally {
        const remaining = (activeGrants.get(specialistSessionId) ?? 1) - 1;
        if (remaining > 0) activeGrants.set(specialistSessionId, remaining);
        else activeGrants.delete(specialistSessionId);
    }
}

export function assertPlanningWriteGrant(sessionId: number): void {
    if (!activeGrants.has(sessionId)) {
        throw new Error("当前会话没有规划写入委派：只有规划助手通过 delegate_planning_task 委派的任务期间，规划专家才能写入规划模块或 lorebook/。");
    }
}
