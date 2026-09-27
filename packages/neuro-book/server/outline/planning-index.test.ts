import fs from "node:fs/promises";
import path from "node:path";
import {createClient} from "@libsql/client";
import {collectReleasedSqliteHandles} from "../workspace-files/sqlite-handle-release";
import {afterEach, describe, expect, it} from "vitest";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import {contentHash, createEmptyManifest, serializeForeshadowingMarkdown, serializeManifest} from "./format";
import {publishPlanningFiles} from "./index";
import {createOutlineRepository} from "./repository";
import {rebuildPlanningIndex} from "./planning-index";

const roots: string[] = [];
afterEach(async () => {
    collectReleasedSqliteHandles({force: true});
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

describe("planning SQLite projection", () => {
    it("can rebuild a deleted index without writing canonical files and rejects damaged sources", async () => {
        const projectRoot = await createTestTmpRoot("outline-index", "outline-index-rebuild");
        roots.push(projectRoot);
        const options = {projectRoot};
        const manifestPath = path.join(projectRoot, "outline", "manifest.yaml");
        const original = serializeManifest(createEmptyManifest());
        await createOutlineRepository(options).ensureLayout(original);
        await rebuildPlanningIndex(options);
        const dbPath = path.join(projectRoot, ".nbook", "outline-index.sqlite");
        const readRevision = async () => {
            const db = createClient({url: `file:${dbPath.replaceAll("\\", "/")}`});
            try {
                const result = await db.execute("SELECT value FROM outline_meta WHERE key = 'revision'");
                return result.rows[0]?.value;
            } finally {
                await db.close();
            }
        };
        expect(await readRevision()).toBe("0");
        collectReleasedSqliteHandles({force: true});
        await fs.rm(dbPath);
        await rebuildPlanningIndex(options);
        expect(await readRevision()).toBe("0");
        expect(await fs.readFile(manifestPath, "utf8")).toBe(original);
        await fs.writeFile(manifestPath, "broken: [");
        await expect(rebuildPlanningIndex(options)).rejects.toThrow();
        expect(await fs.readFile(manifestPath, "utf8")).toBe("broken: [");
    });
    it("rebuilds populated SQLite projections from canonical bytes", async () => {
        const projectRoot = await createTestTmpRoot("outline-index", "outline-nonempty-index");
        roots.push(projectRoot);
        const manifest = createEmptyManifest();
        await createOutlineRepository({projectRoot}).ensureLayout(serializeManifest(manifest));
        const doc = serializeForeshadowingMarkdown({schema: "nbook.outline-foreshadowing/v1", id: "fo-1", version: 0, status: "draft", title: "Clue", body: "Secret"});
        const relativePath = "outline/foreshadowing/clue--fo-1.md";
        const next = serializeManifest({...manifest, revision: 1, foreshadowing: [
            {id: "fo-1", path: relativePath, version: 0, contentHash: contentHash(doc)},
        ]});
        await publishPlanningFiles({projectRoot}, {expectedManifestRevision: 0, mutations: [
            {relativePath, content: doc}, {relativePath: "outline/manifest.yaml", content: next},
        ]});
        const databasePath = path.join(projectRoot, ".nbook", "outline-index.sqlite");
        await rebuildPlanningIndex({projectRoot});
        const query = async () => {
            const db = createClient({url: `file:` + databasePath.replaceAll("\\", "/")});
            try {
                return (await db.execute("SELECT id, title FROM outline_documents ORDER BY id")).rows.map((row) => [row.id, row.title]);
            } finally {await db.close();}
        };
        expect(await query()).toEqual([["fo-1", "Clue"]]);
        collectReleasedSqliteHandles({force: true});
        await fs.rm(databasePath);
        await rebuildPlanningIndex({projectRoot});
        expect(await query()).toEqual([["fo-1", "Clue"]]);
        expect(await fs.readFile(path.join(projectRoot, relativePath), "utf8")).toBe(doc);
        expect(await fs.readFile(path.join(projectRoot, "outline", "manifest.yaml"), "utf8")).toBe(next);
    });

});


