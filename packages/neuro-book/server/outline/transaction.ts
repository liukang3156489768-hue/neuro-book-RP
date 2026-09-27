import {createHash, randomUUID} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type OutlineFileMutation = Readonly<{
    /** 仅允许 outline/ 下的规范文件，使用正斜杠相对路径。 */
    relativePath: string;
    content: string | null;
    /** undefined 表示由事务在开始时捕获；null 表示目标应不存在。 */
    expectedHash?: string | null;
}>;

export type OutlineTransactionOptions = Readonly<{
    projectRoot: string;
    projectGeneration?: string;
    readProjectGeneration?: () => string | Promise<string>;
    mutationGate?: <T>(operation: () => Promise<T>) => Promise<T>;
    /** 测试与宿主故障注入 seam；不改变规范文件的事务边界。 */
    beforePublishFile?: (relativePath: string) => void | Promise<void>;
    /** 修复读取时已缺失的引用不得在发布期间被外部恢复。 */
    assertAbsentPaths?: readonly string[];
    /** 测试撤销中断；journal 进入 undoing 后，此钩子可模拟进程退出前的故障。 */
    beforeUndoFile?: (relativePath: string) => void | Promise<void>;
    /** 撤销发布前检查完整旧快照；拒绝外部丢失对象使旧 manifest 再次悬空。 */
    validateUndoCandidate?: (originals: readonly Readonly<{relativePath: string; content: string | null}>[]) => void | Promise<void>;
}>;

type OutlineTransactionJournal = {
    schema: "nbook.outline-transaction/v1";
    transactionId: string;
    status: "staged" | "publishing" | "committed" | "failed" | "recovered" | "undoing" | "undone";
    projectGeneration?: string;
    createdAt: string;
    updatedAt: string;
    files: Array<{
        relativePath: string;
        stagedPath: string;
        backupPath: string;
        hadOriginal: boolean;
        beforeHash: string | null;
        afterHash: string | null;
    }>;
    error?: string;
};

export type OutlinePublishReceipt = Readonly<{
    transactionId: string;
    files: readonly string[];
    journalPath: string;
}>;

export type OutlineUndoResult =
    | Readonly<{kind: "undone"; transactionId: string; files: readonly string[]}>
    | Readonly<{
        kind: "conflict";
        transactionId: string;
        conflicts: readonly Readonly<{relativePath: string; expectedHash: string | null; actualHash: string | null}>[];
    }>;

export type OutlineRecoveryResult = Readonly<{
    recovered: readonly string[];
    skipped: readonly string[];
}>;

export class OutlineTransactionError extends Error {
    readonly code:
        | "INVALID_PATH"
        | "CAS_CONFLICT"
        | "PROJECT_GENERATION_CONFLICT"
        | "MANIFEST_REVISION_CONFLICT"
        | "CORRUPT_JOURNAL"
        | "PENDING_TRANSACTION"
        | "PUBLISH_FAILED"
        | "NOT_INITIALIZED";

    constructor(code: OutlineTransactionError["code"], message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "OutlineTransactionError";
        this.code = code;
    }
}

const TRANSACTION_ROOT = path.join(".nbook", "outline-transactions");

async function assertTransactionRootSafe(projectRoot: string): Promise<void> {
    for (const relative of [".nbook", TRANSACTION_ROOT]) {
        const target = path.join(projectRoot, relative);
        const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
            if (isMissing(error)) return null;
            throw error;
        });
        if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) {
            throw new OutlineTransactionError("INVALID_PATH", "规划事务目录不是项目内的真实目录");
        }
    }
}


/**
 * 在项目内以备份 + journal 发布多个规范文件。
 *
 * 发布顺序按规范路径排序；失败时仅在目标仍保持事务前后 hash 且备份完整时回滚；
 * 恢复冲突保留 journal 并阻断新发布及索引读取。成功批次的 before/after hash 供 CAS 撤销使用。
 */
