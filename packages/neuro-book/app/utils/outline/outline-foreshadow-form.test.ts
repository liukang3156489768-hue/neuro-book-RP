import {describe, expect, it} from "vitest";
import {
    emptyForeshadowForm, foreshadowToForm, formToCreateDesign, formToEditDesign, insertForeshadowMarker, validateForeshadowForm,
} from "./outline-foreshadow-form";

const definition = {id: "fo-silver", version: 1, status: "draft", title: "银纹", body: "", surface: "旧木箱上的纹路",
    plant: {situation: "搬家", presentation: "一笔带过", subtlety: "高"}} as const;
const attrs = {foreshadowId: "fo-silver", action: "plant", marker: "fm-1"} as const;

describe("outline foreshadow form", () => {
    it("新建省略空分项，编辑用 null 清除分项", () => {
        const form = foreshadowToForm(definition);
        expect(formToCreateDesign(form)).toEqual({surface: "旧木箱上的纹路", plant: {situation: "搬家", presentation: "一笔带过", subtlety: "高"}});
        expect(formToEditDesign({...form, surface: " ", plant: {situation: "", presentation: "", subtlety: ""}}))
            .toEqual({surface: null, connection: null, plant: null, recover: null});
    });

    it("埋设和回收设计只能整体填写或整体留空", () => {
        const form = emptyForeshadowForm();
        expect(validateForeshadowForm(form)).toMatch(/标题/);
        expect(validateForeshadowForm({...form, title: "银纹"})).toBeNull();
        expect(validateForeshadowForm({...form, title: "银纹", plant: {situation: "搬家", presentation: "", subtlety: ""}})).toMatch(/埋设/);
        expect(validateForeshadowForm({...form, title: "银纹", recover: {condition: "", echo: "信", effect: ""}})).toMatch(/回收/);
    });

    it("标记包住选区，并拒绝空选区和嵌套", () => {
        const body = "主角注意到墙角的木箱。";
        const start = body.indexOf("木箱");
        const inserted = insertForeshadowMarker(body, start, start + 2, attrs);
        expect(inserted).toEqual({
            body: '主角注意到墙角的<!-- nb:foreshadow marker="fm-1" foreshadow="fo-silver" action="plant" -->木箱<!-- /nb:foreshadow marker="fm-1" -->。',
            selectionStart: start, selectionEnd: expect.any(Number),
        });
        expect(insertForeshadowMarker(body, 2, 2, attrs)).toMatch(/选中/);
        if (typeof inserted === "string") throw new Error(inserted);
        const inner = inserted.body.indexOf("木箱");
        expect(insertForeshadowMarker(inserted.body, inner, inner + 1, {...attrs, marker: "fm-2"})).toMatch(/嵌套/);
        const after = inserted.body.indexOf("。");
        expect(insertForeshadowMarker(inserted.body, after, after + 1, {...attrs, marker: "fm-2"})).not.toBeTypeOf("string");
    });
});
