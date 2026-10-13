import {describe, expect, it} from "vitest";
import {detailBody} from "nbook/server/outline/detail.fixture";
import {analyzeDetailStructure, blockingDetailProblems, detailReferences, detailTemplate, extractionDetailTemplate, sceneTemplate} from "./outline-detail-structure";

const codes = (body: string, options?: Parameters<typeof analyzeDetailStructure>[1]) =>
    analyzeDetailStructure({body}, options).problems.map(({severity, code}) => `${severity}:${code}`);

describe("细纲结构检查", () => {
    it("提取模板不包含提取阶段禁止的参考资料和伏笔小节", () => {
        const template = extractionDetailTemplate();
        expect(template).not.toContain("### 参考资料");
        expect(template).not.toContain("### 伏笔");
        expect(template).toContain("# 章节总览");
        expect(template).toContain("## 场景1：场景名称");
    });
    it("地点、服饰和缩进角色资料完整保留，子字段不被误认成角色", () => {
        const body = detailBody({scenes: [{words: 100, characters: ["林澄：交谈"], plot: ["离开"]}]})
            .replace("### 参与角色", "### 场景地点\n\n- 具体位置：学校教室，随后走廊\n- 地点资料：[教室](lorebook/location/classroom/index.md)\n\n### 参与角色")
            .replace("- 林澄：交谈", "- 林澄：交谈\n  - 角色资料：[林澄](lorebook/character/lin/index.md)\n  - 当前状态：紧张\n  - 外貌要求：袖口有水痕")
            .replace("### 具体情节", "### 角色服饰与外观状态\n\n- 林澄：延续校服外套\n\n### 具体情节");
        const result = analyzeDetailStructure({body});
        expect(result.scenes[0]).toMatchObject({location: expect.stringContaining("学校教室，随后走廊"), attire: "- 林澄：延续校服外套",
            characters: [{name: "林澄", goal: "交谈", materialPath: "lorebook/character/lin/index.md", state: "紧张", appearance: "袖口有水痕"}]});
        expect(detailReferences(body).map(item => item.path)).toEqual(expect.arrayContaining([
            "lorebook/character/lin/index.md", "lorebook/location/classroom/index.md"]));
        expect(result.problems.some(item => item.code === "IGNORED_CONTENT")).toBe(false);
    });
    it("按模板读出总览、场景字段、各小节与禁止事项", () => {
        const body = detailBody({title: "雨夜", forbidden: ["主角不能死"], scenes: [
            {name: "相遇", summary: "两人在雨中相遇", words: 1200, mood: "压抑", pacing: "慢", characters: ["林澄：躲雨", "顾川"],
                plot: ["撑伞", "对视"], description: "雨声。", guidance: "少对白。", references: ["[城](lorebook/城.md)", "旧报纸"],
                foreshadowing: ["旧玉|fm-01|埋设|身世|一笔带过"]},
            {words: 800, plot: ["分别"]},
        ]});
        const structure = analyzeDetailStructure({body});
        expect(structure.problems).toEqual([]);
        expect(structure.overview).toEqual({title: "雨夜", summary: "本章的经过", conflict: "主角与阻力", mood: "先压后放", targetWords: 2000});
        expect(structure.forbidden).toEqual(["主角不能死"]);
        expect(structure.scenes[0]).toMatchObject({index: 1, heading: "场景1：相遇", name: "相遇", summary: "两人在雨中相遇", words: 1200,
            perspective: "第三人称限知", mood: "压抑", pacing: "慢", characters: [{name: "林澄", goal: "躲雨"}, {name: "顾川", goal: ""}],
            plot: ["撑伞", "对视"], description: "雨声。", guidance: "少对白。",
            references: [{label: "城", path: "lorebook/城.md"}, {label: "旧报纸"}],
            foreshadowing: [{name: "旧玉", marker: "fm-01", status: "plant", purpose: "身世", effect: "一笔带过"}]});
        expect(structure.scenes[1]).toMatchObject({heading: "场景2", name: "", plot: ["分别"]});
        expect(body.slice(structure.scenes[1]!.start, structure.scenes[1]!.end).startsWith("## 场景2")).toBe(true);
        expect(detailReferences(body)).toEqual([{label: "城", path: "lorebook/城.md"}, {label: "旧报纸"}]);
    });

    it("字段可写成「约1500字」，长字段可以换行，情节的缩进子项并入上一条", () => {
        const body = [
            "# 章节总览", "", "- 剧情概括：第一行", "  第二行", "- 目标字数：约 1,500 字", "",
            "# 章节细纲", "", "## 场景1", "", "- 场景简述：经过", "- 字数要求：1500字", "- 人称要求：第一人称", "",
            "### 具体情节", "", "1. 出门", "   - 带伞", "2. 下雨", "",
        ].join("\n");
        const structure = analyzeDetailStructure({body});
        expect(structure.problems).toEqual([]);
        expect(structure.overview).toMatchObject({summary: "第一行\n第二行", targetWords: 1500});
        expect(structure.scenes[0]).toMatchObject({words: 1500, plot: ["出门；带伞", "下雨"]});
    });

    it("缺总览、缺目标字数、前置内容、未知或重复的一级标题阻断", () => {
        expect(codes("# 章节细纲\n\n## 场景1\n\n- 场景简述：甲\n- 字数要求：100\n- 人称要求：第一人称\n\n### 具体情节\n\n1. 乙"))
            .toEqual(["blocking:MISSING_OVERVIEW"]);
        const valid = detailBody({scenes: [{plot: ["事件"]}]});
        expect(codes(valid.replace("- 目标字数：1000", "- 目标字数："))).toEqual(["blocking:MISSING_TARGET_WORDS"]);
        expect(codes(valid.replace("- 目标字数：1000", "- 目标字数：很多"))).toEqual(["blocking:INVALID_WORDS"]);
        expect(codes(`前言\n\n${valid}`)).toEqual(["blocking:PRELUDE_CONTENT"]);
        expect(codes(`${valid}\n# 写作指导\n\n放慢`)).toEqual(["blocking:UNKNOWN_SECTION"]);
        expect(codes(`${valid}\n# 章节总览\n\n- 目标字数：1`)).toEqual(["blocking:DUPLICATE_SECTION"]);
    });

    it("场景标题、编号与必填字段按场景阻断", () => {
        expect(codes("# 章节总览\n\n- 目标字数：1000\n\n# 章节细纲\n\n说明")).toEqual(["blocking:MISSING_SCENE_STRUCTURE"]);
        const two = detailBody({scenes: [{plot: ["甲"]}, {plot: ["乙"]}]});
        expect(codes(two.replace("## 场景2", "## 第二场"))).toEqual(["blocking:INVALID_SCENE_HEADING"]);
        expect(codes(two.replace("## 场景2", "## 场景3"))).toEqual(["blocking:SCENE_NUMBER_GAP"]);
        const one = detailBody({scenes: [{plot: ["甲"]}]});
        expect(codes(one.replace(/- 场景简述：.*\n/u, ""))).toEqual(["blocking:MISSING_SCENE_SUMMARY"]);
        expect(codes(one.replace("- 字数要求：1000", "- 字数要求："), {})).toEqual(["blocking:MISSING_SCENE_WORDS"]);
        expect(codes(one.replace("- 人称要求：第三人称限知", "- 人称要求："))).toEqual(["blocking:MISSING_PERSPECTIVE"]);
        expect(codes(one.replace("1. 甲", ""))).toEqual(["blocking:MISSING_PLOT"]);
        expect(analyzeDetailStructure({body: one.replace("1. 甲", "")}).problems[0]).toMatchObject({sceneIndex: 1});
    });

    it("模板外的小节与场景前的文字只提示", () => {
        const one = detailBody({scenes: [{plot: ["甲"]}]});
        expect(codes(one.replace("### 具体情节", "### 对话\n\n台词\n\n### 具体情节"))).toEqual(["hint:IGNORED_CONTENT"]);
        expect(codes(one.replace("# 章节细纲\n", "# 章节细纲\n\n说明\n"))).toEqual(["hint:IGNORED_CONTENT"]);
    });

    it("伏笔要有标记和合法状态；给出章节标记时检查标记存在且状态与动作一致", () => {
        const body = (item: string) => detailBody({scenes: [{plot: ["甲"], foreshadowing: [item]}]});
        expect(codes(body("旧玉||埋设|身世|一笔"))).toEqual(["blocking:MISSING_FORESHADOW_MARKER"]);
        expect(codes(body("旧玉|fm-01|揭示|身世|一笔"))).toEqual(["blocking:INVALID_FORESHADOW_STATUS"]);
        expect(codes(body("旧玉|fm-09|埋设|身世|一笔"))).toEqual([]);
        const markers = new Map([["fm-01", "plant" as const]]);
        expect(codes(body("旧玉|fm-09|埋设|身世|一笔"), {chapterMarkers: markers})).toEqual(["blocking:UNKNOWN_FORESHADOW_MARKER"]);
        expect(codes(body("旧玉|fm-01|回收|身世|一笔"), {chapterMarkers: markers})).toEqual(["blocking:FORESHADOW_STATUS_MISMATCH"]);
        expect(codes(body("旧玉|fm-01|埋设|身世|一笔"), {chapterMarkers: markers})).toEqual([]);
    });

    it("场景字数之和与目标字数相差超过 50% 时提示", () => {
        expect(codes(detailBody({targetWords: 2000, scenes: [{plot: ["甲"], words: 1000}]}))).toEqual([]);
        expect(codes(detailBody({targetWords: 2000, scenes: [{plot: ["甲"], words: 999}]}))).toEqual(["hint:WORD_TARGET_MISMATCH"]);
    });

    it("代码块内的 # 不算标题", () => {
        const body = detailBody({scenes: [{plot: ["甲"], description: "```\n# 注释\n## 场景9\n```"}]});
        expect(codes(body)).toEqual([]);
        expect(analyzeDetailStructure({body}).scenes).toHaveLength(1);
    });

    it("空模板阻断，填好必填项后通过", () => {
        const template = detailTemplate("第一章");
        expect(blockingDetailProblems(analyzeDetailStructure({body: template})).map(({code}) => code))
            .toEqual(["MISSING_TARGET_WORDS", "MISSING_SCENE_SUMMARY", "MISSING_SCENE_WORDS", "MISSING_PERSPECTIVE", "MISSING_PLOT"]);
        const filled = template.replace("- 目标字数：", "- 目标字数：1000").replace("- 场景简述：", "- 场景简述：经过")
            .replace("- 字数要求：", "- 字数要求：1000").replace("- 人称要求：", "- 人称要求：第一人称").replace("1. ", "1. 出门");
        const structure = analyzeDetailStructure({body: filled});
        expect(structure.problems).toEqual([]);
        expect(structure.scenes[0]).toMatchObject({heading: "场景1：", characters: []});
        expect(structure.forbidden).toEqual([]);
        expect(sceneTemplate(2).startsWith("## 场景2：")).toBe(true);
    });
});
