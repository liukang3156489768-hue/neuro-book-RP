import {describe, expect, it} from "vitest";
import {buildChapterMaterials, type ChapterMaterials} from "./scenes";
import {
    judgeScene, renderRewritePrompt, renderScenePrompt, validateMaterialReview, validateRewritePlan, validateRewriteReview, validateScenePlan,
    validateSceneReview, type PlannedScene, type ScenePlan,
} from "./structures";
import {chapterContext, detailBody, outlineEntry} from "./writer-context.fixture";

const style = {requirements: "冷峻克制。", forbidden: "不用比喻。", sample: ""};

const context = chapterContext({
    chapter: outlineEntry({entryId: "ol-chapter", kind: "chapter", title: "第一章", body: "章节大纲", writingGuidance: "整章压抑"}),
    details: [outlineEntry({entryId: "ol-detail-a", title: "细纲甲", body: detailBody({
        title: "入城", forbidden: ["主角不能被守卫抓住"],
        scenes: [
            {name: "入城", summary: "主角混进城门", words: 1000, mood: "警惕", characters: ["林澄：不被认出"], plot: ["盘查"],
                description: "城门压迫。", guidance: "短句为主。", foreshadowing: ["旧玉|fm-01|埋设|暗示身世|随口一提"]},
            {name: "夜宿", summary: "客栈过夜", words: 800, plot: ["住进客栈", "熄灯"], references: ["[没有](lorebook/没有.md)"]},
        ]})})],
    foreshadowing: [{id: "fo-a", title: "旧玉来历", path: "outline/foreshadowing/fo-a.md", version: 1, contentHash: "h",
        entryPath: "outline/entries/ol-chapter.md", marker: "fm-01", action: "plant", content: "腰间旧玉", startOffset: 0}],
});

function materials(): ChapterMaterials {
    const result = buildChapterMaterials(context);
    if (!result.ok) throw new Error(`切分失败：${JSON.stringify(result.issues)}`);
    return result.materials;
}

const files = new Map([
    ["lorebook/林澄.md", "# 基础人设\n\n林澄是少年，性格谨慎，遇到盘查会先观察。"],
    ["lorebook/城防.md", "# 城防\n\n城墙高十丈。\n\n# 城门\n\n四门。"],
    ["lorebook/长文.md", `${"甲".repeat(1000)}\n\n${"乙".repeat(1000)}\n\n${"丙".repeat(1000)}\n\n丁`],
]);

const planInput = () => ({planId: context.planId, basis: context.basis, materials: materials(), files});

const sceneSubmission = (index: number, heading: string, extra: Record<string, unknown> = {}) => ({
    index, heading, techniques: {points: ["短句"], excerpts: []},
    background: {points: [], excerpts: [{path: "lorebook/城防.md", heading: "城防"}]}, extraMustInclude: [],
    supplements: index === 1 ? [{kind: "character", subject: "林澄", points: ["少年，谨慎，盘查时先观察"],
        excerpts: [{path: "lorebook/林澄.md", heading: "基础人设"}]}] : [], ...extra,
});

function validPlan(): ScenePlan {
    const result = validateScenePlan({scenes: [
        sceneSubmission(1, "场景1：入城", {extraMustInclude: ["旧玉"]}),
        sceneSubmission(2, "场景2：夜宿"),
    ]}, planInput());
    if (!result.ok) throw new Error(result.errors.join("\n"));
    return result.value;
}

