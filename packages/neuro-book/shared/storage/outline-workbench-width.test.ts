import {describe, expect, it} from "vitest";
import {resolveOutlineAgentWidth} from "nbook/shared/storage/outline-workbench-width";
import {
    OUTLINE_WORKBENCH_DEFAULT_AGENT_WIDTH_RATIO,
    OUTLINE_WORKBENCH_MIN_AGENT_WIDTH,
} from "nbook/shared/storage/outline-workbench";

describe("大纲规划工作台左栏宽度", () => {
    it("没有用户偏好时按窗口宽度取五分之一", () => {
        for (const width of [1280, 1600, 1920, 2560]) {
            expect(resolveOutlineAgentWidth(null, width)).toBe(Math.round(width * OUTLINE_WORKBENCH_DEFAULT_AGENT_WIDTH_RATIO));
        }
        expect(OUTLINE_WORKBENCH_DEFAULT_AGENT_WIDTH_RATIO).toBe(0.2);
    });

    it("左栏始终严格小于窗口中线", () => {
        for (const width of [600, 900, 1280, 1920, 3840]) {
            // 比例默认值本身不能越界，否则"约占五分之一"和"不超过中线"会互相矛盾。
            expect(resolveOutlineAgentWidth(null, width)).toBeLessThanOrEqual(width / 2);
            // 用户想拖到极宽时也被夹回中线以内。
            expect(resolveOutlineAgentWidth(10_000, width)).toBeLessThanOrEqual(width / 2);
        }
    });

    it("窗口过窄时退到最小可用宽度，不出现负数或零宽", () => {
        expect(resolveOutlineAgentWidth(null, 320)).toBe(OUTLINE_WORKBENCH_MIN_AGENT_WIDTH);
        expect(resolveOutlineAgentWidth(null, 0)).toBe(OUTLINE_WORKBENCH_MIN_AGENT_WIDTH);
        expect(resolveOutlineAgentWidth(10, 320)).toBe(OUTLINE_WORKBENCH_MIN_AGENT_WIDTH);
    });

    it("用户保存过的宽度在有效范围内原样保留", () => {
        expect(resolveOutlineAgentWidth(420, 1920)).toBe(420);
        expect(resolveOutlineAgentWidth(420, 900)).toBe(420);
        // 窗口缩小到 420 已越过中线时，夹回中线以内而不是继续用旧值。
        expect(resolveOutlineAgentWidth(420, 800)).toBe(399);
    });
});
