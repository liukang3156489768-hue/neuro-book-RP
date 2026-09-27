import {readFile, readdir} from "node:fs/promises";
import {resolve} from "node:path";
import {describe, expect, it} from "vitest";

const outlineDir = resolve(process.cwd(), "app/components/novel-ide/outline");
const dialogPath = resolve(outlineDir, "OutlineWorkbenchDialog.vue");
const foreshadowPanelPath = resolve(outlineDir, "OutlineForeshadowingPanel.vue");
const linePanelPath = resolve(outlineDir, "OutlineLinePanel.vue");
const dataPath = resolve(process.cwd(), "app/composables/useOutlineWorkbenchData.ts");
const sessionPath = resolve(process.cwd(), "app/utils/outline/outline-workbench-session.ts");

/** 组件自设的局部变量，不属于 nb-ui 契约。 */
const LOCAL_VAR_NAMES = new Set(["--outline-agent-width"]);

/**
 * 从 nb-ui 的**事实源**读变量名，而不是在这里抄一份名单：
 * 抄一份就等于给配色与 token 契约建第二个真相源，nb-ui 改名时这边会静默漂移。
 */
async function loadNbUiVarNames(): Promise<Set<string>> {
    const nbUi = resolve(process.cwd(), "../nb-ui/src");
    const allowed = new Set<string>();
    const contract = await readFile(resolve(nbUi, "colorway/colorway-contract.ts"), "utf8");
    for (const [, name] of contract.matchAll(/^\s*"(--[a-z0-9-]+)"/gm)) if (name) allowed.add(name);
    const tokens = await readFile(resolve(nbUi, "tokens.css"), "utf8");
    for (const [, name] of tokens.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)) if (name) allowed.add(name);
    return allowed;
}

/** 只看 `<style>` 块并剥掉注释——注释里写的反例名不是真实引用。 */
function styleVars(source: string): string[] {
    const styles = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
        .map((match) => (match[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, ""))
        .join("\n");
    return [...styles.matchAll(/--[a-z0-9-]+/g)].map((match) => match[0]);
}

describe("Outline workbench contract", () => {
    it("keeps the full-screen split layout and the three planning views", async () => {
        const [dialog, foreshadowPanel, data, session] = await Promise.all([
            readFile(dialogPath, "utf8"),
            readFile(foreshadowPanelPath, "utf8"),
            readFile(dataPath, "utf8"),
            readFile(sessionPath, "utf8"),
        ]);
        expect(dialog).toContain('width="100vw"');
        expect(dialog).toContain("@pointerdown=\"startResize\"");
        expect(dialog).toContain("resolveOutlineAgentWidth");
        expect(dialog).toContain("大纲库");
        expect(dialog).toContain("伏笔库");
        expect(dialog).toContain("线路规划");
        expect(dialog).toContain("OutlineLibraryPanel");
        expect(dialog).toContain("OutlineForeshadowingPanel");
        expect(dialog).toContain("OutlineLinePanel");
        expect(foreshadowPanel).toContain("顺序异常，未计入状态");
        expect(foreshadowPanel).toContain("marker-diagnostics");
        expect(foreshadowPanel).toContain("伏笔标记解析异常");
        expect(data).toContain("/api/projects/outline/snapshot");
        expect(data).toContain("/api/projects/outline/library-trees");
        expect(data).toContain("/api/projects/outline/foreshadowing-states");
        // 会话只负责「有没有用户偏好」，像素宽度由 UI 按视口解析（见宽度用例）。
        expect(session).toContain("agentWidth: number | null");
        expect(dialog).toContain("nbook/shared/storage/outline-workbench-width");
    });

    it("keeps project-only layout persistence and does not derive domain status in the client", async () => {
        const [dialog, data, foreshadowPanel, linePanel] = await Promise.all([readFile(dialogPath, "utf8"), readFile(dataPath, "utf8"),
            readFile(foreshadowPanelPath, "utf8"), readFile(linePanelPath, "utf8")]);
        expect(dialog).toContain("useOutlineWorkbenchSession");
        for (const source of [data, foreshadowPanel, linePanel]) {
            expect(source).not.toContain("deriveForeshadowingStates");
            expect(source).not.toContain("inspectFixedLine");
        }
        // 伏笔四状态只来自状态接口；客户端不能从来源列表自行推断已埋设或已回收。
        expect(foreshadowPanel).not.toMatch(/sources\.some\(/);
        // 线路节点的红黄状态只来自 inspect-line，客户端不按条目状态或哈希自行判定。
        expect(linePanel).toContain('"inspect-line"');
        expect(linePanel).not.toMatch(/contentHash\s*!==|status\s*!==\s*"adopted"/);
    });

    /*
     * 这条守的是一个不报错的失败：变量名写错时浏览器整条声明静默丢弃，
     * typecheck 和组件测试都发现不了，界面只是「没有底色、没有边框」。
     * 该模块此前 73 处引用了一批从未定义的名字（--bg-page / --text-primary /
     * --border-subtle / --warning …），所以这里对全目录做一次契约校验。
     */
    it("only consumes CSS variables that exist in the nb-ui contract", async () => {
        const allowed = await loadNbUiVarNames();
        const files = (await readdir(outlineDir, {recursive: true})).filter((name) => name.endsWith(".vue"));
        expect(files.length).toBeGreaterThan(0);
        const unknown: string[] = [];
        for (const name of files) {
            const source = await readFile(resolve(outlineDir, name), "utf8");
            for (const variable of styleVars(source)) {
                if (LOCAL_VAR_NAMES.has(variable) || allowed.has(variable)) continue;
                unknown.push(`${name}: ${variable}`);
            }
        }
        expect(unknown).toEqual([]);
    });
});
