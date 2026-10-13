// @vitest-environment jsdom
import {describe, expect, it} from "vitest";
import {mount} from "@vue/test-utils";
import WritingCentrePanel from "./WritingCentrePanel.vue";
import type {WritingChapterDto} from "nbook/shared/dto/writing.dto";

const chapter = (extra: Partial<WritingChapterDto> = {}): WritingChapterDto => ({
    entryId: "c1", title: "第一章", version: 1, contentHash: "h", volume: null,
    details: [], status: "unwritten", writable: true, prose: [], ...extra,
});

describe("WritingCentrePanel", () => {
    it("可写章节没有正文时提供“开始写作”", async () => {
        const wrapper = mount(WritingCentrePanel, {props: {view: {kind: "empty-prose", chapter: chapter()}}});
        expect(wrapper.text()).toContain("这一章还没有正文");
        await wrapper.findAll("button").find((button) => button.text() === "开始写作")!.trigger("click");
        expect(wrapper.emitted("start-writing")?.[0]).toEqual(["c1"]);
    });

    it("不可写章节只写原因，没有开始写作", () => {
        const wrapper = mount(WritingCentrePanel, {props: {view: {kind: "empty-prose", chapter: chapter({
            status: "detail-not-reviewed", writable: false, block: {code: "DETAIL_NOT_REVIEWED", message: "x"},
        })}}});
        expect(wrapper.text()).toContain("细纲未审阅");
        expect(wrapper.findAll("button").some((button) => button.text() === "开始写作")).toBe(false);
    });

    it("条目读取失败显示原因与重试；跳转与关闭交给宿主", async () => {
        const wrapper = mount(WritingCentrePanel, {props: {view: {kind: "entry", entryId: "d1", entry: null, loading: false, error: "读不到"}}});
        expect(wrapper.get("[role=alert]").text()).toContain("读不到");
        await wrapper.findAll("button").find((button) => button.text() === "重试")!.trigger("click");
        expect(wrapper.emitted("retry")?.[0]).toEqual(["d1"]);
        await wrapper.findAll("button").find((button) => button.text().includes("在大纲工作台中打开"))!.trigger("click");
        expect(wrapper.emitted("open-outline")?.[0]).toEqual(["d1"]);
        await wrapper.get("button[aria-label=关闭]").trigger("click");
        expect(wrapper.emitted("close")).toHaveLength(1);
    });

    it("条目载入中是忙碌状态", () => {
        const wrapper = mount(WritingCentrePanel, {props: {view: {kind: "entry", entryId: "d1", entry: null, loading: true, error: null}}});
        expect(wrapper.get("[role=status]").attributes("aria-busy")).toBe("true");
    });
});
