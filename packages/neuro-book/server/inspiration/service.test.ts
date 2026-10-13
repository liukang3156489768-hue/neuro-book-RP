import {randomUUID} from "node:crypto";
import {describe, expect, it, vi} from "vitest";
import {InspirationService, type InspirationAgentPort, type InspirationStoragePort} from "./service";
import {InspirationGenerateSchema, InspirationSaveSchema, type InspirationConversationDto, type InspirationDraftDto, type InspirationSaveDto} from "nbook/shared/dto/inspiration.dto";

function storage() {
    const drafts = new Map<string, InspirationDraftDto>();
    const conversations = new Map<string, InspirationConversationDto>();
    const port: InspirationStoragePort = {
        readDraft: vi.fn(async id => {
            const draft = drafts.get(id);
            if (!draft) throw new Error("missing draft");
            return draft;
        }),
        createDraft: vi.fn(async draft => { drafts.set(draft.id, draft); }),
        save: vi.fn(async (draft: InspirationDraftDto, input: InspirationSaveDto) => ({draftId: draft.id, revision: draft.revision, saved: input.artifacts.map(item => ({id: item.id, path: item.id}))})),
        createConversation: vi.fn(async conversation => { conversations.set(conversation.id, conversation); return conversation; }),
        readConversation: vi.fn(async id => {
            const conversation = conversations.get(id);
            if (!conversation) throw new Error("missing conversation");
            return conversation;
        }),
        listConversations: vi.fn(async () => [...conversations.values()].map((item: InspirationConversationDto) => ({id: item.id, title: item.title, createdAt: item.createdAt, updatedAt: item.updatedAt, archivedAt: item.archivedAt, messageCount: item.messages.length}))),
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

const material = {path: "lorebook/character/lamp/index.md", category: "character" as const, title: "旧灯师", sha256: "a".repeat(64), content: "沉默寡言，曾失去老师。"};
const adaptationRequest = () => ({...request(), creationMode: "adaptation" as const, materialPaths: [material.path]});
describe("Inspiration 改编设计", () => {
    it("所选来源形成快照，协调者和各专业设计师收到相同参考，正式文件不自动写入", async () => {
        const store = storage(); const agent = agents(); const readSelected = vi.fn(async () => [material]);
        const draft = await new InspirationService(agent).generate(adaptationRequest(), store.port, new AbortController().signal, {readSelected});
        expect(readSelected).toHaveBeenCalledExactlyOnceWith([material.path], expect.any(AbortSignal));
        for (const [call] of vi.mocked(agent.run).mock.calls) expect(JSON.parse(call.message)).toMatchObject({creationMode: "adaptation", materialSources: [material]});
        expect(draft).toMatchObject({creationMode: "adaptation", materialSources: [material]});
        expect(store.drafts.get(draft.id)).toEqual(draft); expect(store.port.save).not.toHaveBeenCalled();
    });
    it("反馈、追问和单条重做复用快照及原始需求，重做使用新成果身份", async () => {
        const store = storage(); const agent = agents(); const service = new InspirationService(agent);
        const conversation = await service.createConversation("novel-a", store.port);
        const readSelected = vi.fn(async () => [material]);
        const first = await service.generate({...adaptationRequest(), conversationId: conversation.id}, store.port, new AbortController().signal, {readSelected});
        const next = await service.generate({...request(), draftId: first.id, revision: first.revision, feedback: "保留动机、改变性格"}, store.port, new AbortController().signal, {readSelected});
        expect(readSelected).toHaveBeenCalledTimes(1); expect(next.materialSources).toEqual([material]);
        const refine = {projectRoot: "novel-a", requestId: randomUUID(), conversationId: conversation.id, draftId: next.id, revision: next.revision, artifactId: next.artifacts[1]!.id, instruction: "重新设计", thinkingEnabled: false};
        const answer = await service.refine({...refine, action: "ask"}, store.port, new AbortController().signal);
        expect(answer.draft.id).toBe(next.id); expect(store.port.createDraft).toHaveBeenCalledTimes(2);
        const result = await service.refine({...refine, action: "refine"}, store.port, new AbortController().signal);
        expect(JSON.parse(vi.mocked(agent.run).mock.calls.at(-1)![0].message)).toMatchObject({request: next.request, materialSources: [material], creationMode: "adaptation"});
        expect(result.draft.materialSources).toEqual(next.materialSources);
        expect(result.draft.artifacts.every(item => !next.artifacts.some(previous => previous.id === item.id))).toBe(true);
        expect(result.draft.artifacts[1]!.sessionId).not.toBe(next.artifacts[1]!.sessionId);
        expect(store.drafts.get(next.id)).toEqual(next);
    });
    it("缺少、重复或无效参考在模型调用前拒绝", async () => {
        const store = storage(); const agent = agents(); const service = new InspirationService(agent);
        await expect(service.generate({...adaptationRequest(), materialPaths: []}, store.port, new AbortController().signal)).rejects.toThrow("参考素材");
        await expect(service.generate({...adaptationRequest(), materialPaths: [material.path, material.path.toUpperCase()]}, store.port, new AbortController().signal)).rejects.toThrow("重复");
        await expect(service.generate(adaptationRequest(), store.port, new AbortController().signal, {readSelected: async () => []})).rejects.toThrow("不一致");
        await expect(service.generate(adaptationRequest(), store.port, new AbortController().signal, {readSelected: async () => { throw new Error("来源不存在"); }})).rejects.toThrow("来源不存在");
        expect(agent.run).not.toHaveBeenCalled(); expect(store.port.createDraft).not.toHaveBeenCalled();
    });
    it("已有草稿不能无声改变模式或参考集合", async () => {
        const store = storage(); const agent = agents(); const service = new InspirationService(agent);
        const first = await service.generate(adaptationRequest(), store.port, new AbortController().signal, {readSelected: async () => [material]});
        vi.mocked(agent.run).mockClear();
        const followup = {...adaptationRequest(), draftId: first.id, revision: first.revision};
        await expect(service.generate({...followup, creationMode: "original"}, store.port, new AbortController().signal)).rejects.toThrow("新设计任务");
        await expect(service.generate({...followup, materialPaths: ["lorebook/item/other.md"]}, store.port, new AbortController().signal)).rejects.toThrow("新设计任务");
        expect(agent.run).not.toHaveBeenCalled();
    });
    it("单条重做取消后拒绝迟到成果", async () => {
        const store = storage(); const agent = agents(); const service = new InspirationService(agent);
        const conversation = await service.createConversation("novel-a", store.port);
        const first = await service.generate(request(), store.port, new AbortController().signal);
        const run = agent.run; const controller = new AbortController();
        agent.run = vi.fn(async input => { const result = await run(input); controller.abort(); return result; });
        await expect(service.refine({projectRoot: "novel-a", requestId: randomUUID(), conversationId: conversation.id, draftId: first.id, revision: 1, artifactId: first.artifacts[1]!.id, instruction: "重做", thinkingEnabled: false, action: "refine"}, store.port, controller.signal)).rejects.toThrow();
        expect(store.port.createDraft).toHaveBeenCalledTimes(1);
    });
});

describe("Inspiration 原创设计", () => {
    it("新聊天创建时固定版本，生成及草稿追问沿用同一聊天或草稿的版本", async () => {
        const agent = agents();
        const promptSnapshot = vi.fn(async () => "a".repeat(64));
        agent.promptSnapshot = promptSnapshot;
        const store = storage(); const service = new InspirationService(agent);
        const conversation = await service.createConversation("novel-a", store.port);
        expect(promptSnapshot).toHaveBeenLastCalledWith({projectRoot: "novel-a", conversationId: conversation.id, newConversation: true});
        const draft = await service.generate({...request(), conversationId: conversation.id}, store.port, new AbortController().signal);
        expect(promptSnapshot).toHaveBeenLastCalledWith({projectRoot: "novel-a", conversationId: conversation.id, inheritSessionId: undefined});
        expect(agent.run).toHaveBeenNthCalledWith(1, expect.objectContaining({promptSnapshotId: "a".repeat(64)}));
        await service.refine({projectRoot: "novel-a", requestId: randomUUID(), conversationId: conversation.id, draftId: draft.id, revision: 1,
            artifactId: draft.artifacts[1]!.id, action: "ask", instruction: "说明性格", thinkingEnabled: false}, store.port, new AbortController().signal);
        expect(promptSnapshot).toHaveBeenLastCalledWith({projectRoot: "novel-a", conversationId: conversation.id, inheritSessionId: draft.sessionId});
        expect(agent.run).toHaveBeenLastCalledWith(expect.objectContaining({promptSnapshotId: "a".repeat(64)}));
    });
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
});
