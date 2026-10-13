import {describe, expect, it} from "vitest";
import {processTavernWriterOutput} from "./tavern-output";
import {scanTuringQuality} from "./tavern-output-quality";

function source(extra: Record<string, unknown> = {}) {
    return JSON.stringify({prompts: [{identifier: "rule", role: "system", content: "规则"}],
        prompt_order: [{character_id: 100001, order: [{identifier: "rule", enabled: true}]}], ...extra});
}
const identity = {user: "委托者", char: "写手"};

describe("酒馆写手输出边界", () => {
    it("分别保留raw、stored、display；正文与历史不使用display插入的HTML", () => {
        const raw = "说明\n<content>旧词，{{char}}</content><time>午夜</time>";
        const output = processTavernWriterOutput({sourceJson: source({extensions: {regex_scripts: [
            {scriptName: "保存替换", findRegex: "/旧词/g", replaceString: "正文", placement: [2]},
            {scriptName: "显示格式", findRegex: "/<content>([\\s\\S]*?)<\\/content>/g", replaceString: "<article>$1</article>",
                placement: [2], markdownOnly: true},
            {scriptName: "提示处理", findRegex: "/正文/g", replaceString: "提示专用", placement: [2], promptOnly: true},
        ]}}), raw, ...identity, policy: {mode: "tag", tag: "content"}});
        expect(output.raw).toBe(raw);
        expect(output.stored).toBe("说明\n<content>正文，{{char}}</content><time>午夜</time>");
        expect(output.display).toBe("说明\n<article>正文，写手</article><time>午夜</time>");
        expect(output.prose).toBe("正文，{{char}}");
        expect(output.extractionError).toBeNull();
    });
    it.each(["只输出了说明", "<content>部分正文", "</content>逆序<content>",
        "<content>A</content><content>B</content>", "<content><content>A</content></content>", "<content> \n </content>"])(
        "缺失、不完整或歧义正文仍保留审查证据：%s", raw => {
            const output = processTavernWriterOutput({sourceJson: source(), raw, ...identity, policy: {mode: "tag", tag: "content"}});
            expect(output.prose).toBeNull();
            expect(output.extractionError).not.toBeNull();
            expect(output.raw).toBe(raw);
            expect(output.stored).toBe(raw);
            expect(JSON.parse(JSON.stringify(output))).toEqual(output);
        });
    it("full显式允许全文；tag不区分大小写且去掉封套外说明", () => {
        const raw = "\n 说明\n<CONTENT> 正文 </CONTENT>\n尾注 ";
        expect(processTavernWriterOutput({sourceJson: source(), raw, ...identity, policy: {mode: "full"}}).prose).toBe(raw.trim());
        expect(processTavernWriterOutput({sourceJson: source(), raw, ...identity, policy: {mode: "tag", tag: "content"}}).prose).toBe("正文");
    });
    it("存储正则在最新assistant深度0执行，输出宏副作用可冻结且不修改编译初值", () => {
        const state = {local: {seed: "before"}, global: {}};
        const output = processTavernWriterOutput({sourceJson: source({extensions: {regex_scripts: [
            {scriptName: "身份与状态", findRegex: "/正文/g", replaceString: "{{setvar::seed::after}}{{user}}", placement: [2]},
            {scriptName: "较旧历史", findRegex: "/委托者/g", replaceString: "不应出现", placement: [2], minDepth: 1},
        ]}}), raw: "<content>正文</content>", ...identity, state, policy: {mode: "tag", tag: "content"}});
        expect(output.prose).toBe("委托者");
        expect(output.variablesAfter.local).toEqual({seed: "after"});
        expect(state.local).toEqual({seed: "before"});
    });
    it("未知启用脚本只记录依赖；禁用脚本忽略", () => {
        const output = processTavernWriterOutput({sourceJson: source({extensions: {tavern_helper: {scripts: [
            {name: "未知脚本", enabled: true, content: "throw new Error('must not execute')"},
            {name: "停用脚本", enabled: false, content: "throw new Error('must not execute')"},
        ]}}}), raw: "正文", ...identity, policy: {mode: "full"}});
        expect(output.prose).toBe("正文");
        expect(output.quality).toEqual([]);
        expect(output.extensionWarnings).toEqual(["未知脚本：未适配脚本，保留源码但不执行"]);
        expect(output.fullEnvironmentEquivalent).toBe(false);
    });
    it("native替换和trim使用冻结引擎及身份，stored与display按顺序共享变量终态", () => {
        const state = {local: {obsolete: "before", prefix: "DROP"}, global: {obsolete: "before"}};
        const output = processTavernWriterOutput({sourceJson: source({extensions: {regex_scripts: [
            {scriptName: "native存储", findRegex: "/DROP旧词/g", trimStrings: ["{{getvar::prefix}}"],
                replaceString: "{{deletevar::obsolete}}{{setvar::identity::{{user}}}}{{getvar::identity}}:$0", placement: [2]},
            {scriptName: "native显示", findRegex: "/<content>(.*?)<\\/content>/g", placement: [2], markdownOnly: true,
                replaceString: "{{deleteglobalvar::obsolete}}{{setvar::displayed::{{getvar::identity}}}}<article>$1</article>"},
        ]}}), raw: "<content>DROP旧词</content>", ...identity, state, macroEngine: "native",
            bindings: {...identity, slots: {}, nativeContext: {now: "2026-10-11T00:00:00Z", randomSeed: "frozen"}},
            policy: {mode: "tag", tag: "content"}});
        expect(output.prose).toBe("委托者:旧词");
        expect(output.display).toBe("<article>委托者:旧词</article>");
        expect(output.variablesAfter).toEqual({local: {prefix: "DROP", identity: "委托者", displayed: "委托者"}, global: {}});
        expect(state).toEqual({local: {obsolete: "before", prefix: "DROP"}, global: {obsolete: "before"}});
    });
});

describe("Turing v3.11本地质检适配", () => {
    it("使用标签范围、去除think/代码块/HTML，与脚本缺标签时全文扫描一致", () => {
        const raw = "弧度<content><think>弧度</think>```弧度```<b>正文</b></content>弧度";
        expect(scanTuringQuality(raw, "content").hits).toEqual([]);
        const fallback = scanTuringQuality(raw, "missing");
        expect(fallback.scoped).toBe(false);
        expect(fallback.hits.find(hit => hit.name === "ban词直杀")).toMatchObject({count: 2, samples: ["弧度", "弧度"]});
        expect(fallback.cloudReview).toBe("not-configured");
    });
    it("普通规则命中封顶99、保留两个样本；结尾问号另行报告", () => {
        const report = scanTuringQuality("弧度。".repeat(150) + "去哪？");
        expect(report.hits.find(hit => hit.name === "ban词直杀")).toMatchObject({count: 99, samples: ["弧度", "弧度"]});
        expect(report.hits.find(hit => hit.name === "递话筒结尾")).toMatchObject({count: 1});
        expect(report.total).toBe(100);
    });
    it("频率按实际千字密度严格超限才报告，质检不会改写原文", () => {
        const below = "像".repeat(3) + "字".repeat(997);
        expect(scanTuringQuality(below).hits.find(hit => hit.name === "频率·明喻超标")).toBeUndefined();
        const above = "像".repeat(4) + "字".repeat(996);
        expect(scanTuringQuality(above).hits.find(hit => hit.name === "频率·明喻超标")).toMatchObject({count: 4, samples: ["4.0处/千字，上限3"]});
    });
});
