// @vitest-environment jsdom
import {existsSync, readdirSync, readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it} from "vitest";
import {mount, type VueWrapper} from "@vue/test-utils";
import ChapterListEditor from "./ChapterListEditor.vue";
import MaterialClassificationPanel from "./MaterialClassificationPanel.vue";
import MaterialConflictResolver from "./MaterialConflictResolver.vue";
import MaterialReviewList from "./MaterialReviewList.vue";
import OutlineDestinationPicker from "./OutlineDestinationPicker.vue";
import OutlineOverwriteComparison from "./OutlineOverwriteComparison.vue";
import VolumeDivisionEditor from "./VolumeDivisionEditor.vue";
import ExtractionProgressPanel from "./ExtractionProgressPanel.vue";

const directory = dirname(fileURLToPath(import.meta.url));
const mounted: VueWrapper[] = [];
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()); });

function mountTracked(component: unknown, props: Record<string, unknown>): VueWrapper {
    const wrapper = mount(component as Parameters<typeof mount>[0], {props: props as never}) as VueWrapper;
    mounted.push(wrapper);
    return wrapper;
}

function buttonByText(wrapper: VueWrapper, text: string) {
    const target = wrapper.findAll("button").find(button => button.text().replace(/\s+/gu, "") === text.replace(/\s+/gu, ""));
    if (!target) throw new Error(`找不到按钮：${text}`);
    return target;
}

describe("ExtractionProgressPanel 失败项批量处理", () => {
    const progress = {
        taskId: "task-1", kind: "material", status: "partial-failed", awaitingInput: null, stopReason: null,
        overall: {total: 5, pending: 1, running: 1, done: 1, failed: 2, skipped: 0}, groups: [],
        units: [
            {id: "u1", label: "角色甲", status: "failed", error: "缺少引用"},
            {id: "u2", label: "角色乙", status: "failed", error: "格式错误"},
            {id: "u3", label: "角色丙", status: "done"},
            {id: "u4", label: "角色丁", status: "running"},
            {id: "u5", label: "角色戊", status: "pending"},
        ],
    };

    it("计数来自所有失败项，切换筛选不改变批量操作范围", async () => {
        const wrapper = mountTracked(ExtractionProgressPanel, {progress});
        await buttonByText(wrapper, "一键重试（2）").trigger("click");
        expect(wrapper.emitted("retry-failed")).toEqual([[["u1", "u2"]]]);
        expect(wrapper.text()).not.toContain("角色丙");
        await buttonByText(wrapper, "全部").trigger("click");
        expect(wrapper.text()).toContain("角色丙");
        await buttonByText(wrapper, "一键跳过（2）").trigger("click");
        expect(wrapper.emitted("skip-failed")).toEqual([[["u1", "u2"]]]);
    });

    it("没有失败、请求进行中以及任务已停止时禁用批量控件", async () => {
        const wrapper = mountTracked(ExtractionProgressPanel, {progress, busy: true});
        const retry = () => wrapper.find('button[aria-label^="一键重试"]');
        const skip = () => wrapper.find('button[aria-label^="一键跳过"]');
        expect(retry().attributes("disabled")).toBeDefined();
        expect(skip().attributes("disabled")).toBeDefined();
        await retry().trigger("click");
        expect(wrapper.emitted("retry-failed")).toBeUndefined();
        await wrapper.setProps({busy: false, progress: {...progress, status: "interrupted"}});
        expect(retry().attributes("disabled")).toBeDefined();
        await wrapper.setProps({progress: {...progress, units: [], overall: {...progress.overall, failed: 0}}});
        expect(retry().attributes("disabled")).toBeDefined();
        expect(skip().attributes("disabled")).toBeDefined();
    });
});

