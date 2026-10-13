import {describe, expect, it} from "vitest";
import {buildChapterMaterials} from "./scenes";
import {chapterContext, detailBody, outlineEntry} from "./writer-context.fixture";

const foreshadow = (marker: string, text: string, action = "plant") =>
    `<!-- nb:foreshadow marker="${marker}" foreshadow="fo-a" action="${action}" -->${text}<!-- /nb:foreshadow marker="${marker}" -->`;

function materialsOf(context: Parameters<typeof buildChapterMaterials>[0]) {
    const result = buildChapterMaterials(context);
    if (!result.ok) throw new Error(`切分失败：${JSON.stringify(result.issues)}`);
    return result;
}

function foreshadowRef(marker: string, content: string) {
    return {id: "fo-a" as const, title: "旧玉来历", path: "outline/foreshadowing/fo-a.md", version: 1, contentHash: "h",
        entryPath: "outline/entries/ol-chapter.md", marker, action: "plant" as const, content, startOffset: 0};
}

const chapter = outlineEntry({entryId: "ol-chapter", kind: "chapter", title: "第一章",
    body: `${foreshadow("fm-01", "腰间旧玉")}一闪，${foreshadow("fm-02", "檐下铜铃")}。`, writingGuidance: "整章压抑", targetWords: 9999});

describe("场景切分", () => {
    const detail = outlineEntry({entryId: "ol-detail-a", title: "细纲甲", body: detailBody({
        title: "入城", forbidden: ["主角不能被守卫抓住"],
        scenes: [
            {name: "入城", summary: "主角混进城门", words: 1200, mood: "警惕", pacing: "快",
                characters: ["林澄：不被认出", "守卫"], plot: ["排队受检", "守卫起疑", "混在商队里进城"],
                description: "城门的压迫感。", guidance: "少用形容词。",
                references: ["[城防](lorebook/城防.md)", "城门开闭时间（待补）"],
                foreshadowing: ["旧玉|fm-01|埋设|暗示身世|随口一提，不解释"]},
            {name: "夜宿", words: 800, perspective: "第一人称", plot: ["住进客栈"]},
        ]})});

    it("按模板读出场景字段，具体情节在前、执行的伏笔在后作为锁定要素，最后一条情节是结尾落点", () => {
        const {materials} = materialsOf(chapterContext({chapter, details: [detail], foreshadowing: [foreshadowRef("fm-01", "腰间旧玉")]}));
        expect(materials.targetWords).toBe(2000);
        expect(materials.overview).toMatchObject({title: "入城", targetWords: 2000});
        expect(materials.scenes.map(({index, heading, name}) => [index, heading, name])).toEqual([[1, "场景1：入城", "入城"], [2, "场景2：夜宿", "夜宿"]]);
        expect(materials.scenes[0]).toMatchObject({
            summary: "主角混进城门", perspective: "第三人称限知", targetWords: 1200, mood: "警惕", pacing: "快",
            characters: [{name: "林澄", goal: "不被认出"}, {name: "守卫", goal: ""}],
            plot: ["排队受检", "守卫起疑", "混在商队里进城"], ending: "混在商队里进城",
            description: "城门的压迫感。", guidance: "少用形容词。",
            references: [{path: "lorebook/城防.md", purpose: "城防"}, {pending: true, locator: "城门开闭时间（待补）"}],
            foreshadowing: [{marker: "fm-01", name: "旧玉", action: "plant", text: "腰间旧玉", purpose: "暗示身世", effect: "随口一提，不解释"}],
            requiredElements: ["排队受检", "守卫起疑", "混在商队里进城", "伏笔（埋设）：腰间旧玉；效果：随口一提，不解释"],
            forbidden: ["主角不能被守卫抓住"],
        });
        expect(materials.scenes[1]).toMatchObject({perspective: "第一人称", ending: "住进客栈", forbidden: ["主角不能被守卫抓住"]});
        expect(materials.forbidden).toEqual(["主角不能被守卫抓住"]);
    });

    it("正文参考资料进入条目参考：有链接的给路径，没有链接的是待补", () => {
        expect(detail.references).toEqual([{path: "lorebook/城防.md", purpose: "城防"}, {pending: true, locator: "城门开闭时间（待补）"}]);
    });

    it("一章有多份细纲时整章阻断", () => {
        const second = outlineEntry({entryId: "ol-detail-b", body: detailBody({scenes: [{plot: ["离城"]}]})});
        expect(buildChapterMaterials(chapterContext({details: [detail, second]}))).toEqual({ok: false, issues: [
            {code: "MISSING_SCENE_STRUCTURE", severity: "blocking", location: {entryId: "ol-chapter"},
                message: "本章有 2 份细纲，写作只能使用一份；请把细纲合并为一份"}]});
    });

    it("细纲结构不完整时整章失败，并列出全部阻断原因", () => {
        const bare = outlineEntry({entryId: "ol-detail-d", title: "细纲丁", body: "前言\n\n# 章节总览\n\n- 目标字数：1000"});
        expect(buildChapterMaterials(chapterContext({details: [bare]}))).toEqual({ok: false, issues: [
            {code: "MISSING_SCENE_STRUCTURE", severity: "blocking", location: {entryId: "ol-detail-d"},
                message: "细纲「细纲丁」结构不完整，请修改或重新生成：第一个一级标题之前不能有内容；「章节细纲」下没有场景，场景写成「## 场景1：名称」"}]});
    });
});

