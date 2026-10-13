import {describe, expect, it} from "vitest";
import {nextExtractionPlanTitle} from "./outline-destination";

describe("nextExtractionPlanTitle", () => {
    it("同一作品从 1 开始递增", () => {
        expect(nextExtractionPlanTitle([], "作品")).toBe("提取方案1·作品");
        expect(nextExtractionPlanTitle(["提取方案1·作品"], "作品")).toBe("提取方案2·作品");
    });

    it("按最大序号而不是个数递增：删掉中间的方案后不会回退或重名", () => {
        expect(nextExtractionPlanTitle(["提取方案1·作品", "提取方案3·作品"], "作品")).toBe("提取方案4·作品");
        expect(nextExtractionPlanTitle(["提取方案5·作品"], "作品")).toBe("提取方案6·作品");
    });

    it("其他作品的方案与手工方案不占用序号", () => {
        expect(nextExtractionPlanTitle(["提取方案7·别的作品", "主方案"], "作品")).toBe("提取方案1·作品");
    });

    it("作品名两侧空白被忽略", () => {
        expect(nextExtractionPlanTitle(["提取方案1·作品"], "  作品 ")).toBe("提取方案2·作品");
    });
});
