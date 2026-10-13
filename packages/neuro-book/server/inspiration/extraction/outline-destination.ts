import type {OutlineDestinationDto, OutlineExtractionParamsDto} from "nbook/shared/dto/inspiration-outline-extraction.dto";
import type {ExtractionSourceRef, ExtractionTask} from "nbook/shared/dto/inspiration-extraction-task.dto";
import type {PlanningSnapshot} from "nbook/server/outline";
import type {OutlineId} from "nbook/server/outline/format";
import {ExtractionTaskError} from "./errors";
import {
    chapterDisplayTitle, chapterVolumeIndex, volumeDisplayTitle, type OutlineState,
} from "./outline-params";
import {entryOf, hasBody, readPlanLayout, type OutlinePlanningPort, type PlanLayout} from "./outline-planning";

/**
 * 提取方案的命名、数据去向校验与结构预建。预建在 `prepare` 里执行，
 * 管理器只在唯一性与来源复核通过之后才调用它，所以重复确认不会产生第二个方案。
 */

const PLAN_TITLE_PATTERN = /^提取方案(\d+)[·・•.](.+)$/u;

/**
 * 同一作品的下一个提取方案标题。N 取该作品已有提取方案的最大序号加 1，而不是个数加 1：
 * 用户删除或改名中间的方案后，个数会与最大序号错位，按个数算会与现存方案重名或回退序号。
 * 标题仍冲突（用户手工起了同名方案）时继续递增。
 */
export function nextExtractionPlanTitle(existingTitles: readonly string[], workTitle: string): string {
    const name = workTitle.trim();
    let highest = 0;
    for (const title of existingTitles) {
        const match = PLAN_TITLE_PATTERN.exec(title.trim());
        if (match && match[2]!.trim() === name) highest = Math.max(highest, Number(match[1]));
    }
    const taken = new Set(existingTitles);
    let next = highest + 1;
    while (taken.has(`提取方案${next}·${name}`)) next += 1;
    return `提取方案${next}·${name}`;
}

/** 可作为“补充／覆盖”目标的方案及不可用的原因，供界面列出数据去向选项。 */
export type OutlineDestinationOption = Readonly<{
    planId: string;
    planTitle: string;
    /** 最近一次针对该方案的提取任务。 */
    taskId: string;
    /** 该方案最近一次提取时的来源哈希与当前来源是否一致；不一致只允许新建。 */
    sourceChanged: boolean;
    canSupplement: boolean;
    canOverwrite: boolean;
    reason: string | null;
}>;

function planIdOf(task: Pick<ExtractionTask, "state">): string | null {
    return typeof task.state.planId === "string" ? task.state.planId : null;
}

