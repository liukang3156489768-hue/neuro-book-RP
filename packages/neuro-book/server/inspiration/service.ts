import {randomUUID} from "node:crypto";
import {createError} from "h3";
import {z} from "zod";
import type {JsonValue} from "nbook/server/agent/messages/types";
import {
    InspirationCategorySchema, InspirationDraftSchema, INSPIRATION_TEMPLATE_FIELDS,
    type InspirationArtifactRefineDto, type InspirationConversationDto, type InspirationConversationSummaryDto, type InspirationDraftDto, type InspirationExtractDto, type InspirationGenerateDto, type InspirationMessageDto, type InspirationSaveDto, type InspirationSaveResultDto,
} from "nbook/shared/dto/inspiration.dto";
import type {InspirationSourcePrepareResponseDto} from "nbook/shared/dto/inspiration-source.dto";

const PlanSchema = z.object({assignments: z.array(z.object({category: InspirationCategorySchema, brief: z.string().trim().min(1).max(20_000)}).strict()).min(1).max(8)}).strict()
    .refine(value => new Set(value.assignments.map(item => item.category)).size === value.assignments.length, "专业类别重复");
const StructuredFieldsSchema = z.record(z.string().trim().min(1).max(120), z.string().trim().min(1).max(80_000)).refine(value => Object.keys(value).length <= 32, "模板字段过多");
const OutputSchema = z.object({artifacts: z.array(z.object({title: z.string().trim().min(1).max(120), fields: StructuredFieldsSchema}).strict()).min(1).max(4)}).strict();
const ExtractionOutputSchema = z.object({artifacts: z.array(z.object({
    category: InspirationCategorySchema, title: z.string().trim().min(1).max(120), fields: StructuredFieldsSchema,
    citations: z.array(z.object({firstParagraphId: z.string().regex(/^P[1-9]\d*$/u), lastParagraphId: z.string().regex(/^P[1-9]\d*$/u)}).strict()).min(1).max(12),
}).strict()).min(1).max(12)}).strict();

export interface InspirationAgentPort {
    run(input: {profileKey: string; projectRoot: string; parentSessionId?: number; initial: Record<string, JsonValue>; message: string; signal: AbortSignal; modelKey?: string; thinkingLevel?: import("nbook/shared/dto/app-settings.dto").ThinkingLevelDto; temperature?: number}): Promise<{sessionId: number; data: unknown}>;
}
export interface InspirationStoragePort {
    readDraft(id: string): Promise<unknown>;
    createDraft(draft: InspirationDraftDto): Promise<void>;
    save(draft: InspirationDraftDto, input: InspirationSaveDto): Promise<InspirationSaveResultDto>;
    createConversation(conversation: InspirationConversationDto): Promise<InspirationConversationDto>;
    readConversation(id: string): Promise<InspirationConversationDto>;
    listConversations(): Promise<InspirationConversationSummaryDto[]>;
    updateConversation(conversation: InspirationConversationDto): Promise<InspirationConversationDto>;
}

/** 只协调已验证的草稿与专业会话；正式文件写入只通过显式 save 进入存储端口。 */
export class InspirationService {
    constructor(private readonly agents: InspirationAgentPort) {}

