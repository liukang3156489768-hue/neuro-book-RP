import {createError} from "h3";
import {useAgentHarness} from "nbook/server/agent/http";
import {resolveWorkspaceFileTarget} from "nbook/server/workspace-files/novel-workspace";
import {runtimePathsFromEnv} from "nbook/server/runtime/paths/runtime-paths";
import {requireProjectHandles} from "nbook/server/workspace-files/project-open-guard";
import {runReadyProjectOperation} from "nbook/server/workspace-files/project-session";
import {withProjectHttpError} from "nbook/server/api/projects/project-http-error";
import {InspirationDraftSchema, type InspirationArtifactRefineDto, type InspirationConversationDto, type InspirationConversationSummaryDto, type InspirationExtractDto, type InspirationGenerateDto, type InspirationSaveDto} from "nbook/shared/dto/inspiration.dto";
import {InspirationService} from "./service";
import {createInspirationStorage} from "./storage";
import {prepareInspirationSource} from "./source";

const active = new Map<string, AbortController>();
const GENERATION_TIMEOUT_MS = 15 * 60 * 1000;
const service = new InspirationService({
    async run(input) {
        input.signal.throwIfAborted();
        const harness = useAgentHarness();
        const session = await harness.createAgent({profileKey: input.profileKey, currentProjectRoot: input.projectRoot, parentSessionId: input.parentSessionId, initial: input.initial});
        input.signal.throwIfAborted();
        const result = await harness.invokeAgent({sessionId: session.sessionId, mode: "prompt", message: {text: input.message}, modelKey: input.modelKey, thinkingLevel: input.thinkingLevel, requestOptionsPatch: input.temperature === undefined ? undefined : {temperature: input.temperature}, block: true, queueIfBusy: false, signal: input.signal});
        input.signal.throwIfAborted();
        if (result.status !== "completed" || result.reportResult?.success === false || result.reportResult?.data === undefined) {
            throw createError({statusCode: 502, message: "设计 Agent 未返回有效成果，请检查模型配置后重试；运行记录保留在 Agent 会话中"});
        }
        return {sessionId: session.sessionId, data: result.reportResult.data};
    },
});

/** 请求、项目关闭和总超时共同拥有取消；同步请求结束前等待 Harness 收尾。 */
export async function generateInspiration(input: InspirationGenerateDto, requestSignal: AbortSignal) {
    const key = `${input.projectRoot}/${input.requestId}`;
    if (active.has(key)) throw createError({statusCode: 409, message: "此设计请求正在运行"});
    const controller = new AbortController();
    active.set(key, controller);
    const timeout = setTimeout(() => controller.abort(new Error("设计超过十五分钟，请缩小需求后重试")), GENERATION_TIMEOUT_MS);
    try {
        return await withProjectHttpError(async () => {
            const target = await resolveWorkspaceFileTarget(runtimePathsFromEnv(), {projectRoot: input.projectRoot});
            const handles = requireProjectHandles(input.projectRoot);
            return runReadyProjectOperation(handles.ready, async projectSignal => {
                const signal = AbortSignal.any([requestSignal, projectSignal, controller.signal]);
                signal.throwIfAborted();
                return service.generate(input, createInspirationStorage(target), signal);
            });
        });
    } catch (error) {
        if (requestSignal.aborted || controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
            throw createError({statusCode: 409, message: "设计已停止，未保存到正式素材"});
        }
        throw error;
    } finally {
        clearTimeout(timeout);
        active.delete(key);
    }
}

export function cancelInspiration(projectRoot: string, requestId: string): {cancelled: boolean} {
    const controller = active.get(`${projectRoot}/${requestId}`);
    controller?.abort();
    return {cancelled: Boolean(controller)};
}

