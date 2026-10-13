import {randomUUID} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {absoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {parseMarkdownDocument, readWorkspaceTextFile, writeWorkspaceTextFile} from "nbook/server/workspace-files/workspace-files";
import {createInspirationStorage} from "./storage";
import type {InspirationDraftDto, InspirationSaveDto} from "nbook/shared/dto/inspiration.dto";

vi.mock("nbook/server/workspace-files/project-open-guard", () => ({withProjectTargetMutation: async (_target: unknown, action: (handles: undefined) => Promise<unknown>) => action(undefined)}));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))); });
async function fixture() {
    const root = absoluteFsPath(await mkdtemp(join(tmpdir(), "inspiration-"))); roots.push(root);
    const storage = createInspirationStorage({kind: "user-assets", root});
    const draft: InspirationDraftDto = {id: randomUUID(), projectRoot: "novel", revision: 1, request: "角色", sessionId: 1, createdAt: new Date().toISOString(), artifacts: [{id: randomUUID(), category: "character", title: "灯师", content: "原草稿", sessionId: 2}]};
    await storage.createDraft(draft);
    const input: InspirationSaveDto = {projectRoot: "novel", draftId: draft.id, revision: 1, artifacts: [{id: draft.artifacts[0]!.id, title: "已编辑标题", content: "已编辑内容"}]};
    return {root, storage, draft, input};
}
describe("Inspiration 文件保存", () => {
    it("改编另存独立素材，保留来源且元数据只保存来源身份，重复保存幂等", async () => {
        const f = await fixture(); const sourcePath = "lorebook/character/original/index.md";
        await writeWorkspaceTextFile(f.root, sourcePath, "用户原人设");
        const draft = {...f.draft, creationMode: "adaptation" as const, materialSources: [{path: sourcePath, category: "character" as const, title: "原角色", sha256: "a".repeat(64), content: "参考快照私有正文"}]};
        const saved = await f.storage.save(draft, f.input);
        expect(saved.saved[0]!.path).not.toBe(sourcePath);
        expect(await readWorkspaceTextFile(f.root, sourcePath)).toBe("用户原人设");
        const text = await readWorkspaceTextFile(f.root, saved.saved[0]!.path);
        expect(text).not.toContain("参考快照私有正文");
        expect(parseMarkdownDocument(text).frontmatter).toMatchObject({ext: {inspiration: {creationMode: "adaptation", materialSources: [{path: sourcePath, sha256: "a".repeat(64)}]}}});
        expect(await f.storage.save(draft, f.input)).toEqual(saved);
    });
    it("首次列出会话时清除旧提取数据，混合会话保留原创消息和草稿，正式条目不受影响", async () => {
        const f = await fixture(); const now = new Date().toISOString();
        const legacyDraftId = randomUUID(); const legacyArtifactId = randomUUID();
        await writeWorkspaceTextFile(f.root, `.nbook/inspiration/${legacyDraftId}/draft.json`, JSON.stringify({id: legacyDraftId, projectRoot: "novel", revision: 1, request: "旧提取", sessionId: 3, createdAt: now, artifacts: [{id: legacyArtifactId, category: "note", title: "旧", content: "旧", sessionId: 4, source: {path: "reference/book.md", sha256: "a".repeat(64), chunkIndex: 1, citations: [{firstParagraphId: "P1", lastParagraphId: "P2"}]}}]}));
        const mixedId = randomUUID();
        await writeWorkspaceTextFile(f.root, `.nbook/inspiration/conversations/${mixedId}.json`, JSON.stringify({id: mixedId, projectRoot: "novel", title: "旧混合会话", createdAt: now, updatedAt: now, archivedAt: null, messages: [
            {id: randomUUID(), role: "user", kind: "design", content: "保留原创", createdAt: now},
            {id: randomUUID(), role: "assistant", kind: "extract", content: "删除旧提取", createdAt: now, draftId: legacyDraftId},
        ]}));
        const pureId = randomUUID();
        await writeWorkspaceTextFile(f.root, `.nbook/inspiration/conversations/${pureId}.json`, JSON.stringify({id: pureId, projectRoot: "novel", title: "旧纯提取", createdAt: now, updatedAt: now, archivedAt: null, messages: [{id: randomUUID(), role: "assistant", kind: "extract", content: "删除", createdAt: now, draftId: legacyDraftId}]}));
        await writeWorkspaceTextFile(f.root, "lorebook/note/kept/index.md", "正式条目");

        await f.storage.cleanupLegacyExtractionData?.();
        const conversations = await f.storage.listConversations();
        expect(conversations.map(item => item.id)).toContain(mixedId);
        expect(conversations.map(item => item.id)).not.toContain(pureId);
        expect((await f.storage.readConversation(mixedId)).messages).toHaveLength(1);
        await expect(f.storage.readDraft(legacyDraftId)).rejects.toThrow("不存在");
        expect(await readWorkspaceTextFile(f.root, "lorebook/note/kept/index.md")).toBe("正式条目");
        await f.storage.cleanupLegacyExtractionData?.();
    });

    it("聊天记录在当前项目的内部状态中持久化，并可归档而不物理删除", async () => {
        const f = await fixture(); const now = new Date().toISOString();
        const conversation = {id: randomUUID(), projectRoot: "novel", title: "提取设定", createdAt: now, updatedAt: now, archivedAt: null, messages: []};
        await f.storage.createConversation(conversation);
        expect((await f.storage.listConversations())[0]).toMatchObject({id: conversation.id, messageCount: 0});
        await f.storage.updateConversation({...conversation, archivedAt: now, updatedAt: now, messages: [{id: randomUUID(), role: "user", kind: "extract", content: "提取角色", createdAt: now}]});
        expect(await f.storage.readConversation(conversation.id)).toMatchObject({archivedAt: now, messages: [{content: "提取角色"}]});
    });
    it("保存审阅版本，重复和并发重试返回同一路径，服务重建后仍幂等", async () => {
        const f = await fixture();
        const [first, second] = await Promise.all([f.storage.save(f.draft, f.input), f.storage.save(f.draft, f.input)]);
        expect(second).toEqual(first);
        const text = await readWorkspaceTextFile(f.root, first.saved[0]!.path);
        expect(text).toContain("已编辑标题"); expect(text).toContain("已编辑内容"); expect(text).toContain("review: reviewed");
        const restarted = createInspirationStorage({kind: "user-assets", root: f.root});
        expect(await restarted.readDraft(f.draft.id)).toEqual(f.draft);
        expect(await restarted.save(f.draft, f.input)).toEqual(first);
        await expect(restarted.save(f.draft, {...f.input, artifacts: [{...f.input.artifacts[0]!, content: "另一个版本"}]})).rejects.toThrow("不同内容");
    });
    it("同路径冲突失败保留草稿与原文件，修复外部冲突后可恢复", async () => {
        const f = await fixture(); const id = f.draft.artifacts[0]!.id;
        const path = `lorebook/character/inspiration-${id}/index.md`;
        await writeWorkspaceTextFile(f.root, path, "用户原文件");
        await expect(f.storage.save(f.draft, f.input)).rejects.toThrow("未覆盖原文件");
        expect(await readWorkspaceTextFile(f.root, path)).toBe("用户原文件");
        expect(await f.storage.readDraft(f.draft.id)).toEqual(f.draft);
        const confirmation = JSON.parse(await readWorkspaceTextFile(f.root, `.nbook/inspiration/${f.draft.id}/confirmed/${id}.json`));
        // 模拟正式文件已写成功、回执尚未写入时进程退出。
        await writeWorkspaceTextFile(f.root, path, confirmation.content);
        expect((await f.storage.save(f.draft, f.input)).saved[0]!.path).toBe(path);
    });
});
