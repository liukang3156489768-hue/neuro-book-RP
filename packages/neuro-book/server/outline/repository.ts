import fs from "node:fs/promises";
import path from "node:path";
import {assertOutlineTransactionsSettled, hashText, OutlineTransactionError, publishOutlineFiles, resolveOutlinePath, type OutlineTransactionOptions} from "./transaction";

export type OutlineCanonicalFile = Readonly<{
    relativePath: string;
    content: string;
    contentHash: string;
}>;

export type OutlineParser<TDocument> = (input: {
    relativePath: string;
    content: string;
}) => TDocument;

export type OutlineParsedDocument<TDocument> = Readonly<{
    file: OutlineCanonicalFile;
    document: TDocument;
}>;

export type OutlineIndexSink<TDocument> = {
    replace(snapshot: readonly OutlineParsedDocument<TDocument>[]): Promise<void> | void;
};

export type OutlineObjectImpact = Readonly<{
    targetId: string;
    objectFile: string | null;
    references: readonly Readonly<{
        sourceFile: string;
        relation: string;
        sourceId?: string;
    }>[];
    canDeleteObject: boolean;
}>;

export type OutlineRelationImpact = Readonly<{
    relation: string;
    sourceFile: string;
    targetId: string;
    objectFileRemains: boolean;
}>;

export type OutlineRepositoryOptions = OutlineTransactionOptions;

/**
 * 规划规范文件仓储。
 *
 * 每次读取都扫描磁盘并重新解析，SQLite/外部索引只通过 rebuildIndex() 消费这个
 * snapshot；因此外部编辑、索引损坏或重开项目都不会把旧索引误当成事实来源。
 */
