import {mkdir, readFile, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {MaterialReviewError, MaterialReviewService} from "./material-review-service";
import type {MaterialReview} from "./material-review";
import {createMaterialEnv, runMaterialPipeline, type MaterialEnv} from "./material.fixture";
import {parseMarkdownDocument} from "nbook/server/workspace-files/workspace-files";
import {createMaterialIntermediate} from "./material-intermediate";

// 写入走项目 mutation gate；测试用临时目录，不打开真实项目。
vi.mock("nbook/server/workspace-files/project-open-guard", () => ({
    withProjectTargetMutation: async (_target: unknown, action: (handles: undefined) => unknown) => action(undefined),
}));

const USER = {kind: "user"} as const;
const AGENT = {kind: "agent", sessionId: "session-1"} as const;

let env: MaterialEnv | null = null;
afterEach(async () => {
    await env?.cleanup();
    env = null;
});

async function prepare(input: unknown = {skip: true}) {
    env = await createMaterialEnv();
    const task = await runMaterialPipeline(env, input);
    const service = new MaterialReviewService({target: env.target, tasks: env.manager, model: env.model});
    return {env, task, service};
}

const itemOf = (review: MaterialReview, title: string) => review.items.find(item => item.title === title)!;
const lorebook = (...segments: string[]) => path.join(env!.root, "lorebook", ...segments);
const characterPath = async (service: MaterialReviewService, task: {id: string}, title: string, ...segments: string[]) => lorebook("character", itemOf(await service.get(task.id), title).directoryName, ...segments);
async function exists(file: string): Promise<boolean> {
    return readFile(file, "utf8").then(() => true, () => false);
}

describe("待写入清单", () => {
    it("整合完成后生成清单，全部条目默认勾选，确认前 lorebook 里没有任何内容", async () => {
        const {service, task} = await prepare();
        const review = await service.get(task.id);
        expect(review.items.map(item => item.title).sort()).toEqual(
            ["倒叙", "苏晴", "沈念", "林舟", "青云山", "身份反转", "雨夜伏笔", "第一人称视角", "世界观（novel）", "文风（novel）"].sort(),
        );
        const technique = itemOf(review, "倒叙");
        expect(technique.category).toBe("writing-technique");
        expect(technique.nodes[0]!.entries[0]!.block).toBe(1);
        expect(technique.nodes[0]!.entries[0]!.fields["手法说明"]).toBe("先写结局");
        expect(review.items.every(item => item.selected && item.write.status === "pending")).toBe(true);
        expect(await exists((await characterPath(service, task, "林舟", "index.md")))).toBe(false);
        // 清单持久化：新的服务实例读到同一份。
        const again = await new MaterialReviewService({target: env!.target, tasks: env!.manager, model: env!.model}).get(task.id);
        expect(again).toEqual(review);
    });

    it("取消勾选的条目不写入，其余条目写入 lorebook 并带提取来源标记", async () => {
        const {service, task} = await prepare();
        const review = await service.get(task.id);
        await service.setSelected(task.id, [itemOf(review, "青云山").id], false);
        const report = await service.confirmWrite(task.id, {confirmer: USER});
        expect(report.outcomes.every(outcome => outcome.status === "written")).toBe(true);
        expect(report.outcomes).toHaveLength(review.items.length - 1);

        expect(await exists(lorebook("location", "青云山", "index.md"))).toBe(false);
        const main = await readFile((await characterPath(service, task, "林舟", "index.md")), "utf8");
        expect(main).toContain("origin: extract");
        expect(main).toContain("title: 林舟");
        expect(main).toContain(`id: ${itemOf(await service.get(task.id), "林舟").stableId}`);
        expect(main).toContain("sha256");
        // 经历与人际关系是独立节点。
        const experience = await readFile((await characterPath(service, task, "林舟", "original", "experience.md")), "utf8");
        expect(experience).toContain("离开山村");
        expect(experience).toContain("> P");
        expect(parseMarkdownDocument(experience).frontmatter.records).toEqual(expect.arrayContaining([
            expect.objectContaining({title: "出山", content: "离开山村", source: expect.stringMatching(/^P\d+/u)}),
        ]));
        expect(await exists((await characterPath(service, task, "林舟", "original", "relationships.md")))).toBe(true);
        const state = parseMarkdownDocument(await readFile(await characterPath(service, task, "林舟", "original", "state.md"), "utf8"));
        expect(state.frontmatter.state).toEqual({chapter: "", location: "", items: "", psychology: ""});
        // 角色主文件只有基本设定。
        expect(main).not.toContain("离开山村");
    });

    it("素材特点每条一个独立文件", async () => {
        const {service, task} = await prepare();
        await service.confirmWrite(task.id, {confirmer: USER});
        for (const title of ["雨夜伏笔", "第一人称视角", "身份反转"]) {
            expect(await readFile(lorebook("note", "写作素材", title, "index.md"), "utf8")).toContain("origin: extract");
        }
    });

    it("写入后再次确认不会重复写入，已写入的条目被锁定", async () => {
        const {service, task} = await prepare();
        await service.confirmWrite(task.id, {confirmer: USER});
        const second = await service.confirmWrite(task.id, {confirmer: USER});
        expect(second.outcomes).toEqual([]);
        const review = await service.get(task.id);
        await expect(service.update(task.id, itemOf(review, "林舟").id, {title: "别名"})).rejects.toBeInstanceOf(MaterialReviewError);
        await expect(service.remove(task.id, itemOf(review, "林舟").id)).rejects.toMatchObject({code: "LOCKED"});
    });
});

describe("写作素材与手法索引", () => {
    it("旧任务已有整合审阅条目时，不重复加入对应的分块草稿", async () => {
        const {service, task} = await prepare();
        const review = await service.get(task.id);
        const technique = itemOf(review, "倒叙");
        const legacyReview = {...review, consumedUnitIds: [...review.consumedUnitIds.filter(id => !id.endsWith(":writing-technique")), "integrate:writing-technique"], items: review.items.map(item => item.id === technique.id ? {...item, unitId: "integrate:writing-technique"} : item)};
        await createMaterialIntermediate(env!.target, task.id).commit({write: [{path: "review.json", data: legacyReview}]});
        const synced = await service.get(task.id);
        expect(synced.items.filter(item => item.category === "writing-technique")).toHaveLength(1);
    });

    it("索引模型失败时保留草稿，确认写入失败且不写入正文", async () => {
        env = await createMaterialEnv({hook: info => info.kind === "index" ? JSON.stringify({entries: []}) : undefined});
        const task = await runMaterialPipeline(env, {skip: true}, {categories: ["writing-technique"]});
        expect(task.status).toBe("partial-failed");
        const service = new MaterialReviewService({target: env.target, tasks: env.manager, model: env.model});
        expect((await service.get(task.id)).items.filter(item => item.category === "writing-technique")).toHaveLength(1);
        await expect(service.confirmWrite(task.id, {confirmer: USER})).rejects.toThrow();
        expect(await exists(lorebook("note", "写作手法", "倒叙", "index.md"))).toBe(false);
    });

    it("按分类写入两份索引，仅收录已成功写入的条目，包含摘要、检索词及真实路径", async () => {
        const {service, task} = await prepare();
        const review = await service.get(task.id);
        await service.setSelected(task.id, [itemOf(review, "身份反转").id], false);
        await service.remove(task.id, itemOf(review, "第一人称视角").id);
        const report = await service.confirmWrite(task.id, {confirmer: USER});
        expect(report.indexPaths).toEqual(["lorebook/note/写作手法索引.md", "lorebook/note/写作素材索引.md"]);
        for (const [file, title, dir] of [["写作手法索引.md", "倒叙", "写作手法"], ["写作素材索引.md", "雨夜伏笔", "写作素材"]]) {
            const document = parseMarkdownDocument(await readFile(lorebook("note", file!), "utf8"));
            expect(document.body).toContain(`${title}的使用要点`);
            expect(document.body).toContain("检索词");
            expect(document.body).toContain(`lorebook/note/${dir}/${title}/index.md`);
            expect(await exists(lorebook("note", dir!, title!, "index.md"))).toBe(true);
            expect(document.body).not.toContain("身份反转");
            expect(document.body).not.toContain("第一人称视角");
        }
        const before = env!.model.requests.length;
        expect((await service.confirmWrite(task.id, {confirmer: USER})).indexPaths).toEqual([]);
        expect(env!.model.requests).toHaveLength(before);
    });

    it("另存为后的索引指向新目录，后续任务追加索引不会丢失已有条目", async () => {
        const {service, task} = await prepare();
        await service.confirmWrite(task.id, {confirmer: USER});
        const second = await runMaterialPipeline(env!, {skip: true}, {categories: ["writing-technique"]});
        const review = await service.get(second.id);
        const technique = itemOf(review, "倒叙");
        await service.update(second.id, technique.id, {nodes: [{...technique.nodes[0]!, entries: [{fields: {...technique.nodes[0]!.entries[0]!.fields, 手法说明: "先展示新的结局"}, block: 1}]}]});
        const conflicts = await service.confirmWrite(second.id, {confirmer: USER});
        expect(conflicts.conflicts).toHaveLength(1);
        const saved = await service.confirmWrite(second.id, {confirmer: USER, decisions: [{itemId: technique.id, action: "save-as"}]});
        expect(saved.outcomes[0]).toMatchObject({status: "written", title: "倒叙（提取）"});
        const index = parseMarkdownDocument(await readFile(lorebook("note", "写作手法索引.md"), "utf8"));
        expect(index.body).toContain("lorebook/note/写作手法/倒叙/index.md");
        expect(index.body).toContain("lorebook/note/写作手法/倒叙（提取）/index.md");
        expect((await service.confirmWrite(second.id, {confirmer: USER})).indexPaths).toEqual([]);
    });

    it("索引写入失败不丢失成功条目的台账，不覆盖用户同名文件，重试可补写索引", async () => {
        const {service, task} = await prepare();
        await mkdir(lorebook("note"), {recursive: true});
        await writeFile(lorebook("note", "写作手法索引.md"), "用户的索引", "utf8");
        const first = await service.confirmWrite(task.id, {confirmer: USER});
        expect(first.outcomes.find(outcome => outcome.itemId === "index:writing-technique")).toMatchObject({status: "failed"});
        expect(itemOf(await service.get(task.id), "倒叙").write.status).toBe("written");
        expect(await readFile(lorebook("note", "写作手法索引.md"), "utf8")).toBe("用户的索引");
        await rm(lorebook("note", "写作手法索引.md"));
        const again = await service.confirmWrite(task.id, {confirmer: USER});
        expect(again.outcomes).toEqual([]);
        expect(again.indexPaths).toEqual(["lorebook/note/写作手法索引.md"]);
    });

    it("正文写入失败的素材不进入索引，补写成功后才加入", async () => {
        const {service, task} = await prepare();
        await mkdir(lorebook("note", "写作素材"), {recursive: true});
        await writeFile(lorebook("note", "写作素材", "雨夜伏笔"), "占位文件", "utf8");
        const first = await service.confirmWrite(task.id, {confirmer: USER});
        expect(first.outcomes.find(outcome => outcome.title === "雨夜伏笔")?.status).toBe("failed");
        expect(parseMarkdownDocument(await readFile(lorebook("note", "写作素材索引.md"), "utf8")).body).not.toContain("雨夜伏笔");
        await rm(lorebook("note", "写作素材", "雨夜伏笔"));
        const again = await service.confirmWrite(task.id, {confirmer: USER});
        expect(again.outcomes).toEqual([expect.objectContaining({title: "雨夜伏笔", status: "written"})]);
        expect(parseMarkdownDocument(await readFile(lorebook("note", "写作素材索引.md"), "utf8")).body).toContain("雨夜伏笔");
    });

    it("后来任务覆盖同一路径后，重确认旧任务不会恢复旧索引注释", async () => {
        const {service, task} = await prepare();
        await service.confirmWrite(task.id, {confirmer: USER});
        const second = await runMaterialPipeline(env!, {skip: true}, {categories: ["writing-technique"]});
        const review = await service.get(second.id);
        const technique = itemOf(review, "倒叙");
        await service.update(second.id, technique.id, {nodes: [{...technique.nodes[0]!, entries: [{fields: {...technique.nodes[0]!.entries[0]!.fields, 手法说明: "新正文"}, block: 1}]}]});
        await service.confirmWrite(second.id, {confirmer: USER, decisions: [{itemId: technique.id, action: "overwrite"}]});
        const before = await readFile(lorebook("note", "写作手法索引.md"), "utf8");
        expect(before).toContain(second.id);
        const again = await service.confirmWrite(task.id, {confirmer: USER});
        expect(again.indexPaths).toEqual([]);
        expect(await readFile(lorebook("note", "写作手法索引.md"), "utf8")).toBe(before);
    });
});

describe("清单编辑、拆分与合并", () => {
    it("编辑、删除", async () => {
        const {service, task} = await prepare();
        const review = await service.get(task.id);
        const edited = await service.update(task.id, itemOf(review, "青云山").id, {aliases: ["云山"]});
        expect(itemOf(edited, "青云山").aliases).toEqual(["云山"]);
        const removed = await service.remove(task.id, itemOf(review, "沈念").id);
        expect(removed.items.some(item => item.title === "沈念")).toBe(false);
        // 删除后再次同步不会让该条目重新出现。
        expect((await service.get(task.id)).items.some(item => item.title === "沈念")).toBe(false);
    });

    it("拆分：把一条经历移到新条目", async () => {
        const {service, task} = await prepare();
        const review = await service.get(task.id);
        const original = itemOf(review, "林舟");
        const experiences = original.nodes.find(node => node.role === "experience")!;
        expect(experiences.entries).toHaveLength(3);
        const split = await service.split(task.id, original.id, {title: "少年林舟", move: [{role: "experience", entryIndexes: [1]}]});
        const kept = itemOf(split, "林舟").nodes.find(node => node.role === "experience")!;
        const created = itemOf(split, "少年林舟");
        expect(kept.entries.map(entry => entry.fields["阶段名称"])).toEqual(["出山", "出山"]);
        expect(created.nodes.find(node => node.role === "experience")!.entries[0]!.fields["阶段名称"]).toBe("入城");
        expect(created.selected).toBe(true);
    });

    it("手动合并：基本设定一次模型调用，经历按块顺序拼接", async () => {
        const {service, task} = await prepare();
        const review = await service.get(task.id);
        const before = env!.model.requests.length;
        const merged = await service.merge(task.id, [itemOf(review, "苏晴").id, itemOf(review, "沈念").id], new AbortController().signal);
        expect(env!.model.requests.length - before).toBe(1);
        const request = env!.model.requests.at(-1)!;
        expect(request).not.toHaveProperty("reasoning");
        expect(request.metadata?.prefixHash).toMatch(/^[a-f0-9]{64}$/u);
        const item = itemOf(merged, "苏晴");
        expect(item.aliases).toEqual(expect.arrayContaining(["沈念", "晴儿"]));
        expect(merged.items.some(candidate => candidate.title === "沈念")).toBe(false);
        expect(item.nodes.find(node => node.role === "main")!.entries[0]!.fields["性格"]).toBe("合并后的性格");
    });

    it("手动合并只允许同一类别", async () => {
        const {service, task} = await prepare();
        const review = await service.get(task.id);
        await expect(service.merge(task.id, [itemOf(review, "苏晴").id, itemOf(review, "青云山").id], new AbortController().signal)).rejects.toMatchObject({code: "INVALID"});
    });
});

describe("同名冲突与确认者", () => {
    async function withDesignEntry() {
        const ctx = await prepare();
        await mkdir(await characterPath(ctx.service, ctx.task, "林舟"), {recursive: true});
        const original = "---\ntitle: 林舟\ntype: character\n---\n\n用户亲手设计的林舟。\n";
        await writeFile((await characterPath(ctx.service, ctx.task, "林舟", "index.md")), original, "utf8");
        return {...ctx, original};
    }

    it("与用户设计的条目同名时进入对照确认，没有决定就不写", async () => {
        const {service, task, original} = await withDesignEntry();
        const report = await service.confirmWrite(task.id, {confirmer: USER});
        const outcome = report.outcomes.find(candidate => candidate.title === "林舟")!;
        expect(outcome.status).toBe("conflict");
        expect(report.conflicts).toEqual([expect.objectContaining({title: "林舟", role: "main", overwriteAllowed: true})]);
        expect(report.conflicts[0]!.existing).toMatchObject({origin: "design", content: original});
        expect(report.conflicts[0]!.incoming).toContain("origin: extract");
        expect(await readFile(await characterPath(service, task, "林舟", "index.md"), "utf8")).toBe(original);
        // 没有冲突的条目照常写入。
        expect(await exists(await characterPath(service, task, "苏晴", "index.md"))).toBe(true);
    });

    it("Agent 确认不能覆盖用户设计的条目，只能另存为或跳过", async () => {
        const {service, task, original} = await withDesignEntry();
        const review = await service.get(task.id);
        const id = itemOf(review, "林舟").id;
        const comparisons = await service.conflicts(task.id, AGENT);
        expect(comparisons).toEqual([expect.objectContaining({itemId: id, overwriteAllowed: false})]);

        const denied = await service.confirmWrite(task.id, {confirmer: AGENT, decisions: [{itemId: id, action: "overwrite"}]});
        const outcome = denied.outcomes.find(candidate => candidate.itemId === id)!;
        expect(outcome.status).toBe("failed");
        expect(outcome.error).toContain("Agent 不能覆盖");
        expect(await readFile(await characterPath(service, task, "林舟", "index.md"), "utf8")).toBe(original);
    });

    it("另存为后原条目保持不变", async () => {
        const {service, task, original} = await withDesignEntry();
        const review = await service.get(task.id);
        const id = itemOf(review, "林舟").id;
        const originalDirectory = itemOf(review, "林舟").directoryName;
        const saved = await service.confirmWrite(task.id, {confirmer: AGENT, decisions: [{itemId: id, action: "save-as"}]});
        expect(saved.outcomes.find(candidate => candidate.itemId === id)).toMatchObject({status: "written", title: "林舟（提取）"});
        expect(await readFile(lorebook("character", originalDirectory, "index.md"), "utf8")).toBe(original);
        expect(await exists(lorebook("character", originalDirectory, "original", "experience.md"))).toBe(false);
        const savedMainPath = saved.outcomes.find(candidate => candidate.itemId === id)!.paths.find(candidate => candidate.endsWith("/index.md"))!;
        const savedDirectory = path.dirname(path.join(env!.root, savedMainPath));
        expect(path.basename(savedDirectory)).not.toBe(originalDirectory);
        const copy = await readFile(path.join(env!.root, savedMainPath), "utf8");
        expect(copy).toContain("origin: extract");
        expect(copy).toContain(`id: ${path.basename(savedDirectory)}`);
        expect(await exists(path.join(savedDirectory, "original", "experience.md"))).toBe(true);
        expect((await service.get(task.id)).items.find(item => item.write.savedAs === "林舟（提取）")?.write.savedAs).toBe("林舟（提取）");
    });

    it("用户可以覆盖，也可以跳过", async () => {
        const {service, task} = await withDesignEntry();
        const id = itemOf(await service.get(task.id), "林舟").id;
        const skipped = await service.confirmWrite(task.id, {confirmer: USER, decisions: [{itemId: id, action: "skip"}]});
        expect(skipped.outcomes.find(candidate => candidate.itemId === id)!.status).toBe("skipped");
        expect(await readFile((await characterPath(service, task, "林舟", "index.md")), "utf8")).toContain("用户亲手设计");

        const overwritten = await service.confirmWrite(task.id, {confirmer: USER, decisions: [{itemId: id, action: "overwrite"}]});
        expect(overwritten.outcomes.find(candidate => candidate.itemId === id)!.status).toBe("written");
        expect(await readFile((await characterPath(service, task, "林舟", "index.md")), "utf8")).toContain("origin: extract");
    });

    it("Agent 可以覆盖来源为 extract 的旧条目", async () => {
        const {service, task} = await prepare();
        await mkdir(await characterPath(service, task, "林舟"), {recursive: true});
        await writeFile((await characterPath(service, task, "林舟", "index.md")), "---\ntitle: 林舟\ntype: character\norigin: extract\n---\n\n旧的提取结果。\n", "utf8");
        const id = itemOf(await service.get(task.id), "林舟").id;
        const report = await service.confirmWrite(task.id, {confirmer: AGENT, decisions: [{itemId: id, action: "overwrite"}]});
        expect(report.outcomes.find(candidate => candidate.itemId === id)!.status).toBe("written");
        expect(await readFile((await characterPath(service, task, "林舟", "index.md")), "utf8")).not.toContain("旧的提取结果");
    });
});

describe("部分失败", () => {
    it("逐条报告失败项，成功项不回滚也不重复写；修复后重试只补写失败节点", async () => {
        const {service, task} = await prepare();
        // 让林舟的关系节点先与已有文件冲突，验证其余节点可先写入，解决冲突后能继续补写。
        await mkdir(await characterPath(service, task, "林舟", "original"), {recursive: true});
        await writeFile((await characterPath(service, task, "林舟", "original", "relationships.md")), "占位文件", "utf8");

        const first = await service.confirmWrite(task.id, {confirmer: USER});
        const conflicts = first.outcomes.filter(outcome => outcome.status === "conflict");
        expect(conflicts.map(outcome => outcome.title)).toEqual(["林舟"]);
        expect(first.conflicts[0]!.path).toMatch(/original\/relationships\.md$/u);
        expect(first.outcomes.filter(outcome => outcome.status === "written").length).toBe(first.review.items.length - 1);
        // 冲突条目整体等待决定，不会先写入其中部分节点。
        expect(await exists((await characterPath(service, task, "林舟", "index.md")))).toBe(false);
        expect(await exists((await characterPath(service, task, "林舟", "original", "experience.md")))).toBe(false);
        expect(itemOf(await service.get(task.id), "林舟").write.writtenRoles).toEqual([]);

        await rm((await characterPath(service, task, "林舟", "original", "relationships.md")));
        const retry = await service.confirmWrite(task.id, {confirmer: USER});
        expect(retry.outcomes).toHaveLength(1);
        expect(retry.outcomes[0]).toMatchObject({title: "林舟", status: "written"});
        expect(retry.outcomes[0]!.paths).toEqual(expect.arrayContaining([expect.stringMatching(/original\/relationships\.md$/u)]));
        expect(await exists((await characterPath(service, task, "林舟", "index.md")))).toBe(true);
    });

    it("来源文件被改动后拒绝写入，且不写任何内容", async () => {
        const {service, task} = await prepare();
        await writeFile(path.join(env!.root, "reference", "novel.md"), "完全不同的内容\n", "utf8");
        await expect(service.confirmWrite(task.id, {confirmer: USER})).rejects.toMatchObject({code: "SOURCE_CHANGED"});
        expect(await exists((await characterPath(service, task, "林舟", "index.md")))).toBe(false);
    });
});
