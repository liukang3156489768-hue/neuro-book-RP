import {randomUUID} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {absoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {readWorkspaceTextFile, writeWorkspaceTextFile} from "nbook/server/workspace-files/workspace-files";
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