    async generate(input: InspirationGenerateDto, storage: InspirationStoragePort, signal: AbortSignal): Promise<InspirationDraftDto> {
        signal.throwIfAborted();
        if (input.conversationId) await this.appendMessage(storage, input.projectRoot, input.conversationId, {role: "user", kind: "design", content: input.request});
        let previous: InspirationDraftDto | undefined;
        if (input.draftId) {
            previous = await this.readDraft(storage, input.projectRoot, input.draftId, input.revision!);
        }
        const context = JSON.stringify({request: input.request, feedback: input.feedback, previousArtifacts: previous?.artifacts});
        const coordinator = await this.agents.run({profileKey: "inspiration", projectRoot: input.projectRoot, initial: {}, message: context, signal, modelKey: input.modelKey, thinkingLevel: input.thinkingEnabled ? input.thinkingLevel : "off", temperature: input.temperature});
        signal.throwIfAborted();
        const plan = PlanSchema.parse(coordinator.data);
        const artifacts: InspirationDraftDto["artifacts"] = [];
        for (const assignment of plan.assignments) {
            signal.throwIfAborted();
            const result = await this.agents.run({
                profileKey: `inspiration.${assignment.category}`, projectRoot: input.projectRoot,
                parentSessionId: coordinator.sessionId, initial: {fields: [...INSPIRATION_TEMPLATE_FIELDS[assignment.category]]},
                message: JSON.stringify({request: input.request, brief: assignment.brief, feedback: input.feedback, previousArtifacts: previous?.artifacts, relatedArtifacts: artifacts}), signal,
                modelKey: input.modelKey, thinkingLevel: input.thinkingEnabled ? input.thinkingLevel : "off", temperature: input.temperature,
            });
            signal.throwIfAborted();
            const output = OutputSchema.parse(result.data);
            for (const artifact of output.artifacts) artifacts.push({title: artifact.title, content: this.renderTemplateContent(assignment.category, artifact.fields), id: randomUUID(), category: assignment.category, sessionId: result.sessionId});
        }
        // 每次反馈产生独立不可变快照，旧版本仍可查看；保存必须显式引用所审阅的快照身份。
        const draft = InspirationDraftSchema.parse({id: randomUUID(), projectRoot: input.projectRoot, revision: (previous?.revision ?? 0) + 1, request: input.request, artifacts, sessionId: coordinator.sessionId, createdAt: new Date().toISOString()});
        signal.throwIfAborted();
        await storage.createDraft(draft);
        if (input.conversationId) await this.appendMessage(storage, input.projectRoot, input.conversationId, {role: "assistant", kind: "design", content: `已生成 ${artifacts.length} 项待审阅的原创设计成果。`, draftId: draft.id});
        signal.throwIfAborted();
        return draft;
    }

    async extract(input: InspirationExtractDto, source: InspirationSourcePrepareResponseDto, storage: InspirationStoragePort, signal: AbortSignal): Promise<InspirationDraftDto> {
        signal.throwIfAborted();
        const chunks = input.chunkIndexes.map(index => source.chunks.find(chunk => chunk.index === index)).filter((chunk): chunk is NonNullable<typeof chunk> => Boolean(chunk));
        if (chunks.length !== input.chunkIndexes.length) throw createError({statusCode: 409, message: "作品分块已变化，请重新选择分析范围"});
        await this.appendMessage(storage, input.projectRoot, input.conversationId, {
            role: "user", kind: "extract", content: input.request,
            source: {path: source.source.path, sha256: source.source.sha256, chunkIndexes: input.chunkIndexes},
        });
        const artifacts: InspirationDraftDto["artifacts"] = [];
        let sessionId = 0;
        for (const chunk of chunks) {
            signal.throwIfAborted();
            const text = source.paragraphs.filter(paragraph => paragraph.chunkIndex === chunk.index).map(paragraph => `[${paragraph.id}]\n${paragraph.text}`).join("");
            const result = await this.agents.run({
                profileKey: "inspiration.extract", projectRoot: input.projectRoot,
                initial: {categories: input.categories, fields: Object.fromEntries(input.categories.map(category => [category, [...INSPIRATION_TEMPLATE_FIELDS[category]]]))},
                message: JSON.stringify({request: input.request, source: {path: source.source.path, sha256: source.source.sha256, chunkIndex: chunk.index, firstParagraphId: chunk.firstParagraphId, lastParagraphId: chunk.lastParagraphId}, text}), signal,
                modelKey: input.modelKey, thinkingLevel: input.thinkingEnabled ? input.thinkingLevel : "off", temperature: input.temperature,
            });
            sessionId = result.sessionId;
            const output = ExtractionOutputSchema.parse(result.data);
            for (const artifact of output.artifacts) {
                if (!input.categories.includes(artifact.category) || !artifact.citations.every(citation => this.isCitationInChunk(citation, chunk))) {
                    throw createError({statusCode: 502, message: "提取 Agent 返回了范围外的类别或段落引用，请重试"});
                }
                artifacts.push({category: artifact.category, title: artifact.title, content: this.renderTemplateContent(artifact.category, artifact.fields), id: randomUUID(), sessionId: result.sessionId, source: {path: source.source.path, sha256: source.source.sha256, chunkIndex: chunk.index, citations: artifact.citations}});
            }
        }
        if (sessionId === 0 || artifacts.length === 0) throw createError({statusCode: 502, message: "提取 Agent 未返回可审阅成果"});
        const draft = InspirationDraftSchema.parse({id: randomUUID(), projectRoot: input.projectRoot, revision: 1, request: input.request, artifacts, sessionId, createdAt: new Date().toISOString()});
        signal.throwIfAborted();
        await storage.createDraft(draft);
        await this.appendMessage(storage, input.projectRoot, input.conversationId, {role: "assistant", kind: "extract", content: `已从 ${chunks.length} 个分块提取 ${artifacts.length} 项待审阅成果；每项均保留原文段落引用。`, draftId: draft.id});
        return draft;
    }