describe("结构 A 校验", () => {
    it("单场景规划保留整章目标，只允许当前编号与标题，角色和来源约束仍生效", () => {
        const input = {...planInput(), sceneIndices: [2]};
        const result = validateScenePlan({scenes: [sceneSubmission(2, "场景2：夜宿")]}, input);
        expect(result).toMatchObject({ok: true, value: {targetWords: 1800, scenes: [{index: 2}]}});
        expect(result.ok && result.value.scenes).toHaveLength(1);
        expect(validateScenePlan({scenes: [sceneSubmission(1, "场景1：入城")]}, input)).toMatchObject({ok: false});
        expect(validateScenePlan({scenes: [sceneSubmission(1, "场景1：入城"), sceneSubmission(2, "场景2：夜宿")]}, input)).toMatchObject({ok: false});
        expect(validateScenePlan({scenes: [sceneSubmission(1, "场景1：入城", {supplements: []})]}, {...planInput(), sceneIndices: [1]}))
            .toMatchObject({ok: false, errors: [expect.stringContaining("缺少角色")]});
        expect(validateScenePlan({scenes: [sceneSubmission(2, "场景2：夜宿", {background: {points: [], excerpts: [{path: "missing.md", heading: "x"}]}})]}, input))
            .toMatchObject({ok: false, errors: [expect.stringContaining("不可读")]});
    });
    it("缺少角色、额外角色或没有真实来源的补充不能通过", () => {
        const validate = (supplements: unknown[]) => validateScenePlan({scenes: [sceneSubmission(1, "场景1：入城", {supplements}),
            sceneSubmission(2, "场景2：夜宿")]}, planInput());
        expect(validate([])).toMatchObject({ok: false, errors: [expect.stringContaining("缺少角色「林澄」")]});
        expect(validate([{kind: "character", subject: "林澄", points: ["谨慎"], excerpts: []}])).toMatchObject({ok: false});
        expect(validate([{kind: "character", subject: "林澄", points: ["谨慎"], excerpts: [{path: "lorebook/不存在.md", heading: "人设"}]}])).toMatchObject({ok: false});
        expect(validate([{kind: "character", subject: "别的人", points: ["谨慎"], excerpts: [{path: "lorebook/林澄.md", heading: "基础人设"}]}])).toMatchObject({ok: false});
    });

    it("独立审核不得同时声称通过又列问题，也不得无理由退回", () => {
        expect(validateMaterialReview({passed: true, problems: ["缺资料"]})).toMatchObject({ok: false});
        expect(validateMaterialReview({passed: false, problems: []})).toMatchObject({ok: false});
        expect(validateMaterialReview({passed: false, problems: ["关系采用了未来记录"]})).toMatchObject({ok: true});
    });
    it("场景逐一对应；具体情节与伏笔锁定在前、助手追加在后；整章目标取细纲总览", () => {
        const result = validateScenePlan({scenes: [
            sceneSubmission(1, "场景1：入城", {extraMustInclude: ["旧玉"]}),
            sceneSubmission(2, "场景2：夜宿"),
        ]}, planInput());
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const [first, second] = result.value.scenes;
        expect(result.value.targetWords).toBe(1800);
        expect(first).toMatchObject({summary: "主角混进城门", perspective: "第三人称限知", targetWords: 1000,
            mustInclude: ["盘查", "伏笔（埋设）：腰间旧玉；效果：随口一提", "旧玉"], forbidden: ["主角不能被守卫抓住"]});
        expect(second).toMatchObject({mustInclude: ["住进客栈", "熄灯"], ending: "熄灯"});
        expect(first!.background.excerpts).toEqual([{path: "lorebook/城防.md", locator: "标题「城防」", text: "# 城防\n\n城墙高十丈。"}]);
        expect(result.value.basis).toBe(context.basis);
    });

    it("场景参考资料读不到只提示，不退回助手", () => {
        expect(validateScenePlan({scenes: [sceneSubmission(1, "场景1：入城"), sceneSubmission(2, "场景2：夜宿")]}, planInput()))
            .toMatchObject({ok: true, issues: [{code: "PENDING_REFERENCE", severity: "hint", location: {entryId: "ol-detail-a", sceneIndex: 2},
                message: expect.stringContaining("lorebook/没有.md")}]});
    });

    it("场景数量或标题不对应时拒绝", () => {
        expect(validateScenePlan({scenes: [sceneSubmission(1, "场景1：入城")]}, planInput()))
            .toMatchObject({ok: false, errors: [expect.stringContaining("场景数量应为 2")]});
        expect(validateScenePlan({scenes: [sceneSubmission(1, "进城"), sceneSubmission(2, "场景2：夜宿")]}, planInput()))
            .toMatchObject({ok: false, errors: [expect.stringContaining("「场景1：入城」")]});
    });

    it("效果、人称、锁定要素等程序字段不接受助手提交，多余字段拒绝", () => {
        const scenes = (extra: Record<string, unknown>) => [sceneSubmission(1, "场景1：入城", extra), sceneSubmission(2, "场景2：夜宿")];
        expect(validateScenePlan({scenes: scenes({effect: "压迫感"})}, planInput())).toMatchObject({ok: false});
        expect(validateScenePlan({scenes: scenes({perspective: "第一人称"})}, planInput())).toMatchObject({ok: false});
        expect(validateScenePlan({scenes: scenes({mustInclude: ["改写锁定要素"]})}, planInput())).toMatchObject({ok: false});
        expect(validateScenePlan({scenes: scenes({extraMustInclude: [" "]})}, planInput())).toMatchObject({ok: false});
    });

    it("摘录位置不存在、文件不可读或合计超过 3000 字时拒绝", () => {
        const excerpts = (list: unknown[]) => ({background: {points: [], excerpts: list}});
        const missing = validateScenePlan({scenes: [
            sceneSubmission(1, "场景1：入城", excerpts([{path: "lorebook/城防.md", heading: "城墙"}])),
            sceneSubmission(2, "场景2：夜宿", excerpts([{path: "lorebook/没有.md", paragraphs: {from: 1}}])),
        ]}, planInput());
        expect(missing).toMatchObject({ok: false, errors: [expect.stringContaining("找不到标题「城墙」"), expect.stringContaining("不存在或不可读")]});
        const tooLong = validateScenePlan({scenes: [
            sceneSubmission(1, "场景1：入城", excerpts([1, 2, 3, 4].map((from) => ({path: "lorebook/长文.md", paragraphs: {from}})))),
            sceneSubmission(2, "场景2：夜宿"),
        ]}, planInput());
        expect(tooLong).toMatchObject({ok: false, errors: [expect.stringContaining("不能超过 3000 字")]});
    });
});

