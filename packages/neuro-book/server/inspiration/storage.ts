import {createError} from "h3";
import {readdir} from "node:fs/promises";
import path from "node:path";
import {z} from "zod";
import {InspirationConversationSchema, InspirationConversationSummarySchema, type InspirationConversationDto, type InspirationConversationSummaryDto, type InspirationDraftDto, type InspirationSaveDto, type InspirationSaveResultDto} from "nbook/shared/dto/inspiration.dto";
import type {InspirationStoragePort} from "./service";
import type {WorkspaceFileTarget} from "nbook/server/workspace-files/workspace-file-target";
import {withProjectTargetMutation, type ProjectDataPlaneHandles} from "nbook/server/workspace-files/project-open-guard";
import {deleteWorkspacePath, readWorkspaceTextFile, workspacePathExists, renderMarkdownDocument, writeWorkspaceTextFile} from "nbook/server/workspace-files/workspace-files";
import {createWorkspaceContentFrontmatterDefaults} from "nbook/server/workspace-files/content-node-schema";
import {createWorkspaceFileTracked, USER_LOCAL_ACTOR} from "nbook/server/workspace-history/tracked-workspace-files";

const ConfirmationSchema = z.object({id: z.string().uuid(), path: z.string(), content: z.string()}).strict();
const ReceiptSchema = z.object({id: z.string().uuid(), path: z.string()}).strict();
const locks = new Map<string, Promise<void>>();

/** 同一草稿串行确认，失败重试从已持久化的确认内容与保存回执恢复。 */
export async function withInspirationLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    locks.set(key, current);
    await previous;
    try { return await action(); } finally { release(); if (locks.get(key) === current) locks.delete(key); }
}