/** 某方案最近一次大纲提取任务记录；没有任务记录的方案不是提取方案。 */
function latestTaskOfPlan(tasks: readonly ExtractionTask[], planId: string): ExtractionTask | null {
    return tasks
        .filter(task => task.kind === "outline" && planIdOf(task) === planId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

export function listOutlineDestinations(input: Readonly<{
    snapshot: PlanningSnapshot;
    tasks: readonly ExtractionTask[];
    source: ExtractionSourceRef;
}>): OutlineDestinationOption[] {
    const options: OutlineDestinationOption[] = [];
    for (const plan of input.snapshot.manifest.plans) {
        const task = latestTaskOfPlan(input.tasks, plan.id);
        if (!task || task.source.path !== input.source.path) continue;
        const sourceChanged = task.source.sha256 !== input.source.sha256;
        options.push({
            planId: plan.id, planTitle: plan.title, taskId: task.id, sourceChanged,
            canSupplement: !sourceChanged, canOverwrite: !sourceChanged,
            reason: sourceChanged ? "作品文件内容已变化，章节划分可能不同，只能新建方案" : null,
        });
    }
    return options;
}

/** 校验数据去向并返回目标方案（新建返回 null）。不合法时抛 `INVALID_INPUT`，此时尚未写入任何内容。 */
export function assertDestinationAllowed(input: Readonly<{
    destination: OutlineDestinationDto;
    snapshot: PlanningSnapshot;
    tasks: readonly ExtractionTask[];
    source: ExtractionSourceRef;
}>): PlanLayout | null {
    const {destination} = input;
    if (destination.kind === "new") return null;
    const layout = readPlanLayout(input.snapshot, destination.planId);
    if (!layout) throw new ExtractionTaskError("INVALID_INPUT", "目标方案不存在，请重新选择数据去向。");
    const task = latestTaskOfPlan(input.tasks, destination.planId);
    if (!task) throw new ExtractionTaskError("INVALID_INPUT", `方案「${layout.planTitle}」不是由大纲提取创建的，不能补充或覆盖，只能新建方案。`);
    if (task.source.path !== input.source.path) {
        throw new ExtractionTaskError("INVALID_INPUT", `方案「${layout.planTitle}」提取自另一部作品（${task.source.path}），不能补充或覆盖。`);
    }
    if (task.source.sha256 !== input.source.sha256) {
        throw new ExtractionTaskError("INVALID_INPUT", "作品文件内容已变化，章节划分可能不同，只允许新建方案。");
    }
    return layout;
}

/** 预建失败时尽力撤销刚建的方案；失败只记入原错误的说明，不掩盖原因。 */
async function discardPlan(port: OutlinePlanningPort, planId: string, totalId: OutlineId): Promise<string | null> {
    try {
        await port.removePlan(planId);
        await port.removeEntry(totalId, {confirmedTotal: true});
        return null;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

async function buildNewSkeleton(port: OutlinePlanningPort, params: OutlineExtractionParamsDto): Promise<OutlineState> {
    const {structure, workTitle} = params;
    let created: Readonly<{planId: string; totalId: OutlineId; title: string}> | null = null;
    // 同名标题只可能来自并发新建；重读快照重新取号，最多尝试几次。
    for (let attempt = 0; created === null; attempt += 1) {
        const title = nextExtractionPlanTitle((await port.snapshot()).manifest.plans.map(plan => plan.title), workTitle);
        try {
            const result = await port.apply({kind: "create-plan", title});
            created = {planId: result.planId!, totalId: result.entryId!, title};
        } catch (error) {
            if (attempt >= 3 || !(error instanceof Error) || !error.message.includes("同名")) throw error;
        }
    }
    const {planId, totalId, title} = created;
    try {
        const volumeIds: OutlineId[] = [];
        for (const volume of structure.volumes) {
            const result = await port.apply({kind: "create-entry", planId, parentId: totalId, entryKind: "volume", title: volumeDisplayTitle(volume), body: ""});
            volumeIds.push(result.entryId!);
        }
        const chapterIds: OutlineId[] = [];
        for (const chapter of structure.chapters) {
            const parentId = volumeIds[chapterVolumeIndex(structure.volumes, chapter.index) - 1]!;
            const result = await port.apply({kind: "create-entry", planId, parentId, entryKind: "chapter", title: chapterDisplayTitle(chapter), body: ""});
            chapterIds.push(result.entryId!);
        }
        return {destination: "new", planId, planTitle: title, totalId, volumeIds, chapterIds, volumesWithBody: [], totalHadBody: false, unmappedChapters: []};
    } catch (error) {
        const rollback = await discardPlan(port, planId, totalId);
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`创建提取方案「${title}」的空结构失败：${reason}${rollback === null ? "（已撤销刚建的方案）" : `（撤销方案也失败：${rollback}，请在大纲库手动删除该方案）`}`, {cause: error});
    }
}

/** 补充与覆盖都按序号对应：结构第 i 章对应方案文档顺序的第 i 个章节，第 v 卷对应总纲下第 v 个卷。 */
async function mapExistingPlan(
    port: OutlinePlanningPort, layout: PlanLayout, params: OutlineExtractionParamsDto, mayCreate: boolean,
): Promise<OutlineState> {
    const {structure} = params;
    const snapshot = await port.snapshot();
    const body = (id: OutlineId) => {
        const source = entryOf(snapshot, id);
        return source !== undefined && hasBody(source.value);
    };
    const volumeIds = [...layout.volumeIds].slice(0, structure.volumes.length);
    const volumesWithBody = volumeIds.flatMap((id, position) => body(id) ? [position + 1] : []);
    const totalHadBody = body(layout.totalId);
    if (mayCreate) {
        // 补充只会新增缺失的卷与章节；覆盖在用户确认前不写入任何内容，所以不建缺失结构。
        for (const volume of structure.volumes.slice(volumeIds.length)) {
            const result = await port.apply({kind: "create-entry", planId: layout.planId, parentId: layout.totalId, entryKind: "volume", title: volumeDisplayTitle(volume), body: ""});
            volumeIds.push(result.entryId!);
        }
    }
    const chapterIds = [...layout.chapterIds].slice(0, structure.chapters.length);
    const unmappedChapters: number[] = [];
    for (const chapter of structure.chapters.slice(chapterIds.length)) {
        if (!mayCreate) { unmappedChapters.push(chapter.index); continue; }
        const parentId = volumeIds[chapterVolumeIndex(structure.volumes, chapter.index) - 1]!;
        const result = await port.apply({kind: "create-entry", planId: layout.planId, parentId, entryKind: "chapter", title: chapterDisplayTitle(chapter), body: ""});
        chapterIds.push(result.entryId!);
    }
    return {
        destination: mayCreate ? "supplement" : "overwrite",
        planId: layout.planId, planTitle: layout.planTitle, totalId: layout.totalId,
        volumeIds, chapterIds, volumesWithBody, totalHadBody, unmappedChapters,
    };
}

/** 按数据去向建立（或定位）提取方案，返回写入任务 `state` 的方案信息。 */
export async function prepareOutlinePlan(input: Readonly<{
    port: OutlinePlanningPort;
    params: OutlineExtractionParamsDto;
    source: ExtractionSourceRef;
    tasks: readonly ExtractionTask[];
}>): Promise<OutlineState> {
    const {port, params, source, tasks} = input;
    const layout = assertDestinationAllowed({destination: params.destination, snapshot: await port.snapshot(), tasks, source});
    if (params.destination.kind === "new" || layout === null) return buildNewSkeleton(port, params);
    return mapExistingPlan(port, layout, params, params.destination.kind === "supplement");
}
