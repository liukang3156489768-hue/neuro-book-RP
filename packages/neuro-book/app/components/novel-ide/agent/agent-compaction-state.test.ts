import {describe, expect, it} from "vitest";
import type {AgentCompactionStateDto} from "nbook/shared/dto/agent-session.dto";
import {acceptsCompactionUpdate, compactionPresentation, restoreCompactionState} from "nbook/app/components/novel-ide/agent/agent-compaction-state";

const state: AgentCompactionStateDto = {
    invocationId: "outline-run-1", status: "running", stage: "summarizing",
    startedAt: 1000, updatedAt: 5000, completedBatches: 1, totalBatches: 3, tokensBefore: 300000,
};

describe("compaction state", () => {
    it("restores only active running status while retaining terminal receipts", () => {
        expect(restoreCompactionState(state, state.invocationId)).toEqual(state);
        expect(restoreCompactionState(state, null)).toBeNull();
        expect(restoreCompactionState(state, "outline-run-2")).toBeNull();
        expect(restoreCompactionState({...state, status: "completed"}, null)?.status).toBe("completed");
    });

    it("rejects late updates and permits another compaction within the same invocation", () => {
        expect(acceptsCompactionUpdate(state, state, "outline-run-2")).toBe(false);
        expect(acceptsCompactionUpdate(state, {...state, updatedAt: 4000}, state.invocationId)).toBe(false);
        const completed = {...state, status: "completed" as const};
        expect(acceptsCompactionUpdate(completed, state, state.invocationId)).toBe(false);
        expect(acceptsCompactionUpdate(completed, {...state, startedAt: 6000, updatedAt: 6000}, state.invocationId)).toBe(true);
    });

    it("reports actual batch counts and freezes elapsed time at terminal status", () => {
        expect(compactionPresentation(state, 12000)).toMatchObject({batch: "已完成 1/3 批", elapsedSeconds: 11, running: true});
        expect(compactionPresentation({...state, status: "completed", tokensAfter: 60000}, 12000))
            .toMatchObject({elapsedSeconds: 4, running: false, context: "300,000 → 60,000 tokens"});
    });

    it("counts cache writes in the separate summary cache metric", () => {
        const usage = {
            input: 100, output: 20, cacheRead: 200, cacheWrite: 100, totalTokens: 420,
            cost: {input: 0.01, output: 0.01, cacheRead: 0.01, cacheWrite: 0.01, total: 0.04},
        };
        const presented = compactionPresentation({...state, usage}, 5000);
        expect(presented.summaryUsage).toContain("命中率 50.0%");
        expect(presented.summaryUsage).toContain("费用 $0.0400");
    });
});
