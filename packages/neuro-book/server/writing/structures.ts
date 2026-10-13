import {z} from "zod";
import {createHash} from "node:crypto";
import {WRITER_SYSTEM_SECTIONS, SCENE_WRITER_SECTIONS, REWRITE_WRITER_SECTIONS} from "nbook/shared/prompt-management/writing-templates";
import {renderManagedPrompt} from "nbook/server/prompt-management/render";
import type {PromptEntry, PromptSnapshot} from "nbook/shared/dto/prompt-management.dto";
import type {WriterChapterBasis} from "nbook/server/outline/writer-context";
import type {WritingIssueDraft} from "nbook/shared/dto/writing.dto";
import {
    countWords, describeExcerptLocator, meetsWordLowerBound, resolveExcerpt, SCENE_EXCERPT_MAX_WORDS, WORD_LOWER_BOUND,
    type WritingStyle,
} from "./materials";
import {FORESHADOW_ACTION, type ChapterMaterials, type SceneSource} from "./scenes";
import type {TavernWriterOutput} from "./tavern-output";

const Text = z.string().trim().min(1);
const Paragraph = z.number().int().min(1);

const ExcerptRefSchema = z.union([
    z.object({path: Text, heading: Text}).strict(),
    z.object({path: Text, paragraphs: z.object({from: Paragraph, to: Paragraph.optional()}).strict()}).strict(),
]);

/** 写作手法与背景知识：要点，或只给位置、由程序取原文的摘录；两者都可以为空。 */
const MaterialSchema = z.object({
    points: z.array(Text).default([]),
    excerpts: z.array(ExcerptRefSchema).default([]),
}).strict();

const SupplementSchema = z.object({
    kind: z.enum(["character", "environment", "relationship", "experience", "secret", "attire", "item", "reference"]),
    subject: Text,
    points: z.array(Text).min(1),
    excerpts: z.array(ExcerptRefSchema).min(1),
}).strict();

/** Task data also describes the new output contract to sessions that retain an older prompt snapshot. */
export const MATERIAL_SUPPLEMENT_CONTRACT = {
    field: "supplements",
    item: {kind: "character | environment | relationship | experience | secret | attire | item | reference", subject: "角色名或对象",
        points: ["依据源资料整理的必要要点"], excerpts: [{path: "真实可读路径", heading: "源文件唯一标题"}]},
    rules: "每项要点和来源均非空；excerpts也可用{path,paragraphs:{from,to?}}。每个参与角色恰好一项character，包含身份、外貌、性格及具体表现，来源含明确角色引用。其他类别按情节需要，不编造资料，不新增剧情。改编用当前方案和进度，笔记先索引后文档。",
} as const;

export const MaterialReviewSchema = z.object({passed: z.boolean(), problems: z.array(Text)}).strict();
export type MaterialReview = z.infer<typeof MaterialReviewSchema>;

export function validateMaterialReview(value: unknown): Validation<MaterialReview> {
    const parsed = MaterialReviewSchema.safeParse(value);
    if (!parsed.success) return {ok: false, errors: zodErrors(parsed.error)};
    if (parsed.data.passed === (parsed.data.problems.length > 0)) {
        return {ok: false, errors: ["通过时问题清单必须为空，不通过时必须给出具体问题"]};
    }
    return {ok: true, value: parsed.data, issues: []};
}

/** 结构 A 中归助手的字段。问题通过问题登记单独提交，不内嵌在规划里。 */
export const ScenePlanSubmissionSchema = z.object({
    scenes: z.array(z.object({
        index: z.number().int().min(1),
        heading: z.string(),
        techniques: MaterialSchema,
        background: MaterialSchema,
        supplements: z.array(SupplementSchema).default([]),
        extraMustInclude: z.array(Text).default([]),
    }).strict()),
}).strict();

/** 结构 C。elements 与 forbidden 必须分别与规划中的必须写到的要素、本章禁止事项逐项同序对应。 */
export const SceneReviewSubmissionSchema = z.object({
    passed: z.boolean(),
    elements: z.array(z.object({element: Text, covered: z.boolean()}).strict()),
    forbidden: z.array(z.object({item: Text, violated: z.boolean()}).strict()).default([]),
    problems: z.array(Text).default([]),
}).strict();

/** 结构 D 中归助手的字段。 */
export const RewritePlanSubmissionSchema = z.object({
    requirement: Text,
    perspective: Text,
    techniques: MaterialSchema,
    background: MaterialSchema,
    supplements: z.array(SupplementSchema).default([]),
}).strict();

