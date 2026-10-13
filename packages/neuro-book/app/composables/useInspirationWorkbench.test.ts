import {effectScope, ref, type EffectScope} from "vue";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {randomUUID} from "node:crypto";
import {useInspirationWorkbench} from "./useInspirationWorkbench";
import type {InspirationDraftDto} from "nbook/shared/dto/inspiration.dto";

vi.mock("nbook/app/composables/useConfigApi", () => ({useConfigApi: () => ({bootstrap: async () => ({modelSettings: {enabledModels: []}})})}));
const source = {path: "lorebook/character/person/index.md", category: "character" as const, title: "角色", sha256: "a".repeat(64), content: "原人设"};
function draft(): InspirationDraftDto { return {id: randomUUID(), projectRoot: "novel", revision: 1, request: "改编人设", creationMode: "adaptation", materialSources: [source], sessionId: 1, createdAt: new Date().toISOString(), artifacts: [{id: randomUUID(), category: "character", title: "新角色", content: "新内容", sessionId: 2}]}; }
const scopes: EffectScope[] = [];
function setup() { const root = ref<string | null>("novel"); const scope = effectScope(); scopes.push(scope); return {root, workbench: scope.run(() => useInspirationWorkbench(root))!}; }
const fetcher = vi.fn();
beforeEach(() => { vi.useFakeTimers(); fetcher.mockReset(); vi.stubGlobal("$fetch", fetcher); fetcher.mockResolvedValue([]); });
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("改编设计输入与恢复", () => {
    it("未选来源不能开始，选择后按当前模式和路径生成，换参考后不携带旧草稿", async () => {
        const {workbench: w} = setup(); const result = draft();
        fetcher.mockImplementation(async (url: string) => {
            if (url === "/api/inspiration/generate") return result;
            if (url === "/api/inspiration/conversations" ) return [];
            return {id: "conversation", projectRoot: "novel", title: "改编", messages: []};
        });
        w.conversation.value = {id: randomUUID(), projectRoot: "novel", title: "改编", createdAt: result.createdAt, updatedAt: result.createdAt, archivedAt: null, messages: []};
        w.creationMode.value = "adaptation"; w.request.value = "改编人设";
        expect(w.canGenerate.value).toBe(false);
        w.toggleMaterial(source.path); expect(w.canGenerate.value).toBe(true);
        await w.generate();
        expect(fetcher.mock.calls.find(([url]) => url === "/api/inspiration/generate")?.[1].body).toMatchObject({creationMode: "adaptation", materialPaths: [source.path]});
        w.feedback.value = "更克制"; expect(w.canGenerate.value).toBe(true); expect(w.canReuseDraft.value).toBe(true);
        w.toggleMaterial("lorebook/item/item.md"); w.request.value = "新的改编要求";
        await w.generate();
        const body = fetcher.mock.calls.filter(([url]) => url === "/api/inspiration/generate").at(-1)![1].body;
        expect(body).not.toHaveProperty("draftId"); expect(body).not.toHaveProperty("feedback");
    });
    it("恢复历史改编草稿还原创作方式、参考名称和选择", async () => {
        const result = draft(); const {workbench: w} = setup();
        fetcher.mockImplementation(async (url: string) => url.includes("/drafts/") ? result : {id: "conversation", messages: [{draftId: result.id}]});
        await w.openConversation("conversation");
        expect(w.creationMode.value).toBe("adaptation"); expect(w.materialPaths.value).toEqual([source.path]);
        expect(w.materialName(source.path)).toBe("角色"); expect(w.canReuseDraft.value).toBe(true);
    });
    it("取消时即使请求迟到成功也不显示成果", async () => {
        const {workbench: w} = setup(); const result = draft(); let resolve!: (result: InspirationDraftDto) => void;
        fetcher.mockImplementation(async (url: string) => url === "/api/inspiration/generate" ? new Promise<InspirationDraftDto>(done => {resolve = done;}) : []);
        w.conversation.value = {id: randomUUID(), projectRoot: "novel", title: "设计", createdAt: result.createdAt, updatedAt: result.createdAt, archivedAt: null, messages: []};
        w.request.value = "新设计"; const run = w.generate(); await Promise.resolve();
        await w.cancel(); resolve(result); await run;
        expect(w.draft.value).toBeNull(); expect(w.artifacts.value).toEqual([]);
    });
    it("项目切换清空选择，旧目录响应不能污染新项目", async () => {
        const {root, workbench: w} = setup(); let resolve!: (result: unknown) => void;
        fetcher.mockImplementation(async (url: string) => url === "/api/inspiration/materials" ? new Promise(done => {resolve = done;}) : []);
        w.creationMode.value = "adaptation"; w.toggleMaterial(source.path);
        const run = w.loadMaterials(); root.value = "other";
        resolve({items: [source], total: 1, nextOffset: null}); await run;
        expect(w.materialPaths.value).toEqual([]); expect(w.materials.value).toEqual([]); expect(w.creationMode.value).toBe("original");
    });
});
