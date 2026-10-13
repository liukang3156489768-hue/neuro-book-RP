// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {flushPromises, mount, type VueWrapper} from "@vue/test-utils";
import {computed, defineComponent, ref, watch} from "vue";
import YAML from "yaml";
import type {WorkspaceFileNode} from "nbook/app/stores/novel-ide";
import WorkspaceLorebookDetailPanel from "nbook/app/components/novel-ide/workspace/WorkspaceLorebookDetailPanel.vue";

/**
 * 资料库明细面板的保存口径：表单不编辑的来源字段（origin / extraction / ext）必须原样写回。
 * 灵感提取写入的条目靠它们判定覆盖权限与追溯来源，保存一次就丢失会让提取条目被当成用户设计。
 */

const fake = vi.hoisted(() => ({store: null as unknown}));

vi.mock("nbook/app/stores/novel-ide", async () => {
    const {ref} = await import("vue");
    const store = {
        selectedFileContent: ref(""),
        savingFile: ref(false),
        saveCurrentFile: vi.fn(async () => undefined),
    };
    fake.store = store;
    return {useNovelIdeStore: () => store};
});

const SideDetailPanelStub = defineComponent({
    name: "SideDetailPanel",
    props: ["visible", "height"],
    template: "<div><slot name=\"actions\" /><slot /></div>",
});

const node = {
    path: "lorebook/character/林舟/index.md",
    title: "林舟",
    summary: "",
    isDirectory: false,
    editable: true,
    hasIndex: true,
    entryType: "character",
    contentNode: true,
} as WorkspaceFileNode;

const store = () => fake.store as {
    selectedFileContent: {value: string};
    savingFile: {value: boolean};
    saveCurrentFile: ReturnType<typeof vi.fn>;
};

const mounted: VueWrapper[] = [];

function mountPanel(content: string) {
    store().selectedFileContent.value = content;
    const wrapper = mount(WorkspaceLorebookDetailPanel, {
        props: {node, issues: [], height: 400},
        global: {stubs: {SideDetailPanel: SideDetailPanelStub, FormSelect: true, Combobox: true, TagInput: true}},
    });
    mounted.push(wrapper);
    return wrapper;
}

function frontmatterOf(content: string): Record<string, unknown> {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    return YAML.parse(match?.[1] ?? "") as Record<string, unknown>;
}

/** 改标题并失焦，走与用户一致的保存路径。 */
async function editTitle(wrapper: VueWrapper, title: string): Promise<void> {
    const input = wrapper.findAll("input[type=text]").find(candidate => (candidate.element as HTMLInputElement).value === "林舟" && !(candidate.element as HTMLInputElement).disabled);
    expect(input).toBeDefined();
    await input!.setValue(title);
    await input!.trigger("blur");
    await flushPromises();
}

beforeEach(() => {
    // 面板依赖 Nuxt 自动导入（vue 组合式 API 与 useI18n），前端 vitest 配置不带自动导入插件，按全局注入。
    vi.stubGlobal("ref", ref);
    vi.stubGlobal("computed", computed);
    vi.stubGlobal("watch", watch);
    vi.stubGlobal("useI18n", () => ({t: (key: string) => key}));
    store().saveCurrentFile.mockClear();
});

afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount();
    vi.unstubAllGlobals();
});

const EXTRACTED = [
    "---",
    "title: 林舟",
    "type: character",
    "status: active",
    "governance:",
    "  source: generated",
    "  review: reviewed",
    "origin: extract",
    "extraction:",
    "  sourcePath: sources/novel.txt",
    "  sha256: abc123",
    "  citations:",
    "    - P1-P3",
    "ext:",
    "  custom: 1",
    "---",
    "",
    "正文。",
].join("\n");

describe("资料库明细面板保存", () => {
    it("保存时原样保留 origin、extraction 与 ext，只更新被编辑的字段", async () => {
        const wrapper = mountPanel(EXTRACTED);
        await editTitle(wrapper, "林舟（改）");
        expect(store().saveCurrentFile).toHaveBeenCalledTimes(1);
        const saved = store().selectedFileContent.value;
        const frontmatter = frontmatterOf(saved);
        expect(frontmatter.title).toBe("林舟（改）");
        expect(frontmatter.origin).toBe("extract");
        expect(frontmatter.extraction).toEqual({sourcePath: "sources/novel.txt", sha256: "abc123", citations: ["P1-P3"]});
        expect(frontmatter.ext).toEqual({custom: 1});
        expect(saved.endsWith("\n\n正文。")).toBe(true);
    });

    it("原本没有这些字段的条目不会凭空多出来", async () => {
        const wrapper = mountPanel("---\ntitle: 林舟\ntype: character\n---\n\n正文。");
        await editTitle(wrapper, "林舟二");
        const frontmatter = frontmatterOf(store().selectedFileContent.value);
        expect(frontmatter.title).toBe("林舟二");
        expect(Object.keys(frontmatter)).not.toEqual(expect.arrayContaining(["origin"]));
        expect("extraction" in frontmatter).toBe(false);
        expect("ext" in frontmatter).toBe(false);
    });

    it("连续保存两次后来源字段仍在", async () => {
        const wrapper = mountPanel(EXTRACTED);
        await editTitle(wrapper, "林舟甲");
        const input = wrapper.findAll("input[type=text]").find(candidate => (candidate.element as HTMLInputElement).value === "林舟甲");
        await input!.setValue("林舟乙");
        await input!.trigger("blur");
        await flushPromises();
        const frontmatter = frontmatterOf(store().selectedFileContent.value);
        expect(frontmatter.title).toBe("林舟乙");
        expect(frontmatter.origin).toBe("extract");
        expect(frontmatter.extraction).toMatchObject({sha256: "abc123"});
    });
});
