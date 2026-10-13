/**
 * 大纲规划工作台的 Project/local 会话。
 *
 * 会话只负责把已签发的 Project ready、Storage 记录会话和 Vue 消费接起来；
 * 规划实体、伏笔状态和线路权限仍由服务端合同提供，组件不得从这里推导。
 */
import {onScopeDispose, readonly, ref, shallowRef, toValue, watch, type MaybeRefOrGetter, type Ref} from "vue";
import {
    createLayoutRecordSession,
    type LayoutRecordCommitResult,
    type LayoutRecordIntent,
    type LayoutRecordSession,
    type WorkbenchLayoutSurface,
} from "nbook/app/utils/workbench/layout-session";
import {
    createWorkbenchStorageContext,
    type WorkbenchStorageAdapters,
} from "nbook/app/utils/workbench/storage-context";
import {
    defineOutlineWorkbenchState,
    OUTLINE_WORKBENCH_DEFAULT_TEMPERATURE,
    type OutlineWorkbenchCreationMode,
    type OutlineWorkbenchMode,
    type OutlineWorkbenchRecord,
    type OutlineWorkbenchView,
} from "nbook/shared/storage/outline-workbench";

export type OutlineWorkbenchPatch = {
    readonly agentWidth?: number;
    readonly activeView?: OutlineWorkbenchView;
    readonly thinkingEnabled?: boolean;
    readonly modelKey?: string;
    readonly temperature?: number;
    readonly mode?: OutlineWorkbenchMode;
    readonly creationMode?: OutlineWorkbenchCreationMode;
    readonly activeSessionId?: number | null;
    readonly sessions?: readonly Readonly<{
        sessionId: number;
        title?: string;
        creationMode?: OutlineWorkbenchCreationMode;
        started?: boolean;
        createdAt: number;
        lastActiveAt: number;
    }>[];
};

export type OutlineWorkbenchResolvedState = {
    /**
     * 用户拖拽保存过的左栏宽度；`null` 表示还没有用户偏好。
     *
     * 默认宽度是窗口宽度的比例、上限是窗口中线，两者都需要视口才能求值，
     * 所以这里只报告「有没有偏好」，由 UI 用 `resolveOutlineAgentWidth` 换算成像素。
     * 会话层不引入视口，避免这份状态在 Node 测试环境里依赖 `window`。
     */
    readonly agentWidth: number | null;
    readonly activeView: OutlineWorkbenchView;
    readonly thinkingEnabled: boolean;
    readonly modelKey: string | null;
    readonly temperature: number;
    readonly mode: OutlineWorkbenchMode;
    readonly creationMode: OutlineWorkbenchCreationMode;
    readonly activeSessionId: number | null;
    readonly sessions: readonly Readonly<{
        sessionId: number;
        title?: string;
        creationMode?: OutlineWorkbenchCreationMode;
        started?: boolean;
        createdAt: number;
        lastActiveAt: number;
    }>[];
};

export type OutlineWorkbenchNotice = {
    readonly diagnosis: string;
    readonly retryable: boolean;
};

export type OutlineWorkbenchSession = {
    readonly state: Readonly<Ref<OutlineWorkbenchResolvedState>>;
    readonly loading: Readonly<Ref<boolean>>;
    readonly notice: Readonly<Ref<OutlineWorkbenchNotice | null>>;
    commit(patch: OutlineWorkbenchPatch): Promise<LayoutRecordCommitResult>;
    retry(): Promise<LayoutRecordCommitResult | void>;
    abandon(): void;
    release(): Promise<void>;
};

export type OutlineWorkbenchSessionOptions = {
    readonly surface: MaybeRefOrGetter<WorkbenchLayoutSurface>;
    readonly adapters?: WorkbenchStorageAdapters;
};

function patchFields(patch: OutlineWorkbenchPatch): OutlineWorkbenchPatch {
    return {
        ...(Number.isSafeInteger(patch.agentWidth) ? {agentWidth: patch.agentWidth} : {}),
        ...(patch.activeView === "library" || patch.activeView === "foreshadowing" || patch.activeView === "lines"
            ? {activeView: patch.activeView} : {}),
        ...(typeof patch.thinkingEnabled === "boolean" ? {thinkingEnabled: patch.thinkingEnabled} : {}),
        ...(typeof patch.modelKey === "string" && patch.modelKey.length > 0 && patch.modelKey.length <= 256 ? {modelKey: patch.modelKey} : {}),
        ...(typeof patch.temperature === "number" && Number.isFinite(patch.temperature)
            ? {temperature: Math.min(2, Math.max(0, Number(patch.temperature.toFixed(1))))} : {}),
        ...(patch.mode === "discuss" || patch.mode === "auto" ? {mode: patch.mode} : {}),
        ...(patch.creationMode === "original" || patch.creationMode === "adaptation" ? {creationMode: patch.creationMode} : {}),
        ...(patch.activeSessionId !== undefined ? {activeSessionId: patch.activeSessionId} : {}),
        ...(Array.isArray(patch.sessions) ? {sessions: patch.sessions} : {}),
    };
}

function composeState(base: OutlineWorkbenchRecord | null, patch: OutlineWorkbenchPatch): LayoutRecordIntent<OutlineWorkbenchRecord> {
    const fields = patchFields(patch);
    const value: OutlineWorkbenchRecord = base === null ? fields : {...base, ...fields};
    const changed = Object.entries(fields).some(([key, next]) => base === null || base[key] !== next);
    return changed
        ? {value, changed: true, diagnosis: ""}
        : {value, changed: false, diagnosis: "工作台设置与已确认值相同，未写盘"};
}

