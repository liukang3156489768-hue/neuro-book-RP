import {mkdir, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import {absoluteFsPath, type AbsoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {prepareInspirationSource} from "../source";
import {createSourceVerifier} from "./source-guard";

describe("提取来源哈希复核", () => {
    let root: AbsoluteFsPath;
    const cleanup: string[] = [];

    beforeEach(async () => {
        root = absoluteFsPath(await createTestTmpRoot("inspiration-extraction", "source-guard-tests"));
        cleanup.push(root);
        await mkdir(path.join(root, "reference"));
    });

    afterEach(async () => {
        await Promise.all(cleanup.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
    });

    it("内容未变时通过；内容被改写、文件被删除或路径无效时都视为来源变化", async () => {
        const file = path.join(root, "reference", "novel.md");
        await writeFile(file, "第一章\n\n正文。");
        const {source} = await prepareInspirationSource(root, "reference/novel.md");
        const verify = createSourceVerifier(root);

        await expect(verify({path: source.path, sha256: source.sha256})).resolves.toBeUndefined();

        await writeFile(file, "第一章\n\n被修改的正文。");
        await expect(verify({path: source.path, sha256: source.sha256})).rejects.toThrow("内容已变化");

        await rm(file);
        await expect(verify({path: source.path, sha256: source.sha256})).rejects.toBeDefined();
        await expect(verify({path: "../escape.md", sha256: source.sha256})).rejects.toBeDefined();
    });

    it("只信任磁盘内容：调用方给出的哈希与当前文件不符就拒绝", async () => {
        await writeFile(path.join(root, "reference", "novel.md"), "正文");
        await expect(createSourceVerifier(root)({path: "reference/novel.md", sha256: "0".repeat(64)})).rejects.toThrow("内容已变化");
    });
});
