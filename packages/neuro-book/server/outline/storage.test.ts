import fs from "node:fs/promises";
import path from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import {publishPlanningFiles, readPlanningSnapshot} from "./index";
import {createOutlineRepository} from "./repository";
import {readValidFixedLineNodes} from "./line-analysis";
import {
    contentHash,
    createEmptyManifest,
    serializeEntryMarkdown,
    serializeForeshadowingMarkdown,
    serializeGraphYaml,
    serializeLineYaml,
    serializeManifest,
    serializeYaml,
    type Foreshadowing,
    type OutlineEntry,
    type OutlineGraph,
    type OutlineLine,
    type OutlineManifest,
} from "./format";
import {
    hashText,
    publishOutlineFiles,
    readOutlineTransactionJournal,
    recoverOutlineTransactions,
    undoOutlineTransaction,
    type OutlineTransactionOptions,
} from "./transaction";

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

async function createRoot(): Promise<string> {
    const root = await createTestTmpRoot("outline-storage", "outline-phase1-contract");
    roots.push(root);
    return root;
}

function options(projectRoot: string): OutlineTransactionOptions {
    return {projectRoot};
}

describe("outline transaction", () => {
    it("未初始化的 Project 读取规划返回领域错误，不暴露 fs 原始 ENOENT", async () => {
        const projectRoot = await createRoot();
        await expect(readPlanningSnapshot({projectRoot})).rejects.toMatchObject({
            name: "OutlineTransactionError", code: "NOT_INITIALIZED", message: expect.not.stringContaining("ENOENT"),
        });
        await expect(fs.stat(path.join(projectRoot, "outline"))).rejects.toMatchObject({code: "ENOENT"});
    });

    it("拒绝非目录事务根并阻断 staged 状态的规范读取", async () => {
        const first = await createRoot();
        await fs.writeFile(path.join(first, ".nbook"), "not a directory");
        await expect(publishOutlineFiles(options(first), [{relativePath: "outline/manifest.yaml", content: "unsafe"}]))
            .rejects.toMatchObject({code: "INVALID_PATH"});
        const projectRoot = await createRoot();
        const receipt = await publishOutlineFiles(options(projectRoot), [
            {relativePath: "outline/manifest.yaml", content: "initial"},
        ]);
        const journal = await readOutlineTransactionJournal(projectRoot, receipt.transactionId);
        await fs.writeFile(receipt.journalPath, JSON.stringify({...journal, status: "staged"}));
        await expect(createOutlineRepository(options(projectRoot)).readCanonicalFiles())
            .rejects.toMatchObject({code: "PENDING_TRANSACTION"});
    });

    it("rejects a stale Project generation before publishing", async () => {
        const projectRoot = await createRoot();
        await expect(publishOutlineFiles({projectRoot, projectGeneration: "old", readProjectGeneration: () => "new"}, [
            {relativePath: "outline/manifest.yaml", content: "manifest"},
        ])).rejects.toMatchObject({code: "PROJECT_GENERATION_CONFLICT"});
        await expect(fs.readFile(path.join(projectRoot, "outline/manifest.yaml"))).rejects.toMatchObject({code: "ENOENT"});
    });

    it("rolls back when Project generation changes during the final file publish", async () => {
        const projectRoot = await createRoot();
        let generation = "one";
        await expect(publishOutlineFiles({
            projectRoot,
            projectGeneration: "one",
            readProjectGeneration: () => generation,
            beforePublishFile: () => {generation = "two";},
        }, [{relativePath: "outline/manifest.yaml", content: "new"}])).rejects.toMatchObject({code: "PROJECT_GENERATION_CONFLICT"});
        await expect(fs.readFile(path.join(projectRoot, "outline/manifest.yaml"))).rejects.toMatchObject({code: "ENOENT"});
    });

    it("rejects snapshots while a batch is publishing", async () => {
        const projectRoot = await createRoot();
        await publishOutlineFiles(options(projectRoot), [{relativePath: "outline/manifest.yaml", content: "before"}]);
        let release!: () => void;
        let started!: () => void;
        const paused = new Promise<void>((resolve) => {release = resolve;});
        const entered = new Promise<void>((resolve) => {started = resolve;});
        const publishing = publishOutlineFiles({...options(projectRoot), beforePublishFile: async () => {
            started();
            await paused;
        }}, [{relativePath: "outline/manifest.yaml", content: "after"}]);
        try {
            await entered;
            await expect(createOutlineRepository(options(projectRoot)).readCanonicalFiles()).rejects.toMatchObject({code: "PENDING_TRANSACTION"});
        } finally {
            release();
            await publishing;
        }
        expect((await createOutlineRepository(options(projectRoot)).readCanonicalFiles())[0]?.content).toBe("after");
    });

    it("rejects a concurrent change without overwriting it", async () => {
        const projectRoot = await createRoot();
        const target = path.join(projectRoot, "outline/manifest.yaml");
        await publishOutlineFiles(options(projectRoot), [{relativePath: "outline/manifest.yaml", content: "before"}]);
        await expect(publishOutlineFiles({...options(projectRoot), beforePublishFile: async () => {
            await fs.writeFile(target, "external", "utf8");
        }}, [{relativePath: "outline/manifest.yaml", content: "after"}])).rejects.toMatchObject({code: "CAS_CONFLICT"});
        expect(await fs.readFile(target, "utf8")).toBe("external");
    });

    it("keeps an existing canonical file readable after a later file fails", async () => {
        const projectRoot = await createRoot();
        const entry = "outline/entries/total--ol-001.md";
        await publishOutlineFiles(options(projectRoot), [{relativePath: entry, content: "original"}]);
        await expect(publishOutlineFiles({...options(projectRoot), beforePublishFile: (relativePath) => {
            if (relativePath === "outline/manifest.yaml") throw new Error("injected failure");
        }}, [
            {relativePath: entry, content: "replacement"},
            {relativePath: "outline/manifest.yaml", content: "next"},
        ])).rejects.toMatchObject({code: "PUBLISH_FAILED"});
        expect(await fs.readFile(path.join(projectRoot, entry), "utf8")).toBe("original");
        expect((await recoverOutlineTransactions(projectRoot)).recovered).toHaveLength(1);
        expect(await fs.readFile(path.join(projectRoot, entry), "utf8")).toBe("original");
    });

    it("does not claim recovery when an external edit conflicts with a partially published batch", async () => {
        const projectRoot = await createRoot();
        await expect(publishOutlineFiles({...options(projectRoot), beforePublishFile: async (relativePath) => {
            if (relativePath === "outline/manifest.yaml") {
                await fs.writeFile(path.join(projectRoot, "outline/entries/total--ol-001.md"), "external");
                throw new Error("injected failure");
            }
        }}, [
            {relativePath: "outline/entries/total--ol-001.md", content: "entry"},
            {relativePath: "outline/manifest.yaml", content: "manifest"},
        ])).rejects.toMatchObject({code: "PUBLISH_FAILED"});
        const transactionIds = await fs.readdir(path.join(projectRoot, ".nbook/outline-transactions"));
        expect(await fs.readFile(path.join(projectRoot, "outline/entries/total--ol-001.md"), "utf8")).toBe("external");
        expect(await recoverOutlineTransactions(projectRoot)).toMatchObject({recovered: [], skipped: transactionIds});
        await expect(createOutlineRepository(options(projectRoot)).readCanonicalFiles()).rejects.toMatchObject({code: "PENDING_TRANSACTION"});
        expect(await readOutlineTransactionJournal(projectRoot, transactionIds[0]!)).not.toMatchObject({status: "recovered"});
    });

    it("recovers an interrupted multi-file undo without exposing partial state", async () => {
        const projectRoot = await createRoot();
        const entry = "outline/entries/total--ol-001.md";
        await publishOutlineFiles(options(projectRoot), [{relativePath: entry, content: "before"}]);
        const receipt = await publishOutlineFiles(options(projectRoot), [
            {relativePath: entry, content: "after"},
            {relativePath: "outline/manifest.yaml", content: "new"},
        ]);
        await expect(undoOutlineTransaction({...options(projectRoot), beforeUndoFile: (relativePath) => {
            if (relativePath === entry) throw new Error("injected undo failure");
        }}, receipt.transactionId)).rejects.toMatchObject({code: "PUBLISH_FAILED"});
        await expect(createOutlineRepository(options(projectRoot)).readCanonicalFiles()).rejects.toMatchObject({code: "PENDING_TRANSACTION"});
        expect(await fs.readFile(path.join(projectRoot, entry), "utf8")).toBe("after");
        await expect(fs.readFile(path.join(projectRoot, "outline/manifest.yaml"))).rejects.toMatchObject({code: "ENOENT"});
        expect(await recoverOutlineTransactions(projectRoot)).toMatchObject({recovered: [receipt.transactionId]});
        expect(await fs.readFile(path.join(projectRoot, entry), "utf8")).toBe("after");
        expect(await fs.readFile(path.join(projectRoot, "outline/manifest.yaml"), "utf8")).toBe("new");
        await expect(readOutlineTransactionJournal(projectRoot, receipt.transactionId)).resolves.toMatchObject({status: "committed"});
        await expect(undoOutlineTransaction(options(projectRoot), receipt.transactionId)).resolves.toMatchObject({kind: "undone"});
        expect(await fs.readFile(path.join(projectRoot, entry), "utf8")).toBe("before");
    });

    it("leaves an interrupted undo pending when an external edit conflicts with recovery", async () => {
        const projectRoot = await createRoot();
        const receipt = await publishOutlineFiles(options(projectRoot), [
            {relativePath: "outline/entries/total--ol-001.md", content: "after"},
            {relativePath: "outline/manifest.yaml", content: "new"},
        ]);
        await expect(undoOutlineTransaction({...options(projectRoot), beforeUndoFile: async (relativePath) => {
            if (relativePath === "outline/entries/total--ol-001.md") {
                await fs.writeFile(path.join(projectRoot, "outline/manifest.yaml"), "external");
                throw new Error("injected undo failure");
            }
        }}, receipt.transactionId)).rejects.toMatchObject({code: "PUBLISH_FAILED"});
        expect(await recoverOutlineTransactions(projectRoot)).toMatchObject({recovered: [], skipped: [receipt.transactionId]});
        expect(await fs.readFile(path.join(projectRoot, "outline/manifest.yaml"), "utf8")).toBe("external");
        await expect(readOutlineTransactionJournal(projectRoot, receipt.transactionId)).resolves.toMatchObject({status: "undoing"});
    });

    it("按稳定路径发布多个文件并以 CAS 撤销", async () => {
        const projectRoot = await createRoot();
        const first = await publishOutlineFiles(options(projectRoot), [
            {relativePath: "outline/entries/total--ol-001.md", content: "total"},
            {relativePath: "outline/manifest.yaml", content: "revision: 1\n"},
        ]);
        expect(first.files).toEqual(["outline/entries/total--ol-001.md", "outline/manifest.yaml"]);
        expect(await fs.readFile(path.join(projectRoot, "outline/manifest.yaml"), "utf8")).toBe("revision: 1\n");

        const second = await publishOutlineFiles(options(projectRoot), [{
            relativePath: "outline/manifest.yaml",
            content: "revision: 2\n",
            expectedHash: hashText("revision: 1\n"),
        }]);
        await expect(fs.readFile(path.join(projectRoot, "outline/manifest.yaml"), "utf8")).resolves.toBe("revision: 2\n");
        await expect(undoOutlineTransaction(options(projectRoot), second.transactionId)).resolves.toEqual({
            kind: "undone",
            transactionId: second.transactionId,
            files: ["outline/manifest.yaml"],
        });
        await expect(fs.readFile(path.join(projectRoot, "outline/manifest.yaml"), "utf8")).resolves.toBe("revision: 1\n");
        await expect(readOutlineTransactionJournal(projectRoot, second.transactionId)).resolves.toMatchObject({status: "undone"});
    });

    it("发现外部后续修改时把撤销降级为冲突预览", async () => {
        const projectRoot = await createRoot();
        const first = await publishOutlineFiles(options(projectRoot), [{
            relativePath: "outline/manifest.yaml",
            content: "revision: 1\n",
        }]);
        await fs.writeFile(path.join(projectRoot, "outline/manifest.yaml"), "revision: external\n");
        await expect(undoOutlineTransaction(options(projectRoot), first.transactionId)).resolves.toMatchObject({
            kind: "conflict",
            transactionId: first.transactionId,
            conflicts: [{relativePath: "outline/manifest.yaml", expectedHash: hashText("revision: 1\n")}],
        });
    });

    it("拒绝越界路径与过期文件版本", async () => {
        const projectRoot = await createRoot();
        await expect(publishOutlineFiles(options(projectRoot), [{
            relativePath: "outline/../secret.txt",
            content: "no",
        }])).rejects.toMatchObject({code: "INVALID_PATH"});
        await publishOutlineFiles(options(projectRoot), [{relativePath: "outline/manifest.yaml", content: "revision: 1\n"}]);
        await expect(publishOutlineFiles(options(projectRoot), [{
            relativePath: "outline/manifest.yaml",
            content: "revision: 2\n",
            expectedHash: hashText("stale\n"),
        }])).rejects.toMatchObject({code: "CAS_CONFLICT"});
    });

    it("restores a partially published batch and keeps a recovery journal", async () => {
        const projectRoot = await createRoot();
        let publishCount = 0;
        await expect(publishOutlineFiles({...options(projectRoot), beforePublishFile: () => {
            publishCount += 1;
            if (publishCount === 2) throw new Error("injected publish failure");
        }}, [
            {relativePath: "outline/entries/total--ol-001.md", content: "entry"},
            {relativePath: "outline/manifest.yaml", content: "revision: 1\n"},
        ])).rejects.toMatchObject({code: "PUBLISH_FAILED"});
        await expect(fs.readFile(path.join(projectRoot, "outline", "entries", "total--ol-001.md"), "utf8")).rejects.toMatchObject({code: "ENOENT"});
        const transactionRoot = path.join(projectRoot, ".nbook", "outline-transactions");
        const transactionIds = await fs.readdir(transactionRoot);
        expect(transactionIds).toHaveLength(1);
        await expect(readOutlineTransactionJournal(projectRoot, transactionIds[0]!)).resolves.toMatchObject({status: "failed"});
        await expect(recoverOutlineTransactions(projectRoot)).resolves.toMatchObject({recovered: transactionIds});
        await expect(readOutlineTransactionJournal(projectRoot, transactionIds[0]!)).resolves.toMatchObject({status: "recovered"});
    });

    it("checks manifest revision before publishing a planning batch", async () => {
        const projectRoot = await createRoot();
        const initial = createEmptyManifest();
        const next = {...initial, revision: 1};
        await createOutlineRepository(options(projectRoot)).ensureLayout(serializeManifest(initial));
        await publishPlanningFiles(options(projectRoot), {
            expectedManifestRevision: 0,
            mutations: [{relativePath: "outline/manifest.yaml", content: serializeManifest(next)}],
        });
        await expect(publishPlanningFiles(options(projectRoot), {
            expectedManifestRevision: 0,
            mutations: [{relativePath: "outline/manifest.yaml", content: serializeManifest({...next, revision: 2})}],
        })).rejects.toMatchObject({code: "MANIFEST_REVISION_CONFLICT"});
    });
});

