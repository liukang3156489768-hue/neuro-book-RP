import {readdir, readFile} from "node:fs/promises";
import path from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {listClassification, listClassificationWithDetails} from "./material-consolidate";
import {EntityFragmentSchema, materialCategorySpec, readEntityIndex, type CharacterCandidate} from "./material-data";
import {createMaterialIntermediate} from "./material-intermediate";
import {extractUnitId, createMaterialPipeline} from "./material-pipeline";
import {characterExtractionTier, planCharacterExtractionUnits, validateGroupedCharacterOutput} from "./material-extract";
import {createUnit} from "./task-model";
import {ExtractionFatalError} from "./errors";
import {
    createMaterialEnv, runMaterialPipeline, startMaterialTask, type CallInfo, type MaterialEnv,
} from "./material.fixture";

// 单元测试不打开真实项目；写中间产物只需要“直接执行回调”的门。
vi.mock("nbook/server/workspace-files/project-open-guard", () => ({
    withProjectTargetMutation: async (_target: unknown, action: (handles: undefined) => unknown) => action(undefined),
}));

const CATEGORY_COUNT = 9;
const ENTITY_CATEGORIES = ["character", "faction", "item", "location", "system"];

let env: MaterialEnv | null = null;
async function setup(options: Parameters<typeof createMaterialEnv>[0] = {}): Promise<MaterialEnv> {
    env = await createMaterialEnv(options);
    return env;
}
afterEach(async () => {
    await env?.cleanup();
    env = null;
});

function extractionCalls(model: {requests: ReadonlyArray<{prompt: string}>}): string[] {
    return model.requests.map(request => request.prompt).filter(prompt => /【任务】(提取本块|分析本块)/u.test(prompt));
}

