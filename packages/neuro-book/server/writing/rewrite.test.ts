import {describe, expect, it} from "vitest";
import {locateRewrite, replaceRewriteTarget} from "./rewrite";

const BODY = ["# 入城", "第一段，**雾**很浓。", "第二段。", "第三段\n续行。", "```\n代码\n\n仍是代码\n```", "第五段。", "第六段。"].join("\n\n");

describe("改写目标定位", () => {
    it("段号目标取上下各两段；章首章末不足时有多少取多少", () => {
        expect(locateRewrite(BODY, {paragraphs: {from: 4}})).toEqual({ok: true, value: {range: {from: 4, to: 4}, window: {
            before: ["第一段，**雾**很浓。", "第二段。"], target: "第三段\n续行。", after: ["```\n代码\n\n仍是代码\n```", "第五段。"],
        }}});
        const head = locateRewrite(BODY, {paragraphs: {from: 1, to: 2}});
        expect(head).toMatchObject({ok: true, value: {window: {before: [], target: "# 入城\n\n第一段，**雾**很浓。", after: ["第二段。", "第三段\n续行。"]}}});
        expect(locateRewrite(BODY, {paragraphs: {from: 7}})).toMatchObject({ok: true, value: {window: {before: ["```\n代码\n\n仍是代码\n```", "第五段。"], after: []}}});
    });

    it("段号超出范围或正文为空时失败", () => {
        expect(locateRewrite(BODY, {paragraphs: {from: 8}})).toMatchObject({ok: false, message: expect.stringContaining("共 7 段")});
        expect(locateRewrite(BODY, {paragraphs: {from: 3, to: 2}})).toMatchObject({ok: false});
        expect(locateRewrite("", {paragraphs: {from: 1}})).toMatchObject({ok: false, message: expect.stringContaining("正文为空")});
    });

    it("选中原话忽略 Markdown 记号与空白差异，跨段选区扩展到完整段落", () => {
        expect(locateRewrite(BODY, {quote: "雾很浓。 第二"})).toMatchObject({ok: true, value: {range: {from: 2, to: 3}}});
        expect(locateRewrite(BODY, {quote: "第三段续行"})).toMatchObject({ok: true, value: {range: {from: 4, to: 4}}});
        expect(locateRewrite(BODY, {quote: "仍是代码"})).toMatchObject({ok: true, value: {range: {from: 5, to: 5}}});
    });

    it("原话找不到、出现多次或为空时失败", () => {
        expect(locateRewrite(BODY, {quote: "不存在"})).toMatchObject({ok: false, message: expect.stringContaining("找不到")});
        expect(locateRewrite(BODY, {quote: "段。"})).toMatchObject({ok: false, message: expect.stringContaining("出现了")});
        expect(locateRewrite(BODY, {quote: " **\n"})).toMatchObject({ok: false, message: "选中的内容为空"});
    });
});

describe("改写替换", () => {
    it("只替换目标段落，其余原文逐字保留", () => {
        expect(replaceRewriteTarget(BODY, {range: {from: 3, to: 4}, target: "第二段。\n\n第三段\n续行。", replacement: "\n新的一段。\n"}))
            .toEqual({ok: true, body: BODY.replace("第二段。\n\n第三段\n续行。", "新的一段。")});
    });

    it("目标之外的改动移动了段号时按原文找回；目标被改动时不替换", () => {
        const shifted = `前言。\n\n${BODY}`;
        expect(replaceRewriteTarget(shifted, {range: {from: 6, to: 6}, target: "第五段。", replacement: "改。"}))
            .toEqual({ok: true, body: shifted.replace("第五段。", "改。")});
        expect(replaceRewriteTarget(BODY.replace("第五段。", "第五段改过。"), {range: {from: 6, to: 6}, target: "第五段。", replacement: "改。"}))
            .toMatchObject({ok: false, message: expect.stringContaining("已被改动")});
    });

    it("原位置不再匹配且原文出现多处时不替换；原位置匹配时优先原位置", () => {
        const twice = "甲。\n\n乙。\n\n甲。";
        expect(replaceRewriteTarget(twice, {range: {from: 3, to: 3}, target: "甲。", replacement: "丙。"})).toEqual({ok: true, body: "甲。\n\n乙。\n\n丙。"});
        expect(replaceRewriteTarget(`乙。\n\n${twice}`, {range: {from: 1, to: 1}, target: "甲。", replacement: "丙。"}))
            .toMatchObject({ok: false, message: expect.stringContaining("出现多处")});
    });

    it("改写结果为空时不替换", () => {
        expect(replaceRewriteTarget(BODY, {range: {from: 3, to: 3}, target: "第二段。", replacement: " \n"})).toMatchObject({ok: false, message: "改写结果为空，未替换"});
    });
});
