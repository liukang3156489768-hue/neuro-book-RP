import type {ExtractionTaskKind} from "nbook/shared/dto/inspiration-extraction-task.dto";
import {appLogger} from "nbook/server/app-logs/logger";
import {usePromptManagement} from "nbook/server/prompt-management/service";
import {runtimePathsFromEnv} from "nbook/server/runtime/paths/runtime-paths";
import {requireProjectHandles} from "nbook/server/workspace-files/project-open-guard";
import {resolveWorkspaceFileTarget} from "nbook/server/workspace-files/novel-workspace";
import {startReadyProjectOperation} from "nbook/server/workspace-files/project-session";
import type {ReadyProjectSessionRef} from "nbook/server/workspace-files/project-session-types";
import type {WorkspaceFileTarget} from "nbook/server/workspace-files/workspace-file-target";
import {ExtractionTaskError} from "./errors";
import {ExtractionTaskManager} from "./manager";
import {createProjectExtractionModel} from "./model-adapter";
import {createSourceVerifier} from "./source-guard";
import {createFileExtractionStore} from "./store-file";
import type {ExtractionPipeline} from "./types";

/** 流水线工厂拿到的项目上下文；流水线用它读取来源、写入产物，不自己解析项目。 */
export type ExtractionPipelineContext = Readonly<{
    target: WorkspaceFileTarget;
    ready: ReadyProjectSessionRef;
}>;

export type ExtractionPipelineFactory = (context: ExtractionPipelineContext) => ExtractionPipeline;

const factories = new Map<ExtractionTaskKind, ExtractionPipelineFactory>();

/**
 * 注册某一种提取的流水线工厂。大纲／素材切片在模块加载时各注册一次；
 * 每个 ready generation 内工厂最多调用一次，流水线实例可以持有该 generation 的依赖。
 */
export function registerExtractionPipeline(kind: ExtractionTaskKind, factory: ExtractionPipelineFactory): void {
    if (factories.has(kind)) throw new Error(`提取流水线重复注册：${kind}`);
    factories.set(kind, factory);
}

/** 仅供测试清理注册表。 */
export function resetExtractionPipelinesForTests(): void {
    factories.clear();
    managers = new WeakMap();
}

// 以 ready generation 为键：项目关闭再打开会得到新的 ready 引用，因而得到一个“没有活动执行者”的新管理器，
// 上一代遗留的“运行中”记录据此读成“已中断”。
let managers = new WeakMap<ReadyProjectSessionRef, ExtractionTaskManager>();

function createManager(target: WorkspaceFileTarget, ready: ReadyProjectSessionRef): ExtractionTaskManager {
    const pipelines = new Map<ExtractionTaskKind, ExtractionPipeline>();
    return new ExtractionTaskManager({
        store: createFileExtractionStore(target),
        model: createProjectExtractionModel(ready),
        capturePromptSnapshot: async () => (await usePromptManagement().capture()).id,
        verifySource: createSourceVerifier(target.root),
        resolvePipeline(kind) {
            const cached = pipelines.get(kind);
            if (cached) return cached;
            const factory = factories.get(kind);
            if (!factory) throw new ExtractionTaskError("PIPELINE_UNREGISTERED", `尚未提供${kind === "outline" ? "大纲" : "素材"}提取流水线`);
            const created = factory({target, ready});
            pipelines.set(kind, created);
            return created;
        },
        // 运行绑定项目生命周期而非 HTTP 请求：请求返回后任务继续；项目关闭时信号中止并等待收尾。
        launch(body) {
            startReadyProjectOperation(ready, signal => ({result: undefined, completion: body(signal)}));
        },
        log: (event, data) => void appLogger.warn(event, data),
    });
}

/**
 * 取得当前打开项目的提取任务管理器。项目未打开时抛 `ProjectNotOpenError`（路由层按项目守卫映射）。
 * 同一 ready generation 返回同一实例，保证“同一来源同一种类只有一个运行中任务”在进程内成立。
 */
export async function useProjectExtractionManager(projectRoot: string): Promise<ExtractionTaskManager> {
    const target = await resolveWorkspaceFileTarget(runtimePathsFromEnv(), {projectRoot});
    const {ready} = requireProjectHandles(projectRoot);
    let manager = managers.get(ready);
    if (!manager) {
        manager = createManager(target, ready);
        managers.set(ready, manager);
    }
    return manager;
}
