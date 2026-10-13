import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";

const dialogPath = fileURLToPath(new URL("./InspirationWorkbenchDialog.vue", import.meta.url));
const composablePath = fileURLToPath(new URL("../../../composables/useInspirationWorkbench.ts", import.meta.url));

describe("Inspiration workbench entry", () => {
    it("keeps original design and the separate extraction entry visible in source", async () => {
        const [dialog, composable] = await Promise.all([readFile(dialogPath, "utf8"), readFile(composablePath, "utf8")]);
        expect(dialog).toContain("原创设计");
        expect(dialog).toContain("作品提取");
        expect(dialog).toContain("保存已审阅成果");
        expect(composable).toContain("/api/inspiration/generate");
        expect(composable).toContain("/api/inspiration/cancel");
        expect(composable).toContain("/api/inspiration/save");
        expect(composable).not.toContain("/api/inspiration/source-prepare");
        expect(composable).not.toContain("/api/inspiration/extract");
        expect(composable).toContain("/api/inspiration/conversations");
        expect(dialog).toContain("聊天记录");
        expect(dialog).not.toContain("作品分析与提取");
    });
});
