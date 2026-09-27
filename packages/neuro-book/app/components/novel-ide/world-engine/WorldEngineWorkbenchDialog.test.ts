// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {flushPromises, shallowMount, type VueWrapper} from "@vue/test-utils";
import {ref} from "vue";
import Workbench from "./WorldEngineWorkbenchDialog.vue";
import Sidebar from "./workbench-preview/WorldEngineWorkbenchPreviewSidebar.vue";

vi.mock("nbook/app/composables/useDialog", () => ({useDialog: () => ({confirm: vi.fn()})}));
vi.mock("nbook/app/composables/useNotification", () => ({useNotification: () => ({success: vi.fn(), error: vi.fn(), warning: vi.fn()})}));
vi.mock("nbook/app/utils/workbench/world-engine-session", () => ({
    useWorldEnginePanelSizes: () => ({
        loading: ref(false), notice: ref(null),
        sizes: ref({sidebarWidth: 320, inspectorWidth: 420, mutationEditorHeight: 292}),
    }),
}));

const mounted: VueWrapper[] = [];
const schema = {subjectTypes: [], calendar: {format: "测试历", examples: []}};
const pendingSchemas: Array<{resolve: (value: typeof schema) => void; reject: (reason: Error) => void}> = [];

beforeEach(() => {
    pendingSchemas.length = 0;
    vi.stubGlobal("useI18n", () => ({t: (key: string) => key}));
    vi.stubGlobal("$fetch", vi.fn((url: string, options: {query: {projectRoot: string}}) => {
        if (url.endsWith("/schema")) return new Promise((resolve, reject) => pendingSchemas.push({resolve, reject}));
        if (url.endsWith("/subjects")) return Promise.resolve([{id: options.query.projectRoot, type: "world", name: options.query.projectRoot}]);
        if (url.endsWith("/overview")) return Promise.resolve({subjects: []});
        return Promise.resolve([]);
    }));
});
afterEach(() => {
    mounted.splice(0).forEach((wrapper) => wrapper.unmount());
    vi.unstubAllGlobals();
});

function mountWorkbench(): VueWrapper {
    const wrapper = shallowMount(Workbench, {
        props: {modelValue: true, projectRoot: "project-old", projectTitle: "测试作品", surface: {kind: "idle"}},
        global: {renderStubDefaultSlot: true},
    });
    mounted.push(wrapper);
    return wrapper;
}

describe("World Engine 读取会话", () => {
    it("首次以打开状态挂载即加载；关闭再打开后忽略旧成功响应", async () => {
        const wrapper = mountWorkbench();
        expect(pendingSchemas).toHaveLength(1);
        await wrapper.setProps({modelValue: false});
        await wrapper.setProps({modelValue: true, projectRoot: "project-new"});
        expect(pendingSchemas).toHaveLength(2);
        pendingSchemas[1]!.resolve(schema);
        await flushPromises();
        expect(wrapper.findComponent(Sidebar).props("subjects")).toEqual([{id: "project-new", type: "world", name: "project-new"}]);
        pendingSchemas[0]!.resolve(schema);
        await flushPromises();
        expect(wrapper.findComponent(Sidebar).props("subjects")).toEqual([{id: "project-new", type: "world", name: "project-new"}]);
    });

    it("旧会话失败不能清空新项目或显示旧错误", async () => {
        const wrapper = mountWorkbench();
        await wrapper.setProps({projectRoot: "project-new"});
        pendingSchemas[1]!.resolve(schema);
        await flushPromises();
        pendingSchemas[0]!.reject(new Error("旧会话网络错误"));
        await flushPromises();
        expect(wrapper.text()).not.toContain("旧会话网络错误");
        expect(wrapper.findComponent(Sidebar).props("subjects")).toHaveLength(1);
    });
});