describe("素材提取流水线：分块 × 类别提取", () => {
    it("等级边界使用当前任务选定块数，高频覆盖率与八块条件分别生效", () => {
        const candidate = (count: number): CharacterCandidate => ({folderKey: "甲", name: "甲", aliases: [], blocks: Array.from({length: count}, (_, i) => i + 1)});
        expect(characterExtractionTier(candidate(8), 30)).toBe("primary");
        expect(characterExtractionTier(candidate(4), 10)).toBe("primary");
        expect(characterExtractionTier(candidate(7), 30)).toBe("secondary");
        expect(characterExtractionTier(candidate(3), 10)).toBe("secondary");
        expect(characterExtractionTier(candidate(2), 10)).toBe("tertiary");
        expect(characterExtractionTier(candidate(1), 1)).toBe("primary");
    });
    it("按覆盖率分级并只在同一分块内组队", () => {
        const candidate = (folderKey: string, blocks: number[]): CharacterCandidate => ({folderKey, name: folderKey, aliases: [], blocks, stableId: `${folderKey}-id`});
        const units = planCharacterExtractionUnits([
            candidate("高频", [1, 2, 3, 4]),
            candidate("中频甲", [1, 2, 3]), candidate("中频乙", [1, 2, 3]),
            candidate("低频甲", [1]), candidate("低频乙", [1]), candidate("低频丙", [1]), candidate("低频丁", [1]),
        ], 10);
        expect(units.find(unit => unit.id.includes("高频"))?.data?.tier).toBe("primary");
        expect(units.find(unit => Array.isArray(unit.data?.characterNames) && unit.data.characterNames.includes("中频甲"))?.data?.tier).toBe("secondary");
        const lowFrequency = units.filter(unit => unit.data?.block === 1 && unit.data?.tier === "tertiary");
        expect(lowFrequency.map(unit => (unit.data?.folderKeys as string[]).length)).toEqual([3, 1]);
        expect(units.filter(unit => unit.data?.block === 1).every(unit => !String(unit.id).includes(":2"))).toBe(true);
    });

    it("分组键使用稳定的代码点顺序，避免区域设置改变恢复时的单元 ID", () => {
        const candidate = (folderKey: string): CharacterCandidate => ({folderKey, name: folderKey, aliases: [], blocks: [1], stableId: `${folderKey}-id`});
        const units = planCharacterExtractionUnits([
            candidate("乙"), candidate("甲"), candidate("丙"),
        ], 10);
        expect(units[0]!.data?.characterNames).toEqual(["丙", "乙", "甲"]);
        expect(units[0]!.id).toContain("丙+乙+甲");
    });

    it("重新发现角色改变组员或等级时，只补排此前没有单元拥有的角色块", () => {
        const candidate = (name: string, blocks: number[]): CharacterCandidate => ({folderKey: name, name, aliases: [], blocks});
        const previous = planCharacterExtractionUnits([candidate("甲", [1]), candidate("乙", [1])], 10).map(createUnit);
        const additions = planCharacterExtractionUnits([candidate("甲", [1, 2, 3, 4]), candidate("乙", [1]), candidate("丙", [1])], 10, previous);
        expect(additions.filter(unit => unit.data?.block === 1).flatMap(unit => unit.data?.folderKeys)).toEqual(["丙"]);
        expect(additions.filter(unit => unit.data?.block !== 1).flatMap(unit => unit.data?.folderKeys)).toEqual(["甲", "甲", "甲"]);
    });

    it("分组角色输出按请求集合逐个校验，允许无资料角色但拒绝漏项", () => {
        const candidates: CharacterCandidate[] = [
            {folderKey: "甲", name: "甲", aliases: [], blocks: [1]},
            {folderKey: "乙", name: "乙", aliases: ["乙的别名"], blocks: [1]},
        ];
        const empty = (name: string) => ({name, aliases: [], fields: {}, references: "", experiences: [], relationships: []});
        const valid = validateGroupedCharacterOutput(materialCategorySpec("character"), candidates, {firstParagraphId: "P1", lastParagraphId: "P3"}, JSON.stringify({entities: [empty("甲"), empty("乙")]}));
        expect(valid.ok).toBe(true);
        const missing = validateGroupedCharacterOutput(materialCategorySpec("character"), candidates, {firstParagraphId: "P1", lastParagraphId: "P3"}, JSON.stringify({entities: [empty("甲")] }));
        expect(missing.ok).toBe(false);
        for (const entities of [[empty("甲"), empty("甲")], [empty("甲"), empty("其他")],
            [{...empty("甲"), fields: {性格: "沉稳"}, references: "P4"}, empty("乙")],
            [{...empty("甲"), references: "P4"}, empty("乙")], [{...empty("甲"), fields: {不存在的字段: ""}}, empty("乙")]]) {
            expect(validateGroupedCharacterOutput(materialCategorySpec("character"), candidates, {firstParagraphId: "P1", lastParagraphId: "P3"}, JSON.stringify({entities})).ok).toBe(false);
        }
    });

    it("分组成功角色独立落盘，仅坏角色成为补提取单元，手动重试不重做成功角色", async () => {
        let repairSucceeded = false;
        const ctx = await setup({hook: info => {
            if (info.kind === "discover") return JSON.stringify({candidates: info.block === 1 ? [{name: "甲"}, {name: "乙"}, {name: "丙"}] : []});
            if (info.request.metadata?.purposeId === "extraction.character.grouped") return JSON.stringify({entities: [
                {name: "甲", aliases: [], fields: {性格: "沉稳"}, references: "P1"},
                {name: "乙", aliases: [], fields: {性格: 123}, references: "P2"},
                {name: "丙", aliases: [], fields: {}, experiences: [], relationships: []},
            ]});
            if (info.request.metadata?.purposeId === "extraction.character.focused") return JSON.stringify({entity: {
                name: "乙", aliases: [], fields: {性格: repairSucceeded ? "开朗" : 123}, references: "P2",
            }});
            return undefined;
        }});
        const task = await startMaterialTask(ctx, {categories: ["character"]});
        const grouped = task.units.find(unit => Array.isArray(unit.data.folderKeys) && unit.data.folderKeys.length === 3)!;
        const failed = task.units.find(unit => unit.status === "failed")!;
        expect(grouped.status).toBe("done");
        expect(grouped.attempts).toBe(1);
        expect(failed.data.folderKey).toBe("乙");
        expect(failed.data.parentUnitId).toBe(grouped.id);
        expect(Object.keys(readEntityIndex(task.state).character!)).toEqual(["甲"]);
        const store = createMaterialIntermediate(ctx.target, task.id);
        const first = await store.readJson("entities/character/甲/block-001.json", EntityFragmentSchema);
        expect(first?.fields.性格).toBe("沉稳");
        expect(await store.readJson("entities/character/丙/block-001.json", EntityFragmentSchema)).toBeNull();
        repairSucceeded = true;
        await ctx.manager.retryUnit(task.id, failed.id);
        await ctx.manager.whenIdle();
        const retried = await ctx.manager.get(task.id);
        expect(retried.units.every(unit => unit.status === "done")).toBe(true);
        expect(Object.keys(readEntityIndex(retried.state).character!).sort()).toEqual(["乙", "甲"]);
        expect(await store.readJson("entities/character/甲/block-001.json", EntityFragmentSchema)).toEqual(first);
        expect(ctx.model.requests.filter(request => request.metadata?.purposeId === "extraction.character.grouped")).toHaveLength(1);
        expect(ctx.model.requests.filter(request => request.metadata?.purposeId === "extraction.character.focused")).toHaveLength(3);
    });

    it("整体 JSON 失败先修复整组，再追加独立单人单元；单人产物分别进入索引", async () => {
        const ctx = await setup({hook: info => {
            if (info.kind === "discover") return JSON.stringify({candidates: info.block === 1 ? [{name: "甲"}, {name: "乙"}] : []});
            if (info.request.metadata?.purposeId === "extraction.character.grouped") return "invalid json";
            if (info.request.metadata?.purposeId === "extraction.character.focused") return JSON.stringify({entity: {
                name: info.request.metadata.characterKeys![0], aliases: [], fields: {性格: "沉稳"}, references: "P1",
            }});
            return undefined;
        }});
        const task = await startMaterialTask(ctx, {categories: ["character"]});
        expect(task.units.every(unit => unit.status === "done")).toBe(true);
        expect(Object.keys(readEntityIndex(task.state).character!).sort()).toEqual(["乙", "甲"]);
        expect(ctx.model.requests.filter(request => request.metadata?.purposeId === "extraction.character.grouped")).toHaveLength(2);
        expect(ctx.model.requests.filter(request => request.metadata?.purposeId === "extraction.character.focused")).toHaveLength(2);
    });

    it.each([false, true])("网络或任务级错误不拆组，任务级错误保留中断语义（fatal=%s）", async fatal => {
        const ctx = await setup({hook: info => {
            if (info.kind === "discover") return JSON.stringify({candidates: info.block === 1 ? [{name: "甲"}, {name: "乙"}] : []});
            if (info.request.metadata?.purposeId === "extraction.character.grouped") throw fatal
                ? new ExtractionFatalError("source-changed", "来源已变化") : new Error("网络不可达");
            return undefined;
        }});
        const task = await startMaterialTask(ctx, {categories: ["character"]});
        expect(task.status).toBe(fatal ? "interrupted" : "partial-failed");
        expect(task.units.some(unit => typeof unit.data.parentUnitId === "string")).toBe(false);
        expect(ctx.model.requests.filter(request => request.metadata?.purposeId === "extraction.character.grouped")).toHaveLength(1);
        expect(ctx.model.requests.some(request => request.metadata?.purposeId === "extraction.character.focused")).toBe(false);
    });

    it("12 万字来源切成 3 块，每块对 9 个类别各调用一次，前缀逐字节等于该块原文", async () => {
        const ctx = await setup();
        expect(ctx.prepared.chunks).toHaveLength(3);
        const task = await startMaterialTask(ctx);
        expect(task.units.filter(unit => unit.step === "discover")).toHaveLength(3);
        expect(task.units.filter(unit => unit.step === "extract")).toHaveLength(3 * (CATEGORY_COUNT - 1));
        expect(task.units.filter(unit => unit.step === "extract-character")).toHaveLength(5);
        expect(task.units.every(unit => unit.status === "done")).toBe(true);

        const prompts = extractionCalls(ctx.model);
        expect(prompts).toHaveLength(3 * (CATEGORY_COUNT - 1));
        for (const chunk of ctx.prepared.chunks) {
            const paragraphs = ctx.prepared.paragraphs.filter(paragraph => paragraph.chunkIndex === chunk.index);
            const prefix = `【原文】每段以【P编号】开头。\n${paragraphs.map(paragraph => `【${paragraph.id}】${paragraph.text.trimEnd()}`).join("\n")}`;
            const own = prompts.filter(prompt => prompt.startsWith(prefix));
            // 同一块的八个非角色类别共享同一前缀；角色发现单独走轻量提示词。
            expect(own).toHaveLength(CATEGORY_COUNT - 1);
            // 前缀之后紧跟分隔符，没有别的块的原文混入。
            expect(own.every(prompt => prompt.startsWith(`${prefix}\n\n`))).toBe(true);
        }
    });

    it("只有实体类调用带已知实体名单，文风等文档类调用没有", async () => {
        const ctx = await setup();
        await startMaterialTask(ctx);
        const prompts = extractionCalls(ctx.model);
        const withList = prompts.filter(prompt => prompt.includes("【已知"));
        // 非角色实体类 × 3 块；角色发现不需要名单，逐角色调用的名单单独验证。
        expect(withList).toHaveLength((ENTITY_CATEGORIES.length - 1) * 3);
        expect(withList.every(prompt => /【任务】提取本块原文中出现的/u.test(prompt))).toBe(true);
        const style = prompts.filter(prompt => prompt.includes("【任务】分析本块原文，提取文风"));
        expect(style).toHaveLength(3);
        expect(style.some(prompt => prompt.includes("【已知"))).toBe(false);
        // 后面的块能看到前面块已登记的角色名，名单只含当前类别。
        const focusedCharacter = ctx.model.requests.map(request => request.prompt).find(prompt => prompt.includes("【任务】只提取角色") && prompt.includes("林舟"));
        expect(focusedCharacter).toBeDefined();
        expect(focusedCharacter).toContain("【已知角色】");
        expect(focusedCharacter).not.toContain("青云山");
    });

    it("返回别称的实体并入已有文件夹，而不是新建", async () => {
        const ctx = await setup();
        const task = await startMaterialTask(ctx);
        const index = readEntityIndex(task.state);
        // 第 2 块用别称“阿舟”指林舟：不会出现名为“阿舟”的文件夹。
        expect(Object.keys(index.character!).sort()).toEqual(["林舟", "沈念", "苏晴"]);
        expect(index.character!["林舟"]!.blocks).toEqual([1, 2, 3]);
        expect(index.character!["林舟"]!.stableId).toMatch(/^[0-9a-f-]{36}$/u);
        expect(index.character!["林舟"]!.stableId).not.toBe("林舟");
        const store = createMaterialIntermediate(ctx.target, task.id);
        expect(await store.list("entities/character/林舟")).toEqual(expect.arrayContaining(["block-001.json", "block-002.json", "block-003.json"]));
    });

    it("参数可限定类别，单元只包含所选类别", async () => {
        const ctx = await setup();
        const task = await startMaterialTask(ctx, {categories: ["instruction", "character"]});
        expect(task.units.filter(unit => unit.step === "discover").map(unit => unit.id)).toEqual(["discover:character:1", "discover:character:2", "discover:character:3"]);
        expect(task.units.filter(unit => unit.step === "extract").map(unit => unit.id).sort()).toEqual([1, 2, 3].map(block => extractUnitId(block, "instruction")));
        expect(task.units.filter(unit => unit.step === "extract-character").length).toBe(5);
    });

    it("参数可限定分块，单元只包含所选块且保持块号顺序", async () => {
        const ctx = await setup();
        const task = await startMaterialTask(ctx, {blocks: [2]});
        expect(task.units.filter(unit => unit.step === "extract")).toHaveLength(CATEGORY_COUNT - 1);
        expect(task.units.filter(unit => unit.step === "discover")).toHaveLength(1);
        expect(task.units.filter(unit => unit.step === "extract-character").every(unit => unit.data.block === 2)).toBe(true);
        expect(task.units.filter(unit => unit.step === "extract-character").every(unit => unit.data.tier === "primary")).toBe(true);
        expect(task.params).toEqual(expect.objectContaining({blocks: [2]}));
    });

    it("非法参数在创建时被拒绝", async () => {
        const ctx = await setup();
        await expect(ctx.manager.start({kind: "material", source: ctx.source, params: {categories: ["bogus"]}})).rejects.toMatchObject({code: "INVALID_INPUT"});
        await expect(ctx.manager.start({kind: "material", source: ctx.source, params: {blocks: [99]}})).rejects.toMatchObject({code: "INVALID_INPUT"});
    });

    it("引用超出本块范围：重试一次后该单元失败，其余单元继续", async () => {
        let attempts = 0;
        const ctx = await setup({
            hook: (info: CallInfo) => {
                if (info.kind !== "extract" || info.category !== "instruction" || info.block !== 2) return undefined;
                attempts += 1;
                // P1 属于第 1 块，不在第 2 块范围内。
                return JSON.stringify({entries: [{fields: {风格名称或概述: "冷峻", 参考片段: "P1"}}]});
            },
        });
        const task = await startMaterialTask(ctx);
        expect(attempts).toBe(2);
        const failed = task.units.filter(unit => unit.status === "failed");
        expect(failed.map(unit => unit.id)).toEqual([extractUnitId(2, "instruction")]);
        expect(failed[0]!.error).toBeTruthy();
        expect(task.units.filter(unit => unit.step === "extract" && unit.status === "done")).toHaveLength(3 * (CATEGORY_COUNT - 1) - 1);
        // 其他单元不受影响，任务照常进入归类等待。
        expect(task.status).toBe("awaiting-input");
    });

    it("同一提取单元重复执行不会留下重复片段", async () => {
        const ctx = await setup();
        const task = await startMaterialTask(ctx);
        const pipeline = createMaterialPipeline({target: ctx.target});
        const unit = task.units.find(candidate => candidate.id === "extract:character:林舟:1")!;
        const controller = new AbortController();
        const generate = async (request: {prompt: {prefix: string; supplements?: readonly string[]; goal: string}; validate: (output: string) => {ok: boolean; value?: unknown}}) => {
            const output = await ctx.model.complete({prompt: [request.prompt.prefix, ...(request.prompt.supplements ?? []), request.prompt.goal].join("\n\n"), signal: controller.signal});
            const result = request.validate(output);
            if (!result.ok) throw new Error("校验失败");
            return result.value;
        };
        // 以任务当前状态再执行一次（索引里已有该块），产物按块覆盖。
        await pipeline.execute(unit, {task, signal: controller.signal, generate} as never);
        await pipeline.execute(unit, {task, signal: controller.signal, generate} as never);
        const store = createMaterialIntermediate(ctx.target, task.id);
        expect((await store.list("entities/character/林舟")).filter(name => name === "block-001.json")).toHaveLength(1);
        expect(await store.list("entities/character")).toEqual(expect.arrayContaining(["林舟", "苏晴"]));
        const dir = path.join(ctx.root, ".nbook", "inspiration", "extractions", task.id, "entities", "character", "林舟");
        expect((await readdir(dir)).filter(name => name.endsWith(".json")).sort()).toEqual(["block-001.json", "block-002.json", "block-003.json"]);
    });
});

