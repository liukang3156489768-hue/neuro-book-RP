// @vitest-environment jsdom
import {createApp, defineComponent, h, nextTick, ref, type App} from "vue";
import {afterEach, describe, expect, it, vi} from "vitest";
import PromptManagementSettingsView from "./PromptManagementSettingsView.vue";
import type {PromptCatalogDto, PromptEntry, PromptMutationDto} from "nbook/shared/dto/prompt-management.dto";

const apps: App[] = [];
const entries: PromptEntry[] = [
    {id: "rules", name: "设计规则", role: "system", content: "请说明人物动机。"},
    {id: "task", name: "本次设计", role: "user", content: "{{任务}}"},
];

function initialCatalog(): PromptCatalogDto {
    return {revision: 1, purposes: [{
        purposeId: "inspiration.character", module: "design", label: "角色人设设计", description: "依据选定人设设计角色。",
        variables: ["{{任务}}"], entries: entries.map((entry) => ({...entry})), selectedPresetId: "builtin",
        presets: [{id: "builtin", name: "内置默认", builtin: true, revision: 1, entries: entries.map((entry) => ({...entry}))}],
    }]};
}

function mountView(seed = initialCatalog()) {
    const host = document.createElement("div");
    document.body.append(host);
    const catalog = ref(seed);
    const mutate = vi.fn(async (mutation: PromptMutationDto): Promise<PromptCatalogDto> => {
        if (mutation.action === "save") {
            const next = structuredClone(seed);
            next.revision = catalog.value.revision + 1;
            const purpose = next.purposes[0]!;
            purpose.presets.push({id: "custom", name: mutation.name, builtin: false, revision: 1, entries: mutation.entries.map((entry) => ({...entry}))});
            purpose.selectedPresetId = "custom";
            catalog.value = next;
        } else if (mutation.action === "toggle") {
            const next = JSON.parse(JSON.stringify(catalog.value)) as PromptCatalogDto;
            const preset = next.purposes[0]!.presets.find(item => item.id === mutation.presetId)!;
            preset.entries.find(item => item.id === mutation.entryId)!.enabled = mutation.enabled;
            preset.revision++;
            next.revision++;
            catalog.value = next;
        } else if (mutation.action === "import-tavern") {
            const next = JSON.parse(JSON.stringify(catalog.value)) as PromptCatalogDto;
            const purpose = next.purposes[0]!;
            const prior = purpose.presets.find(preset => preset.id === mutation.presetId);
            const id = prior?.id ?? "imported";
            purpose.presets = purpose.presets.filter(preset => preset.id !== id);
            purpose.presets.push({id, name: mutation.name, builtin: false, revision: (prior?.revision ?? 0) + 1, entries: [], tavern: mutation.tavern});
            purpose.selectedPresetId = id;
            next.revision++;
            catalog.value = next;
        }
        return catalog.value;
    });
    const app = createApp(defineComponent({setup: () => () => h(PromptManagementSettingsView, {catalog: catalog.value, mutate})}));
    apps.push(app);
    app.mount(host);
    const button = (text: string) => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((element) => element.textContent?.trim() === text)!;
    return {host, catalog, mutate, button};
}

afterEach(() => {
    apps.splice(0).forEach((app) => app.unmount());
    document.body.replaceChildren();
});