describe("outline journal integrity and reopened recovery", () => {
    it("rejects invalid transaction identities before looking up a journal", async () => {
        const projectRoot = await createRoot();
        await expect(undoOutlineTransaction(options(projectRoot), "../foreign"))
            .rejects.toMatchObject({code: "INVALID_PATH"});
    });

    it("fails closed for an unknown journal state or a backup path outside its transaction", async () => {
        const projectRoot = await createRoot();
        const receipt = await publishOutlineFiles(options(projectRoot), [
            {relativePath: "outline/manifest.yaml", content: "revision: 1\n"},
        ]);
        const original = JSON.parse(await fs.readFile(receipt.journalPath, "utf8"));
        for (const patch of [
            {status: "unknown"},
            {files: [{...original.files[0], backupPath: "../../foreign"}]},
            {transactionId: "00000000-0000-4000-8000-000000000000"},
        ]) {
            await fs.writeFile(receipt.journalPath, JSON.stringify({...original, ...patch}));
            await expect(createOutlineRepository(options(projectRoot)).readCanonicalFiles())
                .rejects.toMatchObject({code: "CORRUPT_JOURNAL"});
        }
        expect(await fs.readFile(path.join(projectRoot, "outline/manifest.yaml"), "utf8"))
            .toBe("revision: 1\n");
    });

    it("restores an interrupted undo after reopening and permits a CAS retry", async () => {
        const projectRoot = await createRoot();
        const receipt = await publishOutlineFiles(options(projectRoot), [
            {relativePath: "outline/entries/total--ol-001.md", content: "entry"},
            {relativePath: "outline/manifest.yaml", content: "revision: 1\n"},
        ]);
        await expect(undoOutlineTransaction({...options(projectRoot), beforeUndoFile: (relativePath) => {
            if (relativePath === "outline/entries/total--ol-001.md") throw new Error("interrupted");
        }}, receipt.transactionId)).rejects.toMatchObject({code: "PUBLISH_FAILED"});
        const reopened = createOutlineRepository(options(projectRoot));
        await expect(reopened.readCanonicalFiles()).rejects.toMatchObject({code: "PENDING_TRANSACTION"});
        await expect(recoverOutlineTransactions(projectRoot)).resolves.toMatchObject({recovered: [receipt.transactionId]});
        expect((await reopened.readCanonicalFiles()).map((file) => file.relativePath)).toEqual(receipt.files);
        await expect(undoOutlineTransaction(options(projectRoot), receipt.transactionId))
            .resolves.toMatchObject({kind: "undone"});
        await expect(fs.readFile(path.join(projectRoot, "outline/manifest.yaml"))).rejects.toMatchObject({code: "ENOENT"});
    });
});