export async function publishOutlineFiles(
    options: OutlineTransactionOptions,
    mutations: readonly OutlineFileMutation[],
): Promise<OutlinePublishReceipt> {
    const unique = normalizeMutations(mutations);
    if (unique.length === 0) {
        throw new OutlineTransactionError("PUBLISH_FAILED", "规划事务不能为空");
    }
    const run = async (): Promise<OutlinePublishReceipt> => {
        await assertProjectGeneration(options);
        await assertOutlineTransactionsSettled(options.projectRoot);
        await assertAbsentPaths(options);
        const transactionId = randomUUID();
        const transactionRoot = path.join(options.projectRoot, TRANSACTION_ROOT, transactionId);
        const stagedRoot = path.join(transactionRoot, "staged");
        const backupRoot = path.join(transactionRoot, "backup");
        const journalPath = path.join(transactionRoot, "journal.json");
        await fs.mkdir(stagedRoot, {recursive: true});
        await fs.mkdir(backupRoot, {recursive: true});

        let files: OutlineTransactionJournal["files"] = [];
        let journal: OutlineTransactionJournal;
        try {
            for (const mutation of unique) {
                const absolutePath = await resolveOutlinePath(options.projectRoot, mutation.relativePath);
                const before = await readFileIfExists(absolutePath);
                const beforeHash = before === null ? null : hashBytes(before);
                const expectedHash = mutation.expectedHash === undefined ? beforeHash : mutation.expectedHash;
                if (expectedHash !== beforeHash) {
                    throw new OutlineTransactionError(
                        "CAS_CONFLICT",
                        `规划文件版本已变化：${mutation.relativePath}`,
                    );
                }
                const stagedPath = path.join(stagedRoot, mutation.relativePath);
                const backupPath = path.join(backupRoot, mutation.relativePath);
                await fs.mkdir(path.dirname(stagedPath), {recursive: true});
                await fs.mkdir(path.dirname(backupPath), {recursive: true});
                if (mutation.content === null && before === null) {
                    throw new OutlineTransactionError("CAS_CONFLICT", `规划文件不存在，无法删除：${mutation.relativePath}`);
                }
                if (mutation.content !== null) await fs.writeFile(stagedPath, mutation.content, "utf8");
                if (before !== null) {
                    await fs.writeFile(backupPath, before);
                }
                files.push({
                    relativePath: mutation.relativePath,
                    stagedPath: path.relative(transactionRoot, stagedPath).replaceAll(path.sep, "/"),
                    backupPath: path.relative(transactionRoot, backupPath).replaceAll(path.sep, "/"),
                    hadOriginal: before !== null,
                    beforeHash,
                    afterHash: mutation.content === null ? null : hashText(mutation.content),
                });
            }

            await assertAbsentPaths(options);
            const now = new Date().toISOString();
            journal = {
                schema: "nbook.outline-transaction/v1",
                transactionId,
                status: "staged",
                projectGeneration: await readGeneration(options),
                createdAt: now,
                updatedAt: now,
                files,
            };
            await writeJournal(journalPath, journal, journal);
        } catch (error) {
            await fs.rm(transactionRoot, {recursive: true, force: true}).catch(() => undefined);
            throw error;
        }

        try {
            journal = {...journal, status: "publishing", updatedAt: new Date().toISOString()};
            await writeJournal(journalPath, journal, journal);
            for (const file of files) {
                await assertAbsentPaths(options);
                await assertProjectGeneration(options, journal.projectGeneration);
                const target = await resolveOutlinePath(options.projectRoot, file.relativePath);
                const before = await readFileIfExists(target);
                const beforeHash = before === null ? null : hashBytes(before);
                if (beforeHash !== file.beforeHash) {
                    throw new OutlineTransactionError("CAS_CONFLICT", `规划文件版本已变化：${file.relativePath}`);
                }
                await options.beforePublishFile?.(file.relativePath);
                await assertAbsentPaths(options);
                const latest = await readFileIfExists(target);
                if ((latest === null ? null : hashBytes(latest)) !== file.beforeHash) {
                    throw new OutlineTransactionError("CAS_CONFLICT", `规划文件版本已变化：${file.relativePath}`);
                }
                const stagedPath = path.join(transactionRoot, file.stagedPath);
                await fs.mkdir(path.dirname(target), {recursive: true});
                if (file.afterHash === null) await fs.rm(target);
                else await fs.rename(stagedPath, target);
            }
            await assertProjectGeneration(options, journal.projectGeneration);
            await assertAbsentPaths(options);
            journal = {...journal, status: "committed", updatedAt: new Date().toISOString()};
            await writeJournal(journalPath, journal, journal);
            return {transactionId, files: files.map((file) => file.relativePath), journalPath};
        } catch (error) {
            const restored = await restoreTransaction(options.projectRoot, transactionRoot, journal);
            journal = {
                ...journal,
                status: "failed",
                updatedAt: new Date().toISOString(),
                error: error instanceof Error ? error.message : String(error),
            };
            await writeJournal(journalPath, journal, journal).catch(() => undefined);
            if (error instanceof OutlineTransactionError) {
                throw error;
            }
            throw new OutlineTransactionError("PUBLISH_FAILED",
                restored ? "规划文件事务发布失败，原文件已恢复" : "规划文件事务发布失败，恢复存在冲突，需人工处理",
                {cause: error});
        }
    };
    return options.mutationGate ? options.mutationGate(run) : run();
}