describe("素材提取流水线：归类暂停与整合", () => {
    it("全部分块完成后暂停，标出名称别称重合的疑似同一实体", async () => {
        const ctx = await setup();
        const task = await startMaterialTask(ctx);
        expect(task.status).toBe("awaiting-input");
        expect(task.awaitingInput).toContain("归类");
        // 暂停点没有任何整合调用，也没有写入 lorebook。
        expect(ctx.model.requests.some(request => /【任务】把上面/u.test(request.prompt))).toBe(false);
        const view = listClassification(task);
        const characters = view.categories.find(category => category.category === "character")!;
        expect(characters.folders.map(folder => folder.key).sort()).toEqual(["林舟", "沈念", "苏晴"]);
        expect(view.candidates).toEqual([expect.objectContaining({category: "character", folders: expect.arrayContaining(["苏晴", "沈念"])})]);
        expect(view.candidates[0]!.reason).toContain("晴儿");
        const detailed = await listClassificationWithDetails(task, createMaterialIntermediate(ctx.target, task.id));
        const linzhou = detailed.categories.find(category => category.category === "character")!.folders.find(folder => folder.key === "林舟")!;
        expect(linzhou.preview?.fragments.some(fragment => fragment.role === "experience" && fragment.fields["经历描述"] === "离开山村")).toBe(true);
        await expect(readdir(path.join(ctx.root, "lorebook"))).rejects.toThrow();
    });

    it("归类输入非法时任务保持暂停", async () => {
        const ctx = await setup();
        const task = await startMaterialTask(ctx);
        await expect(ctx.manager.provideInput(task.id, {groups: [{category: "character", folders: ["苏晴", "不存在"]}]})).rejects.toMatchObject({code: "INVALID_INPUT"});
        expect((await ctx.manager.get(task.id)).status).toBe("awaiting-input");
    });

    it("把两个文件夹勾为同一实体，整合时合并成一个条目；整合输入只含对应文件夹内容", async () => {
        const integrationPrompts: string[] = [];
        const ctx = await setup({hook: info => { if (info.kind === "integrate") integrationPrompts.push(info.prompt); return undefined; }});
        const task = await runMaterialPipeline(ctx, {groups: [{category: "character", folders: ["苏晴", "沈念"]}]});
        expect(task.status).toBe("completed");
        const integrate = task.units.filter(unit => unit.step === "integrate");
        // 角色 林舟 与 {苏晴, 沈念}、地点 青云山、文风、世界观；写作手法改为确定性索引。
        expect(integrate.map(unit => unit.id).sort()).toEqual([
            "integrate:character:林舟", "integrate:character:苏晴", "integrate:instruction", "integrate:location:青云山",
            "integrate:world",
        ].sort());
        expect(integrate.every(unit => unit.status === "done")).toBe(true);
        expect(task.units.find(unit => unit.id === "index:writing-technique")).toMatchObject({step: "index", status: "done"});
        expect(ctx.model.requests.some(request => /【任务】把上面各块的写作手法草稿整合/u.test(request.prompt))).toBe(false);
        // 素材特点不整合。
        expect(task.units.some(unit => unit.id.startsWith("integrate:material-feature"))).toBe(false);

        const store = createMaterialIntermediate(ctx.target, task.id);
        const {WritingTechniqueIndexSchema} = await import("./material-data");
        const index = await store.readJson("integrated/writing-technique/index.json", WritingTechniqueIndexSchema);
        expect(index).toMatchObject({version: 1, category: "writing-technique"});
        expect(index?.blocks).toEqual(expect.arrayContaining([expect.objectContaining({block: 1, path: "documents/writing-technique/block-001.json", entries: [expect.objectContaining({title: "倒叙"})]})]));
        expect(await store.list("documents/writing-technique")).toEqual(["block-001.json", "block-002.json", "block-003.json"]);
        const merged = await store.readJson("integrated/character/苏晴.json", (await import("./material-data")).IntegratedFileSchema);
        expect(merged!.items).toHaveLength(1);
        expect(merged!.items[0]!.title).toBe("苏晴");
        expect(merged!.items[0]!.aliases).toEqual(expect.arrayContaining(["沈念", "晴儿"]));
        expect(await store.list("integrated/character")).toEqual(expect.arrayContaining(["苏晴.json", "林舟.json"]));
        expect(await store.list("integrated/character")).not.toContain("沈念.json");

        // 整合输入只含对应文件夹：林舟的整合提示词里没有苏晴、沈念的草稿。
        const linzhou = integrationPrompts.filter(prompt => prompt.includes("【任务】把上面同一个角色") && prompt.includes("林舟"));
        expect(linzhou).toHaveLength(1);
        expect(linzhou[0]).not.toContain("开朗");
        expect(linzhou[0]).not.toContain("冷静");
    });

    it("角色整合后主文件只有基本设定，经历与人际关系按块顺序保留 P 引用且不去重", async () => {
        const ctx = await setup();
        const task = await runMaterialPipeline(ctx);
        const store = createMaterialIntermediate(ctx.target, task.id);
        const {IntegratedFileSchema} = await import("./material-data");
        const file = await store.readJson("integrated/character/林舟.json", IntegratedFileSchema);
        const item = file!.items[0]!;
        const main = item.nodes.find(node => node.role === "main")!;
        expect(Object.keys(main.entries[0]!.fields)).toEqual(["名称", "性格"]);
        expect(JSON.stringify(main.entries[0]!.fields)).not.toContain("离开山村");

        const experience = item.nodes.find(node => node.role === "experience")!;
        // 第 1、2、3 块各一条，其中第 1 块与第 3 块文字逐字相同，仍各保留一条。
        expect(experience.entries.map(entry => entry.block)).toEqual([1, 2, 3]);
        expect(experience.entries.filter(entry => entry.fields["经历描述"] === "离开山村")).toHaveLength(2);
        expect(experience.entries.every(entry => /^P\d+/u.test(entry.fields["参考片段"]!))).toBe(true);
        const relationship = item.nodes.find(node => node.role === "relationship")!;
        expect(relationship.entries.map(entry => entry.block)).toEqual([1, 3]);
        expect(relationship.entries.every(entry => /^P\d+/u.test(entry.fields["参考片段"]!))).toBe(true);
    });

    it("素材特点每条一个独立文件", async () => {
        const ctx = await setup();
        const task = await runMaterialPipeline(ctx);
        const store = createMaterialIntermediate(ctx.target, task.id);
        expect((await store.list("features")).sort()).toEqual(["block-001-1.json", "block-001-2.json", "block-002-1.json"]);
        const text = await readFile(path.join(ctx.root, ".nbook", "inspiration", "extractions", task.id, "features", "block-001-2.json"), "utf8");
        expect(JSON.parse(text)).toMatchObject({title: "第一人称视角"});
    });

    it("没有任何实体时跳过归类暂停，直接整合文档类", async () => {
        const ctx = await setup({hook: info => info.kind === "discover" ? JSON.stringify({candidates: []})
            : info.kind === "extract" && !info.prompt.includes("只提取角色") && ENTITY_CATEGORIES.includes(info.category) ? JSON.stringify({entities: []}) : undefined});
        const task = await startMaterialTask(ctx);
        expect(task.status).toBe("completed");
        expect(task.units.some(unit => unit.step === "integrate")).toBe(true);
    });
});