describe("planning candidate validation and object deletion", () => {
    it("不提交方案引用层级错误的规范文件批次", async () => {
        const projectRoot = await createRoot();
        const initial = createEmptyManifest();
        await createOutlineRepository(options(projectRoot)).ensureLayout(serializeManifest(initial));
        const entries = [
            {id: "ol-total" as const, kind: "total" as const, parentId: null, chapterId: null, title: "总纲"},
            {id: "ol-chapter" as const, kind: "chapter" as const, parentId: "ol-total" as const, chapterId: null, title: "章节"},
            {id: "ol-detail" as const, kind: "detail" as const, parentId: "ol-chapter" as const, chapterId: "ol-chapter" as const, title: "细纲"},
        ].map((item) => {
            const content = serializeEntryMarkdown({...item, schema: "nbook.outline-entry/v1" as const, version: 0, status: "draft" as const, body: ""});
            return {id: item.id, path: "outline/entries/" + item.id + "--" + item.id + ".md", content};
        });
        const manifest = serializeManifest({...initial, revision: 1, totalId: "ol-total" as const,
            plans: [{id: "plan-a", title: "方案", placements: [
                {entryId: "ol-total" as const, parentId: null, position: 0},
                {entryId: "ol-chapter" as const, parentId: "ol-total" as const, position: 1},
                {entryId: "ol-detail" as const, parentId: "ol-total" as const, position: 2},
            ]}],
            entries: entries.map((entry) => ({id: entry.id, path: entry.path, version: 0, contentHash: contentHash(entry.content)})),
        });
        await expect(publishPlanningFiles(options(projectRoot), {expectedManifestRevision: 0, mutations: [
            ...entries.map((entry) => ({relativePath: entry.path, content: entry.content})),
            {relativePath: "outline/manifest.yaml", content: manifest},
        ]})).rejects.toThrow(/父级类型/);
        expect((await readPlanningSnapshot(options(projectRoot))).manifest.revision).toBe(0);
        for (const entry of entries) await expect(fs.readFile(path.join(projectRoot, entry.path))).rejects.toMatchObject({code: "ENOENT"});
    });
    it("rejects a malformed candidate before writing any canonical file", async () => {
        const projectRoot = await createRoot();
        const manifest = createEmptyManifest();
        await createOutlineRepository(options(projectRoot)).ensureLayout(serializeManifest(manifest));
        const objectPath = "outline/entries/broken--ol-001.md";
        await expect(publishPlanningFiles(options(projectRoot), {
            expectedManifestRevision: 0,
            mutations: [
                {relativePath: objectPath, content: "not front matter"},
                {relativePath: "outline/manifest.yaml", content: serializeManifest({
                    ...manifest, revision: 1, totalId: "ol-001",
                    entries: [{id: "ol-001", path: objectPath, version: 0, contentHash: contentHash("not front matter")}],
                })},
            ],
        })).rejects.toThrow(/front matter/);
        expect((await readPlanningSnapshot(options(projectRoot))).manifest.revision).toBe(0);
        await expect(fs.readFile(path.join(projectRoot, objectPath))).rejects.toMatchObject({code: "ENOENT"});
    });

    it("deletes an unreferenced object without deleting its relations implicitly and restores it on undo", async () => {
        const projectRoot = await createRoot();
        const manifest = createEmptyManifest();
        await createOutlineRepository(options(projectRoot)).ensureLayout(serializeManifest(manifest));
        const objectPath = "outline/foreshadowing/clue--fo-001.md";
        const content = serializeForeshadowingMarkdown({
            schema: "nbook.outline-foreshadowing/v1", id: "fo-001", version: 0, status: "draft",
            title: "Clue", body: "First clue\n",
        });
        const first: OutlineManifest = {...manifest, revision: 1, foreshadowing: [
            {id: "fo-001", path: objectPath, version: 0, contentHash: contentHash(content)},
        ]};
        await publishPlanningFiles(options(projectRoot), {
            expectedManifestRevision: 0,
            mutations: [{relativePath: objectPath, content},
                {relativePath: "outline/manifest.yaml", content: serializeManifest(first)}],
        });
        await expect(publishPlanningFiles(options(projectRoot), {
            expectedManifestRevision: 1,
            mutations: [{relativePath: objectPath, content: null},
                {relativePath: "outline/manifest.yaml", content: serializeManifest({...first, revision: 2})}],
        })).rejects.toThrow(/不存在|数量不一致|元数据/);
        const receipt = await publishPlanningFiles(options(projectRoot), {
            expectedManifestRevision: 1,
            mutations: [{relativePath: objectPath, content: null},
                {relativePath: "outline/manifest.yaml", content: serializeManifest({...first, revision: 2, foreshadowing: []})}],
        });
        expect((await readPlanningSnapshot(options(projectRoot))).foreshadowing).toEqual([]);
        await expect(fs.readFile(path.join(projectRoot, objectPath))).rejects.toMatchObject({code: "ENOENT"});
        await expect(undoOutlineTransaction(options(projectRoot), receipt.transactionId))
            .resolves.toMatchObject({kind: "undone"});
        expect((await readPlanningSnapshot(options(projectRoot))).foreshadowing[0]?.value.id).toBe("fo-001");
    });
});

