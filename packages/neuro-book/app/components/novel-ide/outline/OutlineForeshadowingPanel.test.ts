// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {flushPromises, mount, type VueWrapper} from "@vue/test-utils";
import OutlineForeshadowingPanel from "./OutlineForeshadowingPanel.vue";
import type {OutlineWorkbenchForeshadowingResponse, OutlineWorkbenchSnapshot} from "nbook/app/composables/useOutlineWorkbenchData";

const hash = `sha256:${"a".repeat(64)}`;
const snapshot: OutlineWorkbenchSnapshot = {
    manifest: {revision: 7, plans: [{id: "plan-a", title: "方案甲", totalId: "ol-total", placements: []}]},
    entries: [{path: "outline/entries/ch1.md", contentHash: hash, value: {id: "ol-ch1", kind: "chapter", version: 1, status: "adopted",
        title: "雨夜来客", parentId: "ol-total", chapterId: null, body: ""}}],
    foreshadowing: [
        {path: "outline/foreshadowing/silver.md", contentHash: hash, value: {id: "fo-silver", version: 2, status: "adopted", title: "银纹",
            body: "", surface: "木箱纹路", plant: {situation: "搬家", presentation: "一笔带过", subtlety: "高"}}},
        {path: "outline/foreshadowing/letter.md", contentHash: hash, value: {id: "fo-letter", version: 0, status: "draft", title: "父亲的信", body: ""}},
    ],
    graphs: [],
    lines: [],
};
const foreshadowing: OutlineWorkbenchForeshadowingResponse = {
    parserVersion: 1, markerIssues: [],
    states: [
        {id: "fo-silver", status: "planted", issues: [], sources: [{planId: "plan-a", nodeId: "nd-1", column: 2, lineIds: ["ln-main"],
            chapterId: "ol-ch1", entryPath: "outline/entries/ch1.md", marker: "fm-1", action: "plant", content: "墙角的木箱", startOffset: 0, valid: true}]},
        {id: "fo-letter", status: "draft", issues: [], sources: []},
    ],
    elapsed: [{id: "fo-silver", plans: [{planId: "plan-a", elapsed: 3}]}],
};

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

function mountPanel(refresh: (wrapper: VueWrapper) => Promise<void> = async () => {}): VueWrapper {
    const wrapper: VueWrapper = mount(OutlineForeshadowingPanel, {
        props: {projectRoot: "project", snapshot, foreshadowing, planId: "plan-a", refresh: vi.fn(() => refresh(wrapper))},
        attachTo: document.body,
    });
    mounted.push(wrapper);
    return wrapper;
}
/** 焦点离开表单会立即保存，不必等防抖。 */
async function blurForm(wrapper: VueWrapper): Promise<void> {
    await wrapper.find(".foreshadow-form").trigger("focusout");
    await flushPromises();
}
async function click(wrapper: VueWrapper, text: string): Promise<void> {
    const target = wrapper.findAll("button").find((button) => button.text().trim() === text);
    if (!target) throw new Error(`找不到按钮：${text}`);
    await target.trigger("click");
    await flushPromises();
}
async function select(wrapper: VueWrapper, title: string): Promise<void> {
    await wrapper.findAll("button.foreshadow-row").find((row) => row.find(".row-title").text() === title)!.trigger("click");
    await flushPromises();
}
function lastBody(segment: string): Record<string, unknown> | undefined {
    return fetchMock.mock.calls.filter(([url]) => url === `/api/projects/outline/${segment}`).at(-1)?.[1].body;
}

