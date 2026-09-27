import type {OutlineWorkbenchEntry, OutlineWorkbenchReference} from "nbook/app/composables/useOutlineWorkbenchData";

export type OutlineReferenceDraft = {path: string; locator: string; purpose: string; pending: boolean};

/** 表单态全部用字符串，避免输入框中途的空值被当成“清除字段”。 */
export type OutlineEntryFormValue = {
    title: string;
    body: string;
    targetWords: string;
    writingGuidance: string;
    materialRefs: string[];
    references: OutlineReferenceDraft[];
};

type EntryMetadataPayload = Readonly<{
    materialRefs?: readonly string[] | null;
    writingGuidance?: string | null;
    references?: readonly OutlineWorkbenchReference[] | null;
    targetWords?: number | null;
}>;

/** 交接给正文写作的资料只在章节大纲与细纲上编辑；其他层级保留文件原值。 */
export function entryHasHandoffMetadata(kind: OutlineWorkbenchEntry["kind"]): boolean {
    return kind === "chapter" || kind === "detail";
}

export function emptyEntryForm(): OutlineEntryFormValue {
    return {title: "", body: "", targetWords: "", writingGuidance: "", materialRefs: [], references: []};
}

export function entryToForm(entry: OutlineWorkbenchEntry): OutlineEntryFormValue {
    return {
        title: entry.title,
        body: entry.body,
        targetWords: entry.targetWords === undefined ? "" : String(entry.targetWords),
        writingGuidance: entry.writingGuidance ?? "",
        materialRefs: [...entry.materialRefs ?? []],
        references: (entry.references ?? []).map((item) => ({
            path: item.path ?? "", locator: item.locator ?? "", purpose: item.purpose ?? "", pending: item.pending === true,
        })),
    };
}

/**
 * 客户端只做会让请求必然失败的形状检查；路径合法性、重复路径等语义仍以服务端 parser 为准。
 * 返回 null 表示可以提交。
 */
export function validateEntryForm(form: OutlineEntryFormValue, withMetadata: boolean): string | null {
    if (!form.title.trim()) return "标题不能为空";
    if (!withMetadata) return null;
    const words = form.targetWords.trim();
    if (words && !/^[1-9]\d*$/u.test(words)) return "目标字数必须是正整数";
    for (const [index, item] of form.references.entries()) {
        const label = `第 ${index + 1} 条参考资料`;
        if (!item.path.trim() && !item.pending) return `${label}需要填写文件路径，或标记为待补资料`;
        if (!item.path.trim() && !item.locator.trim()) return `${label}是待补资料，请在“定位”里说明需要什么资料`;
    }
    return null;
}

function referencesOf(form: OutlineEntryFormValue): OutlineWorkbenchReference[] {
    return form.references.map((item) => {
        const path = item.path.trim();
        const locator = item.locator.trim();
        const purpose = item.purpose.trim();
        return {...path ? {path} : {}, ...locator ? {locator} : {}, ...purpose ? {purpose} : {}, ...item.pending ? {pending: true} : {}};
    });
}

/** 新建时空字段直接省略。 */
export function formToCreateMetadata(form: OutlineEntryFormValue): EntryMetadataPayload {
    const refs = form.materialRefs.map((item) => item.trim()).filter(Boolean);
    const guidance = form.writingGuidance.trim();
    const words = form.targetWords.trim();
    const references = referencesOf(form);
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
    const references = referencesOf(form);
    return {
        materialRefs: refs.length ? refs : null,
        writingGuidance: guidance || null,
        references: references.length ? references : null,
        targetWords: words ? Number(words) : null,
    };
}