describe("outline transaction artifact containment", () => {
    it("rejects a backup directory link before undo reads it", async () => {
        const projectRoot = await createRoot();
        const relativePath = "outline/manifest.yaml";
        await publishOutlineFiles(options(projectRoot), [{relativePath, content: "before"}]);
        const receipt = await publishOutlineFiles(options(projectRoot), [{relativePath, content: "after"}]);
        const backup = path.join(path.dirname(receipt.journalPath), "backup");
        const external = await createRoot();
        await fs.rename(backup, path.join(external, "backup"));
        await fs.symlink(path.join(external, "backup"), backup, process.platform === "win32" ? "junction" : "dir");
        await expect(undoOutlineTransaction(options(projectRoot), receipt.transactionId))
            .rejects.toMatchObject({code: "CORRUPT_JOURNAL"});
        expect(await fs.readFile(path.join(projectRoot, relativePath), "utf8")).toBe("after");
    });
});
describe("deletion failure and journal safety", () => {
    it("restores an already deleted object when a later manifest publish fails", async () => {
        const projectRoot = await createRoot();
        const objectPath = "outline/foreshadowing/clue--fo-001.md";
        await publishOutlineFiles(options(projectRoot), [
            {relativePath: objectPath, content: "original"},
            {relativePath: "outline/manifest.yaml", content: "before"},
        ]);
        await expect(publishOutlineFiles({...options(projectRoot), beforePublishFile: (relativePath) => {
            if (relativePath === "outline/manifest.yaml") throw new Error("injected failure");
        }}, [
            {relativePath: objectPath, content: null},
            {relativePath: "outline/manifest.yaml", content: "after"},
        ])).rejects.toMatchObject({code: "PUBLISH_FAILED"});
        expect(await fs.readFile(path.join(projectRoot, objectPath), "utf8")).toBe("original");
        expect(await fs.readFile(path.join(projectRoot, "outline/manifest.yaml"), "utf8")).toBe("before");
    });

    it("restores an interrupted undo of deletion before a retry", async () => {
        const projectRoot = await createRoot();
        const objectPath = "outline/foreshadowing/clue--fo-001.md";
        await publishOutlineFiles(options(projectRoot), [
            {relativePath: objectPath, content: "original"},
            {relativePath: "outline/manifest.yaml", content: "before"},
        ]);
        const receipt = await publishOutlineFiles(options(projectRoot), [
            {relativePath: objectPath, content: null},
            {relativePath: "outline/manifest.yaml", content: "after"},
        ]);
        await expect(undoOutlineTransaction({...options(projectRoot), beforeUndoFile: (relativePath) => {
            if (relativePath === "outline/manifest.yaml") throw new Error("interrupted undo");
        }}, receipt.transactionId)).rejects.toMatchObject({code: "PUBLISH_FAILED"});
        await expect(createOutlineRepository(options(projectRoot)).readCanonicalFiles()).rejects.toMatchObject({code: "PENDING_TRANSACTION"});
        await expect(recoverOutlineTransactions(projectRoot)).resolves.toMatchObject({recovered: [receipt.transactionId]});
        await expect(fs.readFile(path.join(projectRoot, objectPath))).rejects.toMatchObject({code: "ENOENT"});
        await expect(undoOutlineTransaction(options(projectRoot), receipt.transactionId)).resolves.toMatchObject({kind: "undone"});
        expect(await fs.readFile(path.join(projectRoot, objectPath), "utf8")).toBe("original");
    });

    it("rejects invalid transaction IDs and journal-less transaction directories", async () => {
        const projectRoot = await createRoot();
        await expect(readOutlineTransactionJournal(projectRoot, "../../outside")).rejects.toMatchObject({code: "INVALID_PATH"});
        const abandoned = path.join(projectRoot, ".nbook", "outline-transactions", "abandoned");
        await fs.mkdir(abandoned, {recursive: true});
        await expect(createOutlineRepository(options(projectRoot)).readCanonicalFiles()).rejects.toMatchObject({code: "PENDING_TRANSACTION"});
    });
});
describe("outline repository", () => {
    it("从规范文件重建索引且删除预览不隐式删除共享对象", async () => {
        const projectRoot = await createRoot();
        const repository = createOutlineRepository(options(projectRoot));
        await repository.ensureLayout("schema: nbook.outline/v2\nrevision: 1\n");
        await repository.publish([
            {relativePath: "outline/entries/total--ol-001.md", content: "id: ol-001\n"},
            {relativePath: "outline/graphs/plan--gr-001.yaml", content: "id: gr-001\n"},
            {relativePath: "outline/storylines/main--ln-001.yaml", content: "id: ln-001\n"},
            // 旧版线路目录不再是规范来源：文件留在磁盘，但不进入索引。
            {relativePath: "outline/lines/main--ln-legacy.yaml", content: "nodes: []\n"},
        ]);
        const index: Array<unknown> = [];
        const snapshot = await repository.rebuildIndex(
            ({relativePath, content}) => ({id: content.match(/id: ([^\n]+)/)?.[1], relativePath}),
            {replace: (next) => { index.push(...next); }},
        );
        expect(snapshot.map((item) => item.file.relativePath)).toEqual([
            "outline/entries/total--ol-001.md",
            "outline/graphs/plan--gr-001.yaml",
            "outline/manifest.yaml",
            "outline/storylines/main--ln-001.yaml",
        ]);
        expect(index).toHaveLength(4);
        await expect(fs.readFile(path.join(projectRoot, "outline/lines/main--ln-legacy.yaml"), "utf8")).resolves.toBe("nodes: []\n");
        await expect(repository.previewObjectDeletion({
            targetId: "ol-001",
            parser: ({relativePath, content}) => ({id: content.match(/id: ([^\n]+)/)?.[1], relativePath}),
            getDocumentId: (document) => document.id,
            getReferences: () => [],
        })).resolves.toMatchObject({objectFile: "outline/entries/total--ol-001.md", canDeleteObject: true});
    });

    it("reads a complete planning snapshot and rejects stale canonical hashes", async () => {
        const projectRoot = await createRoot();
        const entry: OutlineEntry = {
            schema: "nbook.outline-entry/v1",
            id: "ol-total-001",
            kind: "total",
            version: 0,
            status: "draft",
            title: "Total",
            parentId: null,
            chapterId: null,
            body: "Total body\n",
            materialRefs: ["lorebook/人物/阿青.md"],
            writingGuidance: "叙述节制",
            references: [{path: "research/背景/雨夜.md"}],
            targetWords: 2400,
        };
        const foreshadowing: Foreshadowing = {
            schema: "nbook.outline-foreshadowing/v1",
            id: "fo-001",
            version: 0,
            status: "draft",
            title: "Clue",
            body: "Clue body\n",
        };
        const graph: OutlineGraph = {
            schema: "nbook.outline-graph/v1",
            id: "gr-main-001",
            planId: "plan-a",
            version: 1,
            nodes: [{id: "nd-001", entryId: entry.id, column: 0, row: 2}, {id: "nd-002", entryId: null, column: 1, row: 0}],
            edges: [{id: "eg-001", from: "nd-001", to: "nd-002"}],
        };
        const line: OutlineLine = {
            schema: "nbook.outline-line/v3",
            id: "ln-main-001",
            planId: "plan-a",
            version: 0,
            title: "Main",
            type: "main",
            fixed: false,
            nodeIds: ["nd-001", "nd-002"],
        };
        const entryPath = "outline/entries/total--ol-total-001.md";
        const foreshadowingPath = "outline/foreshadowing/clue--fo-001.md";
        const graphPath = "outline/graphs/plan--gr-main-001.yaml";
        const linePath = "outline/storylines/main--ln-main-001.yaml";
        const entryContent = serializeEntryMarkdown(entry);
        const foreshadowingContent = serializeForeshadowingMarkdown(foreshadowing);
        const graphContent = serializeGraphYaml(graph);
        const lineContent = serializeLineYaml(line);
        const manifest = {
            ...createEmptyManifest(),
            revision: 1,
            totalId: entry.id,
            plans: [{id: "plan-a", title: "方案", placements: [{entryId: entry.id, parentId: null, position: 0}]}],
            entries: [{id: entry.id, path: entryPath, version: entry.version, contentHash: contentHash(entryContent)}],
            foreshadowing: [{id: foreshadowing.id, path: foreshadowingPath, version: foreshadowing.version, contentHash: contentHash(foreshadowingContent)}],
            graphs: [{id: graph.id, path: graphPath, version: graph.version, contentHash: contentHash(graphContent)}],
            lines: [{id: line.id, path: linePath, version: line.version, contentHash: contentHash(lineContent)}],
        };
        await publishOutlineFiles(options(projectRoot), [
            {relativePath: entryPath, content: entryContent},
            {relativePath: foreshadowingPath, content: foreshadowingContent},
            {relativePath: graphPath, content: graphContent},
            {relativePath: linePath, content: lineContent},
            {relativePath: "outline/manifest.yaml", content: serializeManifest(manifest)},
        ]);
        await expect(readPlanningSnapshot(options(projectRoot))).resolves.toMatchObject({
            manifest: {schema: "nbook.outline/v2", revision: 1, totalId: entry.id},
            entries: [{value: {id: entry.id, materialRefs: entry.materialRefs, writingGuidance: entry.writingGuidance,
                references: entry.references, targetWords: entry.targetWords}, markers: []}],
            foreshadowing: [{value: {id: foreshadowing.id}}],
            graphs: [{path: graphPath, value: graph}],
            lines: [{path: linePath, value: line}],
        });
        await fs.writeFile(path.join(projectRoot, entryPath), serializeEntryMarkdown({...entry, body: "externally changed\n"}), "utf8");
        await expect(readPlanningSnapshot(options(projectRoot))).rejects.toThrow(/hash/);
    });
});

    it("v1 manifest 的旧版固定线路读取时被丢弃，旧文件保留在磁盘且不作为正文固定节点", async () => {
        const projectRoot = await createRoot();
        const total: OutlineEntry = {schema: "nbook.outline-entry/v1", id: "ol-total-old", kind: "total", version: 0,
            status: "adopted", title: "总纲", parentId: null, chapterId: null, body: ""};
        const entries: OutlineEntry[] = [total, ...["a", "b"].map((suffix) => ({...total,
            id: `ol-${suffix}`, kind: "chapter" as const, title: `章节 ${suffix}`, parentId: total.id}))];
        const entryFiles = entries.map((value) => ({path: `outline/entries/${value.id}.md`, content: serializeEntryMarkdown(value), value}));
        // 旧格式线路自带节点与连线；新合同不再解析它，因此直接以 YAML 写出历史字节。
        const lineContent = serializeYaml({schema: "nbook.outline-line/v1", id: "ln-old-fork", version: 0,
            title: "旧版分叉主线", type: "main", fixed: true,
            nodes: entries.map((entry, sequence) => ({id: `nd-${sequence}`, entryId: entry.id, sequence})),
            edges: [{id: "nd-a", from: "nd-0", to: "nd-1"}, {id: "nd-b", from: "nd-0", to: "nd-2"}]});
        const linePath = "outline/lines/ln-old-fork.yaml";
        const manifestContent = serializeYaml({schema: "nbook.outline/v1", revision: 1, totalId: total.id, plans: [],
            entries: entryFiles.map(({value, path: filePath, content}) => ({id: value.id, path: filePath,
                version: value.version, contentHash: contentHash(content)})),
            foreshadowing: [],
            lines: [{id: "ln-old-fork", path: linePath, version: 0, contentHash: contentHash(lineContent)}]});
        await publishOutlineFiles(options(projectRoot), [
            ...entryFiles.map(({path: filePath, content}) => ({relativePath: filePath, content})),
            {relativePath: linePath, content: lineContent},
            {relativePath: "outline/manifest.yaml", content: manifestContent},
        ]);
        for (let i = 0; i < 2; i++) {
            const snapshot = await readPlanningSnapshot(options(projectRoot));
            expect(snapshot.manifest).toMatchObject({schema: "nbook.outline/v2", graphs: [], lines: []});
            expect(snapshot.graphs).toEqual([]);
            expect(snapshot.lines).toEqual([]);
            expect(() => readValidFixedLineNodes(snapshot, "ln-old-fork")).toThrow(/不存在/);
        }
        expect(await fs.readFile(path.join(projectRoot, linePath), "utf8")).toBe(lineContent);
        expect(await fs.readFile(path.join(projectRoot, "outline/manifest.yaml"), "utf8")).toBe(manifestContent);
    });