describe("提示词预设编辑行为", () => {
    it("原生酒馆编辑沿用预设身份保存且不修改受控目录或普通条目", async () => {
        const seed = initialCatalog(), purpose = seed.purposes[0]!;
        purpose.purposeId = "writing.writer.scene"; purpose.module = "writing";
        purpose.presets.push({id: "tavern", name: "原生写手", builtin: false, revision: 1, entries: [], tavern: {macroEngine: "legacy", extensionPolicy: "prompt-only", bindings: {user: "作者", char: "写手", slots: {chatHistory: [{role: "user", content: "{{任务}}"}]}}, sourceJson: JSON.stringify({preserved: true, prompts: [{identifier: "main", name: "规则", role: "system", content: "创作"}, {identifier: "chatHistory", marker: true}], prompt_order: [{character_id: 100001, order: [{identifier: "main", enabled: true}, {identifier: "chatHistory", enabled: true}]}]})}});
        purpose.selectedPresetId = "tavern";
        const {host, catalog, mutate, button} = mountView(seed);
        button("编辑").click(); await nextTick();
        host.querySelector<HTMLButtonElement>('[aria-label="main启用状态"]')!.click(); await nextTick();
        expect(mutate).not.toHaveBeenCalled();
        expect(catalog.value.purposes[0]!.presets.find(preset => preset.id === "tavern")!.tavern!.sourceJson).toContain('"enabled":true');
        button("保存预设").click(); await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
        expect(mutate.mock.calls[0]![0]).toMatchObject({action: "import-tavern", presetId: "tavern", expectedRevision: 1});
        expect(catalog.value.purposes[0]!.presets.filter(preset => preset.id === "tavern")).toHaveLength(1);
        expect(catalog.value.purposes[0]!.presets.find(preset => preset.id === "tavern")!.revision).toBe(2);
        expect(catalog.value.purposes[0]!.presets[0]!.entries).toEqual(entries);
        expect(JSON.parse(catalog.value.purposes[0]!.presets.find(preset => preset.id === "tavern")!.tavern!.sourceJson).preserved).toBe(true);
    });
    it("内置默认可查看复制，所有改写和删除控件受保护", async () => {
        const {host, mutate, button} = mountView();
        expect(host.querySelector<HTMLButtonElement>('button[aria-label="删除角色人设设计预设"]')?.disabled).toBe(true);
        button("查看").click();
        await nextTick();
        expect(host.querySelector<HTMLInputElement>('[data-preset-name]')?.readOnly).toBe(true);
        expect(host.querySelector<HTMLTextAreaElement>("textarea")?.readOnly).toBe(true);
        expect(host.querySelector<HTMLButtonElement>('[aria-label="设计规则角色"]')?.disabled).toBe(true);
        expect(button("新建提示词").disabled).toBe(true);
        expect(button("保存预设").disabled).toBe(true);
        expect(host.querySelector<HTMLButtonElement>('[role="switch"]')?.disabled).toBe(true);
        button("保存预设").click();
        expect(mutate).not.toHaveBeenCalled();
        expect(host.textContent).toContain("内置默认 · 只读");
    });

    it("其他用途的开关仅改草稿，离开丢弃，保存保留停用正文", async () => {
        const {host, mutate, button} = mountView();
        button("新建").click();
        await nextTick();
        const toggle = () => host.querySelector<HTMLButtonElement>('[aria-label="设计规则启用状态"]')!;
        expect(toggle().getAttribute("aria-checked")).toBe("true");
        toggle().click();
        await nextTick();
        expect(toggle().getAttribute("aria-checked")).toBe("false");
        expect(mutate).not.toHaveBeenCalled();
        button("返回提示词列表").click();
        await nextTick();
        button("新建").click();
        await nextTick();
        expect(toggle().getAttribute("aria-checked")).toBe("true");
        toggle().click();
        await nextTick();
        button("保存预设").click();
        await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
        expect(mutate.mock.calls[0]![0]).toMatchObject({action: "save", entries: [{enabled: false, content: entries[0]!.content}, entries[1]]});
    });

    it("写手开关即时保存且不提交正文草稿；随后保存和丢弃采用更新后的基线", async () => {
        const seed = initialCatalog();
        const purpose = seed.purposes[0]!;
        purpose.purposeId = "writing.writer.scene";
        purpose.module = "writing";
        purpose.presets.push({id: "custom", name: "我的写手", builtin: false, revision: 1, entries: entries.map(entry => ({...entry}))});
        purpose.selectedPresetId = "custom";
        const {host, catalog, mutate, button} = mountView(seed);
        button("编辑").click();
        await nextTick();
        const text = host.querySelector<HTMLTextAreaElement>("textarea")!;
        text.value = "未保存的正文";
        text.dispatchEvent(new Event("input", {bubbles: true}));
        await nextTick();
        host.querySelector<HTMLButtonElement>('[aria-label="设计规则启用状态"]')!.click();
        await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
        await nextTick();
        expect(mutate.mock.calls[0]![0]).toEqual({action: "toggle", purposeId: "writing.writer.scene", presetId: "custom", entryId: "rules", enabled: false, expectedRevision: 1});
        expect(catalog.value.purposes[0]!.presets[1]!.entries[0]).toMatchObject({enabled: false, content: entries[0]!.content});
        expect(text.value).toBe("未保存的正文");
        expect(button("保存预设").disabled).toBe(false);
        button("返回提示词列表").click();
        await nextTick();
        button("编辑").click();
        await nextTick();
        expect(host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(entries[0]!.content);
        expect(host.querySelector('[aria-label="设计规则启用状态"]')!.getAttribute("aria-checked")).toBe("false");
        expect(button("保存预设").disabled).toBe(true);
    });

    it("复制后编辑没有隐式写入，离开并重新打开恢复内置正文", async () => {
        const {host, mutate, button} = mountView();
        button("新建").click();
        await nextTick();
        const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
        expect(textarea.readOnly).toBe(false);
        textarea.value = "尚未保存的原创设计规则";
        textarea.dispatchEvent(new Event("input", {bubbles: true}));
        await nextTick();
        expect(mutate).not.toHaveBeenCalled();
        button("返回提示词列表").click();
        await nextTick();
        button("查看").click();
        await nextTick();
        expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("请说明人物动机。");
        expect(mutate).not.toHaveBeenCalled();
    });

    it("保存提交全部正文和排序，并保留编辑开始时的并发版本", async () => {
        const {host, catalog, mutate, button} = mountView();
        button("新建").click();
        await nextTick();
        const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
        textarea.value = "修改后的设计规则";
        textarea.dispatchEvent(new Event("input", {bubbles: true}));
        const handle = host.querySelector<HTMLButtonElement>('[aria-label="拖动设计规则排序"]')!;
        handle.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowDown", bubbles: true}));
        catalog.value = {...catalog.value, revision: 9};
        await nextTick();
        button("保存预设").click();
        await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
        const request = mutate.mock.calls[0]![0];
        expect(request).toMatchObject({action: "save", expectedRevision: 1, name: "我的预设"});
        if (request.action !== "save") throw new Error("应当保存新预设");
        expect(request.presetId).toBeUndefined();
        expect(request.entries.map((entry) => entry.id)).toEqual(["task", "rules"]);
        expect(request.entries[1]?.content).toBe("修改后的设计规则");
        await nextTick();
        expect(button("保存预设").disabled).toBe(true);
        expect(catalog.value.purposes[0]?.presets[0]?.entries).toEqual(entries);
    });
});
