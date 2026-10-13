// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vitest";
import {flushPromises, mount, type VueWrapper} from "@vue/test-utils";
import InspirationExtractionPanel from "./InspirationExtractionPanel.vue";
import MaterialExtractionView from "./MaterialExtractionView.vue";
import OutlineExtractionView from "./OutlineExtractionView.vue";
import {useInspirationExtraction} from "nbook/app/composables/useInspirationExtraction";
import type {ExtractionApi} from "nbook/app/utils/inspiration/extraction-api";
import type {ExtractionProgress, ExtractionTask} from "nbook/shared/dto/inspiration-extraction-task.dto";

const source = {path: "reference/book.txt", sha256: "a".repeat(64)};
const preview = {
    mode: "chapters", source, chapters: [{index: 1}, {index: 2}],
    recognition: {
        volumeHeadings: [],
        chapters: [
            {index: 1, title: "第一章", firstParagraphId: "P1", lastParagraphId: "P3", characterCount: 800, headingParagraphId: "P1"},
            {index: 2, title: "第二章", firstParagraphId: "P4", lastParagraphId: "P6", characterCount: 700, headingParagraphId: "P4"},
        ],
    },
    suggestedVolumes: [{title: null, firstChapterIndex: 1, lastChapterIndex: 2}],
};
const task = (kind: string, status: string) => ({id: `${kind}-1`, kind, status, updatedAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z"});
const progress = (kind: string, status: string) => ({
    taskId: `${kind}-1`, kind, status, awaitingInput: null, stopReason: null,
    overall: {total: 2, pending: 0, running: 0, done: 2, failed: 0, skipped: 0}, groups: [], units: [],
});

function createApi(): ExtractionApi {
    return {
        listSources: vi.fn(async () => ({sources: [{path: source.path, name: "book.txt"}]})),
        prepareSource: vi.fn(async () => ({paragraphs: [], chunks: [{index: 1, firstParagraphId: "P1", lastParagraphId: "P3", characterCount: 800}, {index: 2, firstParagraphId: "P4", lastParagraphId: "P6", characterCount: 700}], warnings: []})),
        previewStructure: vi.fn(async () => preview),
        confirmStructure: vi.fn(async () => ({structure: {volumes: []}})),
        listDestinations: vi.fn(async () => ({source, options: []})),
        listTasks: vi.fn(async () => ({tasks: []})),
        startTask: vi.fn(async (request: {kind: string}) => ({task: task(request.kind, "running")})),
        getTask: vi.fn(async (_root: string, id: string) => {
            const kind = id.split("-")[0]!;
            return {task: task(kind, "completed"), progress: progress(kind, "completed")};
        }),
        getOutlineOutcome: vi.fn(async () => ({
            planId: "plan-1", planTitle: "提取方案", destination: "new", comparison: [], confirmed: null, failedOverwrites: [],
            unmappedChapters: [], staleVolumes: [], staleTotal: false, staleNotice: null, canResummarize: true,
        })),
        getReview: vi.fn(async () => ({items: []})),
    } as unknown as ExtractionApi;
}

const mounted: VueWrapper[] = [];
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()); });

function mountViews(api: ExtractionApi) {
    let extraction!: ReturnType<typeof useInspirationExtraction>;
    const host = mount({
        components: {OutlineExtractionView, MaterialExtractionView},
        setup() {
            extraction = useInspirationExtraction("project", {api, pollIntervalMs: 50, validateDelayMs: 5});
            return {extraction};
        },
        template: `<div>
            <OutlineExtractionView :outline="extraction.outline" />
            <MaterialExtractionView :material="extraction.material" :source-ready="Boolean(extraction.preparedSource)" :chunks="extraction.preparedSource?.chunks ?? []" />
        </div>`,
    });
    mounted.push(host);
    return {host, extraction};
}