async function assertAbsentPaths(options: OutlineTransactionOptions): Promise<void> {
    for (const relativePath of options.assertAbsentPaths ?? []) {
        const target = await resolveOutlinePath(options.projectRoot, relativePath);
        if (await readFileIfExists(target) !== null) {
            throw new OutlineTransactionError("CAS_CONFLICT", `规划文件已恢复，请重新读取：${relativePath}`);
        }
    }
}

/** 恢复未完成的 publishing/failed 事务；已提交事务不应被自动回滚。 */
export async function recoverOutlineTransactions(projectRoot: string): Promise<OutlineRecoveryResult> {
    await assertTransactionRootSafe(projectRoot);
    const root = path.join(projectRoot, TRANSACTION_ROOT);
    const entries = await fs.readdir(root, {withFileTypes: true}).catch((error: unknown) => {
        if (isMissing(error)) return [];
        throw error;
    });
    const recovered: string[] = [];
    const skipped: string[] = [];
    for (const entry of entries) {
        if (entry.isSymbolicLink()) throw new OutlineTransactionError("CORRUPT_JOURNAL", "规划事务目录不能是符号链接");
        if (!entry.isDirectory()) continue;
        const transactionRoot = path.join(root, entry.name);
        const journalPath = path.join(transactionRoot, "journal.json");
        const journal = await readJournal(journalPath);
        if (journal === null) {
            skipped.push(entry.name);
            continue;
        }
        if (journal.status === "undoing") {
            if (await restoreUndoTransaction(projectRoot, transactionRoot, journal)) {
                await writeJournal(journalPath, {...journal, status: "committed", updatedAt: new Date().toISOString()}, journal);
                recovered.push(journal.transactionId);
            } else {
                skipped.push(journal.transactionId);
            }
        } else if (journal.status === "staged" || journal.status === "publishing" || journal.status === "failed") {
            if (await restoreTransaction(projectRoot, transactionRoot, journal)) {
                await writeJournal(journalPath, {...journal, status: "recovered", updatedAt: new Date().toISOString()}, journal);
                recovered.push(journal.transactionId);
            } else {
                skipped.push(journal.transactionId);
            }
        } else {
            skipped.push(journal.transactionId);
        }
    }
    return {recovered, skipped};
}

/** 未完成批次不能作为可索引的规划快照，也不能与新写入交错。 */
export async function assertOutlineTransactionsSettled(projectRoot: string): Promise<string> {
    await assertTransactionRootSafe(projectRoot);
    const root = path.join(projectRoot, TRANSACTION_ROOT);
    const entries = await fs.readdir(root, {withFileTypes: true}).catch((error: unknown) => {
        if (isMissing(error)) return [];
        throw error;
    });
    const settled: string[] = [];
    for (const entry of entries) {
        if (entry.isSymbolicLink()) throw new OutlineTransactionError("CORRUPT_JOURNAL", "规划事务目录不能是符号链接");
        if (!entry.isDirectory()) continue;
        const journal = await readJournal(path.join(root, entry.name, "journal.json"));
        if (journal === null) {
            throw new OutlineTransactionError("PENDING_TRANSACTION", `规划事务目录缺少 journal：${entry.name}`);
        }
        if (journal?.status === "staged" || journal?.status === "publishing" || journal?.status === "failed" || journal?.status === "undoing") {
            throw new OutlineTransactionError("PENDING_TRANSACTION", `规划事务尚未恢复：${journal.transactionId}`);
        }
        if (journal) settled.push(`${entry.name}:${journal.status}:${journal.updatedAt}`);
    }
    return settled.sort().join("|");
}

