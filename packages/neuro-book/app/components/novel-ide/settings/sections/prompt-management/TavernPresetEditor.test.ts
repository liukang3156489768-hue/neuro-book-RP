// @vitest-environment jsdom
import {createApp, defineComponent, h, nextTick, ref, type App} from "vue";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {TavernWriterPreset, TavernPreviewResult} from "nbook/shared/dto/tavern-preset.dto";
import TavernPresetEditor from "./TavernPresetEditor.vue";
import {parseEditableTavernSource, tavernEditorOrder} from "./tavern-editor";

const apps: App[] = [];
function preset(): TavernWriterPreset {
    return {macroEngine: "legacy", extensionPolicy: "prompt-only", bindings: {user: "作者", char: "写手", slots: {chatHistory: [{role: "user", content: "{{requirements}}"}]}, localVariables: {custom: "保留"}},
        sourceJson: JSON.stringify({customExtension: {preserve: true}, prompts: [{identifier: "rules", name: "规则", role: "system", content: "{{setvar::style::简洁}}", unknown: "原样"}, {identifier: "chatHistory", name: "任务", marker: true}], prompt_order: [{character_id: 100001, custom: 7, order: [{identifier: "rules", enabled: true, custom: 9}, {identifier: "chatHistory", enabled: true}]}]})};
}
function mountEditor(preview?: (request: unknown) => Promise<TavernPreviewResult>) {
    const host = document.createElement("div"); document.body.append(host);
    const model = ref(preset());
    const app = createApp(defineComponent({setup: () => () => h(TavernPresetEditor, {modelValue: model.value, purposeId: "writing.writer.scene", name: "预设", preview, "onUpdate:modelValue": value => {model.value = value;}})}));
    apps.push(app); app.mount(host);
    const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent?.trim() === text)!;
    const input = (label: string, value: string) => {const field = host.querySelector<HTMLTextAreaElement>(`[aria-label="${label}"]`)!; field.value = value; field.dispatchEvent(new Event("input", {bubbles: true}));};
    return {host, model, button, input};
}
afterEach(() => {apps.splice(0).forEach(app => app.unmount()); document.body.replaceChildren();});

