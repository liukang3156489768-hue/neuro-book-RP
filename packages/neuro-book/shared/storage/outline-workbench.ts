/**
 * 大纲规划工作台的 Project/local 状态定义（Nitro 与浏览器共用）。
 *
 * 规划文件仍是领域真相源；这里仅保存工作台显示和 Agent 控件的用户偏好。
 * 记录允许缺少字段，以便新增偏好时旧记录仍可回退默认值，且读取时的未知字段不会被覆盖。
 */
import {defineStorageState, type DefinedStorageState} from "nbook/shared/storage/definition";

export const OUTLINE_WORKBENCH_OWNER = "outline.workbench";
export const OUTLINE_WORKBENCH_LAYOUT_KEY = "layout";
export const OUTLINE_WORKBENCH_SCHEMA_VERSION = 1;

/**
 * 没有用户偏好时的左栏宽度，是**窗口宽度的比例**而不是像素。
 *
 * 设计合同规定左栏默认约占五分之一且不超过中线，这两条都随视口变化，
 * 固定像素（此前的 300）在宽屏上会明显窄于五分之一。求值入口见
 * `./outline-workbench-width.ts`，记录里只保存用户拖拽过的绝对值。
 */
export const OUTLINE_WORKBENCH_DEFAULT_AGENT_WIDTH_RATIO = 0.2;
export const OUTLINE_WORKBENCH_MIN_AGENT_WIDTH = 220;
export const OUTLINE_WORKBENCH_MAX_AGENT_WIDTH = 4096;
export const OUTLINE_WORKBENCH_DEFAULT_TEMPERATURE = 0.7;

export const OUTLINE_WORKBENCH_VIEWS = ["library", "foreshadowing", "lines"] as const;
export type OutlineWorkbenchView = (typeof OUTLINE_WORKBENCH_VIEWS)[number];
export const OUTLINE_WORKBENCH_MODES = ["discuss", "auto"] as const;
export type OutlineWorkbenchMode = (typeof OUTLINE_WORKBENCH_MODES)[number];
export const OUTLINE_WORKBENCH_CREATION_MODES = ["original", "adaptation"] as const;
export type OutlineWorkbenchCreationMode = (typeof OUTLINE_WORKBENCH_CREATION_MODES)[number];

export type OutlineWorkbenchRecord = {
    readonly agentWidth?: number;
    readonly activeView?: OutlineWorkbenchView;
    readonly thinkingEnabled?: boolean;
    readonly modelKey?: string;
    readonly temperature?: number;
    readonly mode?: OutlineWorkbenchMode;
    readonly creationMode?: OutlineWorkbenchCreationMode;
    /** 当前活动的 Agent 会话 ID（持久化会话，退出工作台后仍保留） */
    readonly activeSessionId?: number | null;
    /** 会话历史列表（用于会话管理） */
    readonly sessions?: readonly Readonly<{
        sessionId: number;
        title?: string;
        creationMode?: OutlineWorkbenchCreationMode;
        started?: boolean;
        createdAt: number;
        lastActiveAt: number;
    }>[];
    readonly [field: string]: unknown;
};

function isRecordObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeWidth(value: unknown): value is number {
    return typeof value === "number"
        && Number.isSafeInteger(value)
        && value >= OUTLINE_WORKBENCH_MIN_AGENT_WIDTH
        && value <= OUTLINE_WORKBENCH_MAX_AGENT_WIDTH;
}

function isTemperature(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 2;
}

function isSafeSessionId(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSessionEntry(value: unknown): value is {sessionId: number; title?: string; creationMode?: OutlineWorkbenchCreationMode; started?: boolean; createdAt: number; lastActiveAt: number} {
    if (!isRecordObject(value)) return false;
    const entry = value as Record<string, unknown>;
    return isSafeSessionId(entry.sessionId)
        && (entry.title === undefined || (typeof entry.title === "string" && entry.title.length <= 200))
        && (entry.creationMode === undefined || (OUTLINE_WORKBENCH_CREATION_MODES as readonly string[]).includes(entry.creationMode as string))
        && (entry.started === undefined || typeof entry.started === "boolean")
        && typeof entry.createdAt === "number" && Number.isSafeInteger(entry.createdAt)
        && typeof entry.lastActiveAt === "number" && Number.isSafeInteger(entry.lastActiveAt);
}

function isSessionArray(value: unknown): value is readonly {sessionId: number; title?: string; creationMode?: OutlineWorkbenchCreationMode; started?: boolean; createdAt: number; lastActiveAt: number}[] {
    return Array.isArray(value) && value.length <= 100 && value.every(isSessionEntry);
}

export function isOutlineWorkbenchRecord(value: unknown): value is OutlineWorkbenchRecord {
    if (!isRecordObject(value)) return false;
    const candidate = value as Partial<OutlineWorkbenchRecord>;
    return (candidate.agentWidth === undefined || isSafeWidth(candidate.agentWidth))
        && (candidate.activeView === undefined || (OUTLINE_WORKBENCH_VIEWS as readonly string[]).includes(candidate.activeView))
        && (candidate.thinkingEnabled === undefined || typeof candidate.thinkingEnabled === "boolean")
        && (candidate.modelKey === undefined || (typeof candidate.modelKey === "string" && candidate.modelKey.length > 0 && candidate.modelKey.length <= 256))
        && (candidate.temperature === undefined || isTemperature(candidate.temperature))
        && (candidate.mode === undefined || (OUTLINE_WORKBENCH_MODES as readonly string[]).includes(candidate.mode))
        && (candidate.creationMode === undefined || (OUTLINE_WORKBENCH_CREATION_MODES as readonly string[]).includes(candidate.creationMode))
        && (candidate.activeSessionId === undefined || candidate.activeSessionId === null || isSafeSessionId(candidate.activeSessionId))
        && (candidate.sessions === undefined || isSessionArray(candidate.sessions));
}

export const OUTLINE_WORKBENCH_DEFAULT_RECORD: OutlineWorkbenchRecord = Object.freeze({});

export function defineOutlineWorkbenchState(): DefinedStorageState<OutlineWorkbenchRecord> {
    return defineStorageState<OutlineWorkbenchRecord>({
        owner: OUTLINE_WORKBENCH_OWNER,
        key: OUTLINE_WORKBENCH_LAYOUT_KEY,
        scope: "project",
        locality: "local",
        records: "single",
        schemaVersion: OUTLINE_WORKBENCH_SCHEMA_VERSION,
        defaultValue: OUTLINE_WORKBENCH_DEFAULT_RECORD,
        validate: isOutlineWorkbenchRecord,
    });
}
