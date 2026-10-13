import {CITATION_MARKER, formatRange, type ChapterParagraphRange} from "./outline-validation";
import {extractionDetailTemplate} from "nbook/shared/outline-detail-structure";

/**
 * 大纲提取的提示词文本。
 *
 * 缓存合同：同一章的细纲与章节大纲共用同一份系统提示（供应商前缀缓存包含系统消息），
 * 差异只放在提示词末尾的任务目标里。卷纲与总纲不读原文，使用另一份系统提示。
 */

export const CHAPTER_SYSTEM_PROMPT = [
    "你是小说结构分析助手，把一章作品原文提取为可供改编和续写使用的大纲材料。",
    "通用规则：",
    "1. 只依据给定原文提取，不补写、不推测、不评价；原文没有的信息不要编造。",
    "2. 原文每段以【P编号】开头。依据的原文段落只写在输出末尾的引用行里，正文不要出现 P 编号，也不要大段抄写原文。",
    "3. 直接输出 Markdown 正文，不要寒暄或解释；可以整体用代码块包裹。",
    `4. 正文之后另起一行，写“${CITATION_MARKER}P3-P8、P12”形式的引用行，范围必须在本章段落之内。`,
].join("\n");

export const SUMMARY_SYSTEM_PROMPT = [
    "你是小说结构分析助手，把下级大纲汇总为更高一层的大纲。",
    "通用规则：",
    "1. 只依据给定的下级大纲汇总，不引入它们没有的情节；标注“缺失”的部分如实说明缺失，不要猜测补写。",
    "2. 聚焦宏观结构，不罗列具体场景与对话。",
    "3. 直接输出 Markdown 正文，不要寒暄或解释；可以整体用代码块包裹。不需要原文引用。",
].join("\n");

const DETAIL_TEMPLATE = extractionDetailTemplate();

export function detailGoal(range: ChapterParagraphRange): string {
    return [
        "【任务】提取本章的细纲：把本章原文还原为可供重写的场景级细纲。",
        "- 严格使用下面的模板；一级标题只能是“章节总览”“章节细纲”“禁止事项”，场景用二级标题，场景内小节用三级标题。",
        "- 每个场景都必须有场景简述、字数要求、人称要求，以及至少一条具体情节。目标字数和每个场景的字数要求必须填写阿拉伯数字正整数，例如 5000；不要填写区间、中文数字、约数或原文段落范围。",
        "- 不要写“伏笔”和“参考资料”小节；伏笔相关的情节照常写进具体情节。模板中没有这两个小节，不要自行添加。",
        "- 场景地点简述实际位置、移动顺序及相关环境；角色服饰与外观状态记录原文明确的穿着与外貌，不把缺失信息补造出来。",
        "- 参与角色按“- 姓名：目的”书写，可缩进补充当前状态与外貌要求；只保留原文信息，素材未生成时不编造角色或地点文件链接。",
        "- 填写场景名称，编号从1连续；无相关内容的可选小节省略。最后一条具体情节就是本场景结束位置。一级标题和二级场景标题必须保留，不能改成普通文本。",
        `- 引用：正文之后另起一行写“${CITATION_MARKER}”加依据的 P 编号，只能引用本章范围 ${formatRange(range)} 内的段落。`,
        "模板：",
        DETAIL_TEMPLATE,
    ].join("\n");
}

const CHAPTER_OUTLINE_TEMPLATE = [
    "# 章节目标",
    "",
    "本章要达成的故事目标。",
    "",
    "# 场景设定",
    "",
    "本章发生的关键场景与人物。",
    "",
    "# 剧情概要",
    "",
    "本章情节的发展经过。",
    "",
    "# 章节结尾",
    "",
    "本章结束时的状态与悬念。",
].join("\n");

/** 章节大纲的细纲材料作为追加材料放在原文之后；细纲被跳过时没有这一段。 */
export function chapterOutlineGoal(range: ChapterParagraphRange, hasDetail: boolean): string {
    return [
        "【任务】提取本章的章节大纲：概括本章要达成的目标、场景、剧情与结尾。",
        hasDetail
            ? "- 上面附有本章已提取的细纲，保持与它一致；细纲是对原文场景的展开，章节大纲更概括。"
            : "- 本章没有可用的细纲（提取失败后被跳过），请直接依据原文概括。",
        "- 严格使用下面的模板；四个一级标题都必须出现且有内容。不写场景细节与对话。",
        `- 引用：正文之后另起一行写“${CITATION_MARKER}”加依据的 P 编号，只能引用本章范围 ${formatRange(range)} 内的段落。`,
        "模板：",
        CHAPTER_OUTLINE_TEMPLATE,
    ].join("\n");
}

export function renderDetailSupplement(detailBody: string): string {
    return `【本章已提取的细纲】\n${detailBody.trim()}`;
}

const VOLUME_TEMPLATE = [
    "# 本卷目标",
    "",
    "本卷需要达成的故事目标。",
    "",
    "# 起始状态",
    "",
    "本卷开始时的人物与世界状态。",
    "",
    "# 核心冲突",
    "",
    "本卷的主要矛盾。",
    "",
    "# 结束状态",
    "",
    "本卷结束时的人物与世界状态。",
].join("\n");

const TOTAL_TEMPLATE = [
    "# 核心冲突",
    "",
    "作品的核心矛盾。",
    "",
    "# 主题",
    "",
    "作品想表达的主题。",
    "",
    "# 主要阶段",
    "",
    "## 第一阶段：阶段名",
    "该阶段的主要目标与转折。",
    "",
    "# 结局方向",
    "",
    "作品的结局与最终状态。",
].join("\n");

/** 汇总输入的一项；`body` 为 null 表示该章或该卷缺失（提取失败或已被跳过）。 */
export type SummaryItem = Readonly<{label: string; body: string | null}>;

export const MISSING_ITEM_TEXT = "（缺失：提取失败或已被跳过，汇总时请如实说明本部分缺失，不要猜测补写）";

/** 汇总单元的前缀：只含下级大纲，不含原文。 */
export function renderSummaryPrefix(heading: string, items: readonly SummaryItem[]): string {
    return [`【${heading}】`, ...items.map(item => `## ${item.label}\n${item.body === null ? MISSING_ITEM_TEXT : item.body.trim()}`)].join("\n\n");
}

export function volumeGoal(volumeTitle: string, hasMissing: boolean): string {
    return [
        `【任务】汇总“${volumeTitle}”的卷纲。`,
        "- 严格使用下面的模板；四个一级标题都必须出现且有内容。",
        hasMissing ? "- 部分章节缺失：在相应部分说明哪些章节缺失，不要猜测它们的内容。" : "",
        "- 不要写具体场景描写，也不要写原文引用行。",
        "模板：",
        VOLUME_TEMPLATE,
    ].filter(line => line !== "").join("\n");
}

export function totalGoal(workTitle: string, hasMissing: boolean): string {
    return [
        `【任务】汇总作品《${workTitle}》的总纲。`,
        "- 严格使用下面的模板；“核心冲突”“主题”“结局方向”必须出现且有内容，主要阶段建议 3 至 5 个。",
        hasMissing ? "- 部分卷缺失：在相应部分说明哪些卷缺失，不要猜测它们的内容。" : "",
        "- 聚焦宏观结构，不写具体章节情节，也不要写原文引用行。",
        "模板：",
        TOTAL_TEMPLATE,
    ].filter(line => line !== "").join("\n");
}
