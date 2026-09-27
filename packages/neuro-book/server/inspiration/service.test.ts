import {randomUUID} from "node:crypto";
import {describe, expect, it, vi} from "vitest";
import {InspirationService, type InspirationAgentPort, type InspirationStoragePort} from "./service";
import {InspirationExtractSchema, InspirationGenerateSchema, InspirationSaveSchema, type InspirationConversationDto, type InspirationDraftDto} from "nbook/shared/dto/inspiration.dto";

function storage() {
    const drafts = new Map<string, InspirationDraftDto>();
    const conversations = new Map<string, InspirationConversationDto>();
    const port: InspirationStoragePort = {
        readDraft: vi.fn(async id => drafts.get(id)),
        createDraft: vi.fn(async draft => { drafts.set(draft.id, draft); }),
        save: vi.fn(async (draft, input) => ({draftId: draft.id, revision: draft.revision, saved: input.artifacts.map(item => ({id: item.id, path: item.id}))})),
        createConversation: vi.fn(async conversation => { conversations.set(conversation.id, conversation); return conversation; }),
        readConversation: vi.fn(async id => conversations.get(id)),
        listConversations: vi.fn(async () => [...conversations.values()].map(item => ({id: item.id, title: item.title, createdAt: item.createdAt, updatedAt: item.updatedAt, archivedAt: item.archivedAt, messageCount: item.messages.length}))),
        updateConversation: vi.fn(async conversation => { conversations.set(conversation.id, conversation); return conversation; }),
    };
    return {drafts, conversations, port};
}
function agents(): InspirationAgentPort {
    let sessionId = 0;
    return {run: vi.fn(async input => ({sessionId: ++sessionId, data: input.profileKey === "inspiration"
        ? {assignments: [{category: "world", brief: "海边蒸汽时代"}, {category: "character", brief: "沉默的制灯师"}]}
        : {artifacts: [{title: input.profileKey, fields: input.profileKey.includes("world") ? {"名称与概述": "仅素材草稿"} : {"角色名称": "仅素材草稿"}}]}}))};
}
const request = () => InspirationGenerateSchema.parse({projectRoot: "novel-a", requestId: randomUUID(), request: "设计世界观和一位制灯师"});

