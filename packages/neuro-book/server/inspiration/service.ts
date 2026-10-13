import {randomUUID} from "node:crypto";
import {createError} from "h3";
import {z} from "zod";
import type {JsonValue} from "nbook/server/agent/messages/types";
import {
    InspirationCategorySchema, InspirationDraftSchema, InspirationMaterialSourcesSchema, INSPIRATION_TEMPLATE_FIELDS,
    type InspirationArtifactRefineDto, type InspirationConversationDto, type InspirationConversationSummaryDto, type InspirationDraftDto, type InspirationGenerateDto, type InspirationMaterialSourceDto, type InspirationMessageDto, type InspirationSaveDto, type InspirationSaveResultDto,
} from "nbook/shared/dto/inspiration.dto";

const PlanSchema = z.object({assignments: z.array(z.object({category: InspirationCategorySchema, brief: z.string().trim().min(1).max(20_000)}).strict()).min(1).max(8)}).strict()
    .refine(value => new Set(value.assignments.map(item => item.category)).size === value.assignments.length, "专业类别重复");
const StructuredFieldsSchema = z.record(z.string().trim().min(1).max(120), z.string().trim().min(1).max(80_000)).refine(value => Object.keys(value).length <= 32, "模板字段过多");
const OutputSchema = z.object({artifacts: z.array(z.object({title: z.string().trim().min(1).max(120), fields: StructuredFieldsSchema}).strict()).min(1).max(4)}).strict();
export interface InspirationAgentPort {
    run(input: {profileKey: string; projectRoot: string; parentSessionId?: number; promptSnapshotId?: string; initial: Record<string, JsonValue>; message: string; signal: AbortSignal; modelKey?: string; thinkingLevel?: import("nbook/shared/dto/app-settings.dto").ThinkingLevelDto; temperature?: number}): Promise<{sessionId: number; data: unknown}>;
    /** Conversation creation fixes the global version even when its first request is sent later. */
    promptSnapshot?(input: {projectRoot: string; conversationId?: string; inheritSessionId?: number; newConversation?: boolean}): Promise<string>;
}
export interface InspirationStoragePort {
    readDraft(id: string): Promise<unknown>;
    createDraft(draft: InspirationDraftDto): Promise<void>;
    save(draft: InspirationDraftDto, input: InspirationSaveDto): Promise<InspirationSaveResultDto>;
    createConversation(conversation: InspirationConversationDto): Promise<InspirationConversationDto>;
    readConversation(id: string): Promise<InspirationConversationDto>;
    listConversations(): Promise<InspirationConversationSummaryDto[]>;
    updateConversation(conversation: InspirationConversationDto): Promise<InspirationConversationDto>;
    /** 首次读取旧版工作台数据时清理旧提取消息与草稿；实现必须幂等且不得触碰 lorebook。 */
    cleanupLegacyExtractionData?(): Promise<void>;
}
export interface InspirationMaterialPort {
    readSelected(paths: readonly string[], signal: AbortSignal): Promise<InspirationMaterialSourceDto[]>;
}

/** 只协调已验证的草稿与专业会话；正式文件写入只通过显式 save 进入存储端口。 */
export class InspirationService {
    constructor(private readonly agents: InspirationAgentPort) {}

