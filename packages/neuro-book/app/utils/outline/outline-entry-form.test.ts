import {describe, expect, it} from "vitest";
import {duplicateOutlineMarkers, entryHasHandoffMetadata, entryToForm, formToCreateMetadata, formToEditMetadata, formToMaterialUpdates, validateEntryForm} from "./outline-entry-form";

const entry = {
    id: "ol-chapter", kind: "chapter", version: 2, status: "draft", title: "雨夜", parentId: "ol-volume", chapterId: null,
    body: "正文", materialRefs: ["lorebook/林默.md"], writingGuidance: "克制", targetWords: 3000,
    references: [{path: "research/雨夜.md", purpose: "天气"}, {locator: "旧城区地图", pending: true}],
} as const;

const marker = (id: string, text: string) => `<!-- nb:foreshadow marker="${id}" foreshadow="fo-a" action="plant" -->${text}<!-- /nb:foreshadow marker="${id}" -->`;

describe("outline entry form", () => {
    it("只有章节大纲用表单编辑交接资料；细纲写在正文模板里", () => {
        expect(entryHasHandoffMetadata("chapter")).toBe(true);
        expect(entryHasHandoffMetadata("detail")).toBe(false);
        expect(entryHasHandoffMetadata("volume")).toBe(false);
    });

    it("往返保留元数据，待补资料不编造路径", () => {
        const form = entryToForm(entry);
        expect(form.targetWords).toBe("3000");
        expect(formToCreateMetadata(form)).toEqual({materialRefs: ["lorebook/林默.md"], writingGuidance: "克制", targetWords: 3000,
            references: [{path: "research/雨夜.md", purpose: "天气"}, {locator: "旧城区地图", pending: true}]});
    });

    it("新建省略空字段，编辑用 null 清除字段", () => {
        const form = {...entryToForm(entry), materialRefs: [" "], writingGuidance: "  ", targetWords: "", references: []};
        expect(formToCreateMetadata(form)).toEqual({});
        expect(formToEditMetadata(form)).toEqual({materialRefs: null, writingGuidance: null, references: null, targetWords: null});
    });

    it("拦截必然被服务端拒绝的输入", () => {
        const form = entryToForm(entry);
        expect(validateEntryForm(form, true)).toBeNull();
        expect(validateEntryForm({...form, title: " "}, false)).toMatch(/标题/);
        expect(validateEntryForm({...form, targetWords: "0"}, true)).toMatch(/正整数/);
        expect(validateEntryForm({...form, targetWords: "0"}, false)).toBeNull();
        expect(validateEntryForm({...form, references: [{path: "", locator: "x", purpose: "", pending: false}]}, true)).toMatch(/待补/);
        expect(validateEntryForm({...form, references: [{path: "", locator: "", purpose: "", pending: true}]}, true)).toMatch(/定位/);
    });

    it("格式截断伏笔标记导致 marker 重复时拦截保存", () => {
        const split = `甲**${marker("fm-01", "林默")}**${marker("fm-01", "推门")}`;
        expect(duplicateOutlineMarkers(split)).toEqual(["fm-01"]);
        expect(duplicateOutlineMarkers(`${marker("fm-01", "甲")}${marker("fm-02", "乙")}`)).toEqual([]);
        expect(validateEntryForm({...entryToForm(entry), body: split}, false)).toMatch(/截成了两段/);
    });

    it("关联新信息使用独立草稿，明确区分没有记录与主动清空", () => {
        const source = {...entry, materialUpdates: [{materialPath: "lorebook/角色/林默/index.md", kind: "experience", body: "旧经历"}] as const};
        const form = entryToForm(source);
        form.materialUpdates![0]!.body = " 新经历 ";
        expect(source.materialUpdates[0].body).toBe("旧经历");
        expect(formToMaterialUpdates(form)).toEqual({materialUpdates: [{materialPath: "lorebook/角色/林默/index.md", kind: "experience", body: "新经历"}]});
        expect(formToMaterialUpdates(entryToForm(entry))).toEqual({});
        form.materialUpdates = [];
        expect(formToMaterialUpdates(form)).toEqual({materialUpdates: null});
    });

    it("非章节规划也要核对关联新信息；移除全部信息可直接保存", () => {
        const form = entryToForm({...entry, materialUpdates: [{materialPath: "lorebook/角色/林默/index.md", kind: "experience", body: "旧经历"}]});
        form.materialUpdatesReviewed = false;
        expect(validateEntryForm(form, false)).toMatch(/核对关联新信息/);
        form.materialUpdatesReviewed = true;
        expect(validateEntryForm(form, false)).toBeNull();
        form.materialUpdates![0]!.body = " ";
        expect(validateEntryForm(form, false)).toMatch(/不能为空/);
        form.materialUpdates = [];
        form.materialUpdatesReviewed = false;
        expect(validateEntryForm(form, false)).toBeNull();
    });
});