export const RewriteReviewSubmissionSchema = z.object({
    passed: z.boolean(),
    problems: z.array(Text).default([]),
}).strict();

export type ScenePlanSubmission = z.infer<typeof ScenePlanSubmissionSchema>;
export type SceneReviewSubmission = z.infer<typeof SceneReviewSubmissionSchema>;
export type RewritePlanSubmission = z.infer<typeof RewritePlanSubmissionSchema>;
export type RewriteReviewSubmission = z.infer<typeof RewriteReviewSubmissionSchema>;

export type ResolvedExcerpt = Readonly<{path: string; locator: string; text: string}>;
export type ResolvedMaterial = Readonly<{points: readonly string[]; excerpts: readonly ResolvedExcerpt[]}>;
export type ResolvedSupplement = ResolvedMaterial & Readonly<{kind: z.infer<typeof SupplementSchema>["kind"]; subject: string}>;

export type PlannedScene = SceneSource & Readonly<{
    /** 助手从写作指导文件中补充的写法；细纲自己的写作指导原文另行渲染，不在这里重复。 */
    techniques: ResolvedMaterial;
    background: ResolvedMaterial;
    supplements?: readonly ResolvedSupplement[];
    sourceHashes?: Readonly<Record<string, string>>;
    /** 细纲锁定的要素在前，助手追加的在后。 */
    mustInclude: readonly string[];
}>;

/** 结构 A：章节依据由程序填写，写作期间据此复核规划是否变化。targetWords 是细纲总览的整章目标。 */
export type ScenePlan = Readonly<{planId: string; basis: WriterChapterBasis; targetWords: number; scenes: readonly PlannedScene[]; materialVersion?: 1}>;

export type Validation<T> =
    | Readonly<{ok: true; value: T; issues: readonly WritingIssueDraft[]}>
    | Readonly<{ok: false; errors: readonly string[]}>;

/**
 * 摘录源文件由调用方按助手的可读范围预先读好；不在表中的路径一律视为不可读。
 * 这里只负责按位置取原文和计量。
 */
export type ExcerptFiles = ReadonlyMap<string, string>;

function materialPathVariants(value: string): string[] {
    const normalized = value.trim().replace(/\\/gu, "/").replace(/\/+$/u, "");
    return normalized.endsWith("/index.md") ? [normalized, normalized.slice(0, -"/index.md".length)]
        : normalized.startsWith("lorebook/") && !normalized.endsWith(".md") ? [normalized, `${normalized}/index.md`] : [normalized];
}

function fileContent(files: ExcerptFiles, requested: string): string | undefined {
    for (const variant of materialPathVariants(requested)) {
        const content = files.get(variant);
        if (content !== undefined) return content;
    }
    return undefined;
}

function pathsReferToSameMaterial(files: ExcerptFiles, left: string, right: string): boolean {
    if (materialPathVariants(left).some(value => materialPathVariants(right).includes(value))) return true;
    const leftContent = fileContent(files, left);
    const rightContent = fileContent(files, right);
    return leftContent !== undefined && leftContent === rightContent;
}

function zodErrors(error: z.ZodError): string[] {
    return error.issues.map((issue) => `${issue.path.join(".") || "提交"}：${issue.message}`);
}

function resolveMaterial(material: z.infer<typeof MaterialSchema>, files: ExcerptFiles, label: string, errors: string[]):
    {material: ResolvedMaterial; words: number} {
    const excerpts: ResolvedExcerpt[] = [];
    let words = 0;
    for (const {path, ...locator} of material.excerpts) {
        const content = fileContent(files, path);
        if (content === undefined) {
            errors.push(`${label}：摘录文件不存在或不可读：${path}`);
            continue;
        }
        const result = resolveExcerpt(content, locator);
        if (!result.ok) {
            errors.push(`${label}：${path} ${result.message}`);
            continue;
        }
        excerpts.push({path, locator: describeExcerptLocator(locator), text: result.text});
        words += result.words;
    }
    return {material: {points: material.points, excerpts}, words};
}

