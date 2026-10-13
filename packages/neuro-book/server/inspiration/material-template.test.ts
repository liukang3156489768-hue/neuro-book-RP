import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {absoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {
    applyWorkspaceContentFrontmatterDefaults, createWorkspaceContentFrontmatterDefaults, readWorkspaceContentOrigin,
    schemaForWorkspaceContentType, workspaceContentJsonSchema,
} from "nbook/server/workspace-files/content-node-schema";
import {parseMarkdownDocument, renderMarkdownDocument, scanWorkspaceTree, validateWorkspaceTree} from "nbook/server/workspace-files/workspace-files";
import {
    MATERIAL_CATEGORIES, MATERIAL_CHARACTER_SUBFOLDERS, MATERIAL_FEATURE_TYPE_FIELD, MATERIAL_TEMPLATES, type MaterialExtractionSource,
} from "nbook/shared/dto/inspiration-material.dto";
import {
    buildExtractedMaterialFrontmatter, parseParagraphReferences, renderMaterialBody, restoreParagraphReferences, validateMaterialTemplateFields,
} from "./material-template";

const paragraphs = Array.from({length: 30}, (_, index) => ({id: `P${index + 1}`, text: `第${index + 1}段。\n`}));
const range = {firstParagraphId: "P10", lastParagraphId: "P20"};
const source: MaterialExtractionSource = {
    sourcePath: "reference/小说/原作.txt", sha256: "a".repeat(64),
    citations: [{firstParagraphId: "P12", lastParagraphId: "P15"}, {firstParagraphId: "P20", lastParagraphId: "P20"}],
};

describe("素材提取模板校验", () => {
    it("四个模板的字段与 Spec 模板表一致，且各自带 Spec 要求的元数据类型", () => {
        expect(MATERIAL_TEMPLATES["writing-technique"].fields).toEqual(["手法名称", "类型（叙事 / 描写 / 对话 / 结构 / 节奏等）", "手法说明", "适用场景", "实现要点", "效果", "参考片段"]);
        expect(MATERIAL_TEMPLATES["material-feature"].fields).toEqual(["名称", "所在位置（分块与章节）", "类型（剧情安排 / 表现形式）", "安排描述", "效果", "参考片段"]);
        expect(MATERIAL_TEMPLATES["character-experience"].fields).toEqual(["时间顺序（分块与章节）", "阶段名称", "经历描述", "对角色的影响", "参考片段"]);
        expect(MATERIAL_TEMPLATES["character-relationship"].fields).toEqual(["关联角色", "关系类型", "关系描述", "变化节点（分块与章节及变化内容）", "参考片段"]);
        // 两类素材保留 note 类型与 subtype，目录按用途分开。
        const [technique, feature] = [MATERIAL_TEMPLATES["writing-technique"].node, MATERIAL_TEMPLATES["material-feature"].node];
        expect(technique).toEqual({type: "note", subtype: "writing-technique"});
        expect(feature).toEqual({type: "note", subtype: "material-feature"});
        expect(MATERIAL_CATEGORIES.filter(category => category.directory.startsWith("lorebook/note/")).map(category => [category.key, category.directory])).toEqual([
            ["writing-technique", "lorebook/note/写作手法/"], ["material-feature", "lorebook/note/写作素材/"],
        ]);
    });

    it("字段均非必填：只填部分字段通过，空值被丢弃并按模板顺序排列", () => {
        const result = validateMaterialTemplateFields("writing-technique", {"参考片段": "P12-P15", "手法名称": "  倒叙  ", "效果": "", "手法说明": "先写结局"}, {paragraphs, range});
        expect(result.errors).toEqual([]);
        expect(Object.entries(result.fields)).toEqual([["手法名称", "倒叙"], ["手法说明", "先写结局"], ["参考片段", "P12-P15"]]);
        expect(result.references).toEqual([{firstParagraphId: "P12", lastParagraphId: "P15"}]);
        expect(validateMaterialTemplateFields("character-experience", {"阶段名称": "入门"}).errors).toEqual([]);
    });

    it("拒绝不属于模板的字段，并指出字段属于哪个模板", () => {
        const foreign = validateMaterialTemplateFields("writing-technique", {"手法名称": "倒叙", "阶段名称": "入门"});
        expect(foreign.errors).toEqual([expect.stringContaining("属于模板“角色经历”")]);
        const unknown = validateMaterialTemplateFields("character-relationship", {"随便": "x", "关联角色": "小红"});
        expect(unknown.errors).toEqual([expect.stringContaining("字段“随便”不属于模板“角色人际关系”")]);
        expect(validateMaterialTemplateFields("material-feature", {"名称": 1 as unknown as string}).errors).toEqual([expect.stringContaining("必须是文本")]);
    });

    it("整条记录没有任何非空字段时报错", () => {
        expect(validateMaterialTemplateFields("material-feature", {"名称": "  ", "效果": ""}).errors).toEqual([expect.stringContaining("至少填写一个字段")]);
    });

    it("素材特点的类型只接受剧情安排或表现形式", () => {
        expect(validateMaterialTemplateFields("material-feature", {[MATERIAL_FEATURE_TYPE_FIELD]: "剧情安排"}).errors).toEqual([]);
        expect(validateMaterialTemplateFields("material-feature", {[MATERIAL_FEATURE_TYPE_FIELD]: "表现形式"}).errors).toEqual([]);
        expect(validateMaterialTemplateFields("material-feature", {[MATERIAL_FEATURE_TYPE_FIELD]: "其他"}).errors).toEqual([expect.stringContaining("只能填写")]);
    });

    it("校验参考片段的 P 编号格式、存在性与分块范围", () => {
        const errorsFor = (value: string) => validateMaterialTemplateFields("character-experience", {"参考片段": value}, {paragraphs, range}).errors;
        expect(errorsFor("P10、P12-P15 P20")).toEqual([]);
        expect(errorsFor("段落12")).toEqual([expect.stringContaining("不是有效的 P 编号引用")]);
        expect(errorsFor("P0")).toEqual([expect.stringContaining("不是有效的 P 编号引用")]);
        expect(errorsFor("P15-P12")).toEqual([expect.stringContaining("结束编号小于起始编号")]);
        expect(errorsFor("P99")).toEqual([expect.stringContaining("不存在的 P 编号")]);
        expect(errorsFor("P9")).toEqual([expect.stringContaining("超出本块范围 P10-P20")]);
        expect(errorsFor("P18-P25")).toEqual([expect.stringContaining("超出本块范围")]);
        // 未提供来源上下文时只做格式校验。
        expect(validateMaterialTemplateFields("character-experience", {"参考片段": "P999"}).errors).toEqual([]);
        expect(parseParagraphReferences("P3，P5-P6").references).toEqual([{firstParagraphId: "P3", lastParagraphId: "P3"}, {firstParagraphId: "P5", lastParagraphId: "P6"}]);
    });
});

describe("参考片段还原与正文渲染", () => {
    it("把 P 引用还原为连续原文片段，并保持引用顺序", () => {
        expect(restoreParagraphReferences(
            [{firstParagraphId: "P12", lastParagraphId: "P13"}, {firstParagraphId: "P3", lastParagraphId: "P3"}], paragraphs,
        )).toEqual([{label: "P12-P13", text: "第12段。\n第13段。"}, {label: "P3", text: "第3段。"}]);
    });

    it("引用缺失或颠倒时抛错而不是返回残缺片段", () => {
        expect(() => restoreParagraphReferences([{firstParagraphId: "P99", lastParagraphId: "P99"}], paragraphs)).toThrow("无法还原参考片段 P99");
        expect(() => restoreParagraphReferences([{firstParagraphId: "P5", lastParagraphId: "P4"}], paragraphs)).toThrow("无法还原");
    });

    it("单条模板按字段顺序渲染，参考片段展开为原文引用", () => {
        const body = renderMaterialBody("writing-technique", [{"参考片段": "P12-P13", "手法名称": "倒叙", "效果": ""}], paragraphs);
        expect(body).toBe("## 手法名称\n\n倒叙\n\n## 参考片段\n\n> P12-P13\n> 第12段。\n> 第13段。");
        expect(renderMaterialBody("writing-technique", [{"参考片段": "P12"}])).toBe("## 参考片段\n\nP12");
        expect(() => renderMaterialBody("writing-technique", [{"手法名称": "a"}, {"手法名称": "b"}])).toThrow("只容纳一条");
    });

    it("多条模板按传入顺序渲染且不去重合并", () => {
        const entry = {"阶段名称": "入门", "经历描述": "拜师"};
        const body = renderMaterialBody("character-experience", [entry, entry, {"经历描述": "无名阶段"}]);
        expect(body.match(/^## 入门$/gmu)).toHaveLength(2);
        expect(body).toContain("## 第 3 条");
    });
});

describe("来源标记 origin", () => {
    it("缺失 origin 视为 design，旧文件 schema 校验与默认值补齐不变", () => {
        const legacy = createWorkspaceContentFrontmatterDefaults({title: "旧素材", type: "character", status: "active"});
        expect(Object.keys(legacy)).not.toContain("origin");
        expect(Object.keys(legacy)).not.toContain("extraction");
        expect(readWorkspaceContentOrigin(legacy)).toBe("design");
        expect(schemaForWorkspaceContentType("character").safeParse(legacy).success).toBe(true);
        const applied = applyWorkspaceContentFrontmatterDefaults({frontmatter: legacy, title: "旧素材", type: "character"});
        expect(applied.changed).toBe(false);
        expect(applied.frontmatter).toEqual(legacy);
        // 旧文件经 YAML 往返后仍不出现来源字段。
        const reparsed = parseMarkdownDocument(renderMarkdownDocument(legacy, "正文")).frontmatter;
        expect(reparsed).toEqual(legacy);
        expect(workspaceContentJsonSchema("note")).toBeTruthy();
    });

    it("显式 design 合法；非法 origin 值按 design 读取但 schema 报错", () => {
        const base = createWorkspaceContentFrontmatterDefaults({title: "x", type: "note", status: "active"});
        expect(schemaForWorkspaceContentType("note").safeParse({...base, origin: "design"}).success).toBe(true);
        expect(readWorkspaceContentOrigin({...base, origin: "design"})).toBe("design");
        expect(schemaForWorkspaceContentType("note").safeParse({...base, origin: "imported"}).success).toBe(false);
        expect(readWorkspaceContentOrigin({...base, origin: "imported"})).toBe("design");
    });

    it("origin 与 extraction 必须成对出现", () => {
        const base = createWorkspaceContentFrontmatterDefaults({title: "x", type: "note", status: "active"});
        const schema = schemaForWorkspaceContentType("note");
        expect(schema.safeParse({...base, origin: "extract"}).success).toBe(false);
        expect(schema.safeParse({...base, extraction: source}).success).toBe(false);
        expect(schema.safeParse({...base, origin: "extract", extraction: {...source, sha256: "bad"}}).success).toBe(false);
        expect(schema.safeParse({...base, origin: "extract", extraction: {...source, citations: [{firstParagraphId: "段12", lastParagraphId: "P13"}]}}).success).toBe(false);
        expect(schema.safeParse({...base, origin: "extract", extraction: source}).success).toBe(true);
    });

    it("提取素材的 frontmatter 经 YAML 往返后保持来源文件、哈希与 P 引用", () => {
        const frontmatter = buildExtractedMaterialFrontmatter({title: "倒叙", ...MATERIAL_TEMPLATES["writing-technique"].node, source});
        const text = renderMarkdownDocument(frontmatter, renderMaterialBody("writing-technique", [{"手法名称": "倒叙"}]));
        const parsed = parseMarkdownDocument(text);
        expect(parsed.error).toBeNull();
        expect(parsed.frontmatter).toMatchObject({origin: "extract", type: "note", subtype: "writing-technique", extraction: source});
        expect(readWorkspaceContentOrigin(parsed.frontmatter)).toBe("extract");
        expect(schemaForWorkspaceContentType("note").safeParse(parsed.frontmatter).success).toBe(true);
    });
});

describe("例外规则：是否允许涉及剧情发展", () => {
    it("只有写作手法与素材特点允许，其余类别保持“不涉及剧情”", () => {
        expect(MATERIAL_CATEGORIES.filter(category => category.allowsPlotDevelopment).map(category => category.key)).toEqual(["writing-technique", "material-feature"]);
        expect(MATERIAL_CATEGORIES.filter(category => !category.allowsPlotDevelopment).map(category => category.key))
            .toEqual(["character", "faction", "item", "location", "system", "instruction", "world"]);
    });
});

describe("lorebook/character/<名称>/ 子文件夹内容节点", () => {
    const roots: string[] = [];
    afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))); });

    it("经历与人际关系子文件夹作为内容节点被扫描索引，且不产生校验问题", async () => {
        const root = await mkdtemp(join(tmpdir(), "material-subnode-"));
        roots.push(root);
        const write = async (relative: string, frontmatter: Record<string, unknown>, body: string) => {
            await mkdir(dirname(join(root, relative)), {recursive: true});
            await writeFile(join(root, relative), renderMarkdownDocument(frontmatter, body), "utf-8");
        };
        const main = buildExtractedMaterialFrontmatter({title: "小明", type: "character", source});
        await write("lorebook/character/xiaoming/index.md", main, "## 角色名称\n\n小明");
        for (const kind of ["character-experience", "character-relationship"] as const) {
            const folder = MATERIAL_CHARACTER_SUBFOLDERS[kind];
            const frontmatter = buildExtractedMaterialFrontmatter({title: `小明·${MATERIAL_TEMPLATES[kind].label}`, ...MATERIAL_TEMPLATES[kind].node, source});
            await write(`lorebook/character/xiaoming/${folder}/index.md`, frontmatter, renderMaterialBody(kind, [{[MATERIAL_TEMPLATES[kind].titleField]: "甲"}]));
        }

        const nodes = await scanWorkspaceTree({root: absoluteFsPath(root), targets: ["lorebook"]});
        const byPath = new Map(nodes.map(node => [node.path, node]));
        for (const [path, subtype] of [["lorebook/character/xiaoming/", "person"], ["lorebook/character/xiaoming/experience/", "experience"], ["lorebook/character/xiaoming/relationship/", "relationship"]] as const) {
            const node = byPath.get(path);
            expect(node, path).toMatchObject({isDirectory: true, contentNode: true, hasIndex: true, entryType: "character", frontmatterError: null});
            expect(node?.frontmatter.subtype).toBe(subtype);
            expect(readWorkspaceContentOrigin(node!.frontmatter)).toBe("extract");
        }
        // 项目文件索引与此处共用 scanWorkspaceTree + createWorkspaceContentIssues，子节点不触发 invalid-type、同名冲突等问题。
        expect(await validateWorkspaceTree({root: absoluteFsPath(root), targets: ["lorebook"]})).toEqual([]);
    });
});
