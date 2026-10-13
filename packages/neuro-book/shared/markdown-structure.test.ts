import {describe, expect, it} from "vitest";
import {markdownBlocks, markdownHeadings} from "./markdown-structure";

describe("Markdown 结构", () => {
    it("代码块中的 # 不算标题，空行不分块", () => {
        const body = "# 一\n\n```\n# 不是标题\n\n仍在代码块\n```\n\n## 二";
        expect(markdownHeadings(body).map(({level, text}) => [level, text])).toEqual([[1, "一"], [2, "二"]]);
        expect(markdownBlocks(body).map(({start, end}) => body.slice(start, end))).toEqual([
            "# 一", "```\n# 不是标题\n\n仍在代码块\n```", "## 二",
        ]);
    });
});