export function materialSourceHash(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

function resolveSupplements(items: readonly z.infer<typeof SupplementSchema>[], files: ExcerptFiles, errors: string[]) {
    const supplements: ResolvedSupplement[] = [];
    let words = 0;
    for (const item of items) {
        const resolved = resolveMaterial(item, files, `${item.kind} ${item.subject}`, errors);
        supplements.push({kind: item.kind, subject: item.subject, ...resolved.material});
        words += resolved.words;
    }
    return {supplements, words};
}

function sourceHashes(materials: readonly ResolvedMaterial[], files: ExcerptFiles): Record<string, string> {
    return Object.fromEntries(materials.flatMap(material => material.excerpts.map(({path}) => path))
        .map(path => [path, materialSourceHash(fileContent(files, path)!)]));
}

/** 待补参考已由交接警告登记，这里只检查有路径的参考是否可读。 */
function checkSceneReferences(source: SceneSource, files: ExcerptFiles, issues: WritingIssueDraft[]): void {
    for (const {path, pending} of source.references) {
        if (path === undefined || pending === true || files.has(path)) continue;
        issues.push({code: "PENDING_REFERENCE", severity: "hint", location: {entryId: source.detailEntryId, sceneIndex: source.index},
            message: `场景 ${source.index}「${source.heading}」的参考资料不存在或不可读：${path}`});
    }
}

/**
 * 校验结构 A。失败原因退回助手，不交给主创和写手。锁定的要素由程序放在最前，助手只能追加。
 * files 须包含助手摘录与场景参考资料涉及的文件。
 */
export function validateScenePlan(submission: unknown, input: Readonly<{
    planId: string;
    basis: WriterChapterBasis;
    materials: ChapterMaterials;
    files: ExcerptFiles;
    /** 只校验当前规划的场景；省略时保留整章校验，供旧调用方使用。 */
    sceneIndices?: readonly number[];
}>): Validation<ScenePlan> {
    const parsed = ScenePlanSubmissionSchema.safeParse(submission);
    if (!parsed.success) return {ok: false, errors: zodErrors(parsed.error)};
    const sceneIndices = input.sceneIndices;
    const expected = sceneIndices === undefined
        ? input.materials.scenes
        : input.materials.scenes.filter(({index}) => sceneIndices.includes(index));
    const submitted = parsed.data.scenes;
    const errors: string[] = [];
    if (expected.length === 0) return {ok: false, errors: ["没有找到需要校验的场景"]};
    if (submitted.length !== expected.length) {
        errors.push(`场景数量应为 ${expected.length}，提交了 ${submitted.length} 个`);
        return {ok: false, errors};
    }
    const issues: WritingIssueDraft[] = [];
    const scenes: PlannedScene[] = [];
    for (const [position, source] of expected.entries()) {
        const scene = submitted[position]!;
        const label = `场景 ${source.index}`;
        if (scene.index !== source.index || scene.heading.trim() !== source.heading) {
            errors.push(`${label}应对应场景标题「${source.heading}」，提交的是 ${scene.index}「${scene.heading}」`);
            continue;
        }
        const techniques = resolveMaterial(scene.techniques, input.files, `${label}写作手法`, errors);
        const background = resolveMaterial(scene.background, input.files, `${label}背景知识`, errors);
        const supplemental = resolveSupplements(scene.supplements, input.files, errors);
        const names = new Set(source.characters.map(({name}) => name));
        const suppliedNames = supplemental.supplements.filter(({kind}) => kind === "character").map(({subject}) => subject);
        for (const name of names) if (!suppliedNames.includes(name)) errors.push(`${label}缺少角色「${name}」的基础资料与来源`);
        if (new Set(suppliedNames).size !== suppliedNames.length || suppliedNames.some(name => !names.has(name))) {
            errors.push(`${label}角色资料必须对应参与角色，不得重复或新增角色`);
        }
        for (const character of source.characters) {
            if (character.materialPath && !supplemental.supplements.some(item => item.kind === "character" && item.subject === character.name
                && item.excerpts.some(excerpt => pathsReferToSameMaterial(input.files, excerpt.path, character.materialPath!)))) errors.push(`${label}未使用「${character.name}」明确引用的角色资料`);
        }
        const excerptWords = techniques.words + background.words + supplemental.words;
        if (excerptWords > SCENE_EXCERPT_MAX_WORDS) {
            errors.push(`${label}的摘录合计 ${excerptWords} 字，不能超过 ${SCENE_EXCERPT_MAX_WORDS} 字`);
        }
        checkSceneReferences(source, input.files, issues);
        scenes.push({...source, techniques: techniques.material, background: background.material, supplements: supplemental.supplements,
            sourceHashes: sourceHashes([techniques.material, background.material, ...supplemental.supplements], input.files),
            mustInclude: [...source.requiredElements, ...scene.extraMustInclude]});
    }
    if (errors.length > 0) return {ok: false, errors};
    return {ok: true, value: {planId: input.planId, basis: input.basis, targetWords: input.materials.targetWords, scenes, materialVersion: 1}, issues};
}

export type WriterPrompt = Readonly<{system: string; user: string; preMessages?: readonly {role: "user" | "assistant"; content: string}[];
    orderedMessages?: readonly {role: "system" | "user" | "assistant"; content: string}[];
    outputReport?: Pick<TavernWriterOutput, "quality" | "extractionError" | "extensionWarnings">;
    managed?: {purposeId: string; variables: Record<string, string>}}>;

const EMPTY = "（无）";

const bullets = (items: readonly string[]) => items.map((item) => `- ${item}`).join("\n");

function styleVariables(style: WritingStyle): Record<string, string> {
    return {requirements: style.requirements.trim() || EMPTY, forbidden: style.forbidden.trim() || EMPTY, sample: style.sample.trim() || EMPTY};
}

/**
 * 没有绑定会话（如离线/后台写作）时，直接按内置默认小节渲染，复用 renderManagedPrompt 保证
 * 和提示词管理里展示的内置默认逐字一致，不另维护一条可能漂移的拼接逻辑。
 */
function renderWriterDefaults(entries: readonly PromptEntry[], variables: Readonly<Record<string, string>>): Readonly<{system: string; user: string}> {
    const snapshot: PromptSnapshot = {schemaVersion: 1, id: "builtin", purposes: {builtin: {presetId: "builtin", presetRevision: 1, entries: [...entries]}}};
    const rendered = renderManagedPrompt(snapshot, "builtin", variables);
    return {system: rendered.systemPrompt, user: rendered.messages.map((message) => message.content).join("\n\n")};
}

export function renderMaterial(material: ResolvedMaterial): string {
    return [
        bullets(material.points),
        ...material.excerpts.map(({path, locator, text}) => `> 摘自 ${path} ${locator}\n\n${text}`),
    ].filter((part) => part !== "").join("\n\n");
}

const SUPPLEMENT_LABELS = {character: "角色基础资料", environment: "场景环境", relationship: "关系", experience: "相关经历",
    secret: "秘密与信息差", attire: "服饰与外观状态", item: "物品", reference: "其他参考"} as const;

export function renderSupplements(items: readonly ResolvedSupplement[] = []): string {
    return items.length === 0 ? "" : `## 依据细纲补充的资料\n\n${items.map(item =>
        `### ${SUPPLEMENT_LABELS[item.kind]}：${item.subject}\n\n${renderMaterial(item)}`).join("\n\n")}`;
}

function fieldLines(fields: readonly (readonly [string, string])[]): string {
    return fields.flatMap(([label, value]) => value.trim() === "" ? [] : [`- ${label}：${value.trim()}`]).join("\n");
}

function renderOverview(materials: ChapterMaterials): string {
    const {overview} = materials;
    return fieldLines([["章节标题", overview.title], ["剧情概括", overview.summary], ["核心冲突", overview.conflict],
        ["情绪基调", overview.mood], ["目标字数", `约 ${materials.targetWords} 字`]]);
}

function renderRoster(materials: ChapterMaterials, current: number): string {
    const {scenes} = materials;
    const label = (scene: SceneSource) => scene.name === "" ? `场景 ${scene.index}` : scene.name;
    const previous = scenes.find(({index}) => index === current - 1);
    const next = scenes.find(({index}) => index === current + 1);
    // 下一场景只给名称和简述，供结尾铺垫衔接；具体情节不给，写手才不会提前写进本场景。
    return [
        ...scenes.map((scene) =>
            `- 场景 ${scene.index}${scene.index === current ? "（当前）" : ""}：${label(scene)}，约 ${scene.targetWords} 字，结尾落点：${scene.ending}`),
        "",
        `上一场景结尾落点：${previous ? previous.ending : EMPTY}`,
        `下一场景：${next ? `${label(next)}（${next.summary}），只用于结尾铺垫，不得展开` : EMPTY}`,
    ].join("\n");
}

function renderForeshadowing(materials: ChapterMaterials, scene: PlannedScene): string {
    return bullets(materials.foreshadowing.map(({marker, action, text}) =>
        `${scene.foreshadowing.some((item) => item.marker === marker) ? "本场景执行" : "不在本场景执行"}｜${FORESHADOW_ACTION[action]}：${text}`));
}

/** 结构 B。非首场景时「上一章结尾」小节仍会出现，但渲染为「不提供」占位，不再整段省略。 */
export function renderScenePrompt(input: Readonly<{
    style: WritingStyle;
    materials: ChapterMaterials;
    scene: PlannedScene;
    previousEnding: string | null;
    acceptedProse: string;
    retryProblems?: readonly string[];
}>): WriterPrompt {
    const {materials, scene} = input;
    const text = (value: string): string => value.trim() || EMPTY;
    const variables = {
        ...styleVariables(input.style),
        previousEnding: scene.index === 1 ? ((input.previousEnding ?? "（上一章尚无正文）").trim() || EMPTY) : "（非首场景，不提供上一章结尾）",
        overview: text(renderOverview(materials)),
        roster: text(renderRoster(materials, scene.index)),
        acceptedProse: input.acceptedProse.trim() || "（本章尚无正文，从本场景开头写起）",
        chapterGuidance: text(materials.chapterGuidance.map(({title, text: content}) => `【${title}】\n${content}`).join("\n\n")),
        chapterForeshadowing: text(renderForeshadowing(materials, scene)),
        sceneLabel: `场景 ${scene.index}${scene.name === "" ? "" : `：${scene.name}`}`,
        sceneDescription: text(fieldLines([
            ["场景简述", scene.summary], ["人称", scene.perspective], ["目标字数", `不少于 ${scene.targetWords} 字`],
            ["情绪基调", scene.mood], ["剧情节奏", scene.pacing]])),
        characters: text(bullets(scene.characters.map(({name, goal, materialPath, state, appearance}) =>
            [goal === "" ? name : `${name}：${goal}`, materialPath ? `资料：${materialPath}` : "", state ? `当前状态：${state}` : "",
                appearance ? `外貌要求：${appearance}` : ""].filter(Boolean).join("；")))),
        location: text(scene.location ?? ""), attire: text(scene.attire ?? ""),
        supplements: renderSupplements(scene.supplements) || "## 依据细纲补充的资料\n\n（无）",
        plot: text(scene.plot.map((item, index) => `${index + 1}. ${item}`).join("\n")),
        description: text(scene.description), guidance: text(scene.guidance),
        sceneForeshadowing: text(bullets(scene.foreshadowing.map(({action, text: content, effect}) => `${FORESHADOW_ACTION[action]}：${content}${effect === "" ? "" : `（效果：${effect}）`}`))),
        techniques: text(renderMaterial(scene.techniques)), background: text(renderMaterial(scene.background)),
        mustInclude: text(bullets(scene.mustInclude)), sceneForbidden: text(bullets(scene.forbidden)),
        retryProblemsText: input.retryProblems?.length ? bullets(input.retryProblems) : "（无，首次写作）",
    };
    return {...renderWriterDefaults([...WRITER_SYSTEM_SECTIONS, ...SCENE_WRITER_SECTIONS], variables),
        managed: {purposeId: "writing.writer.scene", variables}};
}

const sameOrder = (actual: readonly string[], expected: readonly string[]) =>
    actual.length === expected.length && actual.every((item, index) => item === expected[index]);

/** 校验结构 C 的形状；判定是否通过见 judgeScene。 */
export function validateSceneReview(submission: unknown, scene: PlannedScene): Validation<SceneReviewSubmission> {
    const parsed = SceneReviewSubmissionSchema.safeParse(submission);
    if (!parsed.success) return {ok: false, errors: zodErrors(parsed.error)};
    const review = parsed.data;
    const errors: string[] = [];
    if (!sameOrder(review.elements.map(({element}) => element), scene.mustInclude)) {
        errors.push(`elements 必须按顺序逐项对应必须写到的要素：${scene.mustInclude.join("；")}`);
    }
    if (!sameOrder(review.forbidden.map(({item}) => item), scene.forbidden)) {
        errors.push(scene.forbidden.length === 0 ? "本章没有禁止事项，forbidden 应为空"
            : `forbidden 必须按顺序逐项对应本章禁止事项：${scene.forbidden.join("；")}`);
    }
    if (!review.passed && review.problems.length === 0) errors.push("判定不通过时必须列出问题清单");
    return errors.length > 0 ? {ok: false, errors} : {ok: true, value: review, issues: []};
}

export type SceneJudgement = Readonly<{passed: boolean; words: number; problems: readonly string[]}>;

/** 助手判定通过、要素全部写到、禁止事项全部未出现、字数不少于目标 70% 才算通过（不设上限）；写手输出为空直接不通过。 */
export function judgeScene(input: Readonly<{review: SceneReviewSubmission | null; output: string; targetWords: number}>): SceneJudgement {
    const words = countWords(input.output);
    if (input.output.trim() === "" || input.review === null) return {passed: false, words, problems: ["写手输出为空"]};
    const {review, targetWords} = input;
    const problems = [...review.problems];
    for (const {element, covered} of review.elements) if (!covered) problems.push(`没有写到：${element}`);
    for (const {item, violated} of review.forbidden) if (violated) problems.push(`出现了禁止的情节：${item}`);
    if (!meetsWordLowerBound(words, targetWords)) {
        problems.push(`字数 ${words}，不足目标 ${targetWords} 字的 ${Math.round(WORD_LOWER_BOUND * 100)}%`);
    }
    return {passed: review.passed && problems.length === 0, words, problems};
}

export type RewritePlan = Readonly<{requirement: string; perspective: string; techniques: ResolvedMaterial; background: ResolvedMaterial;
    supplements?: readonly ResolvedSupplement[]; sourceHashes?: Readonly<Record<string, string>>}>;

export function validateRewritePlan(submission: unknown, files: ExcerptFiles): Validation<RewritePlan> {
    const parsed = RewritePlanSubmissionSchema.safeParse(submission);
    if (!parsed.success) return {ok: false, errors: zodErrors(parsed.error)};
    const errors: string[] = [];
    const techniques = resolveMaterial(parsed.data.techniques, files, "写作手法", errors);
    const background = resolveMaterial(parsed.data.background, files, "背景知识", errors);
    const supplemental = resolveSupplements(parsed.data.supplements, files, errors);
    const excerptWords = techniques.words + background.words + supplemental.words;
    if (excerptWords > SCENE_EXCERPT_MAX_WORDS) errors.push(`摘录合计 ${excerptWords} 字，不能超过 ${SCENE_EXCERPT_MAX_WORDS} 字`);
    if (errors.length > 0) return {ok: false, errors};
    return {ok: true, issues: [], value: {requirement: parsed.data.requirement, perspective: parsed.data.perspective,
        techniques: techniques.material, background: background.material, supplements: supplemental.supplements,
        sourceHashes: sourceHashes([techniques.material, background.material, ...supplemental.supplements], files)}};
}

export type RewriteWindow = Readonly<{before: readonly string[]; target: string; after: readonly string[]}>;

/** 结构 D 的写手提示；上下文段落由切片 6 按段落边界截取后传入。 */
export function renderRewritePrompt(input: Readonly<{
    style: WritingStyle;
    window: RewriteWindow;
    plan: RewritePlan;
    retryProblems?: readonly string[];
}>): WriterPrompt {
    const {window, plan} = input;
    const variables = {...styleVariables(input.style),
        before: window.before.join("\n\n").trim() || "（章首，没有上文）", target: window.target.trim() || EMPTY,
        after: window.after.join("\n\n").trim() || "（章末，没有下文）", requirement: plan.requirement.trim() || EMPTY,
        perspective: plan.perspective.trim() || EMPTY, techniques: renderMaterial(plan.techniques).trim() || EMPTY,
        background: renderMaterial(plan.background).trim() || EMPTY,
        supplements: renderSupplements(plan.supplements) || "## 依据细纲补充的资料\n\n（无）",
        retryProblemsText: input.retryProblems?.length ? bullets(input.retryProblems) : "（无，首次写作）",
    };
    return {...renderWriterDefaults([...WRITER_SYSTEM_SECTIONS, ...REWRITE_WRITER_SECTIONS], variables),
        managed: {purposeId: "writing.writer.rewrite", variables}};
}

export function validateRewriteReview(submission: unknown): Validation<RewriteReviewSubmission> {
    const parsed = RewriteReviewSubmissionSchema.safeParse(submission);
    if (!parsed.success) return {ok: false, errors: zodErrors(parsed.error)};
    if (!parsed.data.passed && parsed.data.problems.length === 0) return {ok: false, errors: ["判定不通过时必须列出问题清单"]};
    return {ok: true, value: parsed.data, issues: []};
}