describe("Inspiration 原创设计", () => {
    it("按 Inspiration 分派创建专业子会话，草稿不触发正式保存", async () => {
        const agent = agents(); const store = storage();
        const draft = await new InspirationService(agent).generate(request(), store.port, new AbortController().signal);
        expect(draft.artifacts.map(item => item.category)).toEqual(["world", "character"]);
        expect(draft.artifacts[0]?.content).toContain("## 名称与概述");
        expect(draft.artifacts[0]?.content).not.toContain("fields");
        expect(agent.run).toHaveBeenNthCalledWith(2, expect.objectContaining({profileKey: "inspiration.world", parentSessionId: 1, projectRoot: "novel-a"}));
        expect(store.port.save).not.toHaveBeenCalled();
        expect(store.drafts.get(draft.id)).toEqual(draft);
    });
    it("反馈生成独立版本，不损坏已审阅草稿", async () => {
        const store = storage(); const service = new InspirationService(agents());
        const first = await service.generate(request(), store.port, new AbortController().signal);
        const next = await service.generate({...request(), draftId: first.id, revision: 1, feedback: "更克制"}, store.port, new AbortController().signal);
        expect(next.revision).toBe(2); expect(next.id).not.toBe(first.id); expect(store.drafts.get(first.id)).toEqual(first);
    });
    it("保存校验项目、版本及成果归属，保存实际编辑的文字", async () => {
        const store = storage(); const service = new InspirationService(agents());
        const draft = await service.generate(request(), store.port, new AbortController().signal);
        const edited = {id: draft.artifacts[0]!.id, title: "用户标题", content: "用户实际确认内容"};
        const save = {projectRoot: draft.projectRoot, draftId: draft.id, revision: draft.revision, artifacts: [edited]};
        await expect(service.save({...save, projectRoot: "novel-b"}, store.port)).rejects.toThrow("草稿项目或版本不匹配");
        await expect(service.save({...save, revision: 2}, store.port)).rejects.toThrow("草稿项目或版本不匹配");
        await expect(service.save({...save, artifacts: [{...edited, id: randomUUID()}]}, store.port)).rejects.toThrow("不属于此草稿");
        await service.save(save, store.port);
        expect(store.port.save).toHaveBeenCalledExactlyOnceWith(draft, save);
    });
    it("取消后拒绝迟到成果，不生成草稿也不继续其它专业任务", async () => {
        const controller = new AbortController(); const store = storage(); const agent = agents();
        const run = agent.run;
        agent.run = vi.fn(async input => { const result = await run(input); if (input.profileKey !== "inspiration") controller.abort(); return result; });
        await expect(new InspirationService(agent).generate(request(), store.port, controller.signal)).rejects.toThrow();
        expect(agent.run).toHaveBeenCalledTimes(2); expect(store.port.createDraft).not.toHaveBeenCalled();
    });
    it("拒绝非法模型输出，不以普通聊天回复冒充结构化产物", async () => {
        const store = storage(); const service = new InspirationService({run: async () => ({sessionId: 1, data: {assignments: [{category: "plot", brief: "剧情"}]}})});
        await expect(service.generate(request(), store.port, new AbortController().signal)).rejects.toThrow();
        expect(store.port.createDraft).not.toHaveBeenCalled();
    });
    it("拒绝模板之外的结构化字段", async () => {
        const store = storage();
        const service = new InspirationService({run: vi.fn(async input => {
            if (input.profileKey === "inspiration") return {sessionId: 1, data: {assignments: [{category: "world", brief: "世界"}]}};
            return {sessionId: 2, data: {artifacts: [{title: "世界", fields: {未知字段: "越界"}}]}};
        })});
        await expect(service.generate(request(), store.port, new AbortController().signal)).rejects.toThrow("未知字段");
        expect(store.port.createDraft).not.toHaveBeenCalled();
    });
    it("边界拒绝路径注入、重复保存 id 和无版本修改", () => {
        expect(InspirationGenerateSchema.safeParse({...request(), projectRoot: "../outside"}).success).toBe(false);
        expect(InspirationGenerateSchema.safeParse({...request(), draftId: randomUUID()}).success).toBe(false);
        const artifact = {id: randomUUID(), title: "人", content: "文"};
        expect(InspirationSaveSchema.safeParse({projectRoot: "novel-a", draftId: randomUUID(), revision: 1, artifacts: [artifact, artifact]}).success).toBe(false);
    });
    it("按选择的原文分块提取资料，并拒绝越界段落引用", async () => {
        const store = storage(); const service = new InspirationService({run: vi.fn(async () => ({sessionId: 8, data: {artifacts: [{category: "note", title: "结构", fields: {"事件链": "事件链"}, citations: [{firstParagraphId: "P1", lastParagraphId: "P2"}]}]}}))});
        const conversation = await service.createConversation("novel-a", store.port);
        const input = InspirationExtractSchema.parse({projectRoot: "novel-a", requestId: randomUUID(), conversationId: conversation.id, request: "提取细纲", path: "reference/book.txt", chunkIndexes: [1], categories: ["note"]});
        const source = {source: {path: "reference/book.txt", name: "book.txt", bytes: 10, mtimeMs: 1, sha256: "a".repeat(64)}, mode: "paragraphs" as const, targetCharacters: 50_000 as const, characterCount: 4, paragraphs: [{id: "P1", text: "开端\n", startOffset: 0, endOffset: 3, chapterIndex: null, chunkIndex: 1}, {id: "P2", text: "转折", startOffset: 3, endOffset: 5, chapterIndex: null, chunkIndex: 1}], chapters: [], chunks: [{index: 1, startOffset: 0, endOffset: 5, firstParagraphId: "P1", lastParagraphId: "P2", characterCount: 4, chapterIndexes: []}], warnings: []};
        const draft = await service.extract(input, source, store.port, new AbortController().signal);
        expect(draft.artifacts[0]?.source).toMatchObject({path: "reference/book.txt", citations: [{firstParagraphId: "P1", lastParagraphId: "P2"}]});
        expect(store.conversations.get(conversation.id)?.messages).toHaveLength(2);
    });
});
