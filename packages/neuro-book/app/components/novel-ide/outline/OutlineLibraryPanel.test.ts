// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {flushPromises, mount, type VueWrapper} from "@vue/test-utils";
import {FormSelect} from "@notnotype/nb-ui/components";
import OutlineLibraryPanel from "./OutlineLibraryPanel.vue";
import OutlineRichTextEditor from "./OutlineRichTextEditor.vue";
import type {OutlineWorkbenchEntry, OutlineWorkbenchLibraryTree, OutlineWorkbenchSnapshot} from "nbook/app/composables/useOutlineWorkbenchData";
import {sceneDetail} from "nbook/server/outline/detail.fixture";

const hash = (seed: string): string => `sha256:${seed.repeat(64).slice(0, 64)}`;
const entry = (id: string, kind: OutlineWorkbenchEntry["kind"], parentId: string | null, status: "draft" | "adopted" = "adopted"): OutlineWorkbenchEntry => ({
    id, kind, version: 1, status, title: id.replace("ol-", ""), parentId,
    chapterId: kind === "detail" ? parentId : null, body: `${id} 正文`,
});
const entries = [entry("ol-total", "total", null), entry("ol-vol", "volume", "ol-total"),
    entry("ol-chapter", "chapter", "ol-vol"), entry("ol-detail", "detail", "ol-chapter", "draft")];