describe("本章级素材", () => {
    it("伏笔只带标记原文和动作，不含定义；漏分的提示；写作指导只取章节大纲", () => {
        const detail = outlineEntry({entryId: "ol-detail-a", body: detailBody({
            scenes: [{plot: ["相遇"], foreshadowing: ["旧玉|fm-01|埋设|身世|一笔带过"]}]})});
        const result = materialsOf(chapterContext({chapter, details: [detail],
            foreshadowing: [foreshadowRef("fm-01", "腰间旧玉"), foreshadowRef("fm-02", "檐下铜铃")]}));
        expect(result.materials.foreshadowing).toEqual([{marker: "fm-01", action: "plant", text: "腰间旧玉"}, {marker: "fm-02", action: "plant", text: "檐下铜铃"}]);
        expect(JSON.stringify(result.materials)).not.toContain("旧玉来历");
        expect(result.issues).toEqual([expect.objectContaining({code: "UNASSIGNED_FORESHADOW", severity: "hint",
            message: expect.stringContaining("檐下铜铃"), location: {entryId: "ol-chapter"}})]);
        expect(result.materials.chapterGuidance).toEqual([{entryId: "ol-chapter", title: "第一章", text: "整章压抑"}]);
    });

    it("场景认领的伏笔尚未确认时不执行，并提示先确认", () => {
        const detail = outlineEntry({entryId: "ol-detail-a", body: detailBody({
            scenes: [{plot: ["相遇"], foreshadowing: ["旧玉|fm-01|埋设|身世|一笔带过"]}]})});
        const result = materialsOf(chapterContext({chapter, details: [detail]}));
        expect(result.materials.scenes[0]!.foreshadowing).toEqual([]);
        expect(result.issues).toEqual([{code: "UNASSIGNED_FORESHADOW", severity: "hint", location: {entryId: "ol-detail-a", sceneIndex: 1},
            message: "场景1的伏笔「旧玉」对应的伏笔尚未确认，写手不会执行；请先在伏笔库确认该伏笔"}]);
    });

    it("场景字数之和偏离总览目标字数超过 50% 时提示，按细纲总览而不是章节大纲", () => {
        const detail = (words: number) => outlineEntry({entryId: "ol-detail-a", body: detailBody({targetWords: 2000, scenes: [{plot: ["事件"], words}]})});
        expect(materialsOf(chapterContext({chapter, details: [detail(1000)]})).issues).toEqual([]);
        expect(materialsOf(chapterContext({chapter, details: [detail(999)]})).issues).toEqual([{code: "WORD_TARGET_MISMATCH", severity: "hint",
            message: "各场景字数之和 999 与目标字数 2000 相差超过 50%", location: {entryId: "ol-detail-a"}}]);
    });

    it("待补参考资料转为提示", () => {
        const detail = outlineEntry({entryId: "ol-detail-a", body: detailBody({scenes: [{plot: ["事件"]}]})});
        const result = materialsOf(chapterContext({details: [detail], warnings: [
            {code: "PENDING_REFERENCE", entryId: "ol-detail-a", entryPath: detail.path, locator: "城防制度"},
        ]}));
        expect(result.issues).toEqual([{code: "PENDING_REFERENCE", severity: "hint", message: "参考资料待补：城防制度",
            location: {entryId: "ol-detail-a"}}]);
    });
});