    async generate(input: InspirationGenerateDto, storage: InspirationStoragePort, signal: AbortSignal, materials?: InspirationMaterialPort): Promise<InspirationDraftDto> {
        signal.throwIfAborted();
        let previous: InspirationDraftDto | undefined;
        if (input.draftId) {
            previous = await this.readDraft(storage, input.projectRoot, input.draftId, input.revision!);
        }
        const designContext = await this.designContext(input, previous, signal, materials);
        signal.throwIfAborted();
        const promptSnapshotId = await this.agents.promptSnapshot?.({projectRoot: input.projectRoot, conversationId: input.conversationId, inheritSessionId: previous?.sessionId});
        if (input.conversationId) await this.appendMessage(storage, input.projectRoot, input.conversationId, {role: "user", kind: "design", content: input.request,
            creationMode: designContext.creationMode, materialPaths: designContext.materialSources.map(source => source.path)});
        const context = JSON.stringify({request: input.request, feedback: input.feedback, previousArtifacts: previous?.artifacts, ...designContext});
        const coordinator = await this.agents.run({profileKey: "inspiration", projectRoot: input.projectRoot, promptSnapshotId, initial: {}, message: context, signal, modelKey: input.modelKey, thinkingLevel: input.thinkingEnabled ? input.thinkingLevel : "off", temperature: input.temperature});
        signal.throwIfAborted();
        const plan = PlanSchema.parse(coordinator.data);
        const artifacts: InspirationDraftDto["artifacts"] = [];
        for (const assignment of plan.assignments) {
            signal.throwIfAborted();
            const result = await this.agents.run({
                profileKey: `inspiration.${assignment.category}`, projectRoot: input.projectRoot,
                parentSessionId: coordinator.sessionId, initial: {fields: [...INSPIRATION_TEMPLATE_FIELDS[assignment.category]]},
                message: JSON.stringify({request: input.request, brief: assignment.brief, feedback: input.feedback, previousArtifacts: previous?.artifacts, relatedArtifacts: artifacts, ...designContext}), signal,
                modelKey: input.modelKey, thinkingLevel: input.thinkingEnabled ? input.thinkingLevel : "off", temperature: input.temperature,
            });
            signal.throwIfAborted();
            const output = OutputSchema.parse(result.data);
            for (const artifact of output.artifacts) artifacts.push({title: artifact.title, content: this.renderTemplateContent(assignment.category, artifact.fields), id: randomUUID(), category: assignment.category, sessionId: result.sessionId});
        }
        // 每次反馈产生独立不可变快照，旧版本仍可查看；保存必须显式引用所审阅的快照身份。
        const draft = InspirationDraftSchema.parse({id: randomUUID(), projectRoot: input.projectRoot, revision: (previous?.revision ?? 0) + 1, request: input.request, artifacts, sessionId: coordinator.sessionId, createdAt: new Date().toISOString(),
            creationMode: designContext.creationMode, ...(designContext.materialSources.length ? {materialSources: designContext.materialSources} : {})});
        signal.throwIfAborted();
        await storage.createDraft(draft);
        if (input.conversationId) await this.appendMessage(storage, input.projectRoot, input.conversationId, {role: "assistant", kind: "design", content: `已生成 ${artifacts.length} 项待审阅的${designContext.creationMode === "adaptation" ? "改编" : "原创"}设计成果。`, draftId: draft.id,
            creationMode: designContext.creationMode, materialPaths: designContext.materialSources.map(source => source.path)});
        signal.throwIfAborted();
        return draft;
    }