const DEFAULT_STATE: OutlineWorkbenchResolvedState = {
    agentWidth: null,
    activeView: "library",
    thinkingEnabled: false,
    modelKey: null,
    temperature: OUTLINE_WORKBENCH_DEFAULT_TEMPERATURE,
    mode: "discuss",
    creationMode: "original",
    activeSessionId: null,
    sessions: [],
};

function resolveState(value: OutlineWorkbenchRecord): OutlineWorkbenchResolvedState {
    return {
        agentWidth: value.agentWidth ?? null,
        activeView: value.activeView ?? DEFAULT_STATE.activeView,
        thinkingEnabled: value.thinkingEnabled ?? DEFAULT_STATE.thinkingEnabled,
        modelKey: value.modelKey ?? DEFAULT_STATE.modelKey,
        temperature: value.temperature ?? DEFAULT_STATE.temperature,
        mode: value.mode ?? DEFAULT_STATE.mode,
        creationMode: value.creationMode ?? DEFAULT_STATE.creationMode,
        activeSessionId: value.activeSessionId ?? DEFAULT_STATE.activeSessionId,
        sessions: value.sessions ?? DEFAULT_STATE.sessions,
    };
}

export function useOutlineWorkbenchSession(options: OutlineWorkbenchSessionOptions): OutlineWorkbenchSession {
    const definition = defineOutlineWorkbenchState();
    const context = createWorkbenchStorageContext(options.adapters === undefined ? {} : {adapters: options.adapters});
    const state = shallowRef<OutlineWorkbenchResolvedState>(DEFAULT_STATE);
    const loading = ref(true);
    const notice = ref<OutlineWorkbenchNotice | null>(null);
    const session = shallowRef<LayoutRecordSession<OutlineWorkbenchRecord, OutlineWorkbenchPatch> | null>(null);
    let surfaceGeneration = 0;
    let surfaceSetup: Promise<void> = Promise.resolve();

    const publish = (): void => {
        const current = session.value;
        if (current === null) return;
        const currentState = current.state();
        state.value = resolveState(current.display());
        loading.value = currentState.phase === "loading" || currentState.phase === "idle";
        if (currentState.pending !== null) {
            notice.value = {diagnosis: currentState.pending.diagnosis, retryable: currentState.pending.retryable};
        } else if (currentState.blocked !== null) {
            notice.value = {diagnosis: currentState.issues.at(-1) ?? `工作台设置不可用（${currentState.blocked}）`, retryable: false};
        } else {
            notice.value = null;
        }
    };

    const enterSurface = (surface: WorkbenchLayoutSurface): void => {
        const generation = ++surfaceGeneration;
        session.value = null;
        if (surface.kind !== "project") {
            state.value = DEFAULT_STATE;
            loading.value = false;
            notice.value = null;
            surfaceSetup = context.enterUserSurface("idle");
            return;
        }
        loading.value = true;
        surfaceSetup = (async () => {
            await context.enterProject(surface.ready);
            const owned = await context.projectOwner(definition.owner);
            if (generation !== surfaceGeneration) return;
            if (owned.status !== "ready") {
                loading.value = false;
                notice.value = {diagnosis: owned.diagnosis, retryable: false};
                return;
            }
            const created = createLayoutRecordSession<OutlineWorkbenchRecord, OutlineWorkbenchPatch>({
                handle: owned.handle,
                definition,
                compose: composeState,
                onChange: publish,
            });
            session.value = created;
            await created.open();
            if (generation !== surfaceGeneration) return;
            publish();
        })();
    };

    let appliedSurfaceKey = "";
    watch(() => toValue(options.surface), (surface) => {
        const key = surface.kind === "project"
            ? `project:${surface.ready.projectRoot}@${surface.ready.publicId}@${String(surface.ready.revision ?? "")}`
            : surface.kind;
        if (key === appliedSurfaceKey) return;
        appliedSurfaceKey = key;
        enterSurface(surface);
    }, {immediate: true});

    const consumer: OutlineWorkbenchSession = {
        state: readonly(state) as Readonly<Ref<OutlineWorkbenchResolvedState>>,
        loading: readonly(loading),
        notice: readonly(notice),
        async commit(patch: OutlineWorkbenchPatch): Promise<LayoutRecordCommitResult> {
            await surfaceSetup;
            const current = session.value;
            if (current === null) return {status: "rejected", diagnosis: "当前没有可保存的 Project 工作台记录"};
            await current.open();
            if (session.value !== current) return {status: "rejected", diagnosis: "Project 工作台已切换，未保存本次设置"};
            const result = await current.commit(patch);
            publish();
            return result;
        },
        async retry(): Promise<LayoutRecordCommitResult | void> {
            await surfaceSetup;
            const current = session.value;
            if (current === null) return;
            const result = await current.retry();
            publish();
            return result;
        },
        abandon(): void {
            session.value?.abandon();
            publish();
        },
        async release(): Promise<void> {
            surfaceGeneration += 1;
            await session.value?.release();
            await context.release();
            publish();
        },
    };

    onScopeDispose(() => { void consumer.release(); });
    return consumer;
}