describe("伏笔库编辑面板", () => {
    it("展示服务端状态、已过格数和正式来源", async () => {
        const wrapper = mountPanel();
        await select(wrapper, "银纹");
        expect(wrapper.text()).toContain("已埋设");
        expect(wrapper.text()).toContain("已过 3 格");
        expect(wrapper.find(".source-list").text()).toContain("雨夜来客");
        expect(wrapper.find(".source-list").text()).toContain("墙角的木箱");
    });

    it("新建伏笔直接以草稿落盘，选中后全选名称", async () => {
        responses["foreshadowing-action"] = {transactionId: "tx", foreshadowingId: "fo-new"};
        const created = {path: "outline/foreshadowing/new.md", contentHash: hash,
            value: {id: "fo-new", version: 0, status: "draft" as const, title: "新伏笔", body: ""}};
        const wrapper = mountPanel(async (self) => {
            await self.setProps({snapshot: {...snapshot, manifest: {...snapshot.manifest, revision: 8}, foreshadowing: [...snapshot.foreshadowing, created]}});
        });
        await click(wrapper, "新建伏笔");
        expect(lastBody("foreshadowing-action")).toEqual({expectedRevision: 7, action: {kind: "create-foreshadowing", title: "新伏笔", body: ""}});
        const title = wrapper.find<HTMLInputElement>(".foreshadow-title input");
        expect(title.element.value).toBe("新伏笔");
        expect(document.activeElement).toBe(title.element);
    });

    it("自动保存拦截不完整的设计，补齐或清空后保存，空分项显式发送 null", async () => {
        const wrapper = mountPanel();
        await select(wrapper, "父亲的信");
        const inputs = wrapper.findAll(".foreshadow-form input");
        await inputs[0]!.setValue("父亲的旧信");
        await inputs[1]!.setValue("客厅");
        await blurForm(wrapper);
        expect(wrapper.find(".save-status").text()).toContain("埋设设计需要同时填写");
        expect(lastBody("foreshadowing-action")).toBeUndefined();

        await inputs[1]!.setValue("");
        await blurForm(wrapper);
        expect(lastBody("foreshadowing-action")).toEqual({expectedRevision: 7, action: {kind: "edit-foreshadowing", id: "fo-letter",
            expectedVersion: 0, expectedContentHash: hash, title: "父亲的旧信", body: "", surface: null, connection: null, plant: null, recover: null}});
        expect(wrapper.find(".save-status").text()).toBe("已保存");
    });

    it("已确认的伏笔先确认回到草稿才保存", async () => {
        const wrapper = mountPanel();
        await select(wrapper, "银纹");
        await wrapper.find(".foreshadow-form textarea").setValue("");
        await blurForm(wrapper);
        expect(lastBody("foreshadowing-action")).toBeUndefined();
        expect(wrapper.find(".detail-notice").text()).toContain("保存后会回到草稿");

        await click(wrapper, "保存并回到草稿");
        expect(lastBody("foreshadowing-action")).toEqual({expectedRevision: 7, action: {kind: "edit-foreshadowing", id: "fo-silver",
            expectedVersion: 2, expectedContentHash: hash, title: "银纹", body: "", surface: null, connection: null,
            plant: {situation: "搬家", presentation: "一笔带过", subtlety: "高"}, recover: null}});
    });

    it("草稿可以确认设计；有未保存修改时确认按钮不可用", async () => {
        const wrapper = mountPanel();
        await select(wrapper, "父亲的信");
        await click(wrapper, "确认设计");
        expect(lastBody("foreshadowing-action")).toEqual({expectedRevision: 7, action: {kind: "confirm-foreshadowing", id: "fo-letter",
            expectedVersion: 0, expectedContentHash: hash}});

        await wrapper.findAll(".foreshadow-form input")[1]!.setValue("客厅");
        const confirm = wrapper.findAll("button").find((button) => button.text().trim() === "确认设计")!;
        expect(confirm.attributes("disabled")).toBeDefined();
    });

    it("切换伏笔时保存不了会提示，放弃修改后才切换", async () => {
        const wrapper = mountPanel();
        await select(wrapper, "父亲的信");
        await wrapper.findAll(".foreshadow-form input")[1]!.setValue("客厅");
        await select(wrapper, "银纹");
        expect(wrapper.find(".panel-notice").text()).toContain("切换会丢弃这些修改");
        await click(wrapper, "放弃修改并切换");
        expect(wrapper.find<HTMLInputElement>(".foreshadow-title input").element.value).toBe("银纹");
        expect(lastBody("foreshadowing-action")).toBeUndefined();
    });

    it("仍有标记引用时不能删除", async () => {
        responses["preview-object-deletion"] = {revision: 7, objectHash: hash, impact: {targetId: "fo-silver", objectFile: "outline/foreshadowing/silver.md",
            references: [{sourceFile: "outline/entries/ch1.md", relation: "marker:fm-1", sourceId: "ol-ch1"}], canDeleteObject: false}};
        const wrapper = mountPanel();
        await select(wrapper, "银纹");
        await click(wrapper, "删除");
        expect(lastBody("preview-object-deletion")).toEqual({targetId: "fo-silver"});
        expect(wrapper.find(".impact-panel").text()).toContain("「雨夜来客」正文中的伏笔标记");
        const confirm = wrapper.findAll(".impact-actions button").find((button) => button.text() === "确认")!;
        expect(confirm.attributes("disabled")).toBeDefined();
    });
});
