// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {flushPromises, mount, type VueWrapper} from "@vue/test-utils";
import {FormSelect} from "@notnotype/nb-ui/components";
import OutlineLibraryPanel from "./OutlineLibraryPanel.vue";
import type {OutlineWorkbenchEntry, OutlineWorkbenchLibraryTree, OutlineWorkbenchSnapshot} from "nbook/app/composables/useOutlineWorkbenchData";

const hash = (seed: string): string => `sha256:${seed.repeat(64).slice(0, 64)}`;
const entry = (id: string, kind: OutlineWorkbenchEntry["kind"], parentId: string | null, status: "draft" | "adopted" = "adopted"): OutlineWorkbenchEntry => ({
    id, kind, version: 1, status, title: id.replace("ol-", ""), parentId,
    chapterId: kind === "detail" ? parentId : null, body: `${id} 正文`,
});
const entries = [entry("ol-total", "total", null), entry("ol-vol", "volume", "ol-total"),
    entry("ol-chapter", "chapter", "ol-vol"), entry("ol-detail", "detail", "ol-chapter", "draft")];
const place = (entryId: string, parentId: string | null, position = 0) => ({entryId, parentId, position});
const snapshot: OutlineWorkbenchSnapshot = {
    manifest: {revision: 3, totalId: "ol-total", plans: [
        {id: "plan-a", title: "方案甲", placements: [place("ol-total", null), place("ol-vol", "ol-total"), place("ol-chapter", "ol-vol"), place("ol-detail", "ol-chapter")]},
        // 卷纲与章节同时挂在两个方案下，编辑它们必须走写时分叉。
        {id: "plan-b", title: "方案乙", placements: [place("ol-total", null), place("ol-vol", "ol-total"), place("ol-chapter", "ol-vol")]},
    ]},
    entries: entries.map((value, index) => ({path: `outline/entries/${value.id}.md`, contentHash: hash(String(index + 1)), value})),
    foreshadowing: [],
    graphs: [],
    lines: [],
};
const node = (id: string, children: OutlineWorkbenchLibraryTree["root"][] = []) => ({entry: entries.find((item) => item.id === id)!, children});
const trees: OutlineWorkbenchLibraryTree[] = [{id: "plan-a", title: "方案甲", root: node("ol-total", [node("ol-vol", [node("ol-chapter", [node("ol-detail")])])])}];

let responses: Record<string, unknown> = {};
const fetchMock = vi.fn((url: string, _options: {body?: Record<string, unknown>}) => Promise.resolve(responses[url.split("/").pop()!] ?? {transactionId: "tx"}));
const mounted: VueWrapper[] = [];

beforeEach(() => {
    responses = {};
    fetchMock.mockClear();
    vi.stubGlobal("$fetch", fetchMock);
});
afterEach(() => {
    mounted.splice(0).forEach((wrapper) => wrapper.unmount());
    vi.unstubAllGlobals();
});

function mountPanel(source: OutlineWorkbenchSnapshot = snapshot): VueWrapper {
    const wrapper = mount(OutlineLibraryPanel, {
        props: {projectRoot: "project", snapshot: source, libraryTrees: trees, planId: "plan-a", refresh: vi.fn(async () => {})},
        attachTo: document.body,
    });
    mounted.push(wrapper);
    return wrapper;
}
async function click(wrapper: VueWrapper, text: string): Promise<void> {
    const target = wrapper.findAll("button").find((button) => button.text().trim() === text);
    if (!target) throw new Error(`找不到按钮：${text}`);
    await target.trigger("click");
    await flushPromises();
}
async function selectRow(wrapper: VueWrapper, title: string): Promise<void> {
    const row = wrapper.findAll("button.tree-row").find((button) => button.find(".tree-title").text() === title);
    if (!row) throw new Error(`找不到条目：${title}`);
    await row.trigger("click");
    await flushPromises();
}
function lastCall(segment: string): Record<string, unknown> | undefined {
    const call = fetchMock.mock.calls.filter(([url]) => url === `/api/projects/outline/${segment}`).at(-1);
    return call?.[1].body;
}

