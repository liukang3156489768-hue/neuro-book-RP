import type {ExtractionPromptParts} from "./types";

const SECTION_SEPARATOR = "\n\n";
/** 写入预留位的校验错误上限；上次产出不截断，模型需要它才能就地修正。 */
const REPAIR_ERROR_MAX_CHARACTERS = 4000;

/** 修复重试写入预留位的内容。 */
export type RepairSlot = Readonly<{previousOutput: string; error: string}>;

/**
 * 提示词 = 前缀（本单元原文）+ 追加材料 + 任务目标 + 预留位（平时为空）。
 *
 * 缓存合同：前缀位于提示词最开头，且不加任何包装，所以同一单元不同类别、不同任务只要传入相同的 `prefix`，
 * 请求的开头就逐字节一致；预留位只追加在末尾，且为空时不留分隔符，因此首次请求的提示词
 * 恰是修复重试提示词的严格前缀。改动这里的拼接方式会让前缀缓存整体失效。
 */
export function buildExtractionPrompt(parts: ExtractionPromptParts, repair?: RepairSlot): string {
    if (!parts.prefix) throw new Error("提取提示词的前缀（本单元原文）不能为空");
    if (!parts.goal) throw new Error("提取提示词的任务目标不能为空");
    const sections = [parts.prefix, ...(parts.supplements ?? []).filter(section => section !== ""), parts.goal];
    if (repair) sections.push(renderRepairSlot(repair));
    return sections.join(SECTION_SEPARATOR);
}

function renderRepairSlot(repair: RepairSlot): string {
    const error = repair.error.length > REPAIR_ERROR_MAX_CHARACTERS
        ? `${repair.error.slice(0, REPAIR_ERROR_MAX_CHARACTERS)}……（已截断）`
        : repair.error;
    return [
        "【上一次产出未通过校验】",
        "上一次产出：",
        repair.previousOutput,
        "校验错误：",
        error,
        "请只修正上述错误，按任务目标重新完整输出。",
    ].join("\n");
}

/**
 * 把一个单元的段落渲染为提示词前缀。每段以 `【P编号】` 开头，模型引用原文时使用同一编号，
 * 校验再按编号核对范围。渲染是确定性的：同样的段落总是得到同样的字符串。
 */
export function renderSourcePrefix(paragraphs: readonly Readonly<{id: string; text: string}>[]): string {
    if (paragraphs.length === 0) throw new Error("提取单元的原文段落不能为空");
    return `【原文】每段以【P编号】开头。\n${paragraphs.map(paragraph => `【${paragraph.id}】${paragraph.text.trimEnd()}`).join("\n")}`;
}
