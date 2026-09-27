import {describe, expect, it} from "vitest";
import {entryToForm, formToCreateMetadata, formToEditMetadata, validateEntryForm} from "./outline-entry-form";

const entry = {
    id: "ol-detail", kind: "detail", version: 2, status: "draft", title: "雨夜", parentId: "ol-chapter", chapterId: "ol-chapter",
    body: "正文", materialRefs: ["lorebook/林默.md"], writingGuidance: "克制", targetWords: 3000,
    references: [{path: "research/雨夜.md", purpose: "天气"}, {locator: "旧城区地图", pending: true}],
} as const;

describe("outline entry form", () => {
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
});