export async function extractInspiration(input: InspirationExtractDto, requestSignal: AbortSignal) {
    const key = `${input.projectRoot}/${input.requestId}`;
    if (active.has(key)) throw createError({statusCode: 409, message: "此分析请求正在运行"});
    const controller = new AbortController();
    active.set(key, controller);
    const timeout = setTimeout(() => controller.abort(new Error("分析超过十五分钟，请缩小范围后重试")), GENERATION_TIMEOUT_MS);
    try {
        return await withProjectHttpError(async () => {
            const target = await resolveWorkspaceFileTarget(runtimePathsFromEnv(), {projectRoot: input.projectRoot});
            const handles = requireProjectHandles(input.projectRoot);
            return runReadyProjectOperation(handles.ready, async projectSignal => {
                const signal = AbortSignal.any([requestSignal, projectSignal, controller.signal]);
                signal.throwIfAborted();
                // 每次运行从受保护的数据面重读来源；客户端预览和哈希都不能作为分析正文。
                const source = await prepareInspirationSource(target.root, input.path);
                return service.extract(input, source, createInspirationStorage(target), signal);
            });
        });
    } catch (error) {
        if (requestSignal.aborted || controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
            throw createError({statusCode: 409, message: "作品分析已停止，未保存到正式素材"});
        }
        throw error;
    } finally {
        clearTimeout(timeout);
        active.delete(key);
    }
}

async function withInspirationStorage<T>(projectRoot: string, action: (storage: ReturnType<typeof createInspirationStorage>) => Promise<T>): Promise<T> {
    return withProjectHttpError(async () => {
        const target = await resolveWorkspaceFileTarget(runtimePathsFromEnv(), {projectRoot});
        const handles = requireProjectHandles(projectRoot);
        return runReadyProjectOperation(handles.ready, () => action(createInspirationStorage(target)));
    });
}

export function createInspirationConversation(projectRoot: string, title?: string): Promise<InspirationConversationDto> {
    return withInspirationStorage(projectRoot, storage => service.createConversation(projectRoot, storage, title));
}

export function listInspirationConversations(projectRoot: string, includeArchived: boolean): Promise<InspirationConversationSummaryDto[]> {
    return withInspirationStorage(projectRoot, storage => service.listConversations(projectRoot, storage, includeArchived));
}

export function readInspirationConversation(projectRoot: string, id: string): Promise<InspirationConversationDto> {
    return withInspirationStorage(projectRoot, storage => service.readConversation(projectRoot, id, storage));
}

export function archiveInspirationConversation(projectRoot: string, id: string): Promise<InspirationConversationDto> {
    return withInspirationStorage(projectRoot, storage => service.archiveConversation(projectRoot, id, storage));
}

export async function readInspirationDraft(projectRoot: string, id: string): Promise<import("nbook/shared/dto/inspiration.dto").InspirationDraftDto> {
    return withInspirationStorage(projectRoot, async storage => {
        const draft = InspirationDraftSchema.parse(await storage.readDraft(id));
        if (draft.projectRoot !== projectRoot) throw createError({statusCode: 404, message: "草稿不属于当前项目"});
        return draft;
    });
}

export async function saveInspiration(input: InspirationSaveDto) {
    return withProjectHttpError(async () => {
        const target = await resolveWorkspaceFileTarget(runtimePathsFromEnv(), {projectRoot: input.projectRoot});
        const handles = requireProjectHandles(input.projectRoot);
        return runReadyProjectOperation(handles.ready, () => service.save(input, createInspirationStorage(target)));
    });
}

export async function refineInspiration(input: InspirationArtifactRefineDto, requestSignal: AbortSignal) {
    const key = `${input.projectRoot}/${input.requestId}`;
    if (active.has(key)) throw createError({statusCode: 409, message: "此请求正在运行"});
    const controller = new AbortController(); active.set(key, controller);
    try {
        return await withProjectHttpError(async () => {
            const target = await resolveWorkspaceFileTarget(runtimePathsFromEnv(), {projectRoot: input.projectRoot});
            const handles = requireProjectHandles(input.projectRoot);
            return runReadyProjectOperation(handles.ready, async projectSignal => {
                const signal = AbortSignal.any([requestSignal, projectSignal, controller.signal]); signal.throwIfAborted();
                const storage = createInspirationStorage(target);
                const draft = InspirationDraftSchema.parse(await storage.readDraft(input.draftId));
                const artifact = draft.artifacts.find(item => item.id === input.artifactId);
                const source = artifact?.source ? await prepareInspirationSource(target.root, artifact.source.path) : undefined;
                if (artifact?.source && (!source || source.source.sha256 !== artifact.source.sha256 || !source.chunks.some(chunk => chunk.index === artifact.source?.chunkIndex))) {
                    throw createError({statusCode: 409, message: "候选成果引用的作品已变化，请重新分析来源后再提取"});
                }
                return service.refine(input, source, storage, signal);
            });
        });
    } finally { active.delete(key); }
}
