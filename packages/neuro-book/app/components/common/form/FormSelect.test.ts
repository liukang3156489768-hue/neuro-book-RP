// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {DOMWrapper, flushPromises, mount, type VueWrapper} from "@vue/test-utils";
import FormSelect, {type SelectOption, type SelectSize} from "./FormSelect.vue";

const mounted: VueWrapper[] = [];

beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    });
});

afterEach(() => {
    for (const wrapper of mounted.splice(0)) {
        wrapper.unmount();
    }
    document.body.replaceChildren();
    vi.unstubAllGlobals();
});

describe("common/form/FormSelect 代理桥接", () => {
    const options: SelectOption[] = [
        {label: "选项 A", value: "a"},
        {label: "选项 B", value: "b"},
        {label: "选项 C (禁用)", value: "c", disabled: true},
    ];

    it("支持空值选项、切回未挂章且不把内部编码写入表单", async () => {
        const form = document.createElement("form");
        document.body.append(form);
        const wrapper = mount(FormSelect, {
            props: {
                modelValue: "chapter-1",
                name: "chapterId",
                options: [
                    {label: "未挂章", value: ""},
                    {label: "重逢", value: "chapter-1"},
                    {label: "保留真实同名值", value: "__nbook_empty_option__"},
                ],
            },
            attachTo: form,
        });
        mounted.push(wrapper);
        await wrapper.get("button").trigger("keydown", {key: "ArrowDown"});
        await flushPromises();
        const emptyOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
            .find((option) => option.textContent?.includes("未挂章"));
        expect(emptyOption).toBeDefined();
        await new DOMWrapper(emptyOption!).trigger("keydown", {key: "Enter"});
        expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([""]);
        await wrapper.setProps({modelValue: ""});
        expect(wrapper.get("button").text()).toContain("未挂章");
        expect(new FormData(form).getAll("chapterId")).toEqual([""]);
        await wrapper.setProps({modelValue: "__nbook_empty_option__"});
        expect(wrapper.get("button").text()).toContain("保留真实同名值");
        expect(new FormData(form).get("chapterId")).toBe("__nbook_empty_option__");
    });

    it("正确渲染选中项文本并传递 props", () => {
        const wrapper = mount(FormSelect, {
            props: {
                modelValue: "a",
                options,
                size: "sm" as SelectSize,
                placeholder: "请选择",
            },
            attachTo: document.body,
        });
        mounted.push(wrapper);

        const button = wrapper.find("button");
        expect(button.exists()).toBe(true);
        expect(button.text()).toContain("选项 A");
        expect(button.classes()).toContain("nb-ui-control-h-sm");
    });

    it("空值时显示 placeholder", () => {
        const wrapper = mount(FormSelect, {
            props: {
                modelValue: "",
                options,
                placeholder: "请选择选项",
            },
            attachTo: document.body,
        });
        mounted.push(wrapper);

        const button = wrapper.find("button");
        expect(button.exists()).toBe(true);
        expect(button.text()).toContain("请选择选项");
    });

    it("禁用态下按钮包含 disabled 属性", () => {
        const wrapper = mount(FormSelect, {
            props: {
                modelValue: "a",
                options,
                disabled: true,
            },
            attachTo: document.body,
        });
        mounted.push(wrapper);

        const button = wrapper.find("button");
        expect(button.attributes("disabled")).toBeDefined();
    });

    it("透传额外 class 与 attributes 到触发按钮", () => {
        const wrapper = mount(FormSelect, {
            props: {
                modelValue: "a",
                options,
            },
            attrs: {
                class: "custom-width-class w-48",
                "data-testid": "my-select",
            },
            attachTo: document.body,
        });
        mounted.push(wrapper);

        const button = wrapper.find("button");
        expect(button.attributes("data-testid")).toBe("my-select");
        expect(button.classes()).toContain("custom-width-class");
    });
});