describe("线路方案身份的规范快照校验", () => {
    it("从 YAML 恢复两个方案的线路图与主线，拒绝缺失方案与跨方案节点且保留原文件", async () => {
        const projectRoot = await createRoot();
        const total: OutlineEntry = {schema: "nbook.outline-entry/v1", id: "ol-total", kind: "total", version: 0,
            status: "draft", title: "总纲", parentId: null, chapterId: null, body: ""};
        const a: OutlineEntry = {...total, id: "ol-a", kind: "chapter", parentId: total.id, title: "甲章"};
        const b: OutlineEntry = {...total, id: "ol-b", kind: "chapter", parentId: total.id, title: "乙章"};
        const entries = [total, a, b];
        const entryFiles = entries.map((entry) => ({path: `outline/entries/${entry.id}.md`, content: serializeEntryMarkdown(entry), value: entry}));
        const graphs: OutlineGraph[] = [
            {schema: "nbook.outline-graph/v1", id: "gr-a", planId: "plan-a", version: 1,
                nodes: [{id: "nd-a", entryId: a.id, column: 0, row: 0}], edges: []},
            {schema: "nbook.outline-graph/v1", id: "gr-b", planId: "plan-b", version: 1,
                nodes: [{id: "nd-b", entryId: b.id, column: 0, row: 0}], edges: []},
        ];
        const graphFiles = graphs.map((graph) => ({path: `outline/graphs/${graph.id}.yaml`, content: serializeGraphYaml(graph), value: graph}));
        const lineA: OutlineLine = {schema: "nbook.outline-line/v3", id: "ln-a", planId: "plan-a", version: 0,
            title: "甲主线", type: "main", fixed: false, nodeIds: ["nd-a"]};
        const lineB: OutlineLine = {...lineA, id: "ln-b", planId: "plan-b", nodeIds: ["nd-b"]};
        const lineFiles = [lineA, lineB].map((line) => ({path: `outline/storylines/${line.id}.yaml`, content: serializeLineYaml(line), value: line}));
        const manifest: OutlineManifest = {...createEmptyManifest(), revision: 1, totalId: total.id,
            plans: [
                {id: "plan-a", title: "甲", placements: [{entryId: total.id, parentId: null, position: 0}, {entryId: a.id, parentId: total.id, position: 1}]},
                {id: "plan-b", title: "乙", placements: [{entryId: total.id, parentId: null, position: 0}, {entryId: b.id, parentId: total.id, position: 1}]},
            ],
            entries: entryFiles.map(({path, content, value}) => ({id: value.id, path, version: value.version, contentHash: contentHash(content)})),
            graphs: graphFiles.map(({path, content, value}) => ({id: value.id, path, version: value.version, contentHash: contentHash(content)})),
            lines: lineFiles.map(({path, content, value}) => ({id: value.id, path, version: value.version, contentHash: contentHash(content)})),
        };
        await publishOutlineFiles(options(projectRoot), [
            ...entryFiles.map(({path, content}) => ({relativePath: path, content})),
            ...graphFiles.map(({path, content}) => ({relativePath: path, content})),
            ...lineFiles.map(({path, content}) => ({relativePath: path, content})),
            {relativePath: "outline/manifest.yaml", content: serializeManifest(manifest)},
        ]);
        await expect(readPlanningSnapshot(options(projectRoot))).resolves.toMatchObject({
            graphs: [{value: {planId: "plan-a"}}, {value: {planId: "plan-b"}}],
            lines: [{value: {planId: "plan-a"}}, {value: {planId: "plan-b"}}],
        });
        const originalManifest = await fs.readFile(path.join(projectRoot, "outline/manifest.yaml"), "utf8");
        const lineCandidates = [
            {...lineA, planId: "absent"},
            {...lineA, nodeIds: ["nd-b" as const]},
        ].map((invalid) => {
            const content = serializeLineYaml({...invalid, version: 1});
            return {path: lineFiles[0]!.path, content, manifest: {...manifest, revision: 2,
                lines: [{...manifest.lines[0]!, version: 1, contentHash: contentHash(content)}, manifest.lines[1]!]}};
        });
        const graphCandidates = [
            {...graphs[0]!, planId: "absent"},
            {...graphs[0]!, nodes: [{...graphs[0]!.nodes[0]!, entryId: b.id}]},
            {...graphs[0]!, planId: "plan-b"},
        ].map((invalid) => {
            const content = serializeGraphYaml({...invalid, version: 2});
            return {path: graphFiles[0]!.path, content, manifest: {...manifest, revision: 2,
                graphs: [{...manifest.graphs[0]!, version: 2, contentHash: contentHash(content)}, manifest.graphs[1]!]}};
        });
        for (const candidate of [...lineCandidates, ...graphCandidates]) {
            await expect(publishPlanningFiles(options(projectRoot), {expectedManifestRevision: 1, mutations: [
                {relativePath: candidate.path, content: candidate.content},
                {relativePath: "outline/manifest.yaml", content: serializeManifest(candidate.manifest)},
            ]})).rejects.toThrow(/方案不存在|不属于所属方案|不在所属方案|只能有一张线路图/);
            expect(await fs.readFile(path.join(projectRoot, "outline/manifest.yaml"), "utf8")).toBe(originalManifest);
            expect(await fs.readFile(path.join(projectRoot, lineFiles[0]!.path), "utf8")).toBe(lineFiles[0]!.content);
            expect(await fs.readFile(path.join(projectRoot, graphFiles[0]!.path), "utf8")).toBe(graphFiles[0]!.content);
        }
    });
});