describe("作品提取组件合同", () => {
    const vueFiles = readdirSync(directory).filter(name => name.endsWith(".vue"));

    it("每个组件都有同名 .md，且带标签 frontmatter", () => {
        expect(vueFiles.length).toBeGreaterThanOrEqual(15);
        for (const file of vueFiles) {
            const doc = join(directory, file.replace(/\.vue$/u, ".md"));
            expect(existsSync(doc), `${file} 缺少同名 .md`).toBe(true);
            expect(readFileSync(doc, "utf8"), `${file} 的 .md 缺少标签`).toMatch(/^---\r?\n标签: \[/u);
        }
    });

    it("只有宿主面板声明 io 标签，其余组件保持纯展示", () => {
        for (const file of vueFiles) {
            const tags = /^标签: (.*)$/mu.exec(readFileSync(join(directory, file.replace(/\.vue$/u, ".md")), "utf8"))?.[1] ?? "";
            if (file === "InspirationExtractionPanel.vue") expect(tags).toContain("io:mutate");
            else expect(tags, `${file} 不应直接发起 IO`).not.toMatch(/io:/u);
        }
    });

    it("组件源码不含单行压缩样式，也不处理确认者身份", () => {
        for (const file of vueFiles) {
            const source = readFileSync(join(directory, file), "utf8");
            const styles = /<style[^>]*>([\s\S]*?)<\/style>/u.exec(source)?.[1] ?? "";
            const compressed = styles.split(/\r?\n/u).filter(line => (line.match(/;/gu) ?? []).length > 1);
            expect(compressed, `${file} 出现单行压缩 CSS`).toEqual([]);
            expect(source, `${file} 不应出现确认者字段`).not.toMatch(/confirmedBy|confirmer/iu);
        }
    });
});

describe("ChapterListEditor 章节修正", () => {
    const preview = {
        mode: "chapters", source: {path: "reference/a.txt", sha256: "a"}, chapters: [], suggestedVolumes: [],
        recognition: {
            volumeHeadings: [],
            chapters: [
                {index: 1, title: "第一章", firstParagraphId: "P1", lastParagraphId: "P4", characterCount: 1200, headingParagraphId: "P1"},
                {index: 2, title: "第二章", firstParagraphId: "P5", lastParagraphId: "P8", characterCount: 900, headingParagraphId: "P5"},
            ],
        },
    };

    it("取消章标题、合并、设为章标题与拆分都发出对应修正", async () => {
        const wrapper = mountTracked(ChapterListEditor, {preview, corrections: []});
        await buttonByText(wrapper, "取消章标题").trigger("click");
        expect(wrapper.emitted("correct")?.[0]).toEqual([{kind: "unset-heading", paragraphId: "P1"}]);

        await buttonByText(wrapper, "与下一章合并").trigger("click");
        expect(wrapper.emitted("correct")?.[1]).toEqual([{kind: "merge", chapterIndex: 1}]);

        const [paragraph, title] = wrapper.findAll("input");
        await paragraph!.setValue("12");
        await title!.setValue("雨夜");
        await buttonByText(wrapper, "设为章标题").trigger("click");
        expect(wrapper.emitted("correct")?.[2]).toEqual([{kind: "set-heading", paragraphId: "P12", title: "雨夜"}]);

        await paragraph!.setValue("p30");
        await buttonByText(wrapper, "在此拆分").trigger("click");
        expect(wrapper.emitted("correct")?.[3]).toEqual([{kind: "split", paragraphId: "P30"}]);
    });

    it("最后一章不能合并，段落编号格式错误时不提交并提示", async () => {
        const wrapper = mountTracked(ChapterListEditor, {preview, corrections: []});
        const merges = wrapper.findAll("button").filter(button => button.text().includes("与下一章合并"));
        expect(merges.at(-1)!.attributes("disabled")).toBeDefined();

        await wrapper.findAll("input")[0]!.setValue("第三段");
        expect(wrapper.text()).toContain("段落编号写成 P12 或 12 的形式");
        expect(buttonByText(wrapper, "设为章标题").attributes("disabled")).toBeDefined();
    });

    it("显示已做修正，并能撤销与全部还原", async () => {
        const wrapper = mountTracked(ChapterListEditor, {preview, corrections: [{kind: "merge", chapterIndex: 1}]});
        expect(wrapper.text()).toContain("合并第 1 章与下一章");
        await buttonByText(wrapper, "撤销上一项").trigger("click");
        await buttonByText(wrapper, "全部还原").trigger("click");
        expect(wrapper.emitted("undo")).toHaveLength(1);
        expect(wrapper.emitted("clear")).toHaveLength(1);
    });
});

describe("VolumeDivisionEditor 划卷", () => {
    it("按章范围编辑时发出更新后的划卷草稿", async () => {
        const wrapper = mountTracked(VolumeDivisionEditor, {
            mode: "chapters", chapterCount: 10, chunkCount: 0, chunksPerVolume: "3", volumes: [{title: "", first: "1", last: "10"}],
        });
        await wrapper.findAll("input")[2]!.setValue("5");
        expect(wrapper.emitted("update:volumes")?.[0]?.[0]).toEqual([{title: "", first: "1", last: "5"}]);

        await buttonByText(wrapper, "添加一卷").trigger("click");
        expect(wrapper.emitted("update:volumes")?.[1]?.[0]).toEqual([{title: "", first: "1", last: "10"}, {title: "", first: "11", last: ""}]);
    });

    it("服务端校验错误原样显示，通过时显示有效", () => {
        const failed = mountTracked(VolumeDivisionEditor, {
            mode: "chapters", chapterCount: 10, chunkCount: 0, chunksPerVolume: "3", volumes: [{title: "", first: "1", last: "4"}], error: "第 1 卷与第 2 卷的章节范围重叠",
        });
        expect(failed.text()).toContain("第 1 卷与第 2 卷的章节范围重叠");
        expect(failed.text()).not.toContain("划分有效");

        const ok = mountTracked(VolumeDivisionEditor, {
            mode: "chapters", chapterCount: 10, chunkCount: 0, chunksPerVolume: "3", volumes: [{title: "", first: "1", last: "10"}], valid: true,
        });
        expect(ok.text()).toContain("划分有效，共 1 卷");
    });

    it("按块数划卷时提示预计卷数并发出更新", async () => {
        const wrapper = mountTracked(VolumeDivisionEditor, {mode: "chunks", chapterCount: 0, chunkCount: 10, chunksPerVolume: "4", volumes: []});
        expect(wrapper.text()).toContain("预计分成 3 卷");
        await wrapper.find("input").setValue("5");
        expect(wrapper.emitted("update:chunksPerVolume")?.[0]).toEqual(["5"]);
    });
});

describe("OutlineDestinationPicker 数据去向", () => {
    const options = [
        {planId: "plan-a", planTitle: "方案甲", canSupplement: true, canOverwrite: true, reason: null},
        {planId: "plan-b", planTitle: "方案乙", canSupplement: false, canOverwrite: false, reason: "该方案正在被另一个提取任务使用"},
    ];

    it("选择新建、补充、覆盖都发出对应去向", async () => {
        const wrapper = mountTracked(OutlineDestinationPicker, {options, modelValue: {kind: "new"}});
        const supplement = wrapper.findAll("button").filter(button => button.text() === "补充");
        const overwrite = wrapper.findAll("button").filter(button => button.text() === "覆盖");
        await supplement[0]!.trigger("click");
        await overwrite[0]!.trigger("click");
        expect(wrapper.emitted("update:modelValue")).toEqual([[{kind: "supplement", planId: "plan-a"}], [{kind: "overwrite", planId: "plan-a"}]]);
    });

    it("不可用的去向禁用按钮并显示原因", () => {
        const wrapper = mountTracked(OutlineDestinationPicker, {options, modelValue: {kind: "overwrite", planId: "plan-a"}});
        const supplement = wrapper.findAll("button").filter(button => button.text() === "补充");
        expect(supplement[1]!.attributes("disabled")).toBeDefined();
        expect(wrapper.text()).toContain("该方案正在被另一个提取任务使用");
        const overwrite = wrapper.findAll("button").filter(button => button.text() === "覆盖");
        expect(overwrite[0]!.attributes("aria-pressed")).toBe("true");
    });
});

describe("OutlineOverwriteComparison 覆盖对比", () => {
    const items = [
        {chapterIndex: 1, chapterTitle: "第一章", kind: "detail", oldText: "旧细纲", newText: "新细纲", changed: true, locator: "x", oldEntries: []},
        {chapterIndex: 2, chapterTitle: "第二章", kind: "outline", oldText: "同样", newText: "同样", changed: false, locator: "y", oldEntries: []},
    ];

    it("默认只选有变化的条目，确认时提交所选", async () => {
        const wrapper = mountTracked(OutlineOverwriteComparison, {items, confirmed: null});
        expect(wrapper.text()).toContain("旧细纲");
        expect(wrapper.text()).toContain("新细纲");
        await buttonByText(wrapper, "确认覆盖 1 项").trigger("click");
        expect(wrapper.emitted("confirm")?.[0]).toEqual([[{chapterIndex: 1, kind: "detail"}]]);
    });
});

describe("MaterialClassificationPanel 归类", () => {
    const classification = {
        categories: [
            {category: "character", label: "角色", folders: [
                {key: "lin", name: "林舟", aliases: ["阿舟"], blocks: [1], preview: {fragments: [{block: 1, role: "main", fields: {角色名称: "林舟", 性格: "沉稳"}, citations: [{firstParagraphId: "P1", lastParagraphId: "P1"}]}]}},
                {key: "linzhou", name: "林舟舟", aliases: [], blocks: [2]},
                {key: "su", name: "苏然", aliases: [], blocks: [3]},
            ]},
            {category: "location", label: "地点", folders: [{key: "port", name: "港口", aliases: [], blocks: [1]}]},
        ],
        candidates: [{category: "character", folders: ["lin", "linzhou"], reason: "名字相近"}],
    };

    it("勾选同类别的文件夹后合并，提交分组", async () => {
        const wrapper = mountTracked(MaterialClassificationPanel, {classification});
        const boxes = wrapper.findAll("input[type=checkbox]");
        expect(boxes).toHaveLength(4);
        await boxes[0]!.setValue(true);
        expect(wrapper.text()).toContain("至少勾选两个文件夹才能合并");
        await boxes[1]!.setValue(true);
        expect(wrapper.text()).not.toContain("至少勾选两个文件夹才能合并");

        await buttonByText(wrapper, "合并所选").trigger("click");
        expect(wrapper.text()).toContain("已建立 1 个分组");

        await buttonByText(wrapper, "确认归类并继续").trigger("click");
        expect(wrapper.emitted("submit")?.[0]).toEqual([[{category: "character", folders: ["lin", "linzhou"]}]]);
    });

    it("跨类别不能合并；疑似候选一键选中；可以跳过归类", async () => {
        const wrapper = mountTracked(MaterialClassificationPanel, {classification});
        const boxes = wrapper.findAll("input[type=checkbox]");
        await boxes[0]!.setValue(true);
        await boxes[3]!.setValue(true);
        expect(wrapper.text()).toContain("只能合并同一类别的文件夹");

        await buttonByText(wrapper, "选中这几项").trigger("click");
        const checked = wrapper.findAll("input[type=checkbox]").map(box => (box.element as HTMLInputElement).checked);
        expect(checked).toEqual([true, true, false, false]);

        await buttonByText(wrapper, "跳过归类").trigger("click");
        expect(wrapper.emitted("skip")).toHaveLength(1);
    });

    it("查看详情不改变勾选，轮询刷新同一清单时保留选择", async () => {
        const wrapper = mountTracked(MaterialClassificationPanel, {classification});
        const boxes = wrapper.findAll("input[type=checkbox]");
        await boxes[0]!.setValue(true);
        await wrapper.findAll("button").filter(button => button.text() === "查看详情")[0]!.trigger("click");
        expect(wrapper.text()).toContain("性格");
        expect((boxes[0]!.element as HTMLInputElement).checked).toBe(true);
        await wrapper.setProps({classification: structuredClone(classification)});
        expect((wrapper.findAll("input[type=checkbox]")[0]!.element as HTMLInputElement).checked).toBe(true);
    });

    it("隐藏 input 的焦点锚定在行内，勾选仍能更新选择", async () => {
        const wrapper = mountTracked(MaterialClassificationPanel, {classification});
        const second = wrapper.findAll("input[type=checkbox]")[1]!;
        expect(second.classes()).toContain("checkbox-input");
        expect(second.element.parentElement?.classList.contains("relative")).toBe(true);
        await second.setValue(true);
        expect((second.element as HTMLInputElement).checked).toBe(true);
        expect(wrapper.text()).toContain("已勾选 1 项");
    });

    it("连续合并两组角色后仍可继续选择，且含斜杠的文件夹 key 不会被拆错", async () => {
        const extended = structuredClone(classification);
        extended.categories[0]!.folders = [
            ...extended.categories[0]!.folders,
            {key: "mentor/old", name: "旧导师", aliases: [], blocks: [4]},
            {key: "mentor-new", name: "新导师", aliases: [], blocks: [5]},
        ];
        const wrapper = mountTracked(MaterialClassificationPanel, {classification: extended});
        const boxes = () => wrapper.findAll("input[type=checkbox]");
        await boxes()[0]!.setValue(true);
        await boxes()[1]!.setValue(true);
        await buttonByText(wrapper, "合并所选").trigger("click");
        expect(wrapper.text()).toContain("已建立 1 个分组");
        expect((boxes()[0]!.element as HTMLInputElement).disabled).toBe(true);
        expect((boxes()[1]!.element as HTMLInputElement).disabled).toBe(true);

        await boxes()[3]!.setValue(true);
        await boxes()[4]!.setValue(true);
        await buttonByText(wrapper, "合并所选").trigger("click");
        expect(wrapper.text()).toContain("已建立 2 个分组");
        expect((boxes()[3]!.element as HTMLInputElement).disabled).toBe(true);
        expect((boxes()[4]!.element as HTMLInputElement).disabled).toBe(true);
    });
});

describe("MaterialReviewList 待写入清单", () => {
    const item = (id: string, title: string, over: Record<string, unknown> = {}) => ({
        id, category: "character", title, aliases: [], nodes: [{role: "main", content: "设定"}], directoryName: title, selected: true,
        write: {status: "pending", error: null, writtenRoles: [], savedAs: null}, ...over,
    });
    const review = {items: [item("i1", "林舟"), item("i2", "苏然"), item("i3", "港口", {category: "location"})]};

    it("默认全选，可全不选与全选，选择变化以动作发出", async () => {
        const wrapper = mountTracked(MaterialReviewList, {review});
        expect(wrapper.text()).toContain("已选 3 / 共 3");

        await buttonByText(wrapper, "全不选").trigger("click");
        expect(wrapper.emitted("action")?.[0]).toEqual([{kind: "select", itemIds: ["i1", "i2", "i3"], selected: false}]);

        await wrapper.findAll("input[type=checkbox]")[0]!.setValue(false);
        expect(wrapper.emitted("action")?.[1]).toEqual([{kind: "select", itemIds: ["i1"], selected: false}]);
    });

    it("确认写入按钮显示已选数量并发出 write；没有选中时禁用", async () => {
        const wrapper = mountTracked(MaterialReviewList, {review});
        await buttonByText(wrapper, "确认写入 3 项").trigger("click");
        expect(wrapper.emitted("write")).toHaveLength(1);

        const empty = mountTracked(MaterialReviewList, {review: {items: review.items.map(entry => ({...entry, selected: false}))}});
        expect(buttonByText(empty, "确认写入 0 项").attributes("disabled")).toBeDefined();
    });

    it("删除条目、合并同类条目；跨类别合并被禁用", async () => {
        const wrapper = mountTracked(MaterialReviewList, {review});
        await wrapper.findAll("button").filter(button => button.text() === "删除")[0]!.trigger("click");
        expect(wrapper.emitted("action")?.[0]).toEqual([{kind: "remove", itemId: "i1"}]);

        const mergeBoxes = wrapper.findAll("input[type=checkbox]").filter((_, index) => index % 2 === 1);
        await mergeBoxes[0]!.setValue(true);
        await mergeBoxes[1]!.setValue(true);
        await buttonByText(wrapper, "合并所选（2）").trigger("click");
        expect(wrapper.emitted("action")?.[1]).toEqual([{kind: "merge", itemIds: ["i1", "i2"]}]);

        await mergeBoxes[2]!.setValue(true);
        expect(buttonByText(wrapper, "合并所选（3）").attributes("disabled")).toBeDefined();
    });

    it("已写入的条目只读，写入失败显示原因", () => {
        const wrapper = mountTracked(MaterialReviewList, {
            review: {items: [
                item("i1", "林舟", {write: {status: "written", error: null, writtenRoles: ["main"], savedAs: null}}),
                item("i2", "苏然", {write: {status: "failed", error: "磁盘已满", writtenRoles: [], savedAs: null}}),
            ]},
        });
        expect(wrapper.text()).toContain("已写入");
        expect(wrapper.text()).toContain("磁盘已满");
        expect(wrapper.text()).toContain("已写入 1");
    });
});

describe("MaterialConflictResolver 同名冲突", () => {
    const conflict = (itemId: string, over: Record<string, unknown> = {}) => ({
        itemId, title: "林舟", path: `lorebook/characters/${itemId}.md`, role: "main", overwriteAllowed: true,
        existing: {origin: "design", content: "旧内容"}, incoming: "新内容", ...over,
    });

    it("默认跳过；选择覆盖与另存为后提交对应决定，另存为必须填名称", async () => {
        const wrapper = mountTracked(MaterialConflictResolver, {conflicts: [conflict("i1"), conflict("i2", {title: "苏然"})]});
        expect(wrapper.text()).toContain("旧内容");
        expect(wrapper.text()).toContain("新内容");

        await buttonByText(wrapper, "按所选处理并写入").trigger("click");
        expect(wrapper.emitted("confirm")?.[0]).toEqual([[{itemId: "i1", action: "skip"}, {itemId: "i2", action: "skip"}]]);

        const overwrite = wrapper.findAll("button").filter(button => button.text() === "覆盖")[0]!;
        await overwrite.trigger("click");
        const saveAs = wrapper.findAll("button").filter(button => button.text() === "另存为")[1]!;
        await saveAs.trigger("click");
        expect(wrapper.text()).toContain("请为“苏然”填写另存为的名称");
        expect(buttonByText(wrapper, "按所选处理并写入").attributes("disabled")).toBeDefined();

        await wrapper.find("input").setValue("苏然（旧）");
        await buttonByText(wrapper, "按所选处理并写入").trigger("click");
        expect(wrapper.emitted("confirm")?.[1]).toEqual([[{itemId: "i1", action: "overwrite"}, {itemId: "i2", action: "save-as", saveAsName: "苏然（旧）"}]]);
    });

    it("现有文件不允许覆盖时不提供覆盖选项", () => {
        const wrapper = mountTracked(MaterialConflictResolver, {conflicts: [conflict("i1", {overwriteAllowed: false})]});
        expect(wrapper.findAll("button").some(button => button.text() === "覆盖")).toBe(false);
        expect(wrapper.text()).toContain("现有文件不允许被覆盖");
    });
});
