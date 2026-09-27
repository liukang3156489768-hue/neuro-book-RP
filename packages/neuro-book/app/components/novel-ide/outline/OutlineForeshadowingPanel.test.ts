// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {flushPromises, mount, type VueWrapper} from "@vue/test-utils";
import OutlineForeshadowingPanel from "./OutlineForeshadowingPanel.vue";
import type {OutlineWorkbenchForeshadowingResponse, OutlineWorkbenchSnapshot} from "nbook/app/composables/useOutlineWorkbenchData";

const hash = `sha256:${"a".repeat(64)}`;
const snapshot: OutlineWorkbenchSnapshot = {
    manifest: {revision: 7, totalId: "ol-total", plans: [{id: "plan-a", title: "方案甲", placements: []}]},
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

function mountPanel(): VueWrapper {
    const wrapper = mount(OutlineForeshadowingPanel, {
        props: {projectRoot: "project", snapshot, foreshadowing, planId: "plan-a", refresh: vi.fn(async () => {})},
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

    it("新建时拦截不完整的埋设设计，并省略空分项", async () => {
        responses["foreshadowing-action"] = {transactionId: "tx", foreshadowingId: "fo-new"};
        const wrapper = mountPanel();
        await click(wrapper, "新建伏笔");
        const inputs = wrapper.findAll(".foreshadow-form input");
        await inputs[0]!.setValue("旧照片");
        await inputs[1]!.setValue("客厅");
        await click(wrapper, "保存为草稿");
        expect(wrapper.text()).toContain("埋设设计需要同时填写");
        expect(fetchMock).not.toHaveBeenCalled();
        await inputs[1]!.setValue("");
        await click(wrapper, "保存为草稿");
        expect(lastBody("foreshadowing-action")).toEqual({expectedRevision: 7, action: {kind: "create-foreshadowing", title: "旧照片", body: ""}});
    });

    it("编辑时清空的分项显式发送 null，草稿可以确认", async () => {
        const wrapper = mountPanel();
        await select(wrapper, "银纹");
        await click(wrapper, "编辑");
        expect(wrapper.text()).toContain("保存后这条伏笔会回到草稿");
        await wrapper.find(".foreshadow-form textarea").setValue("");
        await click(wrapper, "保存为草稿");
        expect(lastBody("foreshadowing-action")).toEqual({expectedRevision: 7, action: {kind: "edit-foreshadowing", id: "fo-silver",
            expectedVersion: 2, expectedContentHash: hash, title: "银纹", body: "", surface: null, connection: null,
            plant: {situation: "搬家", presentation: "一笔带过", subtlety: "高"}, recover: null}});

        await select(wrapper, "父亲的信");
        await click(wrapper, "确认设计");
        expect(lastBody("foreshadowing-action")).toEqual({expectedRevision: 7, action: {kind: "confirm-foreshadowing", id: "fo-letter",
            expectedVersion: 0, expectedContentHash: hash}});
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