describe("planning object version and external edit conflict", () => {
    it("rejects stale versions, stale hashes and file edits outside the Project host", async () => {
        const projectRoot = await createRoot();
        const base = createEmptyManifest();
        await createOutlineRepository(options(projectRoot)).ensureLayout(serializeManifest(base));
        const relativePath = "outline/foreshadowing/clue--fo-1.md";
        const item: Foreshadowing = {schema: "nbook.outline-foreshadowing/v1", id: "fo-1", version: 0, status: "draft", title: "Clue", body: "before"};
        const original = serializeForeshadowingMarkdown(item);
        const ref = {id: item.id, path: relativePath, version: 0, contentHash: contentHash(original)};
        const initial = serializeManifest({...base, revision: 1, foreshadowing: [ref]});
        await publishPlanningFiles(options(projectRoot), {expectedManifestRevision: 0, mutations: [
            {relativePath, content: original}, {relativePath: "outline/manifest.yaml", content: initial},
        ]});
        for (const version of [0, 2]) {
            const content = serializeForeshadowingMarkdown({...item, version, body: "changed"});
            await expect(publishPlanningFiles(options(projectRoot), {
                expectedManifestRevision: 1, mutations: [
                    {relativePath, content},
                    {relativePath: "outline/manifest.yaml", content: serializeManifest({
                        ...base, revision: 2, foreshadowing: [{...ref, version, contentHash: contentHash(content)}],
                    })},
                ],
            })).rejects.toMatchObject({code: "CAS_CONFLICT"});
        }
        const valid = serializeForeshadowingMarkdown({...item, version: 1, body: "changed"});
        const update = {expectedManifestRevision: 1, mutations: [
            {relativePath, content: valid, expectedHash: "sha256:" + "0".repeat(64)},
            {relativePath: "outline/manifest.yaml", content: serializeManifest({
                ...base, revision: 2, foreshadowing: [{...ref, version: 1, contentHash: contentHash(valid)}],
            })},
        ]};
        await expect(publishPlanningFiles(options(projectRoot), update)).rejects.toMatchObject({code: "CAS_CONFLICT"});
        expect(await fs.readFile(path.join(projectRoot, "outline", "manifest.yaml"), "utf8")).toBe(initial);
        await fs.writeFile(path.join(projectRoot, relativePath), "external edit");
        await expect(readPlanningSnapshot(options(projectRoot))).rejects.toThrow(/hash/);
        await expect(publishPlanningFiles(options(projectRoot), update)).rejects.toMatchObject({code: "CAS_CONFLICT"});
        await expect(publishPlanningFiles(options(projectRoot), {
            ...update, mutations: update.mutations.map((mutation) => ({...mutation, expectedHash: undefined})),
        })).rejects.toThrow(/hash/);
    });
});