describe("结构 B 渲染", () => {
    it("按固定顺序拼装；伏笔作用不进写手提示；下一场景只给简述", () => {
        const plan = validPlan();
        const first = renderScenePrompt({style, materials: materials(), scene: plan.scenes[0]!, previousEnding: "上一章最后一句。", acceptedProse: ""});
        expect(first.system).toContain("冷峻克制。");
        expect(first.system).toContain("## 样文\n\n（无）");
        const order = ["上一章结尾", "章节总览", "场景一览", "已通过正文", "本章写作指导", "本章伏笔标记原文", "本场景（场景 1：入城）",
            "参与角色", "具体情节", "描写", "写作指导", "本场景伏笔", "写作手法补充", "背景知识", "必须写到的要素", "不能出现的情节", "输出要求"];
        const lines = first.user.split("\n");
        const positions = order.map((title) => lines.indexOf(`## ${title}`));
        expect(positions.every((position) => position >= 0)).toBe(true);
        expect([...positions].sort((a, b) => a - b)).toEqual(positions);
        expect(first.user).toContain("- 章节标题：入城");
        expect(first.user).toContain("- 目标字数：约 1800 字");
        expect(first.user).toContain("- 场景 1（当前）：入城，约 1000 字，结尾落点：盘查");
        expect(first.user).toContain("下一场景：夜宿（客栈过夜），只用于结尾铺垫，不得展开");
        expect(first.user).not.toContain("住进客栈");
        expect(first.user).toContain("本场景执行｜埋设：腰间旧玉");
        expect(first.user).toContain("## 本场景伏笔\n\n- 埋设：腰间旧玉（效果：随口一提）");
        expect(first.user).not.toContain("暗示身世");
        expect(first.user).not.toContain("旧玉来历");
        expect(first.user).toContain("- 林澄：不被认出");
        expect(first.user).toContain("角色基础资料：林澄");
        expect(first.user).toContain("林澄是少年，性格谨慎");
        expect(first.user).toContain("## 具体情节\n\n1. 盘查");
        expect(first.user).toContain("## 写作指导\n\n短句为主。");
        expect(first.user).toContain("> 摘自 lorebook/城防.md 标题「城防」");
        expect(first.user).toContain("## 不能出现的情节\n\n- 主角不能被守卫抓住");

        const second = renderScenePrompt({style, materials: materials(), scene: plan.scenes[1]!, previousEnding: "上一章最后一句。",
            acceptedProse: "第一场正文。", retryProblems: ["字数不足"]});
        expect(second.user).toContain("## 上一章结尾\n\n（非首场景，不提供上一章结尾）");
        expect(second.user).toContain("上一场景结尾落点：盘查");
        expect(second.user).toContain("下一场景：（无）");
        expect(second.user).toContain("不在本场景执行｜埋设：腰间旧玉");
        expect(second.user).toContain("## 已通过正文\n\n第一场正文。");
        expect(second.user).toContain("## 不能出现的情节\n\n- 主角不能被守卫抓住");
        expect(second.user.indexOf("字数不足")).toBeLessThan(second.user.indexOf("## 输出要求"));
    });
});

