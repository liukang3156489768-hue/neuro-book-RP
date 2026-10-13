import {createHash} from "node:crypto";
import fs from "node:fs/promises";
import {z} from "zod";
import {parseMarkdownDocument, renderMarkdownDocument, type WorkspaceFrontmatter} from "nbook/server/workspace-files/workspace-files";
import {readPlanningSnapshot} from "nbook/server/outline";
import type {
    CharacterDetailRecordDto,
    CharacterFacetDto,
    CharacterPlanDto,
    CharacterProfileDto,
    CharacterRecordDto,
    CharacterStateDto,
    CharacterWorkspaceSnapshotDto,
} from "nbook/shared/dto/character-workspace.dto";
import {absoluteFsPath, assertRealPathContained, resolveContainedFilePath, type AbsoluteFsPath} from "nbook/server/runtime/paths/file-path";

const CHARACTER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const recordSchema = z.object({
    id: z.string(), title: z.string(), content: z.string(), source: z.string(), targetId: z.string(),
    unknown: z.string(), misunderstanding: z.string(),
}).strict();
const stateSchema = z.object({chapter: z.string(), location: z.string(), items: z.string(), psychology: z.string()}).strict();

export const EMPTY_CHARACTER_STATE: CharacterStateDto = {chapter: "", location: "", items: "", psychology: ""};
export const EMPTY_CHARACTER_FACET: CharacterFacetDto = {experience: [], relationships: [], knowledge: [], state: EMPTY_CHARACTER_STATE};

type ParsedFile = {content: string; frontmatter: WorkspaceFrontmatter; body: string; mtimeMs: number; path: string};
type FileRef = {path: string; mtimeMs: number | null};
type CharacterFiles = CharacterRecordDto["files"];

function safeId(id: string, kind: "character" | "plan"): void {
    if (!(kind === "character" ? CHARACTER_ID : PLAN_ID).test(id)) throw new Error(`${kind} id 无效`);
}
function rel(...parts: string[]): string { return parts.join("/"); }
function profilePath(id: string): string { return rel("lorebook", "character", id, "index.md"); }
function facetPath(id: string, scope: string, kind: string): string {
    return rel("lorebook", "character", id, scope === "original" ? "original" : "plans", ...(scope === "original" ? [] : [scope]), kind === "knowledge" ? "knowledge/index.md" : `${kind}.md`);
}
function emptyFiles(): CharacterFiles { return {profile: null, original: {}, plans: {}}; }
function emptyRecord(id: string, issue?: string): CharacterRecordDto { return {id, profile: null, original: structuredClone(EMPTY_CHARACTER_FACET), plans: {}, issue, files: emptyFiles()}; }

async function readOptional(root: AbsoluteFsPath, relativePath: string): Promise<ParsedFile | null> {
    const target = resolveContainedFilePath(root, relativePath);
    await assertRealPathContained(root, target);
    try {
        const [content, stat] = await Promise.all([fs.readFile(target, "utf8"), fs.stat(target)]);
        const parsed = parseMarkdownDocument(content);
        if (parsed.error) throw new Error(`${relativePath}: ${parsed.error}`);
        return {content, frontmatter: parsed.frontmatter, body: parsed.body, mtimeMs: stat.mtimeMs, path: relativePath};
    } catch (error) {
        if (isMissing(error)) return null;
        throw error;
    }
}
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as {code?: string}).code === "ENOENT"; }
function ref(file: ParsedFile | null): FileRef | null { return file ? {path: file.path, mtimeMs: file.mtimeMs} : null; }

