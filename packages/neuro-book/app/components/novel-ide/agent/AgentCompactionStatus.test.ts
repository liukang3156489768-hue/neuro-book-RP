// @vitest-environment jsdom
import {mount} from "@vue/test-utils";
import {afterEach, describe, expect, it, vi} from "vitest";
import {nextTick} from "vue";
import type {AgentCompactionStateDto} from "nbook/shared/dto/agent-session.dto";
import AgentCompactionStatus from "nbook/app/components/novel-ide/agent/AgentCompactionStatus.vue";

const state: AgentCompactionStateDto = {
    invocationId: "outline-run", status: "running", stage: "summarizing",
    startedAt: 1000, updatedAt: 1000, completedBatches: 0, totalBatches: 2, tokensBefore: 300000,
};

afterEach(() => { vi.useRealTimers(); });

describe("AgentCompactionStatus", () => {
    it("shows real progress with an accessible spinner and stops its timer on completion", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const wrapper = mount(AgentCompactionStatus, {props: {state}});
        expect(wrapper.find('[aria-label="正在压缩上下文"]').exists()).toBe(true);
        expect(wrapper.text()).toContain("已完成 0/2 批");
        await vi.advanceTimersByTimeAsync(5000);
        await nextTick();
        expect(wrapper.text()).toContain("5 秒");
        await wrapper.setProps({state: {...state, status: "completed", updatedAt: 6000, completedBatches: 2, tokensAfter: 50000}});
        expect(wrapper.find('[aria-label="正在压缩上下文"]').exists()).toBe(false);
        expect(wrapper.text()).toContain("300,000 → 50,000 tokens");
        expect(vi.getTimerCount()).toBe(0);
        wrapper.unmount();
    });

    it("clears on session change and disposes an active timer on unmount", async () => {
        vi.useFakeTimers();
        const wrapper = mount(AgentCompactionStatus, {props: {state}});
        expect(vi.getTimerCount()).toBe(1);
        await wrapper.setProps({state: null});
        expect(wrapper.text()).toBe("");
        expect(vi.getTimerCount()).toBe(0);
        await wrapper.setProps({state});
        expect(vi.getTimerCount()).toBe(1);
        wrapper.unmount();
        expect(vi.getTimerCount()).toBe(0);
    });
});
