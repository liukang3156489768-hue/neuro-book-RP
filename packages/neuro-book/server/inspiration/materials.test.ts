import {createHash} from "node:crypto";
import {link, mkdir, mkdtemp, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {listInspirationMaterials, readInspirationMaterials} from "./materials";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))); });
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "design-materials-")); roots.push(root);
    const put = async (path: string, text: string | Buffer) => { await mkdir(dirname(join(root, path)), {recursive: true}); await writeFile(join(root, path), text); };
    return {root, put};
}
const signal = () => new AbortController().signal;
const list = (root: string) => listInspirationMaterials(root, {offset: 0, limit: 20});

describe("改编来源读取", () => {
    it("目录、稳定 ID 和标题引用解析到同一份 index 文件", async () => {
        const f = await fixture();
        await f.put("lorebook/character/123e4567-e89b-12d3-a456-426614174000/index.md", "---\nid: 123e4567-e89b-12d3-a456-426614174000\ntype: character\ntitle: 程杰\naliases: [小程]\next:\n  inspiration:\n    artifactId: 123\n---\n正文");
        const byId = await readInspirationMaterials(f.root, ["lorebook/character/123e4567-e89b-12d3-a456-426614174000"], signal());
        const byTitle = await readInspirationMaterials(f.root, ["lorebook/character/程杰"], signal());
        const byLegacyFolder = await readInspirationMaterials(f.root, ["lorebook/character/程杰/index.md"], signal());
        expect(byId[0]!.path).toBe("lorebook/character/123e4567-e89b-12d3-a456-426614174000/index.md");
        expect(byTitle[0]!.path).toBe(byId[0]!.path);
        expect(byLegacyFolder[0]!.path).toBe(byId[0]!.path);
        expect(byTitle[0]!.content).toBe(byId[0]!.content);
    });

    it("目录只发现名称与路径，分页筛选覆盖嵌套笔记和角色子文件，不解析未选正文", async () => {
        const f = await fixture();
        await f.put("lorebook/character/灯师/index.md", "---\ntitle: 不应读取的标题\n---\n正文");
        await f.put("lorebook/character/灯师/经历.md", "经历");
        await f.put("lorebook/note/写作手法/节奏/index.md", Buffer.from([0xff]));
        const result = await list(f.root);
        expect(result.items).toHaveLength(3);
        expect(result.items.some(item => item.title === "不应读取的标题")).toBe(false);
        expect(result.items.every(item => !('content' in item))).toBe(true);
        const page = await listInspirationMaterials(f.root, {category: "character", query: "灯师", offset: 0, limit: 1});
        expect(page.total).toBe(2); expect(page.nextOffset).toBe(1);
        expect(await listInspirationMaterials(f.root, {category: "character", query: "灯师", offset: 1, limit: 1})).toMatchObject({nextOffset: null});
    });
    it("只读取明确选择的 UTF-8 正文，去除 frontmatter，哈希对应完整源文件", async () => {
        const f = await fixture(); const source = "---\ntitle: 灯师\n---\n\n中文人设";
        await f.put("lorebook/character/person/index.md", source);
        await f.put("lorebook/item/unselected.md", Buffer.from([0xff]));
        const result = await readInspirationMaterials(f.root, ["lorebook/character/person/index.md"], signal());
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({title: "灯师", category: "character", sha256: createHash("sha256").update(source).digest("hex")});
        expect(result[0]!.content.trim()).toBe("中文人设");
    });
    it("字符限额不误算为中文 UTF-8 字节，超额明确拒绝而不截断", async () => {
        const f = await fixture(); await f.put("lorebook/character/a.md", "人".repeat(60_000));
        expect((await readInspirationMaterials(f.root, ["lorebook/character/a.md"], signal()))[0]!.content).toHaveLength(60_000);
        await f.put("lorebook/character/a.md", "人".repeat(60_001));
        await expect(readInspirationMaterials(f.root, ["lorebook/character/a.md"], signal())).rejects.toThrow("60,000 字符");
        for (const name of ["a", "b", "c"]) await f.put(`lorebook/character/${name}.md`, "人".repeat(55_000));
        await expect(readInspirationMaterials(f.root, ["a", "b", "c"].map(name => `lorebook/character/${name}.md`), signal())).rejects.toThrow("160,000");
    });
    it("拒绝空选择、重复、缺失、越界、非文本、无效 frontmatter 和取消", async () => {
        const f = await fixture();
        for (const paths of [[], ["../outside.md"], ["lorebook/character/a.md", "lorebook/character/A.md"]]) await expect(readInspirationMaterials(f.root, paths, signal())).rejects.toMatchObject({statusCode: 400});
        await expect(readInspirationMaterials(f.root, ["lorebook/character/missing.md"], signal())).rejects.toMatchObject({statusCode: 404});
        for (const content of [Buffer.from([0xff]), "body\0", "   ", "---\n42\n---\nbody"]) {
            await f.put("lorebook/character/a.md", content);
            await expect(readInspirationMaterials(f.root, ["lorebook/character/a.md"], signal())).rejects.toThrow();
        }
        const cancelled = new AbortController(); cancelled.abort(new Error("cancelled"));
        await expect(readInspirationMaterials(f.root, ["lorebook/character/a.md"], cancelled.signal)).rejects.toThrow("cancelled");
    });
    it("拒绝硬链接及 lorebook 父目录联接，不能列出或读取外部素材", async () => {
        const f = await fixture(); const outside = await fixture(); await outside.put("secret.md", "外部资料");
        await mkdir(join(f.root, "lorebook/character"), {recursive: true});
        await link(join(outside.root, "secret.md"), join(f.root, "lorebook/character/linked.md"));
        await expect(list(f.root)).rejects.toThrow("硬链接");
        await expect(readInspirationMaterials(f.root, ["lorebook/character/linked.md"], signal())).rejects.toThrow("硬链接");
        const linkedRoot = await fixture(); await mkdir(join(outside.root, "character"));
        await symlink(outside.root, join(linkedRoot.root, "lorebook"), process.platform === "win32" ? "junction" : "dir");
        await expect(list(linkedRoot.root)).rejects.toThrow("链接");
        await expect(readInspirationMaterials(linkedRoot.root, ["lorebook/character/secret.md"], signal())).rejects.toThrow("链接");
    });
});