    async refine(input: InspirationArtifactRefineDto, source: InspirationSourcePrepareResponseDto | undefined, storage: InspirationStoragePort, signal: AbortSignal): Promise<{draft: InspirationDraftDto; answer?: string}> {
        const previous = await this.readDraft(storage, input.projectRoot, input.draftId, input.revision);
        const artifact = previous.artifacts.find(item => item.id === input.artifactId);
        if (!artifact) throw createError({statusCode: 404, message: "候选成果不存在或已被替换"});
        const result = await this.agents.run({
            profileKey: artifact.source ? "inspiration.extract" : `inspiration.${artifact.category}`,
            projectRoot: input.projectRoot,
            initial: artifact.source ? {categories: [artifact.category], fields: {[artifact.category]: [...INSPIRATION_TEMPLATE_FIELDS[artifact.category]]}} : {fields: [...INSPIRATION_TEMPLATE_FIELDS[artifact.category]]},
            message: JSON.stringify({action: input.action, instruction: input.instruction, currentArtifact: {title: artifact.title, content: artifact.content}, source: source?.source, sourceText: source?.paragraphs.filter(p => p.chunkIndex === artifact.source?.chunkIndex).map(p => `[${p.id}]\n${p.text}`).join("")}),
            signal, modelKey: input.modelKey, thinkingLevel: input.thinkingEnabled ? input.thinkingLevel : "off", temperature: input.temperature,
        });
        if (input.action === "ask") {
            const output = artifact.source ? ExtractionOutputSchema.safeParse(result.data) : OutputSchema.safeParse(result.data);
            const answer = output.success ? this.renderTemplateContent(artifact.category, output.data.artifacts[0]!.fields) : "已收到追问，但模型没有返回可解析的模板字段。";
            await this.appendMessage(storage, input.projectRoot, input.conversationId, {role: "assistant", kind: artifact.source ? "extract" : "design", content: answer});
            return {draft: previous, answer};
        }
        let title: string;
        let fields: Record<string, string>;
        let citations = artifact.source?.citations;
        if (artifact.source) {
            const candidate = ExtractionOutputSchema.parse(result.data).artifacts[0]!;
            if (candidate.category !== artifact.category || !candidate.citations.every(citation => source?.chunks.some(chunk => chunk.index === artifact.source?.chunkIndex && this.isCitationInChunk(citation, chunk)))) {
                throw createError({statusCode: 502, message: "重新提取返回了范围外的类别或段落引用，请重试"});
            }
            title = candidate.title; fields = candidate.fields; citations = candidate.citations;
        } else {
            const candidate = OutputSchema.parse(result.data).artifacts[0]!;
            title = candidate.title; fields = candidate.fields;
        }
        const content = this.renderTemplateContent(artifact.category, fields);
        const replacement = {...artifact, title, content, ...(artifact.source && citations ? {source: {...artifact.source, citations}} : {})};
        const next = InspirationDraftSchema.parse({...previous, id: randomUUID(), revision: previous.revision + 1, artifacts: previous.artifacts.map(item => item.id === artifact.id ? replacement : item), createdAt: new Date().toISOString()});
        await storage.createDraft(next);
        await this.appendMessage(storage, input.projectRoot, input.conversationId, {role: "assistant", kind: artifact.source ? "extract" : "design", content: `已针对“${artifact.title}”完成重新提取。`, draftId: next.id});
        return {draft: next};
    }

    async createConversation(projectRoot: string, storage: InspirationStoragePort, title = "新设计对话"): Promise<InspirationConversationDto> {
        const now = new Date().toISOString();
        return storage.createConversation({id: randomUUID(), projectRoot, title, createdAt: now, updatedAt: now, archivedAt: null, messages: []});
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

    private isCitationInChunk(citation: {firstParagraphId: string; lastParagraphId: string}, chunk: InspirationSourcePrepareResponseDto["chunks"][number]): boolean {
        const first = Number(citation.firstParagraphId.slice(1)); const last = Number(citation.lastParagraphId.slice(1));
        return Number.isInteger(first) && Number.isInteger(last) && first <= last
            && first >= Number(chunk.firstParagraphId.slice(1)) && last <= Number(chunk.lastParagraphId.slice(1));
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
