import {describe, expect, it} from "vitest";
import {buildExtractionPrompt, renderSourcePrefix} from "./prompt";

describe("提取提示词", () => {
    const prefix = renderSourcePrefix([{id: "P1", text: "第一段。\n"}, {id: "P2", text: "第二段。"}]);

    it("按前缀、追加材料、目标的顺序拼接，前缀逐字节位于最开头", () => {
        const prompt = buildExtractionPrompt({prefix, supplements: ["已知人物：甲"], goal: "提取人物"});
        expect(prompt.startsWith(prefix)).toBe(true);
        expect(prompt).toBe(`${prefix}\n\n已知人物：甲\n\n提取人物`);
        expect(prefix).toBe("【原文】每段以【P编号】开头。\n【P1】第一段。\n【P2】第二段。");
    });

    it("同一前缀配不同目标时，请求开头逐字节相同（缓存前缀合同）", () => {
        const first = buildExtractionPrompt({prefix, goal: "提取人物"});
        const second = buildExtractionPrompt({prefix, goal: "提取地点"});
        expect(first.slice(0, prefix.length)).toBe(second.slice(0, prefix.length));
    });

    it("预留位平时为空且不留分隔符，修复提示词只在末尾追加", () => {
        const parts = {prefix, goal: "提取人物"};
        const first = buildExtractionPrompt(parts);
        expect(first.endsWith("提取人物")).toBe(true);
        const repaired = buildExtractionPrompt(parts, {previousOutput: "坏产出", error: "缺少字段"});
        expect(repaired.startsWith(first)).toBe(true);
        expect(repaired.slice(first.length)).toContain("坏产出");
        expect(repaired.slice(first.length)).toContain("缺少字段");
    });

    it("超长校验错误在预留位里被截断，上次产出完整保留", () => {
        const output = "产出".repeat(5000);
        const repaired = buildExtractionPrompt({prefix, goal: "g"}, {previousOutput: output, error: "X".repeat(5000)});
        expect(repaired).toContain(output);
        expect(repaired).toContain("（已截断）");
        expect(repaired.split("X").length - 1).toBe(4000);
    });

    it("空前缀或空目标直接失败，不静默发出无原文的请求", () => {
        expect(() => buildExtractionPrompt({prefix: "", goal: "g"})).toThrow("前缀");
        expect(() => buildExtractionPrompt({prefix, goal: ""})).toThrow("目标");
        expect(() => renderSourcePrefix([])).toThrow("不能为空");
    });
});
