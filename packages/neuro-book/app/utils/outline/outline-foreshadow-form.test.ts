import {describe, expect, it} from "vitest";
import {
    emptyForeshadowForm, foreshadowToForm, formToCreateDesign, formToEditDesign, validateForeshadowForm,
} from "./outline-foreshadow-form";

const definition = {id: "fo-silver", version: 1, status: "draft", title: "银纹", body: "", surface: "旧木箱上的纹路",
    plant: {situation: "搬家", presentation: "一笔带过", subtlety: "高"}} as const;

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
});
