const WORKBENCH_RATIO = 0.82;
const WORKBENCH_MIN_WIDTH = 720;
const VIEWPORT_GUTTER = 24;

/** 页面型模态和可拖动窗口共用尺寸，避免设置与业务工作台各自限制像素上限。 */
export const WORKBENCH_DIALOG_SIZE = {
    width: `max(${WORKBENCH_RATIO * 100}vw, min(${WORKBENCH_MIN_WIDTH}px, calc(100vw - ${VIEWPORT_GUTTER}px)))`,
    height: `${WORKBENCH_RATIO * 100}dvh`,
    maxHeight: `calc(100dvh - ${VIEWPORT_GUTTER}px)`,
};

/** 拖动定位需要与模态 CSS 尺寸一致的实际宽度。 */
export function resolveWorkbenchDialogWidth(viewportWidth: number): number {
    return Math.max(viewportWidth * WORKBENCH_RATIO, Math.min(WORKBENCH_MIN_WIDTH, Math.max(0, viewportWidth - VIEWPORT_GUTTER)));
}

export function resolveWorkbenchDialogHeight(viewportHeight: number): number {
    return Math.min(viewportHeight * WORKBENCH_RATIO, Math.max(0, viewportHeight - VIEWPORT_GUTTER));
}
