import {readFile, readdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {normalizeLegacyCharacterFacetDocument} from "nbook/server/character/character-files";

type FacetKind = "experience" | "relationships" | "knowledge";

type Candidate = {
    absolutePath: string;
    relativePath: string;
    kind: FacetKind;
};

type MigrationReport = {
    workspaceRoot: string;
    dryRun: boolean;
    scanned: number;
    changed: string[];
    unchanged: string[];
};

/**
 * 为角色侧面文件补齐 records frontmatter。
 * 默认只预检；只有显式传入 --write 才会落盘，避免把格式修复误当成重新提取。
 */
export async function normalizeCharacterFacets(args: readonly string[]): Promise<MigrationReport> {
    const options = parseArguments(args);
    const candidates = await findCandidates(options.workspaceRoot);
    const report: MigrationReport = {
        workspaceRoot: options.workspaceRoot,
        dryRun: options.dryRun,
        scanned: candidates.length,
        changed: [],
        unchanged: [],
    };

    for (const candidate of candidates) {
        const content = await readFile(candidate.absolutePath, "utf8");
        const normalized = normalizeLegacyCharacterFacetDocument(content, candidate.kind, candidate.relativePath);
        if (normalized === content) {
            report.unchanged.push(candidate.relativePath);
            continue;
        }
        report.changed.push(candidate.relativePath);
        if (!options.dryRun) await writeFile(candidate.absolutePath, normalized, "utf8");
    }
    return report;
}

async function findCandidates(workspaceRoot: string): Promise<Candidate[]> {
    const characterRoot = path.join(workspaceRoot, "lorebook", "character");
    const entries = await readdir(characterRoot, {withFileTypes: true}).catch((error) => {
        if (!isMissing(error)) throw error;
        return [];
    });
    const characters = entries
        .filter((entry) => entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
    const candidates: Candidate[] = [];
    for (const character of characters) {
        const root = path.join(characterRoot, character.name);
        await collectFacet(candidates, workspaceRoot, path.join(root, "original"));
        const plansRoot = path.join(root, "plans");
        const planEntries = await readdir(plansRoot, {withFileTypes: true}).catch((error) => {
            if (!isMissing(error)) throw error;
            return [];
        });
        const plans = planEntries
            .filter((entry) => entry.isDirectory())
            .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
        for (const plan of plans) {
            await collectFacet(candidates, workspaceRoot, path.join(plansRoot, plan.name));
        }
    }
    return candidates;
}

async function collectFacet(candidates: Candidate[], workspaceRoot: string, directory: string): Promise<void> {
    const files: readonly [string, FacetKind][] = [["experience.md", "experience"], ["relationships.md", "relationships"], [path.join("knowledge", "index.md"), "knowledge"]];
    for (const [relativeFile, kind] of files) {
        const absolutePath = path.join(directory, relativeFile);
        const relativePath = path.relative(workspaceRoot, absolutePath).replaceAll(path.sep, "/");
        try {
            await readFile(absolutePath);
            candidates.push({absolutePath, relativePath, kind});
        } catch (error) {
            if (!isMissing(error)) throw error;
        }
    }
}

function parseArguments(args: readonly string[]): {workspaceRoot: string; dryRun: boolean} {
    let workspaceRoot = "";
    let dryRun = true;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--workspace-root") {
            const value = args[index + 1];
            if (!value) throw new Error("--workspace-root需要目录路径。");
            workspaceRoot = path.resolve(value);
            index += 1;
        } else if (argument === "--write") {
            dryRun = false;
        } else if (argument === "--dry-run") {
            dryRun = true;
        } else {
            throw new Error(`未知参数：${argument ?? ""}`);
        }
    }
    if (!workspaceRoot) throw new Error("需要--workspace-root <root>。");
    return {workspaceRoot, dryRun};
}

function isMissing(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && (error as {code?: string}).code === "ENOENT";
}

if (import.meta.main) {
    const report = await normalizeCharacterFacets(process.argv.slice(2));
    console.info(JSON.stringify(report, null, 2));
}
