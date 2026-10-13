import type {AbsoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {runtimePathsFromEnv} from "nbook/server/runtime/paths/runtime-paths";
import {resolveWorkspaceFileTarget} from "nbook/server/workspace-files/novel-workspace";
import {requireProjectHandles} from "nbook/server/workspace-files/project-open-guard";
import {runReadyProjectOperation} from "nbook/server/workspace-files/project-session";
import type {ReadyProjectSessionRef} from "nbook/server/workspace-files/project-session-types";
import type {ExtractionSourceRef} from "nbook/shared/dto/inspiration-extraction-task.dto";
import {prepareInspirationSource} from "../source";
import type {ExtractionTaskManager} from "./manager";
import {createProjectExtractionModel} from "./model-adapter";
import {MaterialReviewService} from "./material-review-service";
import {registerMaterialExtractionPipeline} from "./material-pipeline";
import {listClassificationWithDetails} from "./material-consolidate";
import type {Confirmer} from "./material-write";
import {listOutlineDestinations, type OutlineDestinationOption} from "./outline-destination";
import {registerOutlineExtractionPipeline} from "./outline-register";
import {createReadyOutlinePlanning} from "./outline-planning";
import {resummarizeVolumesAndTotal, type ResummarizeResult} from "./outline-resummarize";
import {useProjectExtractionManager} from "./runtime";
import {createFileExtractionStore} from "./store-file";
import {createMaterialIntermediate} from "./material-intermediate";
import type {ClassificationView} from "./material-consolidate";

/**
 * 提取功能的服务装配：路由、Agent 工具与测试共用的唯一依赖面。
 * 调用方只拿到领域服务，不自己解析项目或拼装流水线，因此“按调用来源判定确认者”与
 * “同一任务的控制操作串行”这两条规则只在这里定义一次。
 */

/** 界面请求的确认者。请求体不携带也不接受确认者，路由只能用这个常量。 */
export const USER_CONFIRMER: Confirmer = Object.freeze({kind: "user"});

/** Agent 工具的确认者；会话 ID 来自工具上下文，不来自模型给出的参数。 */
export function agentConfirmer(sessionId: string): Confirmer {
    return Object.freeze({kind: "agent", sessionId});
}

/**
 * 按任务 ID 串行化的执行队列。管理器内部有同样的私有队列，但“重新汇总本卷与总纲”不经管理器，
 * 所以路由层把所有改变任务记录的操作（取消、继续、重试、跳过、提供输入、重新汇总）放进同一个队列，
 * 重新汇总就不会与同一任务的管理器操作交错读写 `task.json`。前一个操作失败不影响后一个。
 */
export function createTaskSerializer(): <T>(taskId: string, action: () => Promise<T>) => Promise<T> {
    const tails = new Map<string, Promise<unknown>>();
    return (taskId, action) => {
        const result = (tails.get(taskId) ?? Promise.resolve()).catch(() => undefined).then(action);
        const tail = result.catch(() => undefined);
        tails.set(taskId, tail);
        void tail.then(() => {
            if (tails.get(taskId) === tail) tails.delete(taskId);
        });
        return result;
    };
}

export type ExtractionServices = Readonly<{
    /** 项目工作区根，仅用于读取来源。 */
    root: AbsoluteFsPath;
    manager: ExtractionTaskManager;
    review: MaterialReviewService;
    classification(taskId: string): Promise<ClassificationView>;
    /** 同一任务的控制操作排队执行，见 `createTaskSerializer`。 */
    serialize<T>(taskId: string, action: () => Promise<T>): Promise<T>;
    /** 在当前项目 generation 的操作内取得生命周期信号；项目关闭会中止它并等待收尾。 */
    withSignal<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T>;
    /** 某个来源已有提取方案可作为数据去向的选项；来源哈希取自磁盘而不是客户端。 */
    destinations(sourcePath: string): Promise<{source: ExtractionSourceRef; options: OutlineDestinationOption[]}>;
    /** 重新汇总过期的卷纲与总纲；与同一任务的其他控制操作串行。 */
    resummarize(taskId: string): Promise<ResummarizeResult>;
}>;

// 与 `runtime.ts` 的管理器同寿命：项目关闭再打开得到新的 ready 引用，因此得到新的服务与新的队列。
let servicesByReady = new WeakMap<ReadyProjectSessionRef, ExtractionServices>();

/** 仅供测试清理缓存。 */
export function resetExtractionServicesForTests(): void {
    servicesByReady = new WeakMap();
}

/**
 * 取得当前打开项目的提取服务。同时注册两条流水线（幂等），所以任何入口在启动任务前都不必自己注册。
 * 项目未打开时抛 `ProjectNotOpenError`，由路由层的项目错误映射处理。
 */
export async function useProjectExtractionServices(projectRoot: string): Promise<ExtractionServices> {
    registerOutlineExtractionPipeline();
    registerMaterialExtractionPipeline();
    const manager = await useProjectExtractionManager(projectRoot);
    const target = await resolveWorkspaceFileTarget(runtimePathsFromEnv(), {projectRoot});
    const {ready} = requireProjectHandles(projectRoot);
    const cached = servicesByReady.get(ready);
    if (cached && cached.manager === manager) return cached;

    const model = createProjectExtractionModel(ready);
    const planning = createReadyOutlinePlanning(ready);
    const store = createFileExtractionStore(target);
    const serialize = createTaskSerializer();
    const withSignal: ExtractionServices["withSignal"] = action => runReadyProjectOperation(ready, signal => action(signal));
    const services: ExtractionServices = {
        root: target.root,
        manager,
        // 一个 ready generation 一个审阅服务：它的按任务队列只在同一实例内有效。
        review: new MaterialReviewService({target, tasks: manager, model}),
        classification: async taskId => {
            const task = await manager.get(taskId);
            // 任务 ID 由 manager 校验；为每次读取创建带真实任务 ID 的中间存储，避免把路径拼接逻辑放进路由。
            return listClassificationWithDetails(task, createMaterialIntermediate(target, task.id));
        },
        serialize,
        withSignal,
        async destinations(sourcePath) {
            const prepared = await prepareInspirationSource(target.root, sourcePath);
            const source: ExtractionSourceRef = {path: prepared.source.path, sha256: prepared.source.sha256};
            const [snapshot, tasks] = await Promise.all([planning.snapshot(), store.list()]);
            return {source, options: listOutlineDestinations({snapshot, tasks, source})};
        },
        resummarize: taskId => serialize(taskId, () => withSignal(async signal => {
            // 取自管理器：读取时已把“运行中但无执行者”归一化为已中断，resummarize 据此拒绝仍在运行的任务。
            const task = await manager.get(taskId);
            return resummarizeVolumesAndTotal({task, store, planning, model, signal});
        })),
    };
    servicesByReady.set(ready, services);
    return services;
}