describe("素材提取流水线：中断、模型请求与并行", () => {
    it("取消后继续：被中断的单元整体重做，最终产物与未中断一致", async () => {
        let hung = false;
        const ctx = await setup({
            hook: info => {
                if (hung || info.kind !== "extract" || info.block !== 2 || info.category !== "character") return undefined;
                hung = true;
                // 调用停在进行中，直到任务被取消（脚本化模型在信号中止时立即拒绝）。
                return new Promise<string>(() => undefined);
            },
        });
        const started = await ctx.manager.start({kind: "material", source: ctx.source, params: {}});
        await vi.waitFor(() => expect(hung).toBe(true));
        const cancelled = await ctx.manager.cancel(started.id);
        await ctx.manager.whenIdle();
        expect(cancelled.status).toBe("cancelled");
        expect((await ctx.manager.get(started.id)).units.find(unit => unit.id === "extract:character:林舟:2")!.status).toBe("pending");

        await ctx.manager.resume(started.id);
        await ctx.manager.whenIdle();
        const resumed = await ctx.manager.get(started.id);
        expect(resumed.status).toBe("awaiting-input");
        expect(resumed.units.filter(unit => unit.step === "extract" || unit.step === "extract-character").every(unit => unit.status === "done")).toBe(true);
        const index = readEntityIndex(resumed.state);
        expect(index.character!["林舟"]!.blocks).toEqual([1, 2, 3]);
        const store = createMaterialIntermediate(ctx.target, started.id);
        expect((await store.list("entities/character/林舟")).sort()).toEqual(["block-001.json", "block-002.json", "block-003.json", "experience", "relationship"].sort());
    });

    it("模型请求没有思考开关，观测元数据只含身份和计数关联", async () => {
        const ctx = await setup();
        await runMaterialPipeline(ctx);
        for (const request of ctx.model.requests) {
            expect(request).not.toHaveProperty("reasoning");
            expect(request.metadata).toMatchObject({taskId: expect.any(String), unitId: expect.any(String), prefixHash: expect.stringMatching(/^[a-f0-9]{64}$/u)});
        }
    });

    it("与大纲任务并行运行互不干扰", async () => {
        const ctx = await setup();
        const outline = await ctx.manager.start({kind: "outline", source: {path: "reference/other.md", sha256: "b".repeat(64)}, params: {layout: {v1: ["c1", "c2"]}}});
        const material = await ctx.manager.start({kind: "material", source: ctx.source, params: {}});
        await ctx.manager.whenIdle();
        const outlineDone = await ctx.manager.get(outline.id);
        const materialPaused = await ctx.manager.get(material.id);
        expect(outlineDone.status).toBe("completed");
        expect(outlineDone.units.every(unit => unit.status === "done")).toBe(true);
        expect(materialPaused.status).toBe("awaiting-input");
        expect(materialPaused.units.filter(unit => unit.step === "extract").every(unit => unit.status === "done")).toBe(true);
    });
});

