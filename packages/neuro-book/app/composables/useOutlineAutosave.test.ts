// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vitest";
import {defineComponent, h, nextTick, ref} from "vue";
import {flushPromises, mount, type VueWrapper} from "@vue/test-utils";
import {useOutlineAutosave, type OutlineAutosave, type OutlineAutosaveBase} from "nbook/app/composables/useOutlineAutosave";

type ServerRecord = Readonly<{version: number; contentHash: string; text: string}>;
const mounted: VueWrapper[] = [];
afterEach(() => {
    mounted.splice(0).forEach((wrapper) => wrapper.unmount());
    vi.useRealTimers();
});

/** 模拟宿主：save 成功后像真实服务端一样让 version 加一，再由测试决定何时把新快照交回。 */
function setup(options: {blocked?: () => boolean} = {}) {
    const server = ref<ServerRecord>({version: 1, contentHash: "h1", text: "原文"});
    const form = ref({text: ""});
    const save = vi.fn(async (value: {text: string}, base: OutlineAutosaveBase) => {
        server.value = {version: base.version + 1, contentHash: `h${base.version + 1}`, text: value.text};
        return true;
    });
    let autosave!: OutlineAutosave;
    const wrapper = mount(defineComponent({
        setup() {
            autosave = useOutlineAutosave({
                key: () => "entry",
                base: () => ({version: server.value.version, contentHash: server.value.contentHash}),
                form,
                load: () => ({text: server.value.text}),
                serialize: (value) => value.text,
                validate: (value) => value.text.includes("!") ? "不能含感叹号" : null,
                blocked: options.blocked ?? (() => false),
                save,
                errorMessage: () => null,
            });
            return () => h("div");
        },
    }));
    mounted.push(wrapper);
    return {server, form, save, autosave: () => autosave};
}

describe("useOutlineAutosave", () => {
    it("防抖后保存，自己保存的回显不打断后续输入", async () => {
        vi.useFakeTimers();
        const {form, save, autosave} = setup();
        expect(form.value.text).toBe("原文");
        form.value.text = "改一";
        await nextTick();
        expect(autosave().status.value.kind).toBe("dirty");
        await vi.advanceTimersByTimeAsync(1000);
        await flushPromises();
        expect(save).toHaveBeenCalledWith({text: "改一"}, {version: 1, contentHash: "h1"});
        expect(autosave().status.value.kind).toBe("saved");

        form.value.text = "改二";
        await nextTick();
        expect(await autosave().flush()).toBe(true);
        expect(save).toHaveBeenLastCalledWith({text: "改二"}, {version: 2, contentHash: "h2"});
        expect(form.value.text).toBe("改二");
    });

    it("他处修改：本地无改动直接载入，有改动进入冲突且不保存", async () => {
        const {server, form, save, autosave} = setup();
        server.value = {version: 2, contentHash: "h2", text: "Agent 改过"};
        await nextTick();
        expect(form.value.text).toBe("Agent 改过");
        const generation = autosave().generation.value;

        form.value.text = "我的修改";
        await nextTick();
        server.value = {version: 3, contentHash: "h3", text: "又被改了"};
        await nextTick();
        expect(autosave().status.value.kind).toBe("conflict");
        expect(await autosave().flush()).toBe(false);
        expect(save).not.toHaveBeenCalled();

        autosave().reload();
        expect(form.value.text).toBe("又被改了");
        expect(autosave().generation.value).toBeGreaterThan(generation);
    });

    it("校验失败或需要确认时暂停保存，修好后继续", async () => {
        let blocked = true;
        const {form, save, autosave} = setup({blocked: () => blocked});
        form.value.text = "有感叹号!";
        await nextTick();
        expect(await autosave().flush()).toBe(false);
        expect(autosave().status.value).toEqual({kind: "invalid", message: "不能含感叹号"});

        form.value.text = "改好了";
        await nextTick();
        expect(await autosave().flush()).toBe(false);
        expect(autosave().status.value.kind).toBe("blocked");
        blocked = false;
        expect(await autosave().flush()).toBe(true);
        expect(save).toHaveBeenCalledTimes(1);
    });
});