/** 撤销只在 after hash 全部匹配时启动；中断后先恢复已提交状态再允许重试。 */
export async function undoOutlineTransaction(
    options: OutlineTransactionOptions,
    transactionId: string,
): Promise<OutlineUndoResult> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(transactionId)) {
        throw new OutlineTransactionError("INVALID_PATH", "规划事务 ID 无效");
    }
    await assertTransactionRootSafe(options.projectRoot);
    const transactionRoot = path.join(options.projectRoot, TRANSACTION_ROOT, transactionId);
    await assertTransactionDirectorySafe(transactionRoot);
    const journalPath = path.join(transactionRoot, "journal.json");
    const journal = await readJournal(journalPath);
    if (!journal || journal.status !== "committed") {
        throw new OutlineTransactionError("CORRUPT_JOURNAL", `找不到可撤销的规划事务：${transactionId}`);
    }
    const initialConflicts = await findUndoConflicts(options.projectRoot, journal);
    if (initialConflicts.length > 0) return {kind: "conflict", transactionId, conflicts: initialConflicts};

    const run = async (): Promise<OutlineUndoResult> => {
        await assertOutlineTransactionsSettled(options.projectRoot);
        // 撤销可跨关闭/重开：旧代次仅归属原发布，当前 ready 与文件 CAS 决定撤销资格。
        await assertProjectGeneration(options);
        const latestJournal = await readJournal(journalPath);
        if (!latestJournal || latestJournal.status !== "committed") {
            throw new OutlineTransactionError("CORRUPT_JOURNAL", `规划事务状态已变化：${transactionId}`);
        }
        const conflicts = await findUndoConflicts(options.projectRoot, latestJournal);
        if (conflicts.length > 0) return {kind: "conflict", transactionId, conflicts};

        // 标记 undoing 前先持久化 after 快照和校验原备份；否则恢复无法判断部分撤销的来源。
        const originals: Array<{relativePath: string; content: string | null}> = [];
        for (const file of latestJournal.files) {
            if (file.hadOriginal) {
                const backup = await readFileIfExists(path.join(transactionRoot, file.backupPath));
                if (backup === null || hashBytes(backup) !== file.beforeHash) {
                    throw new OutlineTransactionError("CORRUPT_JOURNAL", `规划文件备份缺失或损坏：${file.relativePath}`);
                }
                originals.push({relativePath: file.relativePath, content: backup.toString("utf8")});
            } else {
                originals.push({relativePath: file.relativePath, content: null});
            }
            const target = await resolveOutlinePath(options.projectRoot, file.relativePath);
            const after = await readFileIfExists(target);
            if ((after === null ? null : hashBytes(after)) !== file.afterHash) {
                return {kind: "conflict", transactionId, conflicts: await findUndoConflicts(options.projectRoot, latestJournal)};
            }
            const snapshot = path.join(transactionRoot, "undo-after", file.relativePath);
            await fs.mkdir(path.dirname(snapshot), {recursive: true});
            if (after !== null) await fs.writeFile(snapshot, after);
        }
        const lateConflicts = await findUndoConflicts(options.projectRoot, latestJournal);
        if (lateConflicts.length > 0) return {kind: "conflict", transactionId, conflicts: lateConflicts};
        await options.validateUndoCandidate?.(originals);
        await assertProjectGeneration(options);
        await writeJournal(journalPath, {...latestJournal, status: "undoing", updatedAt: new Date().toISOString()}, latestJournal);
        try {
            for (const file of [...latestJournal.files].reverse()) {
                await options.beforeUndoFile?.(file.relativePath);
                const target = await resolveOutlinePath(options.projectRoot, file.relativePath);
                const current = await readFileIfExists(target);
                if ((current === null ? null : hashBytes(current)) !== file.afterHash) {
                    throw new OutlineTransactionError("CAS_CONFLICT", `撤销期间规划文件已变化：${file.relativePath}`);
                }
                if (file.hadOriginal) {
                    const staging = path.join(transactionRoot, "undo-staged", file.relativePath);
                    await fs.mkdir(path.dirname(staging), {recursive: true});
                    await fs.copyFile(path.join(transactionRoot, file.backupPath), staging);
                    await fs.rename(staging, target);
                } else {
                    await fs.rm(target);
                }
            }
            await assertProjectGeneration(options);
            await writeJournal(journalPath, {...latestJournal, status: "undone", updatedAt: new Date().toISOString()}, latestJournal);
            return {kind: "undone", transactionId, files: latestJournal.files.map((file) => file.relativePath)};
        } catch (error) {
            // 保留 undoing 与 after 快照；下一次恢复不能把半撤销误认为完整批次。
            throw new OutlineTransactionError("PUBLISH_FAILED", "规划批次撤销中断，须先恢复事务", {cause: error});
        }
    };
    return options.mutationGate ? options.mutationGate(run) : run();
}