    async refine(input: InspirationArtifactRefineDto, storage: InspirationStoragePort, signal: AbortSignal): Promise<{draft: InspirationDraftDto; answer?: string}> {
        signal.throwIfAborted();
        const previous = await this.readDraft(storage, input.projectRoot, input.draftId, input.revision);
        await this.readConversation(input.projectRoot, input.conversationId, storage);
        const artifact = previous.artifacts.find(item => item.id === input.artifactId);
        if (!artifact) throw createError({statusCode: 404, message: "候选成果不存在或已被替换"});
        const promptSnapshotId = await this.agents.promptSnapshot?.({projectRoot: input.projectRoot, conversationId: input.conversationId, inheritSessionId: previous.sessionId});
        const result = await this.agents.run({
            profileKey: `inspiration.${artifact.category}`,
            projectRoot: input.projectRoot,
            promptSnapshotId,
            initial: {fields: [...INSPIRATION_TEMPLATE_FIELDS[artifact.category]]},
            message: JSON.stringify({action: input.action, instruction: input.instruction, request: previous.request,
                creationMode: previous.creationMode ?? "original", materialSources: previous.materialSources ?? [],
                currentArtifact: {title: artifact.title, content: artifact.content},
                relatedArtifacts: previous.artifacts.filter(item => item.id !== artifact.id)}),
            signal, modelKey: input.modelKey, thinkingLevel: input.thinkingEnabled ? input.thinkingLevel : "off", temperature: input.temperature,
        });
        signal.throwIfAborted();
        if (input.action === "ask") {
            const output = OutputSchema.safeParse(result.data);
            const answer = output.success ? this.renderTemplateContent(artifact.category, output.data.artifacts[0]!.fields) : "已收到追问，但模型没有返回可解析的模板字段。";
            await this.appendMessage(storage, input.projectRoot, input.conversationId, {role: "assistant", kind: "design", content: answer,
                creationMode: previous.creationMode ?? "original", materialPaths: previous.materialSources?.map(source => source.path)});
            return {draft: previous, answer};
        }
        let title: string;
        let fields: Record<string, string>;
        const candidate = OutputSchema.parse(result.data).artifacts[0]!;
        title = candidate.title; fields = candidate.fields;
        const content = this.renderTemplateContent(artifact.category, fields);
        // 另存成果的身份与本次实际设计会话一起更新，避免重做沿用已保存条目的目标路径。
        const replacement = {...artifact, id: randomUUID(), sessionId: result.sessionId, title, content};
        const next = InspirationDraftSchema.parse({...previous, id: randomUUID(), revision: previous.revision + 1,
            artifacts: previous.artifacts.map(item => item.id === artifact.id ? replacement : {...item, id: randomUUID()}), createdAt: new Date().toISOString()});
        signal.throwIfAborted();
        await storage.createDraft(next);
        await this.appendMessage(storage, input.projectRoot, input.conversationId, {role: "assistant", kind: "design", content: `已针对“${artifact.title}”完成重新设计。`, draftId: next.id,
            creationMode: previous.creationMode ?? "original", materialPaths: previous.materialSources?.map(source => source.path)});
        return {draft: next};
    }

    private async designContext(input: InspirationGenerateDto, previous: InspirationDraftDto | undefined, signal: AbortSignal, materials?: InspirationMaterialPort) {
        const creationMode = input.creationMode ?? previous?.creationMode ?? "original";
        const paths = input.materialPaths ?? previous?.materialSources?.map(source => source.path) ?? [];
        if (previous && creationMode !== (previous.creationMode ?? "original")) {
            throw createError({statusCode: 409, message: "创作方式已改变，请作为新设计任务开始"});
        }
        if (new Set(paths.map(path => path.toLowerCase())).size !== paths.length) throw createError({statusCode: 400, message: "参考素材不能重复"});
        if (creationMode === "original") {
            if (paths.length) throw createError({statusCode: 400, message: "请选择改编模式后使用参考素材"});
            return {creationMode, materialSources: [] as InspirationMaterialSourceDto[]};
        }
        if (!paths.length) throw createError({statusCode: 400, message: "改编设计需要先选择参考素材"});
        if (previous) {
            const sources = InspirationMaterialSourcesSchema.parse(previous.materialSources ?? []);
            if (sources.length !== paths.length || sources.some(source => !paths.includes(source.path))) {
                throw createError({statusCode: 409, message: "参考素材已改变，请作为新设计任务开始"});
            }
            return {creationMode, materialSources: sources};
        }
        if (!materials) throw createError({statusCode: 503, message: "参考素材读取服务不可用"});
        const sources = InspirationMaterialSourcesSchema.parse(await materials.readSelected(paths, signal));
        if (sources.length !== paths.length || sources.some(source => !paths.includes(source.path))) {
            throw createError({statusCode: 400, message: "读取结果与所选参考素材不一致"});
        }
        return {creationMode, materialSources: sources};
    }