function profileFrom(file: ParsedFile): CharacterProfileDto {
    const fm = file.frontmatter;
    const ext = isRecord(fm.ext) && isRecord(fm.ext.character) ? fm.ext.character : {};
    const profile = isRecord(ext.profile) ? ext.profile : {};
    const meta = isRecord(ext.meta) ? ext.meta : {};
    const stringValue = (value: unknown): string => typeof value === "string" ? value : "";
    const listValue = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    const name = stringValue(fm.title) || stringValue(fm.name);
    const id = stringValue(fm.id);
    if (!name.trim() || fm.type !== "character" || !id) throw new Error(`${file.path}: 需要角色 id、type: character 和 title`);
    if (meta.avatar && (typeof meta.avatar !== "string" || !/^avatars?\/[a-f0-9]{64}\.(png|jpg|webp)$/u.test(meta.avatar) && !/^avatar\.(png|jpg|webp)$/u.test(meta.avatar))) throw new Error(`${file.path}: 头像必须是角色目录内的相对路径`);
    return {
        id,
        name,
        aliases: listValue(fm.aliases),
        tags: listValue(fm.tags),
        summary: stringValue(fm.summary) || file.body.trim().replace(/^# .*\r?\n?/u, "").trim(),
        identity: stringValue(profile.identity), appearance: stringValue(profile.appearance),
        clothing: stringValue(profile.clothingStyle ?? profile.clothing), family: stringValue(profile.family),
        economy: stringValue(profile.economy), abilities: stringValue(profile.abilities),
        personality: stringValue(profile.personalityTraits ?? profile.personality), temperament: stringValue(profile.temperament),
        avatar: stringValue(meta.avatar), avatarUrl: "",
    };
}

function facetFrom(files: Partial<Record<string, ParsedFile>>): CharacterFacetDto {
    const result: CharacterFacetDto = structuredClone(EMPTY_CHARACTER_FACET);
    for (const kind of ["experience", "relationships", "knowledge"] as const) {
        const file = files[kind];
        if (!file) continue;
        const records = file.frontmatter.records;
        if (Array.isArray(records)) {
            result[kind] = z.array(recordSchema).parse(records);
        } else {
            // 提取器早期版本把记录写在 Markdown 正文，未同步生成 frontmatter.records。
            // 先按正文回退读取，保证已有资料可用；保存或迁移时会补齐规范化数组。
            result[kind] = parseLegacyFacetRecords(file.body, kind, file.path);
        }
    }
    const state = files.state?.frontmatter.state;
    if (files.state) result.state = stateSchema.parse(state);
    return result;
}

type LegacyFacetKind = "experience" | "relationships" | "knowledge";

/** 将旧版“二级条目 + 三级字段”正文还原为角色页使用的记录结构。 */
function parseLegacyFacetRecords(body: string, kind: LegacyFacetKind, filePath: string): CharacterDetailRecordDto[] {
    const sections = body.split(/(?=^##\s+)/mu).filter(section => /^##\s+/mu.test(section));
    return sections.map((section, index) => {
        const heading = /^##\s+(.+?)\s*$/mu.exec(section)?.[1]?.trim() ?? `第 ${index + 1} 条`;
        const fields = new Map<string, string>();
        const fieldMatches = [...section.matchAll(/^###\s+(.+?)\s*\r?\n([\s\S]*?)(?=^###\s+|$)/gmu)];
        for (const match of fieldMatches) fields.set(match[1]!.trim(), match[2]!.trim());
        const targetId = kind === "relationships" ? fields.get("关联角色") ?? "" : "";
        const content = fields.get(kind === "relationships" ? "关系描述" : "经历描述")
            ?? [...fields.entries()].filter(([name]) => name !== "参考片段").map(([, value]) => value).filter(Boolean).join("\n\n");
        const source = fields.get("参考片段") ?? "";
        const id = createHash("sha256").update(`${filePath}\n${index}\n${heading}\n${content}`, "utf8").digest("hex").slice(0, 24);
        return {id, title: fields.get(kind === "relationships" ? "关联角色" : "阶段名称") || heading, content, source, targetId,
            unknown: fields.get("未知／信息差") ?? fields.get("未知/信息差") ?? "", misunderstanding: fields.get("误解") ?? ""};
    });
}

/** 为一次性修复或保存前规范化旧正文；已有 records 时保持原文不变。 */
export function normalizeLegacyCharacterFacetDocument(content: string, kind: LegacyFacetKind, filePath: string): string {
    const parsed = parseMarkdownDocument(content);
    if (parsed.error || Array.isArray(parsed.frontmatter.records)) return content;
    const records = parseLegacyFacetRecords(parsed.body, kind, filePath);
    return renderMarkdownDocument({...parsed.frontmatter, records}, parsed.body);
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

async function readFacet(root: AbsoluteFsPath, id: string, scope: string): Promise<{facet: CharacterFacetDto; files: Record<string, FileRef>}> {
    const loaded: Partial<Record<string, ParsedFile>> = {};
    const refs: Record<string, FileRef> = {};
    for (const kind of ["experience", "relationships", "knowledge", "state"] as const) {
        const file = await readOptional(root, facetPath(id, scope, kind));
        if (file) { loaded[kind] = file; refs[kind] = ref(file)!; }
    }
    return {facet: facetFrom(loaded), files: refs};
}

export async function readCharacterWorkspace(rootInput: AbsoluteFsPath): Promise<CharacterWorkspaceSnapshotDto> {
    const root = absoluteFsPath(rootInput);
    const characterRoot = resolveContainedFilePath(root, rel("lorebook", "character"));
    await assertRealPathContained(root, characterRoot);
    let entries: import("node:fs").Dirent[] = [];
    try { entries = await fs.readdir(characterRoot, {withFileTypes: true}); } catch (error) { if (!isMissing(error)) throw error; }
    const characters: CharacterRecordDto[] = [];
    for (const entry of entries.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))) {
        const id = entry.name;
        if (!CHARACTER_ID.test(id)) { characters.push(emptyRecord(id, "角色目录名不符合安全格式")); continue; }
        try {
            const profileFile = await readOptional(root, profilePath(id));
            if (!profileFile) { characters.push(emptyRecord(id, "缺少 index.md，无法作为正式角色读取")); continue; }
            const profile = profileFrom(profileFile);
            if (profile.id && profile.id !== id) throw new Error(`index.md 的 id 与目录不一致：${profile.id}`);
            profile.id = id;
            const original = await readFacet(root, id, "original");
            const plans: Record<string, CharacterFacetDto> = {};
            const planFiles: CharacterFiles["plans"] = {};
            const plansRoot = resolveContainedFilePath(root, rel("lorebook", "character", id, "plans"));
            await assertRealPathContained(root, plansRoot);
            let planEntries: import("node:fs").Dirent[] = [];
            try { planEntries = await fs.readdir(plansRoot, {withFileTypes: true}); } catch (error) { if (!isMissing(error)) throw error; }
            for (const planEntry of planEntries.filter(item => item.isDirectory())) {
                if (!PLAN_ID.test(planEntry.name)) continue;
                const loaded = await readFacet(root, id, planEntry.name);
                if (Object.keys(loaded.files).length) { plans[planEntry.name] = loaded.facet; planFiles[planEntry.name] = loaded.files; }
            }
            const files: CharacterFiles = {profile: ref(profileFile), original: original.files, plans: planFiles};
            characters.push({id, profile, original: original.facet, plans, files});
        } catch (error) { characters.push(emptyRecord(id, error instanceof Error ? error.message : "角色文件格式无效")); }
    }
    let plans: CharacterPlanDto[] = [];
    try {
        const snapshot = await readPlanningSnapshot({projectRoot: root});
        plans = snapshot.manifest.plans.map((item: {id: string; title: string}) => ({id: item.id, title: item.title}));
    } catch { /* 角色页面仍可查看文件，规划库损坏不应让角色页崩溃。 */ }
    return {plans, characters};
}

export function serializeCharacterProfile(profile: CharacterProfileDto, previous: ParsedFile | null): string {
    const current = previous?.frontmatter ?? {};
    const ext = isRecord(current.ext) ? current.ext : {};
    const character = isRecord(ext.character) ? ext.character : {};
    const profileExt = isRecord(character.profile) ? character.profile : {};
    const meta = isRecord(character.meta) ? character.meta : {};
    const frontmatter: WorkspaceFrontmatter = {
        ...current, id: profile.id, type: "character", title: profile.name, aliases: profile.aliases, tags: profile.tags, summary: profile.summary,
        ext: {...ext, character: {...character, profile: {...profileExt, identity: profile.identity, appearance: profile.appearance, clothingStyle: profile.clothing, family: profile.family, economy: profile.economy, abilities: profile.abilities, personalityTraits: profile.personality, temperament: profile.temperament}, meta: {...meta, avatar: profile.avatar || null}}},
    };
    return renderMarkdownDocument(frontmatter, previous?.body ?? `# ${profile.name}\n\n${profile.summary}\n`);
}

export function serializeCharacterFacet(kind: "experience" | "relationships" | "knowledge" | "state", facet: CharacterFacetDto, previous: ParsedFile | null): string {
    const frontmatter = previous?.frontmatter ?? {};
    if (kind === "state") return renderMarkdownDocument({...frontmatter, state: facet.state}, previous?.body ?? "# 正文状态追踪\n");
    const titles = {experience: "角色经历", relationships: "人际关系", knowledge: "角色知识"};
    const body = facet[kind].map(item => `## ${item.title}\n\n${[item.content, item.targetId && `关联角色：${item.targetId}`, item.unknown && `未知／信息差：${item.unknown}`, item.misunderstanding && `误解：${item.misunderstanding}`, item.source && `来源：${item.source}`].filter(Boolean).join("\n\n")}`).join("\n\n");
    return renderMarkdownDocument({...frontmatter, kind, records: facet[kind]}, `# ${titles[kind]}\n\n${body}\n`);
}

export async function readCharacterFile(root: AbsoluteFsPath, relativePath: string): Promise<ParsedFile | null> { return readOptional(root, relativePath); }
export function characterFacetPath(id: string, scope: string, kind: string): string { safeId(id, "character"); if (scope !== "original") safeId(scope, "plan"); return facetPath(id, scope, kind); }
export function characterProfilePath(id: string): string { safeId(id, "character"); return profilePath(id); }
