import fs from "node:fs/promises";
import path from "node:path";
import {isAdaptationRecordPath, isMaterialBasePath} from "./adaptation-path";
import {resolveLorebookFile} from "nbook/server/inspiration/lorebook-path";
import {absoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {OutlineFormatError, serializeYaml, type OutlineEntry, type OutlineId, type OutlineManifest, type OutlineMaterialUpdate} from "./format";
import type {PlanningSnapshot} from "./index";
import {hashText, OutlineTransactionError, resolveOutlinePath, type OutlineFileMutation} from "./transaction";

/** 来源章节的顺序来自方案树；跨卷章节不能用全局 placement 数值或显示章号比较。 */
export function validateAdaptationAnchors(manifest: OutlineManifest, entries: readonly OutlineEntry[]): void {
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const sourceOrder = new Map<string, readonly OutlineId[]>();
    for (const entry of entries) {
        const origin = entry.adaptation;
        if (!origin) continue;
        const source = manifest.plans.find((plan) => plan.id === origin.sourcePlanId);
        const targets = manifest.plans.filter((plan) => plan.placements.some(({entryId}) => entryId === entry.id));
        const invalid = (message: string): never => {
            throw new OutlineFormatError(message, [{code: "INVALID_ADAPTATION", message, path: `outline:${entry.id}.adaptation`}]);
        };
        // 解除方案关系保留库条目，来源定位仍可供以后重新挂载，但不能挂回来源方案。
        if (!source || targets.some((plan) => plan.id === origin.sourcePlanId)) {
            invalid("改编章节的来源必须是不同且存在的方案");
        }
        let ordered = sourceOrder.get(origin.sourcePlanId);
        if (!ordered) {
            const children = new Map<OutlineId, OutlineManifest["plans"][number]["placements"][number][]>();
            for (const place of source!.placements) {
                if (place.parentId === null) continue;
                const siblings = children.get(place.parentId) ?? [];
                siblings.push(place);
                children.set(place.parentId, siblings);
            }
            const chapters: OutlineId[] = [];
            const visit = (id: OutlineId): void => {
                if (byId.get(id)?.kind === "chapter") chapters.push(id);
                for (const place of (children.get(id) ?? []).sort((a, b) => a.position - b.position)) visit(place.entryId);
            };
            visit(source!.totalId);
            sourceOrder.set(origin.sourcePlanId, chapters);
            ordered = chapters;
        }
        if (origin.kind === "chapter") {
            if (!ordered.includes(origin.sourceEntryId)) invalid("来源章节必须是来源方案内真实存在的章节大纲");
        } else {
            const before = ordered.indexOf(origin.beforeEntryId);
            const after = ordered.indexOf(origin.afterEntryId);
            if (before < 0 || after <= before) invalid("原创区间必须由来源方案内两个按剧情顺序排列的章节定位");
        }
    }
}

export function adaptationRecordPath(update: OutlineMaterialUpdate, planId: string, entryId: OutlineId): string {
    const directory = update.kind === "experience" ? "改编中的新经历"
        : update.kind === "relationship" ? "改编中的新人际关系" : "改编中的内容";
    const result = `${update.materialPath.slice(0, -"index.md".length)}${directory}/${planId}/${entryId}.md`;
    if (!isAdaptationRecordPath(result)) throw new OutlineTransactionError("INVALID_PATH", "改编记录的素材路径或方案 ID 无效");
    return result;
}

/** 只读生成受限记录变更；调用者可预览，真实发布仍在同一 mutation gate 内重新校验。 */
export async function preparePlanningMaterialMutations(
    projectRoot: string, previous: PlanningSnapshot, candidate: PlanningSnapshot,
): Promise<readonly OutlineFileMutation[]> {
    const before = desiredRecords(previous);
    const after = desiredRecords(candidate);
    const mutations: OutlineFileMutation[] = [];
    for (const relativePath of new Set([...before.keys(), ...after.keys()])) {
        const old = before.get(relativePath);
        const next = after.get(relativePath);
        if (old?.content === next?.content) continue;
        await assertMaterialObjectExists(projectRoot, (next ?? old)!.materialPath);
        const absolute = await resolveOutlinePath(projectRoot, relativePath);
        const actual = await fs.readFile(absolute, "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
        });
        const expectedHash = old ? hashText(old.content) : null;
        if ((actual === null ? null : hashText(actual)) !== expectedHash) {
            throw new OutlineTransactionError("CAS_CONFLICT", `改编记录已被外部修改或删除，请先核对：${relativePath}`);
        }
        mutations.push({relativePath, content: next?.content ?? null, expectedHash});
    }
    return mutations;
}

function desiredRecords(snapshot: PlanningSnapshot): Map<string, Readonly<{content: string; materialPath: string}>> {
    const records = new Map<string, Readonly<{content: string; materialPath: string}>>();
    const folded = new Set<string>();
    const byId = new Map(snapshot.entries.map((item) => [item.value.id, item]));
    for (const plan of snapshot.manifest.plans) {
        for (const place of plan.placements) {
            const source = byId.get(place.entryId);
            if (!source) continue;
            for (const update of source.value.materialUpdates ?? []) {
                const relativePath = adaptationRecordPath(update, plan.id, source.value.id);
                const key = relativePath.toLocaleLowerCase("en-US");
                if (folded.has(key)) throw new OutlineTransactionError("INVALID_PATH", `改编记录路径大小写冲突：${relativePath}`);
                folded.add(key);
                const origin = source.value.adaptation ?? (source.value.chapterId ? byId.get(source.value.chapterId)?.value.adaptation : undefined);
                const content = `---\n${serializeYaml({schema: "nbook.outline-material-plan/v1", status: "planned",
                    planId: plan.id, planTitle: plan.title, entryId: source.value.id, entryTitle: source.value.title,
                    entryVersion: source.value.version, entryPath: source.path, materialPath: update.materialPath, kind: update.kind,
                    ...(origin ? {adaptation: origin} : {})})}---\n\n# ${source.value.title}\n\n本记录属于「${plan.title}」的剧情计划，尚未发生；不改变素材基础资料与原作记录。\n\n${update.body}\n`;
                records.set(relativePath, {content, materialPath: update.materialPath});
            }
        }
    }
    return records;
}

async function assertMaterialObjectExists(projectRoot: string, relativePath: string): Promise<void> {
    if (!isMaterialBasePath(relativePath)) throw new OutlineTransactionError("INVALID_PATH", "只能使用已有角色、物品和地点的基础主文件");
    const resolved = await resolveLorebookFile(absoluteFsPath(projectRoot), relativePath).catch(() => null);
    if (!resolved || !resolved.canonicalPath.endsWith("/index.md")) {
        throw new OutlineTransactionError("INVALID_PATH", `素材不存在或不是项目内真实文件；请先到设计工作台创建：${relativePath}`);
    }
    let cursor = path.resolve(projectRoot);
    for (const segment of resolved.canonicalPath.split("/")) {
        cursor = path.join(cursor, segment);
        const stat = await fs.lstat(cursor).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
        });
        if (!stat || stat.isSymbolicLink() || (cursor.endsWith(`${path.sep}index.md`) ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) {
            throw new OutlineTransactionError("INVALID_PATH", `素材不存在或不是项目内真实文件；请先到设计工作台创建：${relativePath}`);
        }
    }
}
