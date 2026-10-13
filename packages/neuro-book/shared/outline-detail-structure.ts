import {headingSectionEnd, markdownHeadings, type MarkdownHeading} from "nbook/shared/markdown-structure";
import type {ForeshadowAction} from "nbook/server/outline/format";

export const OVERVIEW_HEADING = "章节总览";
export const SCENES_HEADING = "章节细纲";
export const FORBIDDEN_HEADING = "禁止事项";
/** 写手产出与规划一致性共用的字数容差：总览目标字数就是整章正文目标，各场景字数之和也按它衡量。 */
export const WORD_TOLERANCE = 0.5;

export const FORESHADOW_STATUS_LABELS: Readonly<Record<ForeshadowAction, string>> = {plant: "埋设", reinforce: "强化", recover: "回收"};

export type DetailStructureProblemCode =
    | "PRELUDE_CONTENT"
    | "UNKNOWN_SECTION"
    | "DUPLICATE_SECTION"
    | "MISSING_OVERVIEW"
    | "MISSING_TARGET_WORDS"
    | "INVALID_WORDS"
    | "MISSING_SCENE_STRUCTURE"
    | "INVALID_SCENE_HEADING"
    | "SCENE_NUMBER_GAP"
    | "MISSING_SCENE_SUMMARY"
    | "MISSING_SCENE_WORDS"
    | "MISSING_PERSPECTIVE"
    | "MISSING_PLOT"
    | "MISSING_FORESHADOW_MARKER"
    | "INVALID_FORESHADOW_STATUS"
    | "UNKNOWN_FORESHADOW_MARKER"
    | "FORESHADOW_STATUS_MISMATCH"
    | "IGNORED_CONTENT"
    | "WORD_TARGET_MISMATCH";

export type DetailStructureProblem = Readonly<{
    severity: "blocking" | "hint";
    code: DetailStructureProblemCode;
    message: string;
    /** 从 1 开始的场景序号，只在问题属于某个场景时给出。 */
    sceneIndex?: number;
}>;

export type DetailOverview = Readonly<{title: string; summary: string; conflict: string; mood: string; targetWords: number | null}>;
export type DetailCharacter = Readonly<{name: string; goal: string; materialPath?: string; state?: string; appearance?: string}>;
/** 参考资料一项；没有链接路径的是待补资料，只有说明文字。 */
export type DetailReferenceLink = Readonly<{label: string; path?: string}>;
export type DetailForeshadow = Readonly<{
    name: string;
    /** 章节大纲正文里伏笔标记的 marker，例如 fm-01。 */
    marker: string | null;
    status: ForeshadowAction | null;
    /** 伏笔在全书中的作用，只给助手审阅，不进写手提示：写手知道后续揭示内容就容易提前写出来。 */
    purpose: string;
    /** 本章要达到的效果。 */
    effect: string;
}>;

export type DetailSceneSection = Readonly<{
    /** 从 1 开始的位置序号；结构合格时与标题编号相同。 */
    index: number;
    heading: string;
    /** 标题冒号后的场景名，没有时为空串。 */
    name: string;
    start: number;
    end: number;
    summary: string;
    words: number | null;
    perspective: string;
    mood: string;
    pacing: string;
    location: string;
    attire: string;
    characters: readonly DetailCharacter[];
    /** 具体情节，按序；最后一条是场景的结尾落点。 */
    plot: readonly string[];
    description: string;
    guidance: string;
    references: readonly DetailReferenceLink[];
    foreshadowing: readonly DetailForeshadow[];
}>;

export type DetailStructure = Readonly<{
    overview: DetailOverview | null;
    scenes: readonly DetailSceneSection[];
    /** 禁止事项：本章不能出现的情节结果，每个场景都要遵守。 */
    forbidden: readonly string[];
    problems: readonly DetailStructureProblem[];
}>;

