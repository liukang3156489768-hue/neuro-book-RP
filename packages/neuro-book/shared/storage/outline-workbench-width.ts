/**
 * 大纲规划工作台左栏（规划 Agent 区）宽度的解析规则。
 *
 * 设计合同要求左栏默认约占窗口五分之一、上限为窗口中线；这两条都依赖**运行时视口**，
 * 而存储记录里只存绝对值。所以默认值不能写成常量——固定像素在宽屏上会把左栏压成五分之一以下，
 * 在窄屏上又会越过中线。这里把「默认比例 → 像素」和「夹取」做成纯函数，
 * 由 UI 在渲染时按当前视口求值，避免把视口尺寸写进 Project 记录。
 *
 * 只有用户实际拖拽过的宽度才落盘；`resolveOutlineAgentWidth` 收到的 `stored` 为 `null`
 * 表示「没有用户偏好」，此时返回比例默认值。
 */
import {
    OUTLINE_WORKBENCH_DEFAULT_AGENT_WIDTH_RATIO,
    OUTLINE_WORKBENCH_MIN_AGENT_WIDTH,
} from "nbook/shared/storage/outline-workbench";

/**
 * 窗口过窄时按比例算出的宽度会低于最小可用宽度，此时退到最小值；
 * 上限取 `windowWidth / 2 - 1`，保证左栏严格小于中线而不是压线等于。
 */
export function resolveOutlineAgentWidth(stored: number | null, windowWidth: number): number {
    const max = Math.max(OUTLINE_WORKBENCH_MIN_AGENT_WIDTH, Math.floor(windowWidth / 2) - 1);
    const preferred = stored ?? Math.round(windowWidth * OUTLINE_WORKBENCH_DEFAULT_AGENT_WIDTH_RATIO);
    return Math.min(max, Math.max(OUTLINE_WORKBENCH_MIN_AGENT_WIDTH, preferred));
}

/** 拖拽过程中的目标宽度同样走这套夹取，避免拖拽与默认值出现两套边界。 */
export function clampOutlineAgentWidth(width: number, windowWidth: number): number {
    return resolveOutlineAgentWidth(width, windowWidth);
}