async function findUndoConflicts(projectRoot: string, journal: OutlineTransactionJournal): Promise<Array<{
    relativePath: string;
    expectedHash: string | null;
    actualHash: string | null;
}>> {
    const conflicts: Array<{relativePath: string; expectedHash: string | null; actualHash: string | null}> = [];
    for (const file of journal.files) {
        const actual = await readFileIfExists(await resolveOutlinePath(projectRoot, file.relativePath));
        const actualHash = actual === null ? null : hashBytes(actual);
        if (actualHash !== file.afterHash) {
            conflicts.push({relativePath: file.relativePath, expectedHash: file.afterHash, actualHash});
        }
    }
    return conflicts;
}

export async function readOutlineTransactionJournal(
    projectRoot: string,
    transactionId: string,
): Promise<Readonly<Record<string, unknown>> | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(transactionId)) {
        throw new OutlineTransactionError("INVALID_PATH", "规划事务 ID 无效");
    }
    await assertTransactionRootSafe(projectRoot);
    const transactionRoot = path.join(projectRoot, TRANSACTION_ROOT, transactionId);
    await assertTransactionDirectorySafe(transactionRoot);
    return readJournal(path.join(transactionRoot, "journal.json"));
}

export function hashText(content: string): string {
    return hashBytes(Buffer.from(content, "utf8"));
}