const place = (entryId: string, parentId: string | null, position = 0) => ({entryId, parentId, position});
const snapshot: OutlineWorkbenchSnapshot = {
    manifest: {revision: 3, plans: [
        {id: "plan-a", title: "方案甲", totalId: "ol-total", placements: [place("ol-total", null), place("ol-vol", "ol-total"), place("ol-chapter", "ol-vol"), place("ol-detail", "ol-chapter")]},
        // 总纲、卷纲与章节同时挂在两个方案下（总纲是手动关联共用的），编辑它们必须走写时分叉。
        {id: "plan-b", title: "方案乙", totalId: "ol-total", placements: [place("ol-total", null), place("ol-vol", "ol-total"), place("ol-chapter", "ol-vol")]},
    ]},
    entries: entries.map((value, index) => ({path: `outline/entries/${value.id}.md`, contentHash: hash(String(index + 1)), value})),
    foreshadowing: [],
    graphs: [],
    lines: [],
};
/** 每个方案各有一份总纲、互不共用：plan-b 使用自己的 ol-total-b。 */
const separateTotals: OutlineWorkbenchSnapshot = {
    ...snapshot,
    manifest: {revision: 3, plans: [
        snapshot.manifest.plans[0]!,
        {id: "plan-b", title: "方案乙", totalId: "ol-total-b", placements: [place("ol-total-b", null)]},
    ]},
    entries: [...snapshot.entries, {path: "outline/entries/ol-total-b.md", contentHash: hash("b"), value: entry("ol-total-b", "total", null)}],
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

function mountPanel(source: OutlineWorkbenchSnapshot = snapshot, planId: string | null = "plan-a"): VueWrapper {
    const wrapper = mount(OutlineLibraryPanel, {
        props: {projectRoot: "project", snapshot: source, libraryTrees: trees, planId, refresh: vi.fn(async () => {})},
        attachTo: document.body,
    });
    mounted.push(wrapper);
    return wrapper;
}
function buttonByText(wrapper: VueWrapper, text: string) {
    const target = wrapper.findAll("button").find((button) => button.text().trim() === text);
    if (!target) throw new Error(`找不到按钮：${text}`);
    return target;
}
function confirmButton(wrapper: VueWrapper) {
    return wrapper.findAll(".impact-actions button").find((button) => button.text() === "确认")!;
}
function selectByLabel(wrapper: VueWrapper, label: string) {
    const target = wrapper.findAllComponents(FormSelect).find((item) => item.vm.$attrs["aria-label"] === label);
    if (!target) throw new Error(`找不到下拉：${label}`);
    return target;
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
/** 正文由 TipTap 编辑，jsdom 下直接模拟编辑器的 v-model 输出。 */
async function editBody(wrapper: VueWrapper, body: string): Promise<void> {
    wrapper.findComponent(OutlineRichTextEditor).vm.$emit("update:modelValue", body);
    await flushPromises();
}
/** 焦点离开表单会立即保存，不必等防抖。 */
async function blurForm(wrapper: VueWrapper): Promise<void> {
    await wrapper.find(".entry-form").trigger("focusout");
    await flushPromises();
}
function lastCall(segment: string): Record<string, unknown> | undefined {
    const call = fetchMock.mock.calls.filter(([url]) => url === `/api/projects/outline/${segment}`).at(-1);
    return call?.[1].body;
}

describe("大纲库编辑面板", () => {
    it("共享条目的修改只能另存为本方案条目，并要求换标题", async () => {
        const wrapper = mountPanel();
        await selectRow(wrapper, "chapter");
        expect(wrapper.text()).toContain("共用于 2 个方案");
        await editBody(wrapper, "改过的正文");
        await blurForm(wrapper);
        expect(lastCall("library-action")).toBeUndefined();
        const forkInput = wrapper.find<HTMLInputElement>(".fork-form input");
        expect(forkInput.element.value).toBe("chapter（方案甲）");

        await forkInput.setValue("chapter");
        await click(wrapper, "另存为本方案条目");
        expect(wrapper.text()).toContain("需要换一个标题");
        expect(fetchMock).not.toHaveBeenCalled();
        await forkInput.setValue("第一章（方案甲）");
        await click(wrapper, "另存为本方案条目");
        expect(lastCall("fork-entry")).toEqual({planId: "plan-a", sourceId: "ol-chapter", title: "第一章（方案甲）", body: "改过的正文",
            expectedRevision: 3, confirmShared: true, materialRefs: null, writingGuidance: null, references: null, targetWords: null});
        expect(lastCall("library-action")).toBeUndefined();
    });

    describe("总纲按方案独立，手动关联才共用", () => {
        it("共用的总纲和其他共用条目一样，只能另存为本方案条目", async () => {
            const wrapper = mountPanel();
            await selectRow(wrapper, "total");
            expect(wrapper.text()).toContain("共用于 2 个方案");
            await wrapper.find(".entry-title input").setValue("全书总纲");
            await blurForm(wrapper);
            expect(fetchMock).not.toHaveBeenCalled();
            expect(wrapper.find(".detail-notice").text()).toContain("不能直接修改");
            expect(wrapper.text()).not.toContain("修改会影响全部方案");
            expect(wrapper.find(".save-status").text()).toBe("确认后保存");

            expect(wrapper.find<HTMLInputElement>(".fork-form input").element.value).toBe("total（方案甲）");
            await click(wrapper, "另存为本方案条目");
            expect(lastCall("fork-entry")).toMatchObject({planId: "plan-a", sourceId: "ol-total", title: "total（方案甲）", confirmShared: true, expectedRevision: 3});
            expect(lastCall("library-action")).toBeUndefined();
        });

        it("方案独占的总纲直接自动保存，不再有全局确认", async () => {
            const wrapper = mountPanel(separateTotals);
            await selectRow(wrapper, "total");
            // 总纲已正式采用，沿用“回到草稿”确认，但不涉及其他方案。
            await wrapper.find(".entry-title input").setValue("全书总纲");
            await blurForm(wrapper);
            expect(wrapper.find(".detail-notice").text()).not.toContain("全部方案");
            await click(wrapper, "保存并回到草稿");
            expect(lastCall("library-action")).toEqual({expectedRevision: 3, action: {kind: "edit-entry", planId: "plan-a", entryId: "ol-total",
                expectedVersion: 1, expectedContentHash: hash("1"), title: "全书总纲", body: "ol-total 正文"}});
            expect(JSON.stringify(lastCall("library-action"))).not.toContain("confirmGlobal");
        });

        it("选中总纲时可改用其他方案的总纲，当前总纲有正文需确认替换", async () => {
            const wrapper = mountPanel(separateTotals);
            await selectRow(wrapper, "total");
            expect(selectByLabel(wrapper, "关联总纲").props("options")).toEqual([{value: "ol-total-b", label: "total-b"}]);
            expect(wrapper.text()).not.toContain("解除共用");
            expect(buttonByText(wrapper, "关联总纲").attributes("disabled")).toBeDefined();

            await selectByLabel(wrapper, "关联总纲").vm.$emit("update:modelValue", "ol-total-b");
            await click(wrapper, "关联总纲");
            expect(lastCall("library-action")).toEqual({expectedRevision: 3, action: {kind: "associate-total", planId: "plan-a",
                totalId: "ol-total-b", confirmReplace: true}});
        });

        it("当前总纲没有正文时关联不带替换确认", async () => {
            const emptyTotal: OutlineWorkbenchSnapshot = {...separateTotals, entries: separateTotals.entries.map((record) =>
                record.value.id === "ol-total" ? {...record, value: {...record.value, body: ""}} : record)};
            const wrapper = mountPanel(emptyTotal);
            await selectRow(wrapper, "total");
            await selectByLabel(wrapper, "关联总纲").vm.$emit("update:modelValue", "ol-total-b");
            await click(wrapper, "关联总纲");
            expect(lastCall("library-action")).toEqual({expectedRevision: 3, action: {kind: "associate-total", planId: "plan-a", totalId: "ol-total-b"}});
        });

        it("共用的总纲显示解除共用入口", async () => {
            const wrapper = mountPanel();
            await selectRow(wrapper, "total");
            // 所有方案都已共用同一份总纲时没有可改用的其他总纲。
            expect(wrapper.findAllComponents(FormSelect).some((item) => item.vm.$attrs["aria-label"] === "关联总纲")).toBe(false);
            await click(wrapper, "解除共用");
            expect(lastCall("library-action")).toEqual({expectedRevision: 3, action: {kind: "unshare-total", planId: "plan-a"}});
        });

        it("非总纲条目没有关联总纲与解除共用入口", async () => {
            const wrapper = mountPanel();
            await selectRow(wrapper, "vol");
            expect(wrapper.text()).not.toContain("解除共用");
            expect(wrapper.text()).not.toContain("关联总纲");
        });

        it("加入其他方案时，总纲下的条目挂到目标方案自己的总纲", async () => {
            const wrapper = mountPanel(separateTotals);
            await selectRow(wrapper, "vol");
            await selectByLabel(wrapper, "同时加入其他方案").vm.$emit("update:modelValue", "plan-b");
            await click(wrapper, "加入");
            expect(lastCall("library-action")).toEqual({expectedRevision: 3, action: {kind: "attach-entry", planId: "plan-b", parentId: "ol-total-b", entryId: "ol-vol"}});
        });
    });

    describe("没有方案时", () => {
        const empty: OutlineWorkbenchSnapshot = {manifest: {revision: 0, plans: []}, entries: [], foreshadowing: [], graphs: [], lines: []};

        it("新建方案始终可用，不再要求先创建总纲", async () => {
            const wrapper = mountPanel(empty, null);
            expect(wrapper.text()).toContain("还没有方案");
            expect(wrapper.text()).not.toContain("创建总纲");
            expect(wrapper.text()).not.toContain("还没有总纲");
            const createButton = wrapper.find(".plan-bar").findAll("button").find((button) => button.text().trim() === "新建方案")!;
            expect(createButton.attributes("disabled")).toBeUndefined();

            await createButton.trigger("click");
            await wrapper.find(".inline-form input").setValue("方案一");
            await click(wrapper, "创建");
            expect(lastCall("library-action")).toEqual({expectedRevision: 0, action: {kind: "create-plan", title: "方案一"}});
        });

        it("空状态里也有新建方案入口", async () => {
            const wrapper = mountPanel(empty, null);
            await wrapper.find(".library-tree").findAll("button").find((button) => button.text().trim() === "新建方案")!.trigger("click");
            expect((wrapper.find<HTMLInputElement>(".inline-form input")).element.value).toBe("方案一");
        });

        it("已有方案但没有任何总纲数据时，新建方案同样可用", async () => {
            const wrapper = mountPanel({...snapshot, entries: [], manifest: {revision: 3, plans: [{id: "plan-x", title: "空方案", totalId: "ol-missing", placements: []}]}}, "plan-x");
            const createButton = wrapper.find(".plan-bar").findAll("button").find((button) => button.text().trim() === "新建方案")!;
            expect(createButton.attributes("disabled")).toBeUndefined();
        });
    });

    it("本方案专属的草稿直接自动保存正文修改", async () => {
        const wrapper = mountPanel();
        await selectRow(wrapper, "detail");
        await editBody(wrapper, "改过的细纲");
        expect(wrapper.find(".save-status").text()).toBe("有未保存的修改");
        await blurForm(wrapper);
        expect(lastCall("library-action")).toEqual({expectedRevision: 3, action: expect.objectContaining({kind: "edit-entry", planId: "plan-a",
            entryId: "ol-detail", expectedVersion: 1, expectedContentHash: hash("4"), title: "detail", body: "改过的细纲"})});
        expect(wrapper.find(".save-status").text()).toBe("已保存");
    });

    describe("关联新信息随手动规划保存", () => {
        const updates = [{materialPath: "lorebook/角色/林默/index.md", kind: "experience" as const, body: "原有改编经历"}];
        const withUpdates = (source: OutlineWorkbenchSnapshot, entryId: string): OutlineWorkbenchSnapshot => ({
            ...source,
            entries: source.entries.map((record) => record.value.id === entryId
                ? {...record, value: {...record.value, status: "draft", materialUpdates: updates}}
                : record),
        });

        it("正文变更先核对关联信息，再提交修改后的记录", async () => {
            const wrapper = mountPanel(withUpdates(separateTotals, "ol-chapter"));
            await selectRow(wrapper, "chapter");
            expect(wrapper.find(".material-update-row code").text()).toBe(updates[0]!.materialPath);
            await editBody(wrapper, "新剧情");
            expect(wrapper.find<HTMLInputElement>(".material-updates input[type=checkbox]").element.checked).toBe(false);
            await blurForm(wrapper);
            expect(lastCall("library-action")).toBeUndefined();

            await wrapper.find(".material-update-row textarea").setValue("配合新剧情的经历");
            await wrapper.find(".material-updates input[type=checkbox]").setValue(true);
            await blurForm(wrapper);
            expect(lastCall("library-action")).toMatchObject({action: {kind: "edit-entry", entryId: "ol-chapter", body: "新剧情",
                materialUpdates: [{...updates[0], body: "配合新剧情的经历"}]}});
            expect(updates[0]!.body).toBe("原有改编经历");
        });

        it("共用规划另存时同样要求核对，并提交本方案关联信息", async () => {
            const wrapper = mountPanel(withUpdates(snapshot, "ol-chapter"));
            await selectRow(wrapper, "chapter");
            await editBody(wrapper, "另存的剧情");
            await click(wrapper, "另存为本方案条目");
            expect(lastCall("fork-entry")).toBeUndefined();
            expect(wrapper.text()).toContain("请核对关联新信息");
            await wrapper.find(".material-update-row textarea").setValue("另存的经历");
            await wrapper.find(".material-updates input[type=checkbox]").setValue(true);
            await click(wrapper, "另存为本方案条目");
            expect(lastCall("fork-entry")).toMatchObject({planId: "plan-a", sourceId: "ol-chapter", body: "另存的剧情",
                materialUpdates: [{...updates[0], body: "另存的经历"}]});
        });

        it("非章节规划也能移除关联记录，保存明确发送清除", async () => {
            const wrapper = mountPanel(withUpdates(separateTotals, "ol-vol"));
            await selectRow(wrapper, "vol");
            await editBody(wrapper, "不再涉及该角色的卷纲");
            await wrapper.find('button[title="移除这条关联新信息"]').trigger("click");
            await flushPromises();
            expect(wrapper.find(".material-updates").exists()).toBe(false);
            await blurForm(wrapper);
            expect(lastCall("library-action")).toMatchObject({action: {kind: "edit-entry", entryId: "ol-vol",
                body: "不再涉及该角色的卷纲", materialUpdates: null}});
        });

        it("加载另一条规划不会把现有信息误判为未核对", async () => {
            const wrapper = mountPanel(withUpdates(withUpdates(separateTotals, "ol-chapter"), "ol-vol"));
            await selectRow(wrapper, "chapter");
            await editBody(wrapper, "已修改的剧情");
            await wrapper.find(".material-updates input[type=checkbox]").setValue(true);
            await selectRow(wrapper, "vol");
            expect(wrapper.find<HTMLInputElement>(".material-updates input[type=checkbox]").element.checked).toBe(true);
        });
    });

    it("外部定位请求选中条目，条目不存在时提示", async () => {
        const wrapper = mountPanel();
        await wrapper.setProps({focusRequest: {entryId: "ol-detail", token: 1}});
        await flushPromises();
        expect(wrapper.find("button.tree-row.is-selected .tree-title").text()).toBe("detail");
        await wrapper.setProps({focusRequest: {entryId: "ol-gone", token: 2}});
        await flushPromises();
        expect(wrapper.text()).toContain("要打开的条目已不存在");
        expect(wrapper.find("button.tree-row.is-selected .tree-title").text()).toBe("detail");
        await click(wrapper, "知道了");
        expect(wrapper.text()).not.toContain("要打开的条目已不存在");
    });

    it("章节大纲的正文编辑器提供伏笔标记", async () => {
        const wrapper = mountPanel({...snapshot, foreshadowing: [{path: "outline/foreshadowing/silver.md", contentHash: hash("9"),
            value: {id: "fo-silver", version: 1, status: "draft", title: "银纹", body: ""}}]});
        await selectRow(wrapper, "chapter");
        const editor = wrapper.findComponent(OutlineRichTextEditor);
        expect(editor.props("annotations")).toBe("chapter");
        expect(editor.props("foreshadowOptions")).toEqual([{value: "fo-silver", label: "银纹（草稿）"}]);
        expect(editor.props("readonly")).toBe(false);
    });

    it("新增下级条目立即以草稿创建", async () => {
        responses["library-action"] = {transactionId: "tx", entryId: "ol-new"};
        const wrapper = mountPanel();
        await selectRow(wrapper, "vol");
        await click(wrapper, "新增章节大纲");
        expect(lastCall("library-action")).toEqual({expectedRevision: 3, action: {kind: "create-entry", planId: "plan-a", parentId: "ol-vol",
            entryKind: "chapter", title: "新章节大纲", body: ""}});
    });

    it("删除先读取影响，仍有引用时不能确认", async () => {
        responses["preview-object-deletion"] = {revision: 3, objectHash: hash("2"), impact: {targetId: "ol-vol", objectFile: "outline/entries/ol-vol.md",
            references: [{sourceFile: "outline/manifest.yaml", relation: "placement", sourceId: "plan-b"}],
            entryKind: "volume", usedByPlanIds: [], affectedPlanIds: ["plan-a", "plan-b"], canDeleteObject: false}};
        const wrapper = mountPanel();
        await selectRow(wrapper, "vol");
        await click(wrapper, "删除条目");
        expect(lastCall("preview-object-deletion")).toEqual({targetId: "ol-vol"});
        expect(wrapper.text()).toContain("方案「方案乙」仍包含此条目");
        expect(wrapper.text()).not.toContain("总纲仍被方案");
        expect(confirmButton(wrapper).attributes("disabled")).toBeDefined();
    });

    describe("删除总纲", () => {
        const totalImpact = (usedByPlanIds: string[], canDeleteObject: boolean) => ({revision: 3, objectHash: hash("1"), impact: {targetId: "ol-total",
            objectFile: "outline/entries/ol-total.md", references: [], entryKind: "total", usedByPlanIds, affectedPlanIds: usedByPlanIds, canDeleteObject}});

        it("总纲仍被方案使用时说明使用方案，且不能确认", async () => {
            responses["preview-object-deletion"] = totalImpact(["plan-a", "plan-b"], false);
            const wrapper = mountPanel();
            await selectRow(wrapper, "total");
            await click(wrapper, "删除条目");
            expect(wrapper.find(".impact-panel").text()).toContain("总纲仍被方案「方案甲、方案乙」使用，请先让这些方案改用其他总纲或删除这些方案。");
            expect(wrapper.find(".impact-panel input[type=checkbox]").exists()).toBe(false);
            expect(confirmButton(wrapper).attributes("disabled")).toBeDefined();
            await confirmButton(wrapper).trigger("click");
            expect(lastCall("remove-object")).toBeUndefined();
        });

        it("孤立总纲要勾选确认才能删除", async () => {
            responses["preview-object-deletion"] = totalImpact([], true);
            responses["remove-object"] = {transactionId: "tx"};
            const wrapper = mountPanel();
            await selectRow(wrapper, "total");
            await click(wrapper, "删除条目");
            expect(wrapper.find(".impact-panel").text()).toContain("我确认删除这份未被方案使用的总纲");
            expect(wrapper.find(".impact-panel").text()).not.toContain("总纲仍被方案");
            expect(confirmButton(wrapper).attributes("disabled")).toBeDefined();

            await wrapper.find(".impact-panel input[type=checkbox]").setValue(true);
            expect(confirmButton(wrapper).attributes("disabled")).toBeUndefined();
            await click(wrapper, "确认");
            expect(lastCall("remove-object")).toEqual({targetId: "ol-total", expectedRevision: 3, expectedObjectHash: hash("1"), confirmedTotal: true});
        });
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

    describe("操作行的细纲正式采用", () => {
        const report = (deviations: string[]) => ({entryId: "ol-detail", expectedRevision: 3, expectedVersion: 1, warnings: [],
            report: {reportId: "00000000-0000-4000-8000-000000000002", planId: "plan-a", sourceHash: "s", contextHash: "c",
                summary: "一致", deviations, conflicts: [], resolutions: []}});
        const withDetail = (patch: Partial<OutlineWorkbenchEntry>): OutlineWorkbenchSnapshot => ({...snapshot,
            entries: snapshot.entries.map((record) => record.value.id === "ol-detail" ? {...record, value: {...record.value, ...patch}} : record)});
        const complete = withDetail(sceneDetail("盘查", "入城"));
        const adoptButton = (wrapper: VueWrapper) => wrapper.find(".detail-actions").findAll("button").find((button) => button.text().trim() === "正式采用")!;

        beforeEach(() => {
            Element.prototype.scrollIntoView = vi.fn();
        });

        it("没有偏离和冲突时分析后直接采用", async () => {
            responses["analyze-detail"] = report([]);
            const wrapper = mountPanel(complete);
            await selectRow(wrapper, "detail");
            await adoptButton(wrapper).trigger("click");
            await flushPromises();
            expect(lastCall("analyze-detail")).toMatchObject({entryId: "ol-detail", expectedContentHash: hash("4")});
            expect(lastCall("adopt-detail")).toEqual({planId: "plan-a", entryId: "ol-detail", expectedRevision: 3, expectedVersion: 1,
                expectedContentHash: hash("4"), reportId: "00000000-0000-4000-8000-000000000002", confirmDeviations: false, resolutions: []});
        });

        it("有偏离时只分析，留在面板里等作者确认", async () => {
            responses["analyze-detail"] = report(["提前揭示身份"]);
            const wrapper = mountPanel(complete);
            await selectRow(wrapper, "detail");
            await adoptButton(wrapper).trigger("click");
            await flushPromises();
            expect(lastCall("adopt-detail")).toBeUndefined();
            expect(wrapper.find(".analysis-notice").text()).toContain("分析发现偏离或冲突");
            expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
        });

        it("结构不完整或章节大纲未采用时不可点，并说明原因", async () => {
            const bare = mountPanel();
            await selectRow(bare, "detail");
            expect(adoptButton(bare).attributes("disabled")).toBeDefined();
            expect(bare.text()).toContain("细纲结构还有问题");
            bare.unmount();
            const draftChapter = {...complete, entries: complete.entries.map((record) => record.value.id === "ol-chapter"
                ? {...record, value: {...record.value, status: "draft" as const}} : record)};
            const wrapper = mountPanel(draftChapter);
            await selectRow(wrapper, "detail");
            expect(adoptButton(wrapper).attributes("disabled")).toBeDefined();
            expect(wrapper.find(".detail-actions + .detail-hint").text()).toBe("所属章节大纲尚未正式采用，先采用章节大纲再采用细纲。");
        });
    });
});