export function createOutlineRepository(options: OutlineRepositoryOptions) {
    return {
        ensureLayout,
        readCanonicalFiles,
        readParsed,
        rebuildIndex,
        publish,
        previewObjectDeletion,
        previewRelationDeletion,
    };

    async function ensureLayout(manifestContent: string): Promise<void> {
        await resolveOutlinePath(options.projectRoot, "outline/manifest.yaml");
        const outlineRoot = path.join(options.projectRoot, "outline");
        for (const directory of ["entries", "foreshadowing", "graphs", "storylines"]) {
            await resolveOutlinePath(options.projectRoot, `outline/${directory}/placeholder`);
        }
        await fs.mkdir(path.join(outlineRoot, "entries"), {recursive: true});
        await fs.mkdir(path.join(outlineRoot, "foreshadowing"), {recursive: true});
        await fs.mkdir(path.join(outlineRoot, "graphs"), {recursive: true});
        await fs.mkdir(path.join(outlineRoot, "storylines"), {recursive: true});
        const manifestPath = path.join(outlineRoot, "manifest.yaml");
        if (!(await exists(manifestPath))) {
            await publish([{relativePath: "outline/manifest.yaml", content: manifestContent}]);
        }
    }

    async function readCanonicalFiles(): Promise<readonly OutlineCanonicalFile[]> {
        const revision = await assertOutlineTransactionsSettled(options.projectRoot);
        for (const directory of ["entries", "foreshadowing", "graphs", "storylines"]) {
            await resolveOutlinePath(options.projectRoot, `outline/${directory}/placeholder`);
        }
        const relativePaths = [
            "outline/manifest.yaml",
            ...(await collectFiles(path.join(options.projectRoot, "outline", "entries"), "outline/entries")),
            ...(await collectFiles(path.join(options.projectRoot, "outline", "foreshadowing"), "outline/foreshadowing")),
            ...(await collectFiles(path.join(options.projectRoot, "outline", "graphs"), "outline/graphs")),
            ...(await collectFiles(path.join(options.projectRoot, "outline", "storylines"), "outline/storylines")),
        ].sort((left, right) => left.localeCompare(right));
        const files: OutlineCanonicalFile[] = [];
        for (const relativePath of relativePaths) {
            const content = await fs.readFile(await resolveOutlinePath(options.projectRoot, relativePath), "utf8").catch((error: NodeJS.ErrnoException) => {
                // 只读入口不负责初始化；把缺失 manifest 表达为领域状态，避免把本机路径和 fs 原始错误交给界面与模型。
                if (error.code === "ENOENT" && relativePath === "outline/manifest.yaml") {
                    throw new OutlineTransactionError("NOT_INITIALIZED", "当前作品尚未初始化大纲规划，请先打开大纲规划工作台", {cause: error});
                }
                throw error;
            });
            files.push({relativePath, content, contentHash: hashText(content)});
        }
        if (await assertOutlineTransactionsSettled(options.projectRoot) !== revision) {
            throw new OutlineTransactionError("PENDING_TRANSACTION", "规划事务在读取期间发生变化，请重新读取");
        }
        return files;
    }

    async function readParsed<TDocument>(parser: OutlineParser<TDocument>): Promise<readonly OutlineParsedDocument<TDocument>[]> {
        const files = await readCanonicalFiles();
        return files.map((file) => ({file, document: parser({relativePath: file.relativePath, content: file.content})}));
    }

    async function rebuildIndex<TDocument>(
        parser: OutlineParser<TDocument>,
        index: OutlineIndexSink<TDocument>,
    ): Promise<readonly OutlineParsedDocument<TDocument>[]> {
        const snapshot = await readParsed(parser);
        await index.replace(snapshot);
        return snapshot;
    }

    async function publish(mutations: Parameters<typeof publishOutlineFiles>[1]) {
        return publishOutlineFiles(options, mutations);
    }

    async function previewObjectDeletion<TDocument>(input: {
        targetId: string;
        parser: OutlineParser<TDocument>;
        getDocumentId: (document: TDocument) => string | undefined;
        getReferences: (document: TDocument) => readonly Readonly<{targetId: string; relation: string; sourceId?: string}>[];
    }): Promise<OutlineObjectImpact> {
        const snapshot = await readParsed(input.parser);
        const references: Array<{sourceFile: string; relation: string; sourceId?: string}> = [];
        let objectFile: string | null = null;
        for (const parsed of snapshot) {
            if (input.getDocumentId(parsed.document) === input.targetId) {
                objectFile = parsed.file.relativePath;
            }
            for (const reference of input.getReferences(parsed.document)) {
                if (reference.targetId === input.targetId) {
                    references.push({sourceFile: parsed.file.relativePath, relation: reference.relation, sourceId: reference.sourceId});
                }
            }
        }
        return {
            targetId: input.targetId,
            objectFile,
            references,
            canDeleteObject: objectFile !== null && references.length === 0,
        };
    }

    async function previewRelationDeletion<TDocument>(input: {
        sourceFile: string;
        targetId: string;
        relation: string;
        parser: OutlineParser<TDocument>;
        getReferences: (document: TDocument) => readonly Readonly<{targetId: string; relation: string}>[];
    }): Promise<OutlineRelationImpact> {
        const snapshot = await readParsed(input.parser);
        const source = snapshot.find((item) => item.file.relativePath === input.sourceFile);
        const exists = source?.document !== undefined
            && input.getReferences(source.document).some((reference) => reference.targetId === input.targetId && reference.relation === input.relation);
        if (!exists) {
            throw new Error(`关系不存在：${input.sourceFile} -> ${input.targetId} (${input.relation})`);
        }
        return {
            relation: input.relation,
            sourceFile: input.sourceFile,
            targetId: input.targetId,
            objectFileRemains: true,
        };
    }
}

async function collectFiles(root: string, relativeRoot: string): Promise<string[]> {
    const entries = await fs.readdir(root, {withFileTypes: true}).catch((error: unknown) => {
        if (isMissing(error)) return [];
        throw error;
    });
    const files: string[] = [];
    for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (entry.isSymbolicLink()) throw new OutlineTransactionError("INVALID_PATH", "规划规范目录不能包含符号链接");
        const absolutePath = path.join(root, entry.name);
        const relativePath = `${relativeRoot}/${entry.name}`.replaceAll(path.sep, "/");
        if (entry.isDirectory()) {
            files.push(...await collectFiles(absolutePath, relativePath));
        } else if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".yaml"))) {
            files.push(relativePath);
        }
    }
    return files;
}

async function exists(filePath: string): Promise<boolean> {
    return fs.access(filePath).then(() => true, () => false);
}

function isMissing(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