describe("大纲库编辑面板", () => {
    it("共享条目编辑走写时分叉，并要求换标题", async () => {
        const wrapper = mountPanel();
        await selectRow(wrapper, "chapter");
        expect(wrapper.text()).toContain("共用于 2 个方案");
        await click(wrapper, "编辑");
        await click(wrapper, "另存为本方案条目");
        expect(wrapper.text()).toContain("需要换一个标题");
        expect(fetchMock).not.toHaveBeenCalled();
        await wrapper.find(".entry-form input").setValue("第一章（方案甲）");
        await click(wrapper, "另存为本方案条目");
        expect(lastCall("fork-entry")).toEqual({planId: "plan-a", sourceId: "ol-chapter", title: "第一章（方案甲）", body: "ol-chapter 正文",
            expectedRevision: 3, confirmShared: true, materialRefs: null, writingGuidance: null, references: null, targetWords: null});
        expect(lastCall("library-action")).toBeUndefined();
    });

    it("修改总纲必须显式确认全局影响", async () => {
        const wrapper = mountPanel();
        await selectRow(wrapper, "total");
        await click(wrapper, "编辑");
        await click(wrapper, "保存为草稿");
        expect(wrapper.text()).toContain("请先勾选确认");
        expect(fetchMock).not.toHaveBeenCalled();
        await wrapper.find(".detail-notice input[type=checkbox]").setValue(true);
        await click(wrapper, "保存为草稿");
        expect(lastCall("library-action")).toEqual({expectedRevision: 3, action: {kind: "edit-entry", planId: "plan-a", entryId: "ol-total",
            expectedVersion: 1, expectedContentHash: hash("1"), title: "total", body: "ol-total 正文", confirmGlobal: true}});
    });

    it("章节大纲正文可以用选区插入伏笔标记", async () => {
        const wrapper = mountPanel({...snapshot, foreshadowing: [{path: "outline/foreshadowing/silver.md", contentHash: hash("9"),
            value: {id: "fo-silver", version: 1, status: "adopted", title: "银纹", body: ""}}]});
        await selectRow(wrapper, "chapter");
        await click(wrapper, "编辑");
        await click(wrapper, "标记选中文字");
        expect(wrapper.text()).toContain("请先选择要标记的伏笔");
        const foreshadowSelect = wrapper.findAllComponents(FormSelect).find((select) => select.props("placeholder") === "选择伏笔")!;
        foreshadowSelect.vm.$emit("update:modelValue", "fo-silver");
        await flushPromises();
        const textarea = wrapper.find(".entry-form textarea").element as HTMLTextAreaElement;
        textarea.setSelectionRange(0, "ol-chapter".length);
        await click(wrapper, "标记选中文字");
        expect(textarea.value).toMatch(/^<!-- nb:foreshadow marker="fm-[0-9a-f-]+" foreshadow="fo-silver" action="plant" -->ol-chapter<!-- \/nb:foreshadow marker="fm-[0-9a-f-]+" --> 正文$/u);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("删除先读取影响，仍有引用时不能确认", async () => {
        responses["preview-object-deletion"] = {revision: 3, objectHash: hash("2"), impact: {targetId: "ol-vol", objectFile: "outline/entries/ol-vol.md",
            references: [{sourceFile: "outline/manifest.yaml", relation: "placement", sourceId: "plan-b"}], canDeleteObject: false}};
        const wrapper = mountPanel();
        await selectRow(wrapper, "vol");
        await click(wrapper, "删除条目");
        expect(lastCall("preview-object-deletion")).toEqual({targetId: "ol-vol"});
        expect(wrapper.text()).toContain("方案「方案乙」仍包含此条目");
        const confirm = wrapper.findAll(".impact-actions button").find((button) => button.text() === "确认")!;
        expect(confirm.attributes("disabled")).toBeDefined();
    });

    it("细纲采用前要确认偏离并逐条说明冲突处理", async () => {
        responses["analyze-detail"] = {entryId: "ol-detail", expectedRevision: 3, expectedVersion: 1, warnings: [],
            report: {reportId: "00000000-0000-4000-8000-000000000001", planId: "plan-a", sourceHash: "s", contextHash: "c",
                summary: "基本一致", deviations: ["提前揭示身份"], conflicts: ["与第三章时间线冲突"], resolutions: []}};
        const wrapper = mountPanel();
        await selectRow(wrapper, "detail");
        await click(wrapper, "开始分析");
        expect(lastCall("analyze-detail")).toEqual({planId: "plan-a", entryId: "ol-detail", expectedRevision: 3, expectedVersion: 1, expectedContentHash: hash("4")});
        const adopt = () => wrapper.findAll("button").find((button) => button.text().trim() === "正式采用细纲")!;
        expect(adopt().attributes("disabled")).toBeDefined();
        await wrapper.find(".analysis-block input[type=checkbox]").setValue(true);
        await wrapper.find(".conflict-row textarea").setValue("已调整到第四章之后");
        expect(adopt().attributes("disabled")).toBeUndefined();
        await click(wrapper, "正式采用细纲");
        expect(lastCall("adopt-detail")).toEqual({planId: "plan-a", entryId: "ol-detail", expectedRevision: 3, expectedVersion: 1,
            expectedContentHash: hash("4"), reportId: "00000000-0000-4000-8000-000000000001", confirmDeviations: true,
            resolutions: [{index: 0, decision: "resolved", reason: "已调整到第四章之后"}]});
    });
});