    async createConversation(projectRoot: string, storage: InspirationStoragePort, title = "新设计对话"): Promise<InspirationConversationDto> {
        const now = new Date().toISOString();
        const id = randomUUID();
        await this.agents.promptSnapshot?.({projectRoot, conversationId: id, newConversation: true});
        return storage.createConversation({id, projectRoot, title, createdAt: now, updatedAt: now, archivedAt: null, messages: []});
    }

    async listConversations(projectRoot: string, storage: InspirationStoragePort, includeArchived: boolean): Promise<InspirationConversationSummaryDto[]> {
        // Storage is already bound to the resolved current project target; projectRoot remains part of this boundary's API contract.
        void projectRoot;
        return (await storage.listConversations()).filter(item => !item.archivedAt || includeArchived);
    }

    async readConversation(projectRoot: string, id: string, storage: InspirationStoragePort): Promise<InspirationConversationDto> {
        const conversation = await storage.readConversation(id);
        if (conversation.projectRoot !== projectRoot) throw createError({statusCode: 404, message: "聊天记录不属于当前项目"});
        return conversation;
    }

    async archiveConversation(projectRoot: string, id: string, storage: InspirationStoragePort): Promise<InspirationConversationDto> {
        const conversation = await this.readConversation(projectRoot, id, storage);
        return storage.updateConversation({...conversation, archivedAt: new Date().toISOString(), updatedAt: new Date().toISOString()});
    }

    async save(input: InspirationSaveDto, storage: InspirationStoragePort): Promise<InspirationSaveResultDto> {
        const draft = await this.readDraft(storage, input.projectRoot, input.draftId, input.revision);
        const known = new Set(draft.artifacts.map(item => item.id));
        if (input.artifacts.some(item => !known.has(item.id))) throw createError({statusCode: 400, message: "待保存成果不属于此草稿"});
        return storage.save(draft, input);
    }

    private async readDraft(storage: InspirationStoragePort, projectRoot: string, id: string, revision: number): Promise<InspirationDraftDto> {
        const draft = InspirationDraftSchema.parse(await storage.readDraft(id));
        if (draft.id !== id || draft.projectRoot !== projectRoot || draft.revision !== revision) {
            throw createError({statusCode: 409, message: "草稿项目或版本不匹配，请重新审阅"});
        }
        return draft;
    }

    private async appendMessage(storage: InspirationStoragePort, projectRoot: string, id: string, message: Omit<InspirationMessageDto, "id" | "createdAt">): Promise<void> {
        const conversation = await this.readConversation(projectRoot, id, storage);
        if (conversation.archivedAt) throw createError({statusCode: 409, message: "聊天记录已归档，请新建对话后继续"});
        const createdAt = new Date().toISOString();
        await storage.updateConversation({...conversation, updatedAt: createdAt, messages: [...conversation.messages, {id: randomUUID(), createdAt, ...message}].slice(-200)});
    }

    private renderTemplateContent(category: keyof typeof INSPIRATION_TEMPLATE_FIELDS, fields: Record<string, string>): string {
        const allowed = new Set(INSPIRATION_TEMPLATE_FIELDS[category]);
        if (category !== "note" && Object.keys(fields).some(label => !allowed.has(label))) throw createError({statusCode: 502, message: `模板类别“${category}”包含未知字段`});
        const entries = Object.entries(fields).filter(([label, value]) => value.trim() && (category === "note" || allowed.has(label)));
        if (!entries.length) throw createError({statusCode: 502, message: `模板类别“${category}”未返回可用字段`});
        const order = new Map((INSPIRATION_TEMPLATE_FIELDS[category] as readonly string[]).map((label, index) => [label, index]));
        entries.sort(([a], [b]) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER));
        return entries.map(([label, value]) => `## ${label}\n\n${value.trim()}`).join("\n\n");
    }
}