const SCENE_HEADING = /^场景\s*(\d+)\s*(?:[：:]\s*(.*))?$/u;
const SCENE_SUBSECTIONS = ["场景地点", "参与角色", "角色服饰与外观状态", "具体情节", "描写", "写作指导", "参考资料", "伏笔"] as const;
type SceneSubsection = typeof SCENE_SUBSECTIONS[number];
const OVERVIEW_FIELDS = ["章节标题", "剧情概括", "核心冲突", "情绪基调", "目标字数"] as const;
const SCENE_FIELDS = ["场景简述", "字数要求", "人称要求", "情绪基调", "剧情节奏"] as const;
const FORESHADOW_FIELDS = ["标记", "状态", "作用", "效果"] as const;
const STATUS_BY_LABEL: ReadonlyMap<string, ForeshadowAction> = new Map([["埋设", "plant"], ["强化", "reinforce"], ["回收", "recover"]]);

const FIELD_LINE = /^\s*(?:[-*+]\s*)?([^：:\n]+?)\s*[：:]\s*(.*)$/u;
const LIST_ITEM = /^(\s*)(?:\d{1,3}[.)、]|[-*+])\s+(.*)$/u;
const LINK = /\[([^\]]*)\]\(\s*<?([^)\s>]+)>?\s*\)/u;
const BARE_PATH = /^[\w一-鿿./-]+\.md$/u;

const stripComments = (text: string) => text.replace(/<!--[\s\S]*?-->/gu, "");
const lines = (text: string) => stripComments(text).split(/\r?\n/u);

/**
 * 读取“- 字段名：值”形式的字段行。字段名只认 labels 里的；之后不是字段行的文字续接到上一个字段，
 * 这样剧情概括之类的长字段可以换行。
 */
function parseFields<const L extends string>(text: string, labels: readonly L[]): Map<L, string> {
    const fields = new Map<L, string>();
    let current: L | null = null;
    for (const line of lines(text)) {
        const match = FIELD_LINE.exec(line);
        const label = match ? labels.find((item) => item === match[1]!.trim()) : undefined;
        if (label !== undefined) {
            current = label;
            fields.set(label, match![2]!.trim());
        } else if (current !== null && line.trim() !== "") {
            const previous = fields.get(current) ?? "";
            fields.set(current, previous === "" ? line.trim() : `${previous}\n${line.trim()}`);
        }
    }
    return fields;
}

/** 字数写成“1500”“约1500字”“1,500 字”都可以；空值为 null，写了但读不出数字为 undefined。 */
function parseWords(value: string | undefined): number | null | undefined {
    const text = (value ?? "").replace(/[,，\s]/gu, "");
    if (text === "") return null;
    const match = /^(?:约|大约)?(\d+)字?$/u.exec(text);
    const words = match ? Number(match[1]) : NaN;
    return Number.isInteger(words) && words > 0 ? words : undefined;
}

function listItems(text: string): string[] {
    const items: string[] = [];
    for (const line of lines(text)) {
        if (line.trim() === "") continue;
        const match = LIST_ITEM.exec(line);
        // 不缩进的列表项开始新的一条；缩进的子项和续行并进上一条。
        if (match && match[1]!.length < 2) items.push(match[2]!.trim());
        else if (items.length > 0) items[items.length - 1] += `；${(match ? match[2]! : line).trim()}`;
        else items.push((match ? match[2]! : line).trim());
    }
    return items.filter((item) => item !== "");
}

