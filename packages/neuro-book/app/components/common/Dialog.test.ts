// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {DOMWrapper, flushPromises, mount, type VueWrapper} from "@vue/test-utils";
import {h} from "vue";
import {Dialog as NbDialog, FormSelect} from "@notnotype/nb-ui/components";
import Dialog from "./Dialog.vue";

const mounted: VueWrapper[] = [];
beforeEach(() => {
    vi.stubGlobal("useI18n", () => ({t: (key: string) => key}));
    vi.stubGlobal("ResizeObserver", class {
        observe(): void {}
        disconnect(): void {}
        unobserve(): void {}
    });
});
afterEach(() => {
    mounted.splice(0).reverse().forEach((wrapper) => wrapper.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
});

function escape(): void {
    document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
}

describe("工作台与编辑表单的对话框组合", () => {
    it("初始打开的工作台可用 Escape 关闭，二级表单打开时只关二级", async () => {
        const workbench = mount(Dialog, {props: {modelValue: true, teleportTarget: "body"}, attachTo: document.body});
        const editor = mount(NbDialog, {props: {modelValue: true, title: "场景编辑"}, attachTo: document.body});
        mounted.push(workbench, editor);
        await flushPromises();
        escape();
        expect(editor.emitted("update:modelValue")).toEqual([[false]]);
        expect(workbench.emitted("update:modelValue")).toBeUndefined();
        await editor.setProps({modelValue: false});
        escape();
        expect(workbench.emitted("update:modelValue")).toEqual([[false]]);
    });

    it("顶层忙碌时不关闭底层；已被下拉框消费的 Escape 不关闭窗口", async () => {
        const workbench = mount(Dialog, {props: {modelValue: true, teleportTarget: "body"}, attachTo: document.body});
        const editor = mount(NbDialog, {props: {modelValue: true, busy: true}, attachTo: document.body});
        mounted.push(workbench, editor);
        await flushPromises();
        escape();
        expect(workbench.emitted("update:modelValue")).toBeUndefined();
        expect(editor.emitted("update:modelValue")).toBeUndefined();
        await editor.setProps({busy: false});
        const event = new KeyboardEvent("keydown", {key: "Escape", cancelable: true});
        event.preventDefault();
        document.dispatchEvent(event);
        expect(editor.emitted("update:modelValue")).toBeUndefined();
    });

    it("新表单中的下拉框位于模态遮罩之上", async () => {
        Element.prototype.scrollIntoView = vi.fn();
        const editor = mount(NbDialog, {
            props: {modelValue: true}, attachTo: document.body,
            slots: {default: () => h(FormSelect, {options: [{label: "草稿", value: "draft"}]})},
        });
        mounted.push(editor);
        await flushPromises();
        await new DOMWrapper(document.querySelector('[role="combobox"]')!).trigger("keydown", {key: "ArrowDown"});
        await flushPromises();
        const listbox = document.querySelector<HTMLElement>('[role="listbox"]');
        expect(listbox).not.toBeNull();
        expect(Number(listbox!.style.zIndex)).toBeGreaterThan(9000);
    });
});