describe("酒馆受控编辑", () => {
    it("写作条目切换直接排序加入序列，切回映射不重复，单条删除清除直接引用", async () => {
        const {host, model, button} = mountEditor();
        button("启用写作条目映射").click(); await nextTick();
        const click = async (label: string) => {host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click(); await nextTick();};
        await click("章节总览直接排序");
        const target = model.value.writerMappings!.overview!;
        expect(target.kind).toBe("prompt");
        expect(parseEditableTavernSource(model.value.sourceJson).prompts.find(prompt => prompt.identifier === target.name)?.content).toContain("{{overview}}");
        expect(host.querySelector('[aria-label="章节总览映射目标"]')).toBeNull();
        await click("章节总览直接排序");
        expect(parseEditableTavernSource(model.value.sourceJson).prompts.filter(prompt => prompt.identifier === target.name)).toHaveLength(1);
        await click("章节总览变量映射");
        expect(model.value.writerMappings!.overview).toEqual({kind: "slot", name: "chatHistory"});
        expect(parseEditableTavernSource(model.value.sourceJson).prompts.some(prompt => prompt.identifier === target.name)).toBe(false);
        await click("章节总览直接排序");
        await click("删除" + model.value.writerMappings!.overview!.name);
        expect(model.value.writerMappings!.overview).toBeNull();
    });
    it("多选删除涵盖未加入序列条目和所有角色顺序，资料绑定清理且保留未应用JSON", async () => {
        const {host, model, button, input} = mountEditor();
        const source = parseEditableTavernSource(model.value.sourceJson);
        source.prompts.push({identifier: "unlisted", name: "未排序", role: "system", content: "保留数据"});
        source.prompt_order.push({character_id: 42, order: [{identifier: "chatHistory", enabled: true}]});
        model.value = {...model.value, sourceJson: JSON.stringify(source)}; await nextTick();
        input("酒馆身份资料与变量绑定 JSON", '{"待应用":true}'); await nextTick();
        const checkbox = (text: string) => [...host.querySelectorAll<HTMLLabelElement>("label")].find(label => label.textContent?.trim() === text)!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
        checkbox("选择任务").click(); checkbox("选择未排序").click(); await nextTick();
        expect(host.textContent).toContain("已选择 2 条");
        button("删除所选条目").click(); await nextTick();
        const remaining = parseEditableTavernSource(model.value.sourceJson);
        expect(remaining.prompts.map(prompt => prompt.identifier)).toEqual(["rules"]);
        expect(remaining.prompt_order[1]!.order).toEqual([]);
        expect(model.value.bindings.slots.chatHistory).toBeUndefined();
        expect(model.value.bindings.localVariables).toEqual({custom: "保留"});
        expect(host.querySelector<HTMLTextAreaElement>('[aria-label="酒馆身份资料与变量绑定 JSON"]')!.value).toBe('{"待应用":true}');
        checkbox("全选条目").click(); await nextTick();
        button("删除所选条目").click(); await nextTick();
        expect(parseEditableTavernSource(model.value.sourceJson).prompts).toEqual([]);
        expect(host.textContent).toContain("已选择 0 条");
    });
    it("旧配置显式启用分组映射，排除职责输出，源目标变化保留原选择和未应用绑定草稿", async () => {
        const {host, model, button, input} = mountEditor();
        expect(model.value.writerMappings).toBeUndefined();
        input("酒馆身份资料与变量绑定 JSON", '{"待应用":true}'); await nextTick();
        button("启用写作条目映射").click(); await nextTick();
        expect(model.value.writerMappings!.overview).toEqual({kind: "slot", name: "chatHistory"});
        expect(model.value.writerMappings!.role).toBeUndefined();
        expect(model.value.writerMappings!.output).toBeUndefined();
        expect(host.querySelectorAll('[aria-label$="映射目标"]')).toHaveLength(23);
        expect(host.querySelector('[aria-label="文风要求映射目标"]')).not.toBeNull();
        expect(host.querySelector('[aria-label="写作条目映射"]')?.textContent).toContain("章节与上下文");
        expect(host.querySelector<HTMLTextAreaElement>('[aria-label="酒馆身份资料与变量绑定 JSON"]')!.value).toBe('{"待应用":true}');
        const next = parseEditableTavernSource(model.value.sourceJson);
        next.prompts = next.prompts.filter(prompt => !prompt.marker);
        next.prompt_order[0]!.order = next.prompt_order[0]!.order.filter(order => order.identifier !== "chatHistory");
        model.value = {...model.value, sourceJson: JSON.stringify(next)}; await nextTick();
        expect(host.querySelector('[aria-label="章节总览映射目标"]')?.textContent).toContain("目标已缺失");
        expect(model.value.writerMappings!.overview).toEqual({kind: "slot", name: "chatHistory"});
    });
    it("预算必须显式填写应用，关闭移除设置且保留资料与变量", async () => {
        const {host, model, button} = mountEditor();
        host.querySelector<HTMLButtonElement>('[aria-label="酒馆上下文预算"]')!.click(); await nextTick();
        expect(model.value.bindings.contextBudget).toBeUndefined();
        button("应用上下文预算").click(); await nextTick();
        expect(model.value.bindings.contextBudget).toBeUndefined();
        expect(host.querySelector('[role="alert"]')?.textContent).toContain("请填写");
        const tokens = host.querySelector<HTMLInputElement>('[aria-label="酒馆上下文总预算"]')!;
        tokens.value = "32000"; tokens.dispatchEvent(new Event("input", {bubbles: true})); await nextTick();
        button("应用上下文预算").click(); await nextTick();
        expect(model.value.bindings.contextBudget).toEqual({tokenizer: "claude", contextTokens: 32000, pinExamples: false});
        host.querySelector<HTMLButtonElement>('[aria-label="酒馆上下文预算"]')!.click(); await nextTick();
        expect(model.value.bindings.contextBudget).toBeUndefined();
        expect(model.value.bindings.slots.chatHistory).toEqual([{role: "user", content: "{{requirements}}"}]);
        expect(model.value.bindings.localVariables).toEqual({custom: "保留"});
    });
    it("兼容报告把提示词编译与未执行插件依赖分别展示", async () => {
        const preview = vi.fn(async (): Promise<TavernPreviewResult> => ({report: {sourceSha256: "test", upstreamRevision: "test", prompts: 2, active: 2, regexes: 0, unsupported: [], extensionDependencies: ["第三方质检脚本"], promptSupported: true, fullEnvironmentEquivalent: false}, messages: [{role: "user", content: "正文任务"}], promptMessages: [{role: "user", content: "正文任务"}], messageIdentifiers: ["chatHistory"], variablesBefore: {local: {}, global: {}}, variablesAfter: {local: {}, global: {}}, generation: {}}));
        const {host, button} = mountEditor(preview);
        button("预览最终请求结构").click();
        await vi.waitFor(() => expect(host.querySelector('[aria-label="酒馆兼容报告"]')).not.toBeNull());
        expect(host.querySelector('[aria-label="酒馆兼容报告"]')?.textContent).toContain("原生提示词可编译");
        expect(host.querySelector('[aria-label="酒馆兼容报告"]')?.textContent).toContain("已保留的插件依赖（未执行）：第三方质检脚本");
    });
    it("原生深度和触发编排编辑保留未知字段，错误整数不污染草稿", async () => {
        const {host, model, button} = mountEditor();
        const source = parseEditableTavernSource(model.value.sourceJson);
        source.prompts[0]!.injection_position = 1;
        source.prompts[0]!.injection_depth = 2;
        source.prompts[0]!.injection_order = 100;
        model.value = {...model.value, sourceJson: JSON.stringify(source)}; await nextTick();
        button("1. 规则").click(); await nextTick();
        const edit = async (label: string, value: string) => {const field = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!; field.value = value; field.dispatchEvent(new Event("input", {bubbles: true})); await nextTick();};
        await edit("rules插入深度", "4"); await edit("rules插入顺序", "60");
        await edit("rules生成类型触发条件", "normal, continue, normal");
        expect(parseEditableTavernSource(model.value.sourceJson).prompts[0]).toMatchObject({injection_depth: 4, injection_order: 60, injection_trigger: ["normal", "continue"], unknown: "原样"});
        await edit("rules插入深度", "-1");
        expect(parseEditableTavernSource(model.value.sourceJson).prompts[0]!.injection_depth).toBe(4);
        expect(host.querySelector('[role="alert"]')?.textContent).toContain("非负整数");
        await edit("rules插入深度", "");
        expect(parseEditableTavernSource(model.value.sourceJson).prompts[0]!.injection_depth).toBeUndefined();
        expect(host.textContent).toContain("不会执行插件");
    });
    it("首次启用资料槽位只新增空绑定，保留原槽位和变量初值", async () => {
        const {host, model} = mountEditor();
        const source = parseEditableTavernSource(model.value.sourceJson);
        source.prompts.push({identifier: "charDescription", marker: true});
        tavernEditorOrder(source).push({identifier: "charDescription", enabled: false});
        model.value = {...model.value, sourceJson: JSON.stringify(source)}; await nextTick();
        host.querySelector<HTMLButtonElement>('[aria-label="charDescription启用状态"]')!.click(); await nextTick();
        expect(model.value.bindings.slots.charDescription).toEqual([]);
        expect(model.value.bindings.slots.chatHistory).toEqual([{role: "user", content: "{{requirements}}"}]);
        expect(model.value.bindings.localVariables).toEqual({custom: "保留"});
    });
    it("启停与排序保留未知字段、禁用正文和变量初值", async () => {
        const {host, model} = mountEditor();
        host.querySelector<HTMLButtonElement>('[aria-label="rules启用状态"]')!.click(); await nextTick();
        host.querySelector<HTMLButtonElement>('[aria-label="下移rules"]')!.click(); await nextTick();
        const source = parseEditableTavernSource(model.value.sourceJson);
        expect(tavernEditorOrder(source)).toEqual([{identifier: "chatHistory", enabled: true}, {identifier: "rules", enabled: false, custom: 9}]);
        expect(source.customExtension).toEqual({preserve: true});
        expect(source.prompts[0]).toMatchObject({unknown: "原样", content: "{{setvar::style::简洁}}"});
        expect(source.prompt_order[0]!.custom).toBe(7);
        expect(model.value.bindings.localVariables).toEqual({custom: "保留"});
    });
    it("JSON解析失败保留既有草稿；参数覆盖严格校验；无关编辑保留待应用的绑定", async () => {
        const {host, model, button, input} = mountEditor();
        const before = model.value.sourceJson;
        input("酒馆原生 JSON", "{破损"); await nextTick(); button("应用 JSON").click(); await nextTick();
        expect(model.value.sourceJson).toBe(before); expect(host.querySelector('[role="alert"]')).not.toBeNull();
        input("酒馆身份资料与变量绑定 JSON", '{"待应用":true}'); await nextTick();
        host.querySelector<HTMLButtonElement>('[aria-label="rules启用状态"]')!.click(); await nextTick();
        expect(host.querySelector<HTMLTextAreaElement>('[aria-label="酒馆身份资料与变量绑定 JSON"]')!.value).toBe('{"待应用":true}');
        input("酒馆生成参数覆盖 JSON", '{"reasoningEffort":"none","temperature":0.8}'); await nextTick(); button("应用参数覆盖").click(); await nextTick();
        expect(model.value.generationOverride).toEqual({reasoningEffort: "none", temperature: 0.8});
        input("酒馆生成参数覆盖 JSON", '{"typo":true}'); await nextTick(); button("应用参数覆盖").click(); await nextTick();
        expect(model.value.generationOverride).toEqual({reasoningEffort: "none", temperature: 0.8});
    });
    it("预览不修改草稿，草稿变化使正在返回的旧预览失效", async () => {
        let complete!: (value: TavernPreviewResult) => void;
        const preview = vi.fn(() => new Promise<TavernPreviewResult>(resolve => {complete = resolve;}));
        const {host, model, button} = mountEditor(preview);
        const before = JSON.stringify(model.value);
        button("预览最终请求结构").click(); await nextTick(); expect(preview).toHaveBeenCalledTimes(1); expect(JSON.stringify(model.value)).toBe(before);
        host.querySelector<HTMLButtonElement>('[aria-label="rules启用状态"]')!.click(); await nextTick();
        complete({report: {sourceSha256: "stale", upstreamRevision: "test", prompts: 2, active: 2, regexes: 0, unsupported: [], extensionDependencies: [], promptSupported: true, fullEnvironmentEquivalent: false}, messages: [], promptMessages: [], messageIdentifiers: [], variablesBefore: {local: {}, global: {}}, variablesAfter: {local: {}, global: {}}, generation: {}});
        await nextTick(); await nextTick(); expect(host.querySelector('[aria-label="编译预览结果"]')).toBeNull();
    });
});