export function createInspirationStorage(target: WorkspaceFileTarget): InspirationStoragePort {
    const draftPath = (id: string) => `.nbook/inspiration/${id}/draft.json`;
    const conversationPath = (id: string) => `.nbook/inspiration/conversations/${id}.json`;
    const create = async (handles: ProjectDataPlaneHandles | undefined, path: string, content: string) => {
        await createWorkspaceFileTracked({target, history: handles?.history, filePath: path, content, actor: USER_LOCAL_ACTOR});
    };
    const removeIfPresent = async (relativePath: string, recursive: boolean) => {
        if (await workspacePathExists(target.root, relativePath)) await deleteWorkspacePath(target.root, relativePath, recursive);
    };
    const isLegacyDraft = (value: unknown): boolean => {
        if (typeof value !== "object" || value === null || !Array.isArray((value as {artifacts?: unknown}).artifacts)) return false;
        return (value as {artifacts: unknown[]}).artifacts.some(artifact => typeof artifact === "object" && artifact !== null && "source" in artifact);
    };
    const cleanupLegacyExtractionData = async (): Promise<void> => withInspirationLock(`${target.root}/legacy-extraction-cleanup`, () => withProjectTargetMutation(target, async () => {
        const conversationDirectory = path.join(target.root, ".nbook", "inspiration", "conversations");
        const draftDirectory = path.join(target.root, ".nbook", "inspiration");
        const legacyDraftIds = new Set<string>();
        let draftEntries: string[] = [];
        try { draftEntries = await readdir(draftDirectory); } catch (error: unknown) {
            if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
        }
        for (const entry of draftEntries.filter(item => /^[0-9a-f-]{36}$/iu.test(item))) {
            try {
                const raw = JSON.parse(await readWorkspaceTextFile(target.root, `.nbook/inspiration/${entry}/draft.json`));
                if (isLegacyDraft(raw)) legacyDraftIds.add(entry);
            } catch (error: unknown) {
                if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
            }
        }
        let conversationEntries: string[] = [];
        try { conversationEntries = await readdir(conversationDirectory); } catch (error: unknown) {
            if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
        }
        for (const file of conversationEntries.filter(item => /^[0-9a-f-]{36}\.json$/iu.test(item))) {
            const id = file.slice(0, -5);
            const relative = conversationPath(id);
            const raw = JSON.parse(await readWorkspaceTextFile(target.root, relative)) as {messages?: Array<Record<string, unknown>>; updatedAt?: string};
            const messages = Array.isArray(raw.messages) ? raw.messages : [];
            const hasExtract = messages.some(message => message.kind === "extract");
            const removedDraftIds = new Set(messages.filter(message => message.kind === "extract" || (typeof message.draftId === "string" && legacyDraftIds.has(message.draftId)))
                .map(message => typeof message.draftId === "string" ? message.draftId : null).filter((draftId): draftId is string => draftId !== null));
            if (!hasExtract && !removedDraftIds.size) continue;
            const kept = messages.filter(message => message.kind !== "extract" && !(typeof message.draftId === "string" && removedDraftIds.has(message.draftId)));
            for (const draftId of removedDraftIds) legacyDraftIds.add(draftId);
            if (!kept.length) await removeIfPresent(relative, false);
            else await writeWorkspaceTextFile(target.root, relative, JSON.stringify({...raw, messages: kept, updatedAt: new Date().toISOString()}));
        }
        for (const draftId of legacyDraftIds) await removeIfPresent(`.nbook/inspiration/${draftId}`, true);
    }));
    return {
        async readDraft(id) {
            try { return JSON.parse(await readWorkspaceTextFile(target.root, draftPath(id))); }
            catch (error: unknown) {
                if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") throw createError({statusCode: 404, message: "设计草稿不存在或已被移除"});
                throw error;
            }
        },
        async createDraft(draft) {
            await withProjectTargetMutation(target, handles => create(handles, draftPath(draft.id), JSON.stringify(draft)));
        },
        async createConversation(conversation: InspirationConversationDto) {
            await withProjectTargetMutation(target, handles => create(handles, conversationPath(conversation.id), JSON.stringify(conversation)));
            return conversation;
        },
        async readConversation(id: string) {
            try {
                return InspirationConversationSchema.parse(JSON.parse(await readWorkspaceTextFile(target.root, conversationPath(id))));
            } catch (error: unknown) {
                if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
                    throw createError({statusCode: 404, message: "聊天记录不存在或已被移除"});
                }
                throw error;
            }
        },
        async listConversations() {
            const directory = path.join(target.root, ".nbook", "inspiration", "conversations");
            let entries: string[];
            try { entries = await readdir(directory); } catch (error: unknown) {
                if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
                throw error;
            }
            const conversations = await Promise.all(entries.filter(entry => /^[0-9a-f-]{36}\.json$/iu.test(entry)).map(async file => {
                const id = file.slice(0, -5);
                return InspirationConversationSchema.parse(JSON.parse(await readWorkspaceTextFile(target.root, conversationPath(id))));
            }));
            return conversations.map(conversation => InspirationConversationSummarySchema.parse({id: conversation.id, title: conversation.title, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, archivedAt: conversation.archivedAt, messageCount: conversation.messages.length}))
                .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        },
        cleanupLegacyExtractionData,
        async updateConversation(conversation: InspirationConversationDto) {
            return withInspirationLock(`${target.root}/conversation/${conversation.id}`, () => withProjectTargetMutation(target, async () => {
                if (!await workspacePathExists(target.root, conversationPath(conversation.id))) {
                    throw createError({statusCode: 404, message: "聊天记录不存在或已被移除"});
                }
                // 对话属于 .nbook 内部状态，不是内容节点；仍经项目 mutation gate 保护其项目生命周期。
                await writeWorkspaceTextFile(target.root, conversationPath(conversation.id), JSON.stringify(conversation));
                return conversation;
            }));
        },
        async save(draft: InspirationDraftDto, input: InspirationSaveDto): Promise<InspirationSaveResultDto> {
            return withInspirationLock(`${target.root}/${draft.id}`, () => withProjectTargetMutation(target, async handles => {
                const saved: InspirationSaveResultDto["saved"] = [];
                for (const edited of input.artifacts) {
                    const original = draft.artifacts.find(item => item.id === edited.id);
                    if (!original) throw createError({statusCode: 400, message: "草稿成果不存在"});
                    const path = `lorebook/${original.category}/inspiration-${original.id}/index.md`;
                    const frontmatter = createWorkspaceContentFrontmatterDefaults({title: edited.title, type: original.category, status: "active"});
                    frontmatter.governance = {source: "generated", review: "reviewed"};
                    frontmatter.ext = {inspiration: {draftId: draft.id, revision: draft.revision, artifactId: original.id, sessionId: original.sessionId,
                        ...(draft.creationMode ? {creationMode: draft.creationMode} : {}),
                        ...(draft.materialSources?.length ? {materialSources: draft.materialSources.map(({content: _content, ...source}) => source)} : {})}};
                    const content = renderMarkdownDocument(frontmatter, edited.content);
                    const confirmationPath = `.nbook/inspiration/${draft.id}/confirmed/${original.id}.json`;
                    const receiptPath = `.nbook/inspiration/${draft.id}/saved/${original.id}.json`;
                    if (await workspacePathExists(target.root, confirmationPath)) {
                        const confirmed = ConfirmationSchema.parse(JSON.parse(await readWorkspaceTextFile(target.root, confirmationPath)));
                        if (confirmed.id !== original.id || confirmed.path !== path || confirmed.content !== content) {
                            throw createError({statusCode: 409, message: "该成果已经确认过不同内容，请重新生成草稿后保存"});
                        }
                    } else {
                        // 先固定用户确认的字节，后续失败只能以完全相同内容重试，不能覆盖已存在素材。
                        await create(handles, confirmationPath, JSON.stringify({id: original.id, path, content}));
                    }
                    if (await workspacePathExists(target.root, receiptPath)) {
                        const receipt = ReceiptSchema.parse(JSON.parse(await readWorkspaceTextFile(target.root, receiptPath)));
                        if (receipt.id !== original.id || receipt.path !== path) {
                            throw createError({statusCode: 409, message: "保存回执与草稿成果不匹配，请重新生成草稿后重试"});
                        }
                    } else {
                        if (await workspacePathExists(target.root, path)) {
                            if (await readWorkspaceTextFile(target.root, path) !== content) {
                                throw createError({statusCode: 409, message: "目标素材已存在且内容不同，未覆盖原文件"});
                            }
                        } else {
                            await create(handles, path, content);
                        }
                        await create(handles, receiptPath, JSON.stringify({id: original.id, path}));
                    }
                    saved.push({id: original.id, path});
                }
                return {draftId: draft.id, revision: draft.revision, saved};
            }));
        },
    };
}
