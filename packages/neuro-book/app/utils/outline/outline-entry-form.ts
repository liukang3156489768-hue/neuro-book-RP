import type {OutlineWorkbenchEntry, OutlineWorkbenchMaterialUpdate, OutlineWorkbenchReference} from "nbook/app/composables/useOutlineWorkbenchData";

export type OutlineReferenceDraft = {path: string; locator: string; purpose: string; pending: boolean};
export type OutlineMaterialUpdateDraft = {-readonly [K in keyof OutlineWorkbenchMaterialUpdate]: OutlineWorkbenchMaterialUpdate[K]};

/** 表单态全部用字符串，避免输入框中途的空值被当成“清除字段”。 */
export type OutlineEntryFormValue = {
    title: string;
    body: string;
    targetWords: string;
    writingGuidance: string;
    materialRefs: string[];
    references: OutlineReferenceDraft[];
    /** undefined 表示原条目没有该字段；清空数组表示用户主动移除全部关联信息。 */
    materialUpdates?: OutlineMaterialUpdateDraft[];
    materialUpdatesReviewed: boolean;
};

type EntryMetadataPayload = Readonly<{
    materialRefs?: readonly string[] | null;
    writingGuidance?: string | null;
    references?: readonly OutlineWorkbenchReference[] | null;
    targetWords?: number | null;
}>;

/**
 * 交接给正文写作的资料只在章节大纲上用表单编辑。细纲的字数、写作指导和参考资料都写在正文模板里，
 * 其他层级保留文件原值。
 */
export function entryHasHandoffMetadata(kind: OutlineWorkbenchEntry["kind"]): boolean {
    return kind === "chapter";
}

export function emptyEntryForm(): OutlineEntryFormValue {
    return {title: "", body: "", targetWords: "", writingGuidance: "", materialRefs: [], references: [], materialUpdatesReviewed: true};
}

export function entryToForm(entry: OutlineWorkbenchEntry): OutlineEntryFormValue {
    return {
        title: entry.title,
        body: entry.body,
        targetWords: entry.targetWords === undefined ? "" : String(entry.targetWords),
        writingGuidance: entry.writingGuidance ?? "",
        materialRefs: [...entry.materialRefs ?? []],
        references: (entry.references ?? []).map(referenceDraftOf),
        ...(entry.materialUpdates === undefined ? {} : {materialUpdates: entry.materialUpdates.map((item) => ({...item}))}),
        materialUpdatesReviewed: true,
    };
}

/**
 * 正文里重复出现的伏笔标记 marker。富文本序列化在格式与标记部分重叠时会把标记断成两段写出，
 * 服务端会以重复 marker 整篇拒绝；保存前拦下，让作者先调整格式。
 */
export function duplicateOutlineMarkers(body: string): string[] {
    const counts = new Map<string, number>();
    for (const matched of body.matchAll(/<!--\s*nb:foreshadow\s+marker="([^"]+)"/gu)) {
        counts.set(matched[1]!, (counts.get(matched[1]!) ?? 0) + 1);
    }
    return [...counts].flatMap(([marker, count]) => count > 1 ? [marker] : []);
}

/**
 * 客户端只做会让请求必然失败的形状检查；路径合法性、重复路径等语义仍以服务端 parser 为准。
 * 返回 null 表示可以提交。
 */
export function validateEntryForm(form: OutlineEntryFormValue, withMetadata: boolean): string | null {
    if (!form.title.trim()) return "标题不能为空";
    if (duplicateOutlineMarkers(form.body).length) return "有伏笔标记被加粗等格式截成了两段，请让格式完整包含标记或位于标记之内";
    if (form.materialUpdates?.some((item) => !item.body.trim())) return "关联新信息不能为空；不再需要时请移除该条信息";
    if (form.materialUpdates?.length && !form.materialUpdatesReviewed) return "请核对关联新信息与当前正文一致，并勾选确认后保存";
    if (!withMetadata) return null;
    const words = form.targetWords.trim();
    if (words && !/^[1-9]\d*$/u.test(words)) return "目标字数必须是正整数";
    for (const [index, item] of form.references.entries()) {
        const problem = referenceProblem(item);
        if (problem) return `第 ${index + 1} 条参考资料${problem}`;
    }
    return null;
}

/** 所有规划层级的关联信息独立于章节交接资料；空数组明确撤下记录。 */
export function formToMaterialUpdates(form: OutlineEntryFormValue): Readonly<{materialUpdates?: readonly OutlineWorkbenchMaterialUpdate[] | null}> {
    return form.materialUpdates === undefined ? {} : {
        materialUpdates: form.materialUpdates.length ? form.materialUpdates.map((item) => ({...item, body: item.body.trim()})) : null,
    };
}

function referenceProblem(item: OutlineReferenceDraft): string | null {
    if (!item.path.trim() && !item.pending) return "需要填写文件路径，或标记为待补资料";
    if (!item.path.trim() && !item.locator.trim()) return "是待补资料，请在“定位”里说明需要什么资料";
    return null;
}

function referenceDraftOf(item: OutlineWorkbenchReference): OutlineReferenceDraft {
    return {path: item.path ?? "", locator: item.locator ?? "", purpose: item.purpose ?? "", pending: item.pending === true};
}

function referencePayloadOf(item: OutlineReferenceDraft): OutlineWorkbenchReference {
    const path = item.path.trim();
    const locator = item.locator.trim();
    const purpose = item.purpose.trim();
    return {...path ? {path} : {}, ...locator ? {locator} : {}, ...purpose ? {purpose} : {}, ...item.pending ? {pending: true} : {}};
}

/** 新建时空字段直接省略。 */
export function formToCreateMetadata(form: OutlineEntryFormValue): EntryMetadataPayload {
    const refs = form.materialRefs.map((item) => item.trim()).filter(Boolean);
    const guidance = form.writingGuidance.trim();
    const words = form.targetWords.trim();
    const references = form.references.map(referencePayloadOf);
    return {
        ...refs.length ? {materialRefs: refs} : {},
        ...guidance ? {writingGuidance: guidance} : {},
        ...references.length ? {references} : {},
        ...words ? {targetWords: Number(words)} : {},
    };
}

/** 编辑时空字段发送 null，由服务端从文件中移除；与新建的“省略”语义不同。 */
export function formToEditMetadata(form: OutlineEntryFormValue): EntryMetadataPayload {
    const refs = form.materialRefs.map((item) => item.trim()).filter(Boolean);
    const guidance = form.writingGuidance.trim();
    const words = form.targetWords.trim();
    const references = form.references.map(referencePayloadOf);
    return {
        materialRefs: refs.length ? refs : null,
        writingGuidance: guidance || null,
        references: references.length ? references : null,
        targetWords: words ? Number(words) : null,
    };
}
