import {createHash} from "node:crypto";
import {mkdir, readFile, rm, stat, symlink, writeFile} from "node:fs/promises";
import path from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import {absoluteFsPath, type AbsoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {
    INSPIRATION_SOURCE_MAX_BYTES,
    InspirationSourceListResponseSchema,
    InspirationSourcePrepareResponseSchema,
} from "nbook/shared/dto/inspiration-source.dto";
import {listInspirationSources, prepareInspirationSource} from "nbook/server/inspiration/source";

describe("Inspiration 来源文件边界", () => {
    let root: AbsoluteFsPath;
    const cleanup: string[] = [];

    beforeEach(async () => {
        root = absoluteFsPath(await createTestTmpRoot("inspiration-source", "source-read-only-tests"));
        cleanup.push(root);
        await mkdir(path.join(root, "reference"));
    });

    afterEach(async () => {
        await Promise.all(cleanup.splice(0).map((directory) => rm(directory, {recursive: true, force: true})));
    });

    it("递归列出受支持文本并跳过目录联接，不读取其它目录", async () => {
        await mkdir(path.join(root, "reference", "nested"));
        await mkdir(path.join(root, "other"));
        await writeFile(path.join(root, "reference", "a.txt"), "正文");
        await writeFile(path.join(root, "reference", "nested", "b.MD"), "正文");
        await writeFile(path.join(root, "reference", "ignore.docx"), "正文");
        await writeFile(path.join(root, "other", "secret.txt"), "其它目录");
        await symlink(path.join(root, "other"), path.join(root, "reference", "linked"), process.platform === "win32" ? "junction" : "dir");
        const result = await listInspirationSources(root);
        expect(result.sources.map((source) => source.path)).toEqual(["reference/a.txt", "reference/nested/b.MD"]);
        expect(InspirationSourceListResponseSchema.safeParse(JSON.parse(JSON.stringify(result))).success).toBe(true);
        await expect(prepareInspirationSource(root, "reference/linked/secret.txt")).rejects.toMatchObject({
            statusCode: 400,
            data: {code: "INSPIRATION_SOURCE_LINK"},
        });
    });

    it("来源快照带实际文件 hash、完整映射，准备前后源文件内容与时间不变", async () => {
        const text = "\uFEFF\r\n第一章 雨夜\r\n雨落了。🌧\r\n\r\n第二章 清晨\r\n末章正文";
        const filePath = path.join(root, "reference", "book.txt");
        await writeFile(filePath, text, "utf8");
        const before = await stat(filePath);
        const result = await prepareInspirationSource(root, "reference/book.txt");
        expect(result.source.sha256).toBe(createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"));
        expect(result.source.bytes).toBe(Buffer.byteLength(text, "utf8"));
        expect(result.paragraphs.map((paragraph) => paragraph.text).join("")).toBe(text);
        expect(InspirationSourcePrepareResponseSchema.safeParse(JSON.parse(JSON.stringify(result))).success).toBe(true);
        expect(await readFile(filePath, "utf8")).toBe(text);
        expect((await stat(filePath)).mtimeMs).toBe(before.mtimeMs);
    });

    it.each([
        "../outside.txt", "reference/../outside.txt", "reference/nested/../../outside.txt",
        "reference\\book.txt", "reference//book.txt", "reference/book.txt:stream", "/reference/book.txt",
        "C:/reference/book.txt", "reference/book.pdf", "lorebook/book.txt",
    ])("拒绝未授权来源路径 %s", async (sourcePath) => {
        await expect(prepareInspirationSource(root, sourcePath)).rejects.toMatchObject({statusCode: 400, data: {code: "INSPIRATION_SOURCE_PATH"}});
    });

    it("5 MiB 是读取边界，超限不返回不完整结果", async () => {
        await writeFile(path.join(root, "reference", "large.txt"), Buffer.alloc(INSPIRATION_SOURCE_MAX_BYTES + 1, 65));
        await expect(prepareInspirationSource(root, "reference/large.txt")).rejects.toMatchObject({statusCode: 413, data: {code: "INSPIRATION_SOURCE_TOO_LARGE"}});
    });

    it("拒绝非 UTF-8、二进制和没有正文的文件，错误可恢复", async () => {
        await writeFile(path.join(root, "reference", "gbk.txt"), Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));
        await writeFile(path.join(root, "reference", "binary.txt"), Buffer.from([65, 0, 66]));
        await writeFile(path.join(root, "reference", "empty.md"), "\uFEFF\r\n  \r\n");
        await expect(prepareInspirationSource(root, "reference/gbk.txt")).rejects.toMatchObject({statusCode: 415, data: {code: "INSPIRATION_SOURCE_ENCODING"}});
        await expect(prepareInspirationSource(root, "reference/binary.txt")).rejects.toMatchObject({statusCode: 415});
        await expect(prepareInspirationSource(root, "reference/empty.md")).rejects.toMatchObject({statusCode: 400, data: {code: "INSPIRATION_SOURCE_EMPTY"}});
        await writeFile(path.join(root, "reference", "gbk.txt"), "修正编码后的正文", "utf8");
        expect((await prepareInspirationSource(root, "reference/gbk.txt")).paragraphs[0]?.text).toBe("修正编码后的正文");
    });

    it("不存在 reference 时返回空列表，不存在选中文件时明确报错", async () => {
        const emptyProject = absoluteFsPath(path.join(root, "empty-project"));
        await mkdir(emptyProject);
        expect((await listInspirationSources(emptyProject)).sources).toEqual([]);
        await expect(prepareInspirationSource(root, "reference/missing.txt")).rejects.toMatchObject({statusCode: 404});
    });

    it("reference 本身是目录联接时拒绝访问其目标", async () => {
        const project = absoluteFsPath(path.join(root, "project"));
        await mkdir(project);
        await symlink(path.join(root, "reference"), path.join(project, "reference"), process.platform === "win32" ? "junction" : "dir");
        await expect(listInspirationSources(project)).rejects.toMatchObject({statusCode: 400, data: {code: "INSPIRATION_SOURCE_LINK"}});
    });
});
