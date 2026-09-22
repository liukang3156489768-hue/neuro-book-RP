import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";

const profileNavPath = fileURLToPath(new URL("../components/novel-ide/settings/AgentProfileNavList.vue", import.meta.url));
const modelPanelPath = fileURLToPath(new URL("../components/novel-ide/settings/NovelIdeModelSettingsPanel.vue", import.meta.url));

describe("Novel IDE Settings responsive contract", () => {
    it("Profile 导航不复制 Dialog 的旧视口高度预算", async () => {
        const source = (await readFile(profileNavPath, "utf8")).replace(/\r\n/g, "\n");

        expect(source).not.toContain("90vh");
        expect(source).toContain("overflow-y-auto");
    });

    it("模型设置双栏的 sticky 定位只作用于 xl 桌面断点", async () => {
        const source = (await readFile(modelPanelPath, "utf8")).replace(/\r\n/g, "\n");

        expect(source).toContain("xl:sticky xl:top-4");
        expect(source).toContain("xl:items-start");
        expect(source).not.toContain("sticky top-4");
        expect(source).not.toContain("flex h-fit flex-col");
    });
});