function parseCharacters(text: string): DetailCharacter[] {
    const characters: DetailCharacter[] = [];
    for (const line of lines(text)) {
        const list = LIST_ITEM.exec(line);
        const item = (list?.[2] ?? line).trim();
        if (item === "") continue;
        if (list && list[1]!.length >= 2) {
            const previous = characters.at(-1);
            if (!previous) continue;
            const field = FIELD_LINE.exec(item);
            const value = field?.[2]?.trim() ?? "";
            const label = field?.[1]?.trim();
            const path = label === "角色资料" ? LINK.exec(value)?.[2] ?? (BARE_PATH.test(value) ? value : undefined) : undefined;
            characters[characters.length - 1] = {...previous,
                ...(path ? {materialPath: path.replace(/^\.\//u, "")} : {}),
                ...(label === "当前状态" && value ? {state: value} : {}),
                ...(label === "外貌要求" && value ? {appearance: value} : {})};
            continue;
        }
        const match = /^([^：:]+?)\s*[：:]\s*(.*)$/u.exec(item);
        if (!match) {characters.push({name: item, goal: ""}); continue;}
        const name = match[1]!.trim();
        // 模板里的“角色目的：”只是分组提示，不是角色。
        if (name === "角色目的" && match[2]!.trim() === "") continue;
        characters.push({name, goal: match[2]!.trim()});
    }
    return characters;
}

function parseReferences(text: string): DetailReferenceLink[] {
    return listItems(text).map((item) => {
        const link = LINK.exec(item);
        if (link) return {label: (link[1]!.trim() || link[2]!).trim(), path: link[2]!.replace(/^\.\//u, "")};
        const bare = item.replace(/^`|`$/gu, "");
        return BARE_PATH.test(bare) ? {label: bare, path: bare.replace(/^\.\//u, "")} : {label: item};
    });
}

type ForeshadowDraft = {name: string; marker: string | null; status: string | null; purpose: string; effect: string};

function parseForeshadowing(text: string): ForeshadowDraft[] {
    const items: ForeshadowDraft[] = [];
    const draft = (name = ""): ForeshadowDraft => ({name, marker: null, status: null, purpose: "", effect: ""});
    for (const line of lines(text)) {
        if (line.trim() === "") continue;
        const content = (LIST_ITEM.exec(line)?.[2] ?? line).trim();
        const field = /^([^：:]+?)\s*[：:]\s*(.*)$/u.exec(content);
        const label = field ? FORESHADOW_FIELDS.find((item) => item === field[1]!.trim()) : undefined;
        if (label === undefined) {
            items.push(draft(content));
            continue;
        }
        if (items.length === 0) items.push(draft());
        const current = items[items.length - 1]!;
        const value = field![2]!.trim();
        if (label === "标记") current.marker = value.replace(/^`|`$/gu, "") || null;
        else if (label === "状态") current.status = value || null;
        else if (label === "作用") current.purpose = value;
        else current.effect = value;
    }
    return items;
}

type Section = Readonly<{heading: MarkdownHeading; end: number}>;

function sectionsOf(body: string, headings: readonly MarkdownHeading[], level: number, from: number, to: number): Section[] {
    return headings.flatMap((heading, index) => heading.level === level && heading.start >= from && heading.start < to
        ? [{heading, end: Math.min(headingSectionEnd(body, headings, index), to)}] : []);
}

/**
 * 细纲模板见 docs/specs/outline/outline-entry-templates.md。大纲分析、正式采用、编辑界面与写作共用这一份检查，
 * 避免几处规则各自漂移。chapterMarkers 是章节大纲里的伏笔标记及其动作；缺省时不检查伏笔是否对得上。
 */
export function analyzeDetailStructure(
    entry: Readonly<{body: string}>,
    options: Readonly<{chapterMarkers?: ReadonlyMap<string, ForeshadowAction>}> = {},
): DetailStructure {
    const body = entry.body;
    const problems: DetailStructureProblem[] = [];
    const report = (severity: DetailStructureProblem["severity"], code: DetailStructureProblemCode, message: string, sceneIndex?: number) =>
        problems.push({severity, code, message, ...(sceneIndex === undefined ? {} : {sceneIndex})});
    const block = (code: DetailStructureProblemCode, message: string, sceneIndex?: number) => report("blocking", code, message, sceneIndex);
    const hint = (code: DetailStructureProblemCode, message: string, sceneIndex?: number) => report("hint", code, message, sceneIndex);

    const headings = markdownHeadings(body);
    const tops = sectionsOf(body, headings, 1, 0, body.length);
    if (tops.length > 0 && stripComments(body.slice(0, tops[0]!.heading.start)).trim() !== "") {
        block("PRELUDE_CONTENT", "第一个一级标题之前不能有内容");
    }
    const known = new Map<string, Section>();
    for (const section of tops) {
        const title = section.heading.text;
        if (![OVERVIEW_HEADING, SCENES_HEADING, FORBIDDEN_HEADING].includes(title)) {
            block("UNKNOWN_SECTION", `一级标题只能是「${OVERVIEW_HEADING}」「${SCENES_HEADING}」「${FORBIDDEN_HEADING}」，「${title}」的内容不会被使用`);
        } else if (known.has(title)) {
            block("DUPLICATE_SECTION", `「${title}」只能有一个`);
        } else {
            known.set(title, section);
        }
    }

    const overviewSection = known.get(OVERVIEW_HEADING);
    let overview: DetailOverview | null = null;
    if (overviewSection === undefined) {
        block("MISSING_OVERVIEW", `细纲缺少「${OVERVIEW_HEADING}」`);
    } else {
        const fields = parseFields(body.slice(overviewSection.heading.end, overviewSection.end), OVERVIEW_FIELDS);
        const targetWords = parseWords(fields.get("目标字数"));
        if (targetWords === null) block("MISSING_TARGET_WORDS", `「${OVERVIEW_HEADING}」没有目标字数`);
        if (targetWords === undefined) block("INVALID_WORDS", `「${OVERVIEW_HEADING}」的目标字数「${fields.get("目标字数")}」不是正整数`);
        overview = {title: fields.get("章节标题") ?? "", summary: fields.get("剧情概括") ?? "", conflict: fields.get("核心冲突") ?? "",
            mood: fields.get("情绪基调") ?? "", targetWords: targetWords ?? null};
    }

    const scenesSection = known.get(SCENES_HEADING);
    const scenes: DetailSceneSection[] = [];
    if (scenesSection !== undefined) {
        const sceneSections = sectionsOf(body, headings, 2, scenesSection.heading.end, scenesSection.end);
        const prelude = body.slice(scenesSection.heading.end, sceneSections[0]?.heading.start ?? scenesSection.end);
        if (sceneSections.length > 0 && stripComments(prelude).trim() !== "") {
            hint("IGNORED_CONTENT", `「${SCENES_HEADING}」与第一个场景之间的文字不会交给写作`);
        }
        for (const section of sceneSections) {
            const index = scenes.length + 1;
            const match = SCENE_HEADING.exec(section.heading.text);
            if (!match) {
                block("INVALID_SCENE_HEADING", `「${section.heading.text}」不是场景标题，场景写成「## 场景${index}」或「## 场景${index}：名称」`, index);
            } else if (Number(match[1]) !== index) {
                block("SCENE_NUMBER_GAP", `第 ${index} 个场景的标题编号是 ${match[1]}，场景编号必须从 1 连续`, index);
            }
            scenes.push(parseScene(body, headings, section, index, match?.[2]?.trim() ?? "", {block, hint}, options.chapterMarkers));
        }
    }
    if (scenes.length === 0) block("MISSING_SCENE_STRUCTURE", `「${SCENES_HEADING}」下没有场景，场景写成「## 场景1：名称」`);

    const forbiddenSection = known.get(FORBIDDEN_HEADING);
    const forbidden = forbiddenSection === undefined ? [] : listItems(body.slice(forbiddenSection.heading.end, forbiddenSection.end));

    const target = overview?.targetWords ?? null;
    const sceneWords = scenes.map(({words}) => words);
    if (target !== null && sceneWords.length > 0 && sceneWords.every((words) => words !== null)) {
        const sum = sceneWords.reduce<number>((total, words) => total + words!, 0);
        if (Math.abs(sum - target) > target * WORD_TOLERANCE) {
            hint("WORD_TARGET_MISMATCH", `各场景字数之和 ${sum} 与目标字数 ${target} 相差超过 50%`);
        }
    }
    return {overview, scenes, forbidden, problems};
}

type Reporters = Readonly<{
    block: (code: DetailStructureProblemCode, message: string, sceneIndex?: number) => void;
    hint: (code: DetailStructureProblemCode, message: string, sceneIndex?: number) => void;
}>;

function parseScene(body: string, headings: readonly MarkdownHeading[], section: Section, index: number, name: string,
    {block, hint}: Reporters, chapterMarkers: ReadonlyMap<string, ForeshadowAction> | undefined): DetailSceneSection {
    const label = `场景${index}`;
    const subsections = sectionsOf(body, headings, 3, section.heading.end, section.end);
    const fields = parseFields(body.slice(section.heading.end, subsections[0]?.heading.start ?? section.end), SCENE_FIELDS);
    const parts = new Map<SceneSubsection, string>();
    for (const subsection of subsections) {
        const title = SCENE_SUBSECTIONS.find((item) => item === subsection.heading.text);
        if (title === undefined) {
            hint("IGNORED_CONTENT", `${label}的「${subsection.heading.text}」不是模板中的小节，内容不会交给写作`, index);
            continue;
        }
        const text = body.slice(subsection.heading.end, subsection.end);
        parts.set(title, parts.has(title) ? `${parts.get(title)}\n${text}` : text);
    }
    const summary = fields.get("场景简述") ?? "";
    const perspective = fields.get("人称要求") ?? "";
    const words = parseWords(fields.get("字数要求"));
    const plot = listItems(parts.get("具体情节") ?? "");
    if (summary === "") block("MISSING_SCENE_SUMMARY", `${label}没有场景简述`, index);
    if (words === null) block("MISSING_SCENE_WORDS", `${label}没有字数要求`, index);
    if (words === undefined) block("INVALID_WORDS", `${label}的字数要求「${fields.get("字数要求")}」不是正整数`, index);
    if (perspective === "") block("MISSING_PERSPECTIVE", `${label}没有人称要求`, index);
    if (plot.length === 0) block("MISSING_PLOT", `${label}的「具体情节」至少要写一条`, index);

    const foreshadowing = parseForeshadowing(parts.get("伏笔") ?? "").map((item): DetailForeshadow => {
        const title = item.name || item.marker || "未命名伏笔";
        const status = item.status === null ? null : STATUS_BY_LABEL.get(item.status) ?? null;
        if (item.marker === null) block("MISSING_FORESHADOW_MARKER", `${label}的伏笔「${title}」没有标记`, index);
        if (status === null) block("INVALID_FORESHADOW_STATUS", `${label}的伏笔「${title}」状态必须是埋设、强化或回收`, index);
        if (item.marker !== null && chapterMarkers) {
            const action = chapterMarkers.get(item.marker);
            if (action === undefined) {
                block("UNKNOWN_FORESHADOW_MARKER", `${label}的伏笔标记 ${item.marker} 不在章节大纲中`, index);
            } else if (status !== null && action !== status) {
                block("FORESHADOW_STATUS_MISMATCH",
                    `${label}的伏笔「${title}」写的是${FORESHADOW_STATUS_LABELS[status]}，章节大纲中标记 ${item.marker} 是${FORESHADOW_STATUS_LABELS[action]}`, index);
            }
        }
        return {name: item.name, marker: item.marker, status, purpose: item.purpose, effect: item.effect};
    });

    const characters = parseCharacters(parts.get("参与角色") ?? "");
    return {
        index, heading: section.heading.text, name, start: section.heading.start, end: section.end,
        summary, words: words ?? null, perspective, mood: fields.get("情绪基调") ?? "", pacing: fields.get("剧情节奏") ?? "",
        characters,
        location: stripComments(parts.get("场景地点") ?? "").trim(),
        attire: stripComments(parts.get("角色服饰与外观状态") ?? "").trim(),
        plot,
        description: stripComments(parts.get("描写") ?? "").trim(),
        guidance: stripComments(parts.get("写作指导") ?? "").trim(),
        references: [...parseReferences(parts.get("参考资料") ?? ""),
            ...characters.flatMap(({name, materialPath}) => materialPath ? [{label: `${name}角色资料`, path: materialPath}] : []),
            ...parseReferences(parts.get("场景地点") ?? "").filter(({path}) => path !== undefined)],
        foreshadowing,
    };
}

export function blockingDetailProblems(structure: DetailStructure): readonly DetailStructureProblem[] {
    return structure.problems.filter(({severity}) => severity === "blocking");
}

/** 细纲里所有参考资料项，供待补告警与可读范围计算。 */
export function detailReferences(body: string): readonly DetailReferenceLink[] {
    return analyzeDetailStructure({body}).scenes.flatMap(({references}) => references);
}

/** 新建细纲时插入的模板；编辑界面的“插入细纲模板”和规划 Agent 的模板说明保持同一形状。 */
export function detailTemplate(title = ""): string {
    return [
        `# ${OVERVIEW_HEADING}`,
        "",
        `- 章节标题：${title}`,
        "- 剧情概括：",
        "- 核心冲突：",
        "- 情绪基调：",
        "- 目标字数：",
        "",
        `# ${SCENES_HEADING}`,
        "",
        sceneTemplate(1),
        `# ${FORBIDDEN_HEADING}`,
        "",
        "- ",
        "",
    ].join("\n");
}

/**
 * 提取阶段使用的细纲模板。提取不负责维护伏笔库和参考资料链接，
 * 因而不能复用编辑器的完整模板，否则模型会被模板诱导输出校验器禁止的字段。
 */
export function extractionDetailTemplate(): string {
    return [
        `# ${OVERVIEW_HEADING}`,
        "",
        "- 章节标题：",
        "- 剧情概括：",
        "- 核心冲突：",
        "- 情绪基调：",
        "- 目标字数：",
        "",
        `# ${SCENES_HEADING}`,
        "",
        extractionSceneTemplate(1),
        `# ${FORBIDDEN_HEADING}`,
        "",
        "- ",
    ].join("\n");
}

function extractionSceneTemplate(index: number): string {
    return [
        `## 场景${index}：场景名称`,
        "",
        "- 场景简述：",
        "- 字数要求：",
        "- 人称要求：",
        "- 情绪基调：",
        "- 剧情节奏：",
        "",
        "### 场景地点",
        "",
        "- 地点名称：",
        "- 具体位置：",
        "- 与前文的衔接：",
        "- 本场景相关条件：",
        "",
        "### 参与角色",
        "",
        "- 角色姓名：本场景目的",
        "",
        "### 角色服饰与外观状态",
        "",
        "- 角色姓名：穿着、外貌状态及变化；没有变化时写“沿用前文”",
        "",
        "### 具体情节",
        "",
        "1. ",
        "",
        "### 描写",
        "",
        "### 写作指导",
        "",
    ].join("\n");
}

export function sceneTemplate(index: number): string {
    return [
        `## 场景${index}：`,
        "",
        "- 场景简述：",
        "- 字数要求：",
        "- 人称要求：",
        "- 情绪基调：",
        "- 剧情节奏：",
        "",
        "### 场景地点",
        "",
        "- 地点名称：",
        "- 具体位置：",
        "- 地点资料：",
        "- 与前文的衔接：",
        "- 本场景相关条件：",
        "",
        "### 参与角色",
        "",
        "- ",
        "",
        "### 角色服饰与外观状态",
        "",
        "<!-- 按角色简述穿着、外貌状态及变化；没有变化时沿用前文。 -->",
        "",
        "### 具体情节",
        "",
        "1. ",
        "",
        "### 描写",
        "",
        "### 写作指导",
        "",
        "### 参考资料",
        "",
        "### 伏笔",
        "",
    ].join("\n");
}
