import fs from "node:fs/promises";
import path from "node:path";
import {createClient, type InStatement} from "@libsql/client";
import {readPlanningSnapshot} from "./index";
import type {OutlineRepositoryOptions} from "./repository";

/** 可丢弃的 Project 派生索引；读取规范文件并完整验证后才允许替换索引内容。 */
export async function rebuildPlanningIndex(options: OutlineRepositoryOptions): Promise<void> {
    const snapshot = await readPlanningSnapshot(options);
    const databasePath = path.join(options.projectRoot, ".nbook", "outline-index.sqlite");
    await fs.mkdir(path.dirname(databasePath), {recursive: true});
    for (const target of [path.dirname(databasePath), databasePath]) {
        const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
        });
        if (stat?.isSymbolicLink()) throw new Error("规划索引路径不能是符号链接");
    }
    const client = createClient({url: `file:${databasePath.replaceAll("\\", "/")}`});
    try {
        await client.execute(`CREATE TABLE IF NOT EXISTS outline_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
        await client.execute(`CREATE TABLE IF NOT EXISTS outline_documents (
            id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
            version INTEGER NOT NULL, content_hash TEXT NOT NULL, title TEXT NOT NULL
        )`);
        await client.execute(`CREATE TABLE IF NOT EXISTS outline_references (
            source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation TEXT NOT NULL,
            PRIMARY KEY (source_id, target_id, relation)
        )`);
        await client.execute(`CREATE TABLE IF NOT EXISTS outline_markers (
            entry_id TEXT NOT NULL, marker TEXT NOT NULL, foreshadow_id TEXT NOT NULL,
            action TEXT NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
            PRIMARY KEY (entry_id, marker)
        )`);
        const statements: InStatement[] = [
            "DELETE FROM outline_meta", "DELETE FROM outline_markers",
            "DELETE FROM outline_references", "DELETE FROM outline_documents",
        ];
        for (const item of snapshot.entries) {
            statements.push({sql: "INSERT INTO outline_documents VALUES (?, ?, ?, ?, ?, ?)", args: [
                item.value.id, item.path, item.value.kind, item.value.version, item.contentHash, item.value.title,
            ]});
            if (item.value.chapterId) statements.push({sql: "INSERT INTO outline_references VALUES (?, ?, ?)", args: [item.value.id, item.value.chapterId, "chapter"]});
            for (const marker of item.markers) statements.push({sql: "INSERT INTO outline_markers VALUES (?, ?, ?, ?, ?, ?)", args: [
                item.value.id, marker.marker, marker.foreshadowId, marker.action, marker.startOffset, marker.endOffset,
            ]});
        }
        for (const plan of snapshot.manifest.plans) {
            for (const placement of plan.placements) {
                statements.push({sql: "INSERT INTO outline_references VALUES (?, ?, ?)", args: [
                    plan.id, placement.entryId, `placement:${placement.parentId ?? "root"}`,
                ]});
            }
        }
        for (const item of snapshot.foreshadowing) statements.push({sql: "INSERT INTO outline_documents VALUES (?, ?, ?, ?, ?, ?)", args: [
            item.value.id, item.path, "foreshadowing", item.value.version, item.contentHash, item.value.title,
        ]});
        for (const item of snapshot.lines) {
            statements.push({sql: "INSERT INTO outline_documents VALUES (?, ?, ?, ?, ?, ?)", args: [
                item.value.id, item.path, `line:${item.value.type}`, item.value.version, item.contentHash, item.value.title,
            ]});
            for (const nodeId of item.value.nodeIds) statements.push({sql: "INSERT INTO outline_references VALUES (?, ?, ?)", args: [
                item.value.id, nodeId, "line-node",
            ]});
        }
        for (const item of snapshot.graphs) {
            statements.push({sql: "INSERT INTO outline_documents VALUES (?, ?, ?, ?, ?, ?)", args: [
                item.value.id, item.path, "graph", item.value.version, item.contentHash, item.value.planId,
            ]});
            for (const node of item.value.nodes) {
                if (node.entryId !== null) statements.push({sql: "INSERT INTO outline_references VALUES (?, ?, ?)", args: [
                    node.id, node.entryId, "node-entry",
                ]});
            }
        }
        statements.push({sql: "INSERT INTO outline_meta VALUES (?, ?)", args: ["revision", String(snapshot.manifest.revision)]});
        await client.batch(statements, "write");
    } finally {
        await client.close();
    }
}


