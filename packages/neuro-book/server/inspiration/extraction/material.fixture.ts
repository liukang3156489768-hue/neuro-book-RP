import {mkdir, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import {absoluteFsPath, type AbsoluteFsPath} from "nbook/server/runtime/paths/file-path";
import type {ExtractionSourceRef, ExtractionTask, JsonRecord} from "nbook/shared/dto/inspiration-extraction-task.dto";
import type {InspirationSourcePrepareResponseDto} from "nbook/shared/dto/inspiration-source.dto";
import type {WorkspaceFileTarget} from "nbook/server/workspace-files/workspace-file-target";
import {prepareInspirationSource} from "../source";
import {ExtractionTaskManager} from "./manager";
import {createMaterialPipeline} from "./material-pipeline";
import {createSourceVerifier} from "./source-guard";
import {createMemoryExtractionStore} from "./store-memory";
import {createLayeredPipeline, createScriptedModel, createTestLaunch, type ScriptedModel} from "./testing";
import type {ExtractionModelRequest} from "./types";

/**
 * 素材流水线测试的共用夹具：临时项目里的 12 万字来源、按类别与块脚本化的 Mock 模型、管理器装配。
 * 只在测试中使用，不接入真实模型。
 */

export const MATERIAL_SOURCE_PATH = "reference/novel.md";

/** 600 行 × 约 200 字；没有章节标题，按完整自然段切分，约 5 万字一块。 */
export function buildNovelText(): string {
    return `${Array.from({length: 600}, (_, index) => `段${index + 1}：${"雨".repeat(195)}`).join("\n")}\n`;
}

const LABEL_TO_CATEGORY: Record<string, string> = {
    角色: "character", 势力: "faction", 物品: "item", 地点: "location", 特殊规则: "system",
    文风: "instruction", 世界观: "world", 写作手法: "writing-technique", 素材特点: "material-feature",
};

const ENTITY_CATEGORIES = new Set(["character", "faction", "item", "location", "system"]);

export type CallKind = "discover" | "extract" | "integrate" | "merge" | "index";
export type CallInfo = Readonly<{
    kind: CallKind;
    category: string;
    /** 提取调用所属的块号（从 1 开始）；其他调用为 0。 */
    block: number;
    /** 块内第一个段落的编号。 */
    first: number;
    prompt: string;
    request: ExtractionModelRequest;
}>;

/** 返回字符串即覆盖默认应答；返回 undefined 走默认应答。 */
export type CallHook = (info: CallInfo) => string | undefined | Promise<string | undefined>;

const EXPERIENCE_TIME = "时间顺序（分块与章节）";
const FEATURE_TYPE = "类型（剧情安排 / 表现形式）";

function json(value: unknown): string {
    return JSON.stringify(value);
}

function entityReply(category: string, block: number, first: number): string {
    const p = (offset: number) => `P${first + offset}`;
    if (category === "character") {
        if (block === 1) {
            return json({entities: [
                {
                    name: "林舟", aliases: ["阿舟"], fields: {名称: "林舟", 性格: "沉稳"}, references: p(0),
                    experiences: [{[EXPERIENCE_TIME]: "第1块", 阶段名称: "出山", 经历描述: "离开山村", 参考片段: p(1)}],
                    relationships: [{关联角色: "苏晴", 关系类型: "同伴", 关系描述: "并肩作战", 参考片段: p(2)}],
                },
                {name: "苏晴", aliases: ["晴儿"], fields: {名称: "苏晴", 性格: "开朗"}, references: p(3)},
            ]});
        }
        if (block === 2) {
            // 用上一块的别称“阿舟”作为名称：应并入已有的林舟文件夹，而不是新建。
            return json({entities: [
                {
                    name: "阿舟", aliases: [], fields: {性格: "沉稳而坚定"}, references: p(0),
                    experiences: [{[EXPERIENCE_TIME]: "第2块", 阶段名称: "入城", 经历描述: "进入王都", 参考片段: p(1)}],
                },
                // 与苏晴共用别称“晴儿”，归类暂停点应标为疑似同一实体。
                {name: "沈念", aliases: ["晴儿"], fields: {名称: "沈念", 性格: "冷静"}, references: p(2)},
            ]});
        }
        return json({entities: [{
            name: "林舟", aliases: [], fields: {性格: "沉稳"}, references: p(0),
            // 与第 1 块的阶段名称、描述逐字相同：时间线不去重，两条都要保留。
            experiences: [{[EXPERIENCE_TIME]: "第3块", 阶段名称: "出山", 经历描述: "离开山村", 参考片段: p(1)}],
            relationships: [{关联角色: "苏晴", 关系类型: "同伴", 关系描述: "并肩作战", 参考片段: p(2)}],
        }]});
    }
    if (category === "location" && block === 1) {
        return json({entities: [{name: "青云山", aliases: [], fields: {名称: "青云山", 描述: "终年云雾的山"}, references: p(0)}]});
    }
    return json({entities: []});
}

function characterDiscoveryReply(block: number): string {
    if (block === 1) return json({candidates: [{name: "林舟", aliases: ["阿舟"]}, {name: "苏晴", aliases: ["晴儿"]}]});
    if (block === 2) return json({candidates: [{name: "阿舟", aliases: []}, {name: "沈念", aliases: ["晴儿"]}]});
    return json({candidates: [{name: "林舟", aliases: []}]});
}

function focusedCharacterReply(block: number, first: number, name: string): string {
    const p = (offset: number) => `P${first + offset}`;
    if (block === 1 && name === "林舟") return json({entity: {
        name: "林舟", aliases: ["阿舟"], fields: {名称: "林舟", 性格: "沉稳"}, references: p(0),
        experiences: [{[EXPERIENCE_TIME]: "第1块", 阶段名称: "出山", 经历描述: "离开山村", 参考片段: p(1)}],
        relationships: [{关联角色: "苏晴", 关系类型: "同伴", 关系描述: "并肩作战", 参考片段: p(2)}],
    }});
    if (block === 1 && name === "苏晴") return json({entity: {name: "苏晴", aliases: ["晴儿"], fields: {名称: "苏晴", 性格: "开朗"}, references: p(3)}});
    if (block === 2 && (name === "阿舟" || name === "林舟")) return json({entity: {
        name: "阿舟", aliases: [], fields: {性格: "沉稳而坚定"}, references: p(0),
        experiences: [{[EXPERIENCE_TIME]: "第2块", 阶段名称: "入城", 经历描述: "进入王都", 参考片段: p(1)}],
    }});
    if (block === 2 && name === "沈念") return json({entity: {name: "沈念", aliases: ["晴儿"], fields: {名称: "沈念", 性格: "冷静"}, references: p(2)}});
    return json({entity: {name: "林舟", aliases: [], fields: {性格: "沉稳"}, references: p(0),
        experiences: [{[EXPERIENCE_TIME]: "第3块", 阶段名称: "出山", 经历描述: "离开山村", 参考片段: p(1)}],
        relationships: [{关联角色: "苏晴", 关系类型: "同伴", 关系描述: "并肩作战", 参考片段: p(2)}],
    }});
}

function entriesReply(category: string, block: number, first: number): string {
    const p = (offset: number) => `P${first + offset}`;
    switch (category) {
        case "instruction": return json({entries: [{fields: {风格名称或概述: "冷峻", 整体基调: "压抑", 参考片段: p(0)}}]});
        case "world": return json({entries: [{fields: {名称与概述: "九州", 时代与文明水平: "古代"}, references: p(0)}]});
        case "writing-technique":
            return json({entries: block === 1 ? [{fields: {手法名称: "倒叙", 手法说明: "先写结局", 参考片段: p(0)}}] : []});
        default: {
            const features = [
                [{名称: "雨夜伏笔", [FEATURE_TYPE]: "剧情安排", 安排描述: "雨夜埋下线索", 参考片段: p(0)}, {名称: "第一人称视角", [FEATURE_TYPE]: "表现形式", 安排描述: "以林舟视角叙述", 参考片段: p(1)}],
                [{名称: "身份反转", [FEATURE_TYPE]: "剧情安排", 安排描述: "同伴身份揭晓", 参考片段: p(0)}],
                [],
            ][block - 1] ?? [];
            return json({entries: features.map(fields => ({fields}))});
        }
    }
}

function integrationReply(kind: CallKind, category: string, prompt: string): string {
    if (kind === "merge") return json({fields: {性格: "合并后的性格"}});
    if (category === "character") return json({fields: {性格: "整合后的性格"}});
    if (category === "instruction") {
        // 整合不能新增引用：把草稿里出现过的参考片段并起来。
        const refs = [...prompt.matchAll(/"参考片段": "([^"]+)"/gu)].map(match => match[1]!);
        return json({entries: [{fields: {风格名称或概述: "冷峻克制", 参考片段: refs.join(" ")}}]});
    }
    if (category === "world") return json({entries: [{fields: {名称与概述: "九州总述"}}]});
    return json({fields: {}});
}

export type MaterialModelOptions = Readonly<{blocks: InspirationSourcePrepareResponseDto["chunks"]; hook?: CallHook}>;

/** 按提示词里的任务句识别调用类型与类别；识别不了的调用直接报错，避免测试静默通过。 */
export function createMaterialModel(options: MaterialModelOptions): ScriptedModel {
    const blockOfFirst = new Map(options.blocks.map(chunk => [Number(chunk.firstParagraphId.slice(1)), chunk.index]));
    return createScriptedModel(async request => {
        const prompt = request.prompt;
        if (prompt.startsWith("【待索引条目】\n")) {
            const category = prompt.includes("为这些写作手法条目") ? "writing-technique" : "material-feature";
            const info: CallInfo = {kind: "index", category, block: 0, first: 0, prompt, request};
            const overridden = await options.hook?.(info);
            if (overridden !== undefined) return overridden;
            const entries = JSON.parse(prompt.slice("【待索引条目】\n".length).split("\n\n")[0]!) as Array<{key: string; title: string}>;
            return json({entries: entries.map(entry => ({key: entry.key, group: "叙事", summary: `${entry.title}的使用要点`, keywords: [entry.title]}))});
        }
        // 大纲演示流水线的提示词不带素材任务句，与素材任务并行时用它验证两边互不串扰。
        if (/^【原文】(chapter|volume|total)/u.test(prompt)) return `OK:${/【原文】(\S+)/u.exec(prompt)![1]}`;
        if (prompt.includes("【提取目标】本次只处理这些角色：")) {
            const first = Number(/【P(\d+)】/u.exec(prompt)![1]);
            const block = blockOfFirst.get(first)!;
            const info: CallInfo = {kind: "extract", category: "character", block, first, prompt, request};
            const overridden = await options.hook?.(info);
            if (overridden !== undefined) return overridden;
            const example = JSON.parse(/输出格式：(\{"entities":.+\})/u.exec(prompt)![1]!) as {entities: Array<{name: string}>};
            return json({entities: example.entities.map(({name}) => JSON.parse(focusedCharacterReply(block, first, name)).entity)});
        }
        const patterns: Array<[CallKind, RegExp]> = [
            ["discover", /【任务】粗读本块原文，列出其中实际出现的角色与称谓/u],
            ["extract", /【任务】只提取角色“(.+?)”在本块中的资料/u],
            ["extract", /【任务】提取本块原文中出现的(.+?)。/u],
            ["extract", /【任务】分析本块原文，提取(.+?)。/u],
            ["integrate", /【任务】把上面同一个(.+?)在各块的草稿/u],
            ["integrate", /【任务】把上面各块的(.+?)草稿整合/u],
            ["merge", /【任务】用户认为上面这些(.+?)条目/u],
        ];
        for (const [kind, pattern] of patterns) {
            const match = pattern.exec(prompt);
            if (!match) continue;
            const label = match?.[1];
            if (kind === "discover") {
                const firstMatch = /【P(\d+)】/u.exec(prompt);
                const first = Number(firstMatch![1]);
                const block = blockOfFirst.get(first)!;
                const info: CallInfo = {kind, category: "character", block, first, prompt, request};
                const overridden = await options.hook?.(info);
                if (overridden !== undefined) return overridden;
                return characterDiscoveryReply(block);
            }
            if (!label) continue;
            const category = kind === "extract" && pattern.source.includes("只提取角色") ? "character" : LABEL_TO_CATEGORY[label];
            if (!category) throw new Error(`无法识别类别：${label}`);
            const firstMatch = /【P(\d+)】/u.exec(prompt);
            const first = kind === "extract" ? Number(firstMatch![1]) : 0;
            const block = kind === "extract" ? blockOfFirst.get(first)! : 0;
            const info: CallInfo = {kind, category, block, first, prompt, request};
            const overridden = await options.hook?.(info);
            if (overridden !== undefined) return overridden;
            if (kind === "extract") {
                if (pattern.source.includes("只提取角色")) return focusedCharacterReply(block, first, label);
                return ENTITY_CATEGORIES.has(category) ? entityReply(category, block, first) : entriesReply(category, block, first);
            }
            return integrationReply(kind, category, prompt);
        }
        throw new Error(`无法识别的提示词：${prompt.slice(0, 80)}`);
    });
}

export type MaterialEnv = Readonly<{
    root: AbsoluteFsPath;
    target: WorkspaceFileTarget;
    source: ExtractionSourceRef;
    prepared: InspirationSourcePrepareResponseDto;
    model: ScriptedModel;
    manager: ExtractionTaskManager;
    cleanup(): Promise<void>;
}>;

export async function createMaterialEnv(options: Readonly<{hook?: CallHook; model?: (blocks: MaterialModelOptions["blocks"]) => ScriptedModel}> = {}): Promise<MaterialEnv> {
    const root = absoluteFsPath(await createTestTmpRoot("inspiration-extraction", "material-pipeline-tests"));
    await mkdir(path.join(root, "reference"), {recursive: true});
    await writeFile(path.join(root, MATERIAL_SOURCE_PATH), buildNovelText(), "utf8");
    const target: WorkspaceFileTarget = {kind: "user-assets", root};
    const prepared = await prepareInspirationSource(root, MATERIAL_SOURCE_PATH);
    const model = options.model?.(prepared.chunks) ?? createMaterialModel({blocks: prepared.chunks, hook: options.hook});
    const pipeline = createMaterialPipeline({target});
    const outline = createLayeredPipeline();
    const realVerifier = createSourceVerifier(root);
    const manager = new ExtractionTaskManager({
        store: createMemoryExtractionStore(), model,
        // 并行用的大纲演示任务没有真实来源文件，只对素材来源做磁盘复核。
        verifySource: async source => { if (source.path === MATERIAL_SOURCE_PATH) await realVerifier(source); },
        resolvePipeline: kind => kind === "material" ? pipeline : outline,
        launch: createTestLaunch().launch,
    });
    return {
        root, target, source: {path: MATERIAL_SOURCE_PATH, sha256: prepared.source.sha256}, prepared, model, manager,
        cleanup: () => rm(root, {recursive: true, force: true}),
    };
}

/** 启动素材任务并等到第一个稳定点（暂停或结束）。 */
export async function startMaterialTask(env: MaterialEnv, params: JsonRecord = {}): Promise<ExtractionTask> {
    const started = await env.manager.start({kind: "material", source: env.source, params});
    await env.manager.whenIdle();
    return env.manager.get(started.id);
}

/** 走完整条流水线：提取 -> 归类（按 `groups`，缺省跳过）-> 整合。 */
export async function runMaterialPipeline(env: MaterialEnv, input: unknown = {skip: true}, params: JsonRecord = {}): Promise<ExtractionTask> {
    const paused = await startMaterialTask(env, params);
    if (paused.status !== "awaiting-input") return paused;
    await env.manager.provideInput(paused.id, input);
    await env.manager.whenIdle();
    return env.manager.get(paused.id);
}