describe("结构 C 审阅", () => {
    const scene = (): PlannedScene => validPlan().scenes[0]!;
    const elements = [{element: "盘查", covered: true}, {element: "伏笔（埋设）：腰间旧玉；效果：随口一提", covered: true}, {element: "旧玉", covered: true}];
    const forbidden = [{item: "主角不能被守卫抓住", violated: false}];

    it("要素与禁止事项必须按顺序逐项对应，不通过时必须有问题清单", () => {
        expect(validateSceneReview({passed: true, elements, forbidden}, scene())).toMatchObject({ok: true});
        expect(validateSceneReview({passed: true, elements: [...elements].reverse(), forbidden}, scene())).toMatchObject({ok: false});
        expect(validateSceneReview({passed: true, elements}, scene()))
            .toMatchObject({ok: false, errors: [expect.stringContaining("forbidden 必须按顺序逐项对应")]});
        expect(validateSceneReview({passed: true, elements, avoid: forbidden}, scene())).toMatchObject({ok: false});
        expect(validateSceneReview({passed: false, elements, forbidden}, scene())).toMatchObject({ok: false, errors: ["判定不通过时必须列出问题清单"]});
    });

    it("字数不少于目标 70%、要素全部写到、禁止事项未出现且助手通过才算通过", () => {
        const review = {passed: true, elements: [{element: "盘查", covered: true}], forbidden, problems: []};
        expect(judgeScene({review, output: "字".repeat(700), targetWords: 1000})).toEqual({passed: true, words: 700, problems: []});
        expect(judgeScene({review, output: "字".repeat(699), targetWords: 1000}))
            .toMatchObject({passed: false, problems: [expect.stringContaining("字数 699")]});
        expect(judgeScene({review: {...review, elements: [{element: "盘查", covered: false}]}, output: "字".repeat(1000), targetWords: 1000}))
            .toMatchObject({passed: false, problems: ["没有写到：盘查"]});
        expect(judgeScene({review: {...review, forbidden: [{item: "主角不能被守卫抓住", violated: true}]}, output: "字".repeat(1000), targetWords: 1000}))
            .toMatchObject({passed: false, problems: ["出现了禁止的情节：主角不能被守卫抓住"]});
        expect(judgeScene({review: null, output: " \n", targetWords: 1000})).toEqual({passed: false, words: 0, problems: ["写手输出为空"]});
    });
});

describe("结构 D 改写", () => {
    it("校验改写规划并渲染上下文和修改要求", () => {
        const plan = validateRewritePlan({requirement: "加强对峙", perspective: "第三人称",
            techniques: {points: [], excerpts: []}, background: {points: ["城有四门"], excerpts: []}}, files);
        expect(plan.ok).toBe(true);
        if (!plan.ok) return;
        const prompt = renderRewritePrompt({style, plan: plan.value, window: {before: ["前一段。"], target: "目标段。", after: []},
            retryProblems: ["语气过软"]});
        expect(prompt.user).toContain("## 上文\n\n前一段。");
        expect(prompt.user).toContain("## 下文\n\n（章末，没有下文）");
        expect(prompt.user).toContain("- 城有四门");
        expect(prompt.user).toContain("- 语气过软");
        expect(validateRewritePlan({requirement: "", perspective: "甲", techniques: {}, background: {}}, files)).toMatchObject({ok: false});
    });

    it("改写审阅不通过时必须有问题清单", () => {
        expect(validateRewriteReview({passed: true})).toMatchObject({ok: true, value: {passed: true, problems: []}});
        expect(validateRewriteReview({passed: false})).toMatchObject({ok: false});
    });
});
