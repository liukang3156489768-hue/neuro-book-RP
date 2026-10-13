import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {testHostPath} from "@notnotype/neuro-book-test-support/test-path";
import {absoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {
    characterFacetPath,
    characterProfilePath,
    readCharacterWorkspace,
    normalizeLegacyCharacterFacetDocument,
    serializeCharacterFacet,
    serializeCharacterProfile,
} from "nbook/server/character/character-files";
import type {CharacterFacetDto, CharacterProfileDto} from "nbook/shared/dto/character-workspace.dto";

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

function profileDocument(id: string, title: string): string {
    return `---
id: ${id}
type: character
title: ${title}
aliases: [小梨]
tags: [主角]
summary: 一个用于测试的角色
ext:
  character:
    profile:
      identity: 学生
      appearance: 黑发
      clothingStyle: 校服
      personalityTraits: 谨慎
      temperament: 遇事先观察
    meta:
      source: extracted
---

# ${title}

正文说明
`;
}

function facetDocument(kind: string, title: string, content: string): string {
    return `---
kind: ${kind}
records:
  - id: record-1
    title: ${title}
    content: ${content}
    source: original
    targetId: ""
    unknown: ""
    misunderstanding: ""
---

# ${title}
`;
}

async function makeRoot(): Promise<string> {
    const root = await mkdtemp(testHostPath("nbook-character-files-"));
    roots.push(root);
    return root;
}

describe("character file workspace", () => {
    it("只把带有效 index.md 的 character 目录作为正式角色，并读取原作与方案侧面", async () => {
        const root = await makeRoot();
        await mkdir(path.join(root, "lorebook", "character", "li-xi", "original", "knowledge"), {recursive: true});
        await mkdir(path.join(root, "lorebook", "character", "li-xi", "plans", "adapted"), {recursive: true});
        await mkdir(path.join(root, "lorebook", "character", "broken"), {recursive: true});
        await writeFile(path.join(root, "lorebook", "character", "li-xi", "index.md"), profileDocument("li-xi", "李希"));
        await writeFile(path.join(root, "lorebook", "character", "li-xi", "original", "experience.md"), facetDocument("experience", "原作经历", "在雨夜离开车站"));
        await writeFile(path.join(root, "lorebook", "character", "li-xi", "original", "knowledge", "index.md"), facetDocument("knowledge", "原作知识", "知道旧校舍的入口"));
        await writeFile(path.join(root, "lorebook", "character", "li-xi", "plans", "adapted", "relationships.md"), facetDocument("relationships", "改编关系", "与顾言成为同盟"));
        await writeFile(path.join(root, "lorebook", "character", "broken", "notes.md"), "不是角色入口");

        const snapshot = await readCharacterWorkspace(absoluteFsPath(root));
        expect(snapshot.characters).toHaveLength(2);
        const valid = snapshot.characters.find((item) => item.id === "li-xi");
        expect(valid?.profile?.name).toBe("李希");
        expect(valid?.original.experience[0]?.content).toContain("雨夜");
        expect(valid?.original.knowledge[0]?.content).toContain("旧校舍");
        expect(valid?.plans.adapted.relationships[0]?.content).toContain("同盟");
        expect(snapshot.characters.find((item) => item.id === "broken")?.issue).toContain("缺少 index.md");
        expect(snapshot.characters.find((item) => item.id === "legacy")).toBeUndefined();
    });

    it("序列化 profile 和方案侧面时保留未知字段，并分别生成稳定路径", () => {
        const profile: CharacterProfileDto = {
            id: "li-xi", name: "李希", aliases: [], tags: ["主角"], identity: "学生", summary: "摘要",
            appearance: "黑发", clothing: "校服", family: "", economy: "", abilities: "", personality: "谨慎",
            temperament: "观察", avatar: "avatar.png", avatarUrl: "",
        };
        const facet: CharacterFacetDto = {experience: [], relationships: [], knowledge: [], state: {chapter: "1", location: "教室", items: "", psychology: "平静"}};
        const previous = {
            content: profileDocument("li-xi", "旧名"),
            frontmatter: {id: "li-xi", type: "character", title: "旧名", customFlag: true},
            body: "# 旧名\n\n保留正文\n",
            mtimeMs: 1,
            path: "lorebook/character/li-xi/index.md",
        };
        const profileText = serializeCharacterProfile(profile, previous);
        expect(profileText).toContain("customFlag: true");
        expect(profileText).toContain("title: 李希");
        expect(profileText).toContain("保留正文");
        const stateText = serializeCharacterFacet("state", facet, null);
        expect(stateText).toContain("chapter: \"1\"");
        expect(characterProfilePath("li-xi")).toBe("lorebook/character/li-xi/index.md");
        expect(characterFacetPath("li-xi", "adapted", "knowledge")).toBe("lorebook/character/li-xi/plans/adapted/knowledge/index.md");
        expect(() => characterProfilePath("../escape")).toThrow();
        expect(() => characterFacetPath("li-xi", "../escape", "experience")).toThrow();
    });

    it("方案资料缺失时返回空侧面，便于新方案首次创建", async () => {
        const root = await makeRoot();
        await mkdir(path.join(root, "lorebook", "character", "li-xi"), {recursive: true});
        await writeFile(path.join(root, "lorebook", "character", "li-xi", "index.md"), profileDocument("li-xi", "李希"));
        const snapshot = await readCharacterWorkspace(absoluteFsPath(root));
        const record = snapshot.characters.find((item) => item.id === "li-xi");
        expect(record?.plans).toEqual({});
        expect(record?.original.state).toEqual({chapter: "", location: "", items: "", psychology: ""});
        expect(await readFile(path.join(root, "lorebook", "character", "li-xi", "index.md"), "utf8")).toContain("李希");
    });

    it("兼容提取器旧版正文记录，并可无模型补齐 records frontmatter", async () => {
        const root = await makeRoot();
        const directory = path.join(root, "lorebook", "character", "li-xi", "original");
        await mkdir(directory, {recursive: true});
        await writeFile(path.join(root, "lorebook", "character", "li-xi", "index.md"), profileDocument("li-xi", "李希"));
        const legacy = `---\ntitle: 李希的角色经历\ntype: character\nsubtype: experience\norigin: extract\n---\n\n# 角色经历\n\n## 离开车站\n\n### 时间顺序（分块与章节）\n\n第1章\n\n### 阶段名称\n\n离开车站\n\n### 经历描述\n\n在雨夜离开车站。\n\n### 参考片段\n\n> P12\n> 雨夜。\n`;
        await writeFile(path.join(directory, "experience.md"), legacy);
        const snapshot = await readCharacterWorkspace(absoluteFsPath(root));
        const record = snapshot.characters[0]!.original.experience[0]!;
        expect(record.title).toBe("离开车站");
        expect(record.content).toContain("雨夜离开车站");
        expect(record.source).toContain("P12");
        const normalized = normalizeLegacyCharacterFacetDocument(legacy, "experience", "lorebook/character/li-xi/original/experience.md");
        expect(normalized).toContain("records:");
        expect(normalized).toContain("id:");
        expect(normalized).toContain("在雨夜离开车站");
        expect(normalizeLegacyCharacterFacetDocument(normalized, "experience", "x")).toBe(normalized);
    });
});