function hashBytes(content: Uint8Array): string {
    return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function normalizeMutations(mutations: readonly OutlineFileMutation[]): OutlineFileMutation[] {
    const byPath = new Map<string, OutlineFileMutation>();
    for (const mutation of mutations) {
        const relativePath = normalizeOutlinePath(mutation.relativePath);
        if (byPath.has(relativePath)) {
            throw new OutlineTransactionError("INVALID_PATH", `规划事务包含重复文件：${relativePath}`);
        }
        byPath.set(relativePath, {...mutation, relativePath});
    }
    return [...byPath.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function normalizeOutlinePath(relativePath: string): string {
    const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
    if (!normalized.startsWith("outline/") || normalized.includes("..") || normalized.includes("//")) {
        throw new OutlineTransactionError("INVALID_PATH", `规范文件路径非法：${relativePath}`);
    }
    return normalized;
}

export async function resolveOutlinePath(projectRoot: string, relativePath: string): Promise<string> {
    const normalized = normalizeOutlinePath(relativePath);
    const root = path.resolve(projectRoot);
    const target = path.resolve(root, normalized);
    const relative = path.relative(root, target);
    if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new OutlineTransactionError("INVALID_PATH", `规范文件路径越界：${relativePath}`);
    }
    let cursor = root;
    for (const segment of normalized.split("/")) {
        cursor = path.join(cursor, segment);
        const stat = await fs.lstat(cursor).catch((error: NodeJS.ErrnoException) => {
            if (isMissing(error)) return null;
            throw error;
        });
        if (stat?.isSymbolicLink()) throw new OutlineTransactionError("INVALID_PATH", `规划文件路径不能经过符号链接：${relativePath}`);
        if (stat === null) break;
    }
    return target;
}

async function readFileIfExists(filePath: string): Promise<Buffer | null> {
    try {
        return await fs.readFile(filePath);
    } catch (error) {
        if (isMissing(error)) return null;
        throw error;
    }
}

async function restoreTransaction(
    projectRoot: string,
    transactionRoot: string,
    journal: OutlineTransactionJournal,
): Promise<boolean> {
    // 整批预检后才回滚，避免遇到外部编辑时只恢复一部分却宣称成功。
    for (const file of journal.files) {
        const target = await resolveOutlinePath(projectRoot, file.relativePath);
        const current = await readFileIfExists(target);
        const currentHash = current === null ? null : hashBytes(current);
        if (currentHash !== file.beforeHash && currentHash !== file.afterHash) return false;
        if (currentHash === file.afterHash && file.hadOriginal) {
            const backup = await readFileIfExists(path.join(transactionRoot, file.backupPath));
            if (backup === null || hashBytes(backup) !== file.beforeHash) {
                throw new OutlineTransactionError("CORRUPT_JOURNAL", `规划文件备份缺失或损坏：${file.relativePath}`);
            }
        }
    }
    for (const file of [...journal.files].reverse()) {
        const target = await resolveOutlinePath(projectRoot, file.relativePath);
        const current = await readFileIfExists(target);
        if ((current === null ? null : hashBytes(current)) === file.beforeHash) continue;
        if (file.hadOriginal) {
            const backup = path.join(transactionRoot, file.backupPath);
            const temporary = path.join(transactionRoot, `restore-${path.basename(file.backupPath)}-${journal.transactionId}.tmp`);
            await fs.copyFile(backup, temporary);
            await fs.rename(temporary, target);
        } else {
            await fs.rm(target, {force: true});
        }
    }
    return true;
}

async function restoreUndoTransaction(
    projectRoot: string,
    transactionRoot: string,
    journal: OutlineTransactionJournal,
): Promise<boolean> {
    // 先确认整批仍在撤销前后两个状态且 after 快照完整；外部编辑不能被恢复覆盖。
    for (const file of journal.files) {
        const target = await resolveOutlinePath(projectRoot, file.relativePath);
        const current = await readFileIfExists(target);
        const currentHash = current === null ? null : hashBytes(current);
        if (currentHash !== file.beforeHash && currentHash !== file.afterHash) return false;
        const after = await readFileIfExists(path.join(transactionRoot, "undo-after", file.relativePath));
        if (file.afterHash !== null && (after === null || hashBytes(after) !== file.afterHash)) {
            throw new OutlineTransactionError("CORRUPT_JOURNAL", `撤销快照缺失或损坏：${file.relativePath}`);
        }
    }
    for (const file of journal.files) {
        const target = await resolveOutlinePath(projectRoot, file.relativePath);
        const current = await readFileIfExists(target);
        if ((current === null ? null : hashBytes(current)) === file.afterHash) continue;
        if (file.afterHash === null) {
            await fs.rm(target, {force: true});
        } else {
            const staging = path.join(transactionRoot, "undo-restore", file.relativePath);
            await fs.mkdir(path.dirname(staging), {recursive: true});
            await fs.copyFile(path.join(transactionRoot, "undo-after", file.relativePath), staging);
            await fs.mkdir(path.dirname(target), {recursive: true});
            await fs.rename(staging, target);
        }
    }
    return true;
}

async function writeJournal(
    journalPath: string,
    next: OutlineTransactionJournal,
    previous: OutlineTransactionJournal,
): Promise<void> {
    if (previous.transactionId !== next.transactionId) {
        throw new OutlineTransactionError("CORRUPT_JOURNAL", "规划事务 journal 身份不一致");
    }
    const temporary = `${journalPath}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await fs.rename(temporary, journalPath);
}

async function assertTransactionDirectorySafe(transactionRoot: string): Promise<void> {
    const stat = await fs.lstat(transactionRoot).catch((error: NodeJS.ErrnoException) => {
        if (isMissing(error)) return null;
        throw error;
    });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
        throw new OutlineTransactionError("CORRUPT_JOURNAL", "规划事务目录不是项目内的真实目录");
    }
}

async function readJournal(journalPath: string): Promise<OutlineTransactionJournal | null> {
    const stat = await fs.lstat(journalPath).catch((error: NodeJS.ErrnoException) => {
        if (isMissing(error)) return null;
        throw error;
    });
    if (stat?.isSymbolicLink()) throw new OutlineTransactionError("CORRUPT_JOURNAL", "规划事务 journal 不能是符号链接");
    try {
        const value: unknown = JSON.parse(await fs.readFile(journalPath, "utf8"));
        if (!isJournal(value) || value.transactionId !== path.basename(path.dirname(journalPath))) {
            throw new OutlineTransactionError("CORRUPT_JOURNAL", `规划事务 journal 无效：${journalPath}`);
        }
        await assertTransactionArtifactsSafe(path.dirname(journalPath), value);
        return value;
    } catch (error) {
        if (isMissing(error)) return null;
        if (error instanceof OutlineTransactionError) throw error;
        throw new OutlineTransactionError("CORRUPT_JOURNAL", `规划事务 journal 无法读取：${journalPath}`, {cause: error});
    }
}

/** journal 内容合法也不意味着磁盘备份可读：外部链接不能成为回滚或撤销的数据源。 */
async function assertTransactionArtifactsSafe(transactionRoot: string, journal: OutlineTransactionJournal): Promise<void> {
    const paths = ["journal.json.tmp"];
    for (const file of journal.files) {
        paths.push(file.stagedPath, file.backupPath,
            `undo-after/${file.relativePath}`, `undo-staged/${file.relativePath}`, `undo-restore/${file.relativePath}`,
            `restore-${path.basename(file.backupPath)}-${journal.transactionId}.tmp`);
    }
    for (const relative of paths) {
        const segments = relative.split("/");
        let cursor = transactionRoot;
        for (const [index, segment] of segments.entries()) {
            cursor = path.join(cursor, segment);
            const stat = await fs.lstat(cursor).catch((error: NodeJS.ErrnoException) => {
                if (isMissing(error)) return null;
                throw error;
            });
            if (stat === null) break;
            if (stat.isSymbolicLink() || (index < segments.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
                throw new OutlineTransactionError("CORRUPT_JOURNAL", `规划事务产物路径无效：${relative}`);
            }
        }
    }
}
function isJournal(value: unknown): value is OutlineTransactionJournal {
    if (typeof value !== "object" || value === null) return false;
    const journal = value as Record<string, unknown>;
    if (journal.schema !== "nbook.outline-transaction/v1"
        || typeof journal.transactionId !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(journal.transactionId)
        || !["staged", "publishing", "committed", "failed", "recovered", "undoing", "undone"].includes(String(journal.status))
        || typeof journal.createdAt !== "string"
        || typeof journal.updatedAt !== "string"
        || (journal.projectGeneration !== undefined && typeof journal.projectGeneration !== "string")
        || !Array.isArray(journal.files)
        || journal.files.length === 0) return false;
    const seen = new Set<string>();
    return journal.files.every((value: unknown) => {
        if (typeof value !== "object" || value === null) return false;
        const file = value as Record<string, unknown>;
        if (typeof file.relativePath !== "string") return false;
        try {
            if (normalizeOutlinePath(file.relativePath) !== file.relativePath || seen.has(file.relativePath)) return false;
        } catch {
            return false;
        }
        seen.add(file.relativePath);
        return file.stagedPath === `staged/${file.relativePath}`
            && file.backupPath === `backup/${file.relativePath}`
            && typeof file.hadOriginal === "boolean"
            && (file.beforeHash === null || isContentHash(file.beforeHash))
            && file.hadOriginal === (file.beforeHash !== null)
            && (file.afterHash === null || isContentHash(file.afterHash));
    });
}

function isContentHash(value: unknown): value is string {
    return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

async function assertProjectGeneration(options: OutlineTransactionOptions, expected?: string): Promise<void> {
    const actual = await readGeneration(options);
    if (expected !== undefined && actual !== expected) {
        throw new OutlineTransactionError("PROJECT_GENERATION_CONFLICT", "Project generation 已变化，拒绝提交规划事务");
    }
    if (options.projectGeneration !== undefined && actual !== options.projectGeneration) {
        throw new OutlineTransactionError("PROJECT_GENERATION_CONFLICT", "Project generation 已过期，拒绝提交规划事务");
    }
}

async function readGeneration(options: OutlineTransactionOptions): Promise<string | undefined> {
    return options.readProjectGeneration ? options.readProjectGeneration() : options.projectGeneration;
}

async function exists(filePath: string): Promise<boolean> {
    return fs.access(filePath).then(() => true, () => false);
}

function isMissing(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}









