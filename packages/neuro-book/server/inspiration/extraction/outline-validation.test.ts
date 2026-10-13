import {describe, expect, it} from "vitest";
import {detailBody} from "nbook/server/outline/detail.fixture";
import {
    parseCitedOutput, plainOutput, validateChapterOutlineBody, validateCitedOutput, validateDetailBody,
    validatePlainOutput, validateTotalBody, validateVolumeBody,
} from "./outline-validation";

const RANGE = {first: 5, last: 8};

function failure(result: {ok: boolean; error?: string}): string {
    if (result.ok) throw new Error("预期校验失败");
    return result.error ?? "";
}

describe("parseCitedOutput", () => {
    it("拆出正文与规范化的引用定位，并去掉整体代码围栏", () => {
        const result = parseCitedOutput("```markdown\n正文\n【引用】P5-P6、P8\n```", RANGE);
        expect(result).toEqual({ok: true, value: {body: "正文", locator: "P5-P6, P8"}});
    });

    it("缺少引用行、引用越界、倒序和格式错误都给出可用于修复的中文说明", () => {
        expect(failure(parseCitedOutput("只有正文", RANGE))).toContain("缺少末尾的原文引用行");
        expect(failure(parseCitedOutput("正文\n【引用】P4-P6", RANGE))).toContain("超出本章范围 P5-P8");
        expect(failure(parseCitedOutput("正文\n【引用】P9", RANGE))).toContain("超出本章范围");
        expect(failure(parseCitedOutput("正文\n【引用】P8-P5", RANGE))).toContain("起点大于终点");
        expect(failure(parseCitedOutput("正文\n【引用】第三段", RANGE))).toContain("格式无效");
        expect(failure(parseCitedOutput("正文\n【引用】", RANGE))).toContain("没有写任何 P 编号");
        expect(failure(parseCitedOutput("【引用】P5", RANGE))).toContain("没有正文");
    });

    it("正文里夹带本章以外的 P 编号也视为越界，本章内的编号和普通单词不受影响", () => {
        expect(failure(parseCitedOutput("见 P20 的描写\n【引用】P5", RANGE))).toContain("P20");
        expect(parseCitedOutput("见 P6 与 PDF\n【引用】P5", RANGE).ok).toBe(true);
    });
});

describe("模板校验", () => {
    it("卷纲、总纲、章节大纲缺少必需标题或标题下为空时点名缺失项", () => {
        expect(failure(validateVolumeBody("# 本卷目标\n目标"))).toContain("缺少一级标题“# 起始状态”");
        expect(failure(validateTotalBody("# 核心冲突\n\n# 主题\n主题\n# 结局方向\n结局"))).toContain("“# 核心冲突”下没有内容");
        expect(validateChapterOutlineBody("# 章节目标\n目标\n# 场景设定\n地点\n# 剧情概要\n概要\n# 章节结尾\n悬念").ok).toBe(true);
    });

    it("细纲接受合法模板，拒绝伏笔小节", () => {
        expect(validateDetailBody(detailBody({scenes: [{name: "场景", plot: ["事件"]}]})).ok).toBe(true);
        expect(failure(validateDetailBody("没有结构的文字"))).toContain("细纲不符合模板");
        expect(failure(validateDetailBody(`${detailBody({scenes: [{name: "场景", plot: ["事件"]}]})}\n## 伏笔\n- 某条`))).toContain("伏笔");
    });

    it("带引用的产出先核引用再核模板；卷纲与总纲不允许引用行", () => {
        const chapter = validateCitedOutput(RANGE, validateChapterOutlineBody);
        expect(failure(chapter("# 章节目标\n目标\n【引用】P5"))).toContain("章节大纲不符合模板");
        expect(failure(chapter("# 章节目标\n目标\n【引用】P99"))).toContain("超出本章范围");
        expect(failure(validatePlainOutput(validateVolumeBody)("# 本卷目标\n目标\n【引用】P5"))).toContain("不需要原文引用");
        expect(plainOutput("").ok).toBe(false);
    });
});