describe("大纲与素材提取视图", () => {
    it.each(["outline", "material"] as const)("%s 视图的一键按钮通过一次批量请求处理失败项", async kind => {
        const api = createApi();
        const failedTask: ExtractionTask = {
            ...task(kind, "partial-failed"), version: 1, kind, status: "partial-failed", source,
            modelKey: null, params: {}, state: {}, awaitingInput: null, stopReason: null, units: [],
        };
        const failedProgress: ExtractionProgress = {
            ...progress(kind, "partial-failed"), kind, status: "partial-failed",
            overall: {total: 3, pending: 0, running: 0, done: 1, failed: 2, skipped: 0},
            units: [
                {id: "u1", step: "extract", label: "失败甲", group: null, status: "failed", attempts: 2, error: "格式错误"},
                {id: "u2", step: "extract", label: "失败乙", group: null, status: "failed", attempts: 2, error: "引用错误"},
                {id: "u3", step: "extract", label: "成功", group: null, status: "done", attempts: 1, error: null},
            ],
        };
        api.changeFailedUnits = vi.fn(async () => ({task: failedTask}));
        api.getTask = vi.fn(async () => ({task: failedTask, progress: failedProgress}));
        const {host, extraction} = mountViews(api);
        await extraction[kind].selectTask(`${kind}-1`);
        await flushPromises();
        const buttons = () => host.findAll("button");
        await buttons().find(button => button.attributes("aria-label") === "一键重试 2 个失败项")!.trigger("click");
        await flushPromises();
        expect(api.changeFailedUnits).toHaveBeenNthCalledWith(1, "project", `${kind}-1`, "retry", ["u1", "u2"]);
        await buttons().find(button => button.attributes("aria-label") === "一键跳过 2 个失败项")!.trigger("click");
        await flushPromises();
        expect(api.changeFailedUnits).toHaveBeenNthCalledWith(2, "project", `${kind}-1`, "skip", ["u1", "u2"]);
        expect(api.getTask).toHaveBeenCalledTimes(3);
    });

    it("选择来源后显示章节与划卷；开始大纲提取不影响素材入口", async () => {
        const api = createApi();
        const {host, extraction} = mountViews(api);
        await extraction.selectSource(source.path);
        await flushPromises();

        expect(host.text()).toContain("第一章");
        const start = host.findAll("button").find(button => button.text().includes("确认划分并开始提取"));
        expect(start, "应有“确认划分并开始提取”按钮").toBeDefined();
        await start!.trigger("click");
        await flushPromises();
        await new Promise(resolve => setTimeout(resolve, 120));
        await flushPromises();

        expect(api.startTask).toHaveBeenCalledTimes(1);
        expect(extraction.material.task).toBeNull();
        expect(host.findAll("button").some(button => button.text().includes("开始提取素材"))).toBe(true);
        expect(host.text()).toContain("提取方案");
    });

    it("素材提取默认选中九类，取消全部后不能开始", async () => {
        const {host, extraction} = mountViews(createApi());
        await extraction.selectSource(source.path);
        await flushPromises();
        expect(extraction.material.categories).toHaveLength(9);

        extraction.material.categories = [];
        await flushPromises();
        const start = host.findAll("button").find(button => button.text().includes("开始提取素材"))!;
        expect(start.attributes("disabled")).toBeDefined();
    });
});

describe("InspirationExtractionPanel 宿主", () => {
    it("没有作品时给出提示，不发请求", () => {
        const api = createApi();
        const wrapper = mount(InspirationExtractionPanel, {props: {projectRoot: null, api}});
        mounted.push(wrapper);
        expect(wrapper.text()).toContain("请先打开一个作品");
        expect(api.listSources).not.toHaveBeenCalled();
    });

    it("有作品时载入来源列表，卸载后不再留下轮询", async () => {
        const api = createApi();
        const wrapper = mount(InspirationExtractionPanel, {props: {projectRoot: "project", api, pollIntervalMs: 50}});
        mounted.push(wrapper);
        await flushPromises();
        expect(api.listSources).toHaveBeenCalledWith("project");
        expect(wrapper.text()).toContain("大纲提取");
        expect(wrapper.text()).toContain("素材提取");
        wrapper.unmount();
        mounted.pop();
        await new Promise(resolve => setTimeout(resolve, 120));
        expect(api.getTask).not.toHaveBeenCalled();
    });
});
