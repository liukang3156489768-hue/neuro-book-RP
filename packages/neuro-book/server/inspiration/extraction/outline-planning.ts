import type {OperationActor} from "@notnotype/nb-history";
import type {ReadyProjectSessionRef} from "nbook/server/workspace-files/project-session-types";
import type {OutlineEntry, OutlineId} from "nbook/server/outline/format";
import type {PlanningSnapshot} from "nbook/server/outline";
import {
    applyReadyLibraryAction, applyReadySourceExtractionDetail, openReadyPlanning, previewReadyPlanningObjectDeletion,
    previewReadyPlanningPlanRemoval, readReadyPlanningSnapshot, removeReadyPlanningObject, removeReadyPlanningPlan,
} from "nbook/server/outline/host";
import type {LibraryAction, SourceExtractionDetail} from "nbook/server/outline/library";
import {OutlineTransactionError} from "nbook/server/outline/transaction";

/**
 * 大纲提取流水线访问大纲库的端口。流水线只经这里读写，真实实现走 ready Project 的宿主入口
 * （mutation gate、工作区历史），测试用 `PlanningFixture` 的纯内存实现替换。
 */
export interface OutlinePlanningPort {
    snapshot(): Promise<PlanningSnapshot>;
    /** 提交一个领域动作；返回新建条目或方案的 ID。 */
    apply(action: LibraryAction): Promise<Readonly<{entryId?: OutlineId; planId?: string}>>;
    /** 写入以原文引用为依据的正式细纲。 */
    createDetail(input: SourceExtractionDetail): Promise<OutlineId>;
    /** 删除一个条目及其按 parentId 级联的子条目；总纲需要 `confirmedTotal`。 */
    removeEntry(entryId: OutlineId, options?: Readonly<{confirmedTotal?: boolean}>): Promise<void>;
    /** 解除方案（不删除条目文件）。 */
    removePlan(planId: string): Promise<void>;
}

/** 提取流水线写入大纲库时登记的来源，出现在工作区历史里。 */
export const EXTRACTION_ACTOR: OperationActor = {kind: "system", source: "inspiration-extraction"};

const MAX_REVISION_RETRIES = 3;

function isRevisionConflict(error: unknown): boolean {
    return error instanceof OutlineTransactionError && (error.code === "MANIFEST_REVISION_CONFLICT" || error.code === "CAS_CONFLICT");
}

/**
 * 每次提交都以刚读到的 manifest revision 为期望值。用户在提取期间编辑大纲会让 revision 前进，
 * 此时重读后重试；动作自身带有条目版本与内容哈希，真正的内容冲突仍会以领域错误暴露，不会被覆盖。
 */
async function withRevisionRetry<T>(readRevision: () => Promise<number>, run: (revision: number) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
        const revision = await readRevision();
        try {
            return await run(revision);
        } catch (error) {
            if (attempt < MAX_REVISION_RETRIES && isRevisionConflict(error)) continue;
            throw error;
        }
    }
}

export function createReadyOutlinePlanning(ready: ReadyProjectSessionRef): OutlinePlanningPort {
    // 从未打开过大纲工作台的项目没有 manifest，只读快照会报“尚未初始化”；首次读取走 `openReadyPlanning`
    // 完成初始化与事务恢复，之后每个单元都用不重建索引的轻量读取。
    let opened: Promise<unknown> | null = null;
    const snapshot = async () => {
        if (opened === null) opened = openReadyPlanning(ready).catch(error => { opened = null; throw error; });
        await opened;
        return readReadyPlanningSnapshot(ready);
    };
    const revision = async () => (await snapshot()).manifest.revision;
    return {
        snapshot,
        apply: action => withRevisionRetry(revision, async expected => {
            const result = await applyReadyLibraryAction(ready, action, expected, EXTRACTION_ACTOR);
            return {...(result.entryId ? {entryId: result.entryId} : {}), ...(result.planId ? {planId: result.planId} : {})};
        }),
        createDetail: input => withRevisionRetry(revision, async expected =>
            (await applyReadySourceExtractionDetail(ready, input, expected, EXTRACTION_ACTOR)).entryId),
        async removeEntry(entryId, options = {}) {
            await withRevisionRetry(revision, async () => {
                const preview = await previewReadyPlanningObjectDeletion(ready, entryId);
                if (preview.objectHash === null) return;
                await removeReadyPlanningObject(ready, entryId, preview.revision, preview.objectHash, options.confirmedTotal === true, EXTRACTION_ACTOR);
            });
        },
        async removePlan(planId) {
            await withRevisionRetry(revision, async () => {
                const preview = await previewReadyPlanningPlanRemoval(ready, planId);
                await removeReadyPlanningPlan(ready, planId, preview.revision, EXTRACTION_ACTOR);
            });
        },
    };
}

/** 快照里一个条目及其文件元数据（版本与内容哈希用于后续动作的 CAS）。 */
export type EntrySource = PlanningSnapshot["entries"][number];

export function entryOf(snapshot: PlanningSnapshot, entryId: OutlineId): EntrySource | undefined {
    return snapshot.entries.find(({value}) => value.id === entryId);
}

/** 方案的层级读法：总纲的子级可以是卷或直属章节；章节的文档顺序是 DFS 顺序。 */
export type PlanLayout = Readonly<{
    planId: string;
    planTitle: string;
    totalId: OutlineId;
    /** 总纲下的卷，按位置排序。 */
    volumeIds: readonly OutlineId[];
    /** 全部章节，按文档顺序（卷的顺序，卷内章节顺序；直属章节按其位置）。 */
    chapterIds: readonly OutlineId[];
    /** 某条目在本方案内的子级，按位置排序。 */
    childrenOf(entryId: OutlineId): readonly EntrySource[];
}>;

export function readPlanLayout(snapshot: PlanningSnapshot, planId: string): PlanLayout | null {
    const plan = snapshot.manifest.plans.find(item => item.id === planId);
    if (!plan) return null;
    const byId = new Map(snapshot.entries.map(source => [source.value.id, source] as const));
    const childrenOf = (entryId: OutlineId): EntrySource[] => plan.placements
        .filter(place => place.parentId === entryId)
        .sort((left, right) => left.position - right.position)
        .flatMap(place => byId.get(place.entryId) ?? []);
    const top = childrenOf(plan.totalId);
    const volumeIds = top.filter(({value}) => value.kind === "volume").map(({value}) => value.id);
    const chapterIds = top.flatMap(({value}) => value.kind === "volume"
        ? childrenOf(value.id).filter(child => child.value.kind === "chapter").map(child => child.value.id)
        : value.kind === "chapter" ? [value.id] : []);
    return {planId, planTitle: plan.title, totalId: plan.totalId, volumeIds, chapterIds, childrenOf};
}

/** 章节下的细纲，按位置排序。 */
export function detailsOfChapter(layout: PlanLayout, chapterId: OutlineId): readonly OutlineEntry[] {
    return layout.childrenOf(chapterId).filter(({value}) => value.kind === "detail").map(({value}) => value);
}

export function hasBody(entry: Pick<OutlineEntry, "body">): boolean {
    return entry.body.trim() !== "";
}
