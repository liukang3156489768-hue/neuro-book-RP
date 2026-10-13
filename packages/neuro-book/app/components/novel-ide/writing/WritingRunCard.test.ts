// @vitest-environment jsdom
import {afterEach, describe, expect, it} from "vitest";
import {mount, type VueWrapper} from "@vue/test-utils";
import WritingRunCard from "./WritingRunCard.vue";
import type {WritingChapterRunProgressDto, WritingRewriteRunProgressDto} from "nbook/shared/dto/writing.dto";

const base = {runId: "run-1", chapterEntryId: "ch1", interrupted: false, error: null, createdAt: "t", updatedAt: "t", phase: "writing", asks: [], logs: []};
const chapterRun = (extra: Partial<WritingChapterRunProgressDto> = {}): WritingChapterRunProgressDto => ({
    ...base, kind: "chapter", status: "running", task: "new", mode: "auto", result: null,
    scenes: [
        {index: 0, heading: "雨夜", state: "passed", retry: 0, attempts: [{prompt: {system: "系统提示", user: "用户提示"}, output: "正文", judgement: {passed: true, problems: []}}]},
        {index: 1, heading: "来客", state: "retrying", retry: 2, attempts: []},
        {index: 2, heading: "离别", state: "pending", retry: 0, attempts: []},
    ],
    ...extra,
});
const rewriteRun = (extra: Partial<WritingRewriteRunProgressDto> = {}): WritingRewriteRunProgressDto => ({
    ...base, kind: "rewrite", status: "waiting", requirement: "更紧凑", range: {from: 1, to: 1}, original: "旧段落", replacement: "新段落",
    attempts: [], result: null, asks: [{key: "confirm", role: "rewrite-confirm", title: "确认替换", description: null}], ...extra,
});

const mounted: VueWrapper[] = [];
afterEach(() => mounted.splice(0).forEach((wrapper) => wrapper.unmount()));
function mountCard(props: InstanceType<typeof WritingRunCard>["$props"]): VueWrapper {
    const wrapper = mount(WritingRunCard, {props, attachTo: document.body});
    mounted.push(wrapper);
    return wrapper;
}
const button = (wrapper: VueWrapper, text: string) => wrapper.findAll("button").find((item) => item.text() === text);

describe("写作进度卡片", () => {
    it("规划阶段区分当前规划、未来待规划与已确认待写场景", () => {
        const wrapper = mountCard({progress: chapterRun({phase: "planning", scenes: [
            {index: 1, heading: "雨夜", state: "pending", retry: 0, attempts: []},
            {index: 2, heading: "来客", state: "planning", retry: 0, attempts: []},
            {index: 3, heading: "离别", state: "unplanned", retry: 0, attempts: []},
        ]})});
        expect(wrapper.findAll(".scene-row").map((row) => row.text())).toEqual(["雨夜待写", "来客规划中", "离别待规划"]);
    });

    it("逐场景显示状态，展开后只读查看写手提示", async () => {
        const wrapper = mountCard({progress: chapterRun(), latest: true});
        expect(wrapper.findAll(".scene-row").map((row) => row.text())).toEqual(["雨夜已通过", "来客重写第 2 次", "离别待写"]);
        expect(wrapper.text()).not.toContain("系统提示");
        await wrapper.find(".scene-row").trigger("click");
        expect(wrapper.text()).toContain("系统提示");
        expect(wrapper.find("textarea").exists()).toBe(false);
        expect(button(wrapper, "停止")).toBeTruthy();
        expect(button(wrapper, "继续")).toBeUndefined();
        await button(wrapper, "停止")!.trigger("click");
        expect(wrapper.emitted("stop")).toEqual([["run-1"]]);
    });

    it("已停止的最近一次运行可以继续，旧运行不行", async () => {
        const stopped = chapterRun({status: "completed", result: {outcome: "stopped", reason: "x", message: "第 2 个场景未通过审阅", passedScenes: 1,
            totalScenes: 3, failedScene: {index: 1, heading: "来客", problems: ["视角混乱"]}, words: null, targetWords: null, withinTarget: null, hints: [], notes: []}});
        const wrapper = mountCard({progress: stopped, latest: true});
        expect(wrapper.text()).toContain("视角混乱");
        await button(wrapper, "继续")!.trigger("click");
        expect(wrapper.emitted("continue")).toEqual([["ch1"]]);
        expect(button(mountCard({progress: stopped, latest: false}), "继续")).toBeUndefined();
        expect(button(mountCard({progress: chapterRun({interrupted: true}), latest: true}), "继续")).toBeTruthy();
    });

    it("讨论模式确认场景规划，退回必须写意见；主创核对时不给按钮", async () => {
        const wrapper = mountCard({progress: chapterRun({status: "waiting", scenes: [],
            asks: [{key: "plan", role: "user-confirm", title: "确认场景规划", description: "1. 雨夜\n2. 来客"}]})});
        expect(wrapper.text()).toContain("2. 来客");
        expect(button(wrapper, "确认场景")).toBeTruthy();
        expect(button(wrapper, "退回修改")!.attributes("disabled")).toBeDefined();
        await wrapper.find("textarea").setValue("第二场太长");
        await button(wrapper, "退回修改")!.trigger("click");
        expect(wrapper.emitted("answer")).toEqual([["run-1", "plan", {approved: false, comments: "第二场太长"}]]);

        const lead = mountCard({progress: chapterRun({status: "waiting", scenes: [], asks: [{key: "plan", role: "lead-review", title: "核对", description: null}]})});
        expect(lead.text()).toContain("等待主创核对");
        expect(button(lead, "确认场景")).toBeUndefined();
    });

    it("改写显示新旧对照，替换与放弃只能操作一次", async () => {
        const wrapper = mountCard({progress: rewriteRun()});
        expect(wrapper.text()).toContain("旧段落");
        expect(wrapper.text()).toContain("新段落");
        await button(wrapper, "替换")!.trigger("click");
        expect(wrapper.emitted("answer")).toEqual([["run-1", "confirm", {replace: true}]]);
        expect(button(wrapper, "替换")!.attributes("disabled")).toBeDefined();
        expect(button(wrapper, "放弃")!.attributes("disabled")).toBeDefined();
    });

    it("连接中断与替换失败都有提示", () => {
        const failed = rewriteRun({status: "completed", asks: [], result: {outcome: "stopped", reason: "TARGET_CHANGED", message: "目标段落已被改动，替换失败",
            range: null, original: "旧段落", replacement: "新段落", problems: [], notes: []}});
        const wrapper = mountCard({progress: failed, connectionLost: true});
        expect(wrapper.find("[role=status]").text()).toContain("连接中断");
        expect(wrapper.find("[role=alert]").text()).toContain("替换失败");
    });
});
