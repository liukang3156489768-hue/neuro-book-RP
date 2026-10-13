import {createHash} from "node:crypto";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it} from "vitest";
import {absoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {createRuntimePaths} from "nbook/server/runtime/paths/runtime-paths";
import {PromptSnapshotSchema, type PromptEntry, type PromptPurposeDefinition} from "nbook/shared/dto/prompt-management.dto";
import {renderManagedPrompt, renderPromptText} from "./render";
import {PromptManagementService} from "./service";
import {createMappedTavernImport} from "nbook/shared/prompt-management/tavern-bindings";
import {writerMappingSections} from "nbook/shared/prompt-management/tavern-writer-mapping";

const applicationRoot = absoluteFsPath(fileURLToPath(new URL("../../", import.meta.url)));
const roots: string[] = [];
afterEach(async () => {await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));});
const definition: PromptPurposeDefinition = {purposeId: "writing.test", module: "writing", label: "测试用途", description: "", variables: ["novel"], requiredVariables: ["novel"],
    entries: [{id: "system", name: "系统", role: "system", content: "原始规则 {{novel}}"}]};
async function setup(real = false) {
    const root = await mkdtemp(join(tmpdir(), "prompt-management-")); roots.push(root);
    const paths = createRuntimePaths({applicationRoot, stateRoot: absoluteFsPath(root)});
    return {root, paths, service: new PromptManagementService(paths, real ? undefined : [definition])};
}
const custom = (text: string): PromptEntry[] => [{id: "user", name: "用户示例", role: "user", content: "先读示例"},
    {id: "assistant", name: "回答示例", role: "assistant", content: "已读"},
    {id: "system", name: "系统", role: "system", content: `${text} {{novel}}`}];

describe("全局提示词持久化合同", () => {
    it("条目映射保存重开与快照保持，预览与实际编译都先初始化后映射且不推进持久变量", async () => {
        const {paths, service} = await setup(true);
        const purposeId = "writing.writer.scene";
        const sourceJson = JSON.stringify({prompts: [{identifier: "rule", role: "system", content: "{{getvar::facts}}{{setvar::facts::默认}}{{incvar::counter}}"}],
            prompt_order: [{character_id: 100001, order: [{identifier: "rule", enabled: true}]}]});
        const tavern = {sourceJson, ...createMappedTavernImport(purposeId, sourceJson), macroEngine: "native" as const, extensionPolicy: "prompt-only" as const};
        tavern.bindings.localVariables = {counter: "7"};
        const purpose = (await service.catalog()).purposes.find(value => value.purposeId === purposeId)!;
        const variables = Object.fromEntries(purpose.variables.map(name => [name, `审核-${name}`]));
        const preview = await service.preview({purposeId, tavern, variables});
        expect((await service.catalog()).revision).toBe(0);
        const catalog = await service.mutate({action: "import-tavern", purposeId, expectedRevision: 0, name: "变量映射", tavern});
        const reopened = new PromptManagementService(paths);
        const saved = (await reopened.catalog()).purposes.find(value => value.purposeId === purposeId)!.presets.find(value => value.id === catalog.purposes.find(value => value.purposeId === purposeId)!.selectedPresetId)!;
        expect(saved.tavern).toEqual(tavern);
        const snapshot = await reopened.capture();
        const actual = renderManagedPrompt(snapshot, purposeId, variables);
        expect(actual.orderedMessages).toEqual(preview.messages);
        expect(actual.tavernState).toEqual(preview.variablesAfter);
        expect(actual.tavernState!.local.counter).toBe("8");
        expect(actual.systemPrompt).toContain("审核-sceneDescription");
        expect(actual.systemPrompt).not.toContain("默认");
        expect(await reopened.readSnapshot(snapshot.id)).toEqual(snapshot);
        expect((await service.preview({purposeId, tavern, variables})).variablesAfter.local.counter).toBe("8");
        const direct = structuredClone(tavern);
        const source = JSON.parse(direct.sourceJson);
        const section = writerMappingSections(purposeId).find(section => section.id === "overview")!;
        source.prompts.push({identifier: "direct-overview", role: "user", content: section.content});
        source.prompt_order[0].order.unshift({identifier: "direct-overview", enabled: true});
        direct.sourceJson = JSON.stringify(source);
        direct.writerMappings.overview = {kind: "prompt", name: "direct-overview"};
        const revision2 = await reopened.mutate({action: "import-tavern", purposeId, expectedRevision: catalog.revision, presetId: saved.id, name: "混合方式", tavern: direct});
        const snapshot2 = await reopened.capture();
        const preview2 = await reopened.preview({purposeId, tavern: direct, variables});
        expect(renderManagedPrompt(snapshot2, purposeId, variables).orderedMessages).toEqual(preview2.messages);
        expect(preview2.messages[0]).toEqual({role: "user", content: "## 章节总览\n\n审核-overview"});
        expect(revision2.purposes.find(value => value.purposeId === purposeId)!.presets.find(value => value.id === saved.id)!.revision).toBe(2);
        expect((await reopened.readSnapshot(snapshot.id)).purposes[purposeId]!.tavern).toEqual(tavern);
    });
    it("配置中心的预算预览裁剪旧历史，保存后仍保留预算且必需作品资料不被裁掉", async () => {
        const {paths} = await setup();
        const writer = {...definition, purposeId: "writing.writer.scene"};
        const service = new PromptManagementService(paths, [writer]);
        const tavern = {sourceJson: JSON.stringify({openai_max_tokens: 10, new_chat_prompt: "", prompts: [
            {identifier: "charDescription", marker: true}, {identifier: "chatHistory", marker: true}],
            prompt_order: [{character_id: 100001, order: ["charDescription", "chatHistory"].map(identifier => ({identifier, enabled: true}))}]}),
        macroEngine: "legacy" as const, extensionPolicy: "prompt-only" as const, bindings: {user: "作者", char: "写手",
            contextBudget: {tokenizer: "cl100k_base" as const, contextTokens: 60}, slots: {
                charDescription: [{role: "system" as const, content: "{{novel}}"}],
                chatHistory: [{role: "assistant" as const, content: "old ".repeat(200)}, {role: "user" as const, content: "recent task"}],
            }}};
        const preview = await service.preview({purposeId: writer.purposeId as "writing.writer.scene", tavern, variables: {novel: "审核资料"}});
        expect(preview.messages).toEqual([{role: "system", content: "审核资料"}, {role: "user", content: "recent task"}]);
        expect(preview.budgetReport).toMatchObject({contextTokens: 60, responseTokens: 10, droppedHistory: 1});
        expect((await service.catalog()).revision).toBe(0);
        const saved = await service.mutate({action: "import-tavern", purposeId: writer.purposeId, expectedRevision: 0, name: "预算预设", tavern});
        expect(saved.purposes[0]!.presets.find(preset => !preset.builtin)!.tavern!.bindings.contextBudget).toEqual(tavern.bindings.contextBudget);
        await expect(service.preview({purposeId: "writing.writer.scene", tavern, variables: {novel: "mandatory ".repeat(200)}})).rejects.toMatchObject({statusCode: 400});
        const historyFacts = structuredClone(tavern);
        historyFacts.bindings.slots.charDescription = [];
        historyFacts.bindings.slots.chatHistory[0]!.content = "{{novel}}";
        await expect(service.preview({purposeId: "writing.writer.scene", tavern: historyFacts, variables: {novel: "reviewed ".repeat(200)}})).rejects.toMatchObject({statusCode: 400, message: expect.stringContaining("必需作品资料")});
        // Dropping a redundant copy must not invalidate facts retained in another active slot.
        const duplicateFacts = structuredClone(tavern);
        duplicateFacts.bindings.slots.chatHistory[0]!.content = "{{novel}} " + "old ".repeat(200);
        await expect(service.preview({purposeId: "writing.writer.scene", tavern: duplicateFacts, variables: {novel: "审核资料"}}))
            .resolves.toMatchObject({budgetReport: {droppedHistory: 1}});
    });
    it("本次generation不生效的资料槽位不能提供必需变量", async () => {
        const {paths} = await setup();
        const writer = {...definition, purposeId: "writing.writer.scene"};
        const service = new PromptManagementService(paths, [writer]);
        const sourceJson = JSON.stringify({prompts: [{identifier: "rule", role: "system", content: "正文"},
            {identifier: "scenario", marker: true, injection_trigger: ["continue"]}],
            prompt_order: [{character_id: 100001, order: ["rule", "scenario"].map(identifier => ({identifier, enabled: true}))}]});
        await expect(service.mutate({action: "import-tavern", purposeId: writer.purposeId, expectedRevision: 0, name: "缺本次资料",
            tavern: {sourceJson, macroEngine: "legacy", extensionPolicy: "prompt-only", bindings: {user: "作者", char: "写手",
                slots: {scenario: [{role: "system", content: "{{novel}}"}]}, generationType: "normal"}}})).rejects.toMatchObject({statusCode: 400});
        expect((await service.catalog()).revision).toBe(0);
    });
    it("原生酒馆预设仅导入写手，绑定保留必需资料，原文件与版本被冻结", async () => {
        const {paths} = await setup();
        const writer = {...definition, purposeId: "writing.writer.scene"};
        const service = new PromptManagementService(paths, [writer, definition]);
        const raw = JSON.stringify({prompts: [{identifier: "init", role: "system", content: "{{setvar::mode::scene}}"},
            {identifier: "rule", role: "assistant", content: "{{user}}/{{getvar::mode}}"}, {identifier: "chatHistory", marker: true}],
            prompt_order: [{character_id: 100001, order: ["init", "rule", "chatHistory"].map(identifier => ({identifier, enabled: true}))}], new_chat_prompt: ""});
        const tavern = {sourceJson: raw, macroEngine: "legacy" as const, extensionPolicy: "prompt-only" as const,
            bindings: {user: "小说用户角色", char: "写手", slots: {chatHistory: [{role: "user" as const, content: "{{novel}}"}]}}};
        await expect(service.mutate({action: "import-tavern", purposeId: definition.purposeId, expectedRevision: 0, name: "错用途", tavern})).rejects.toMatchObject({statusCode: 400});
        await expect(service.mutate({action: "import-tavern", purposeId: writer.purposeId, expectedRevision: 0, name: "缺资料",
            tavern: {...tavern, bindings: {...tavern.bindings, slots: {chatHistory: []}}}})).rejects.toMatchObject({statusCode: 400});
        const catalog = await service.mutate({action: "import-tavern", purposeId: writer.purposeId, expectedRevision: 0, name: "原生预设", tavern});
        const snapshot = await service.capture();
        const rendered = renderManagedPrompt(snapshot, writer.purposeId, {novel: "助手交付的任务"});
        expect(rendered.orderedMessages).toEqual([{role: "assistant", content: "小说用户角色/scene"}, {role: "user", content: "助手交付的任务"}]);
        expect(rendered.tavernState).toEqual({local: {mode: "scene"}, global: {}});
        expect(snapshot.purposes[writer.purposeId]!.tavern!.sourceJson).toBe(raw);
        expect(await new PromptManagementService(paths, [writer, definition]).readSnapshot(snapshot.id)).toEqual(snapshot);
        const presetId = catalog.purposes[0]!.selectedPresetId;
        await expect(service.mutate({action: "save", purposeId: writer.purposeId, expectedRevision: catalog.revision, presetId, name: "覆盖", entries: custom("覆盖")})).rejects.toMatchObject({statusCode: 400});
        await service.mutate({action: "delete", purposeId: writer.purposeId, expectedRevision: catalog.revision, presetId});
        expect(await service.readSnapshot(snapshot.id)).toEqual(snapshot);
    });
    it("写手停用必需变量对应的条目时保存被拒绝，停用「禁用写法」这类可选条目允许保存", async () => {
        const {service} = await setup(true);
        const catalog = await service.catalog();
        const purpose = catalog.purposes.find((item) => item.purposeId === "writing.writer.scene")!;
        const disable = (id: string) => purpose.entries.map((entry) => entry.id === id ? {...entry, enabled: false} : entry);
        await expect(service.mutate({action: "save", purposeId: purpose.purposeId, expectedRevision: catalog.revision, name: "缺场景地点",
            entries: disable("location")})).rejects.toMatchObject({statusCode: 400});
        const saved = await service.mutate({action: "save", purposeId: purpose.purposeId, expectedRevision: catalog.revision, name: "关闭禁用写法",
            entries: disable("style-forbidden")});
        const savedPurpose = saved.purposes.find((item) => item.purposeId === purpose.purposeId)!;
        expect(savedPurpose.presets.find((preset) => preset.id === savedPurpose.selectedPresetId)!.entries
            .find((entry) => entry.id === "style-forbidden")).toMatchObject({enabled: false});
    });
    it("旧快照缺少开关仍启用且原哈希不变", () => {
        const purposes = {[definition.purposeId]: {presetId: "builtin", presetRevision: 1, entries: definition.entries}};
        const id = createHash("sha256").update(JSON.stringify({schemaVersion: 1, purposes})).digest("hex");
        const parsed = PromptSnapshotSchema.parse({schemaVersion: 1, id, purposes});
        expect(createHash("sha256").update(JSON.stringify({schemaVersion: 1, purposes: parsed.purposes})).digest("hex")).toBe(id);
        expect(renderManagedPrompt(parsed, definition.purposeId, {novel: "作品"}).systemPrompt).toBe("原始规则 作品");
    });
    it("停用各角色条目不展开变量、不发送内容，恢复和旧绑定保留各自状态", async () => {
        const {service, paths} = await setup();
        const initial = custom("规则");
        initial.push(...["system", "user", "assistant"].map((role, index) => ({id: `off-${index}`, name: "备用", role: role as PromptEntry["role"], content: "备用 {{novel}}", enabled: false})));
        let catalog = await service.mutate({action: "save", purposeId: definition.purposeId, expectedRevision: 0, name: "开关测试", entries: initial});
        const frozen = await service.bind("before-toggle");
        expect(renderManagedPrompt(frozen, definition.purposeId, {novel: "作品"}).messages).toHaveLength(2);
        const isolated = structuredClone(frozen);
        isolated.purposes[definition.purposeId]!.entries = initial.filter(entry => entry.enabled === false);
        expect(renderManagedPrompt(isolated, definition.purposeId, {})).toEqual({systemPrompt: "", messages: [], orderedMessages: []});
        catalog = await service.mutate({action: "save", purposeId: definition.purposeId, presetId: catalog.purposes[0]!.selectedPresetId,
            expectedRevision: catalog.revision, name: "开关测试", entries: initial.map(entry => entry.id === "user" ? {...entry, enabled: false} : entry)});
        const restored = new PromptManagementService(paths, [definition]);
        expect(await restored.catalog()).toEqual(catalog);
        expect(renderManagedPrompt(await restored.capture(), definition.purposeId, {novel: "作品"}).messages).toEqual([{role: "assistant", content: "已读"}]);
        expect(renderManagedPrompt((await restored.bound("before-toggle"))!, definition.purposeId, {novel: "作品"}).messages).toHaveLength(2);
        await expect(service.mutate({action: "save", purposeId: definition.purposeId, expectedRevision: catalog.revision, name: "无任务",
            entries: initial.map(entry => ({...entry, enabled: false}))})).rejects.toMatchObject({statusCode: 400});
    });
    it("写手即时开关仅更新已保存条目，保护内置、必需变量和并发版本", async () => {
        const {paths} = await setup();
        const writerDefinition = {...definition, purposeId: "writing.writer.scene"};
        const service = new PromptManagementService(paths, [writerDefinition]);
        let catalog = await service.mutate({action: "save", purposeId: writerDefinition.purposeId, expectedRevision: 0, name: "写手", entries: custom("已保存正文")});
        const request = {action: "toggle" as const, purposeId: writerDefinition.purposeId, expectedRevision: catalog.revision,
            presetId: catalog.purposes[0]!.selectedPresetId, entryId: "user", enabled: false};
        catalog = await service.mutate(request);
        const preset = catalog.purposes[0]!.presets[1]!;
        expect(preset.entries[0]).toMatchObject({content: "先读示例", enabled: false});
        expect(preset.entries[2]!.content).toBe("已保存正文 {{novel}}");
        expect(preset.revision).toBe(2);
        await expect(service.mutate(request)).rejects.toMatchObject({statusCode: 409});
        await expect(service.mutate({...request, expectedRevision: catalog.revision, presetId: "builtin"})).rejects.toMatchObject({statusCode: 403});
        await expect(service.mutate({...request, expectedRevision: catalog.revision, entryId: "system"})).rejects.toMatchObject({statusCode: 400});
        await expect(service.mutate({...request, expectedRevision: catalog.revision, entryId: "unsaved"})).rejects.toMatchObject({statusCode: 404});
        expect((await service.catalog()).revision).toBe(catalog.revision);
    });
    it("所有正式用途可从应用默认资产登记，默认模板变量均可渲染", async () => {
        const {service} = await setup(true);
        const catalog = await service.catalog();
        expect(catalog.purposes).toHaveLength(60);
        expect(new Set(catalog.purposes.map(p => p.module))).toEqual(new Set(["design", "outline", "writing"]));
        const snapshot = await service.capture();
        for (const purpose of catalog.purposes) {
            expect(purpose.presets[0]).toMatchObject({id: "builtin", builtin: true});
            expect(() => renderManagedPrompt(snapshot, purpose.purposeId, Object.fromEntries(purpose.variables.map(key => [key, "动态资料"])))).not.toThrow();
        }
    });
    it("内置拒绝保存、改名和删除，拒绝过期覆盖，失败后默认保持原样", async () => {
        const {service, root} = await setup();
        for (const input of [
            {action: "save" as const, purposeId: definition.purposeId, expectedRevision: 0, presetId: "builtin", name: "篡改", entries: custom("修改")},
            {action: "delete" as const, purposeId: definition.purposeId, expectedRevision: 0, presetId: "builtin"},
        ]) await expect(service.mutate(input)).rejects.toMatchObject({statusCode: 403});
        expect((await service.catalog()).purposes[0]!.presets[0]!.entries).toEqual(definition.entries);
        await expect(readFile(join(root, "prompt-management", "presets.json"))).rejects.toMatchObject({code: "ENOENT"});
        await service.mutate({action: "save", purposeId: definition.purposeId, expectedRevision: 0, name: "副本", entries: custom("新规则")});
        await expect(service.mutate({action: "save", purposeId: definition.purposeId, expectedRevision: 0, name: "过期", entries: custom("旧草稿")})).rejects.toMatchObject({statusCode: 409});
    });
    it("复制自定义后真实落盘，旧绑定冻结，新绑定采用最新选择，删除不损坏历史", async () => {
        const {service, paths} = await setup();
        const before = await service.bind("old-chat");
        const saved = await service.mutate({action: "save", purposeId: definition.purposeId, expectedRevision: 0, name: "副本", entries: custom("新规则")});
        const presetId = saved.purposes[0]!.selectedPresetId;
        const after = await service.bind("new-chat");
        expect(after.id).not.toBe(before.id);
        expect(await new PromptManagementService(paths, [definition]).catalog()).toEqual(saved);
        expect((await service.bind("old-chat")).id).toBe(before.id);
        expect((await service.bind("new-expert", {inheritSnapshotId: before.id})).id).toBe(before.id);
        expect(renderManagedPrompt(after, definition.purposeId, {novel: "作品"})).toEqual({systemPrompt: "新规则 作品", messages: [{role: "user", content: "先读示例"}, {role: "assistant", content: "已读"}],
            orderedMessages: [{role: "user", content: "先读示例"}, {role: "assistant", content: "已读"}, {role: "system", content: "新规则 作品"}]});
        const deleted = await service.mutate({action: "delete", purposeId: definition.purposeId, expectedRevision: saved.revision, presetId});
        expect(deleted.purposes[0]!.selectedPresetId).toBe("builtin");
        expect((await new PromptManagementService(paths, [definition]).bound("new-chat"))!.id).toBe(after.id);
    });
    it("缺失或损坏快照报错，不偷偷使用当前方案", async () => {
        const {service, root} = await setup();
        const snapshot = await service.capture();
        const path = join(root, "prompt-management", "snapshots", `${snapshot.id}.json`);
        snapshot.purposes[definition.purposeId]!.entries[0]!.content = "被修改";
        await writeFile(path, JSON.stringify(snapshot));
        await expect(service.readSnapshot(snapshot.id)).rejects.toThrow("校验失败");
        await expect(service.capture()).rejects.toThrow("校验失败");
        await rm(path);
        await expect(service.readSnapshot(snapshot.id)).rejects.toThrow("未切换为当前配置");
    });
    it("并发保存只能成功一个；模板校验拒绝未知、缺失变量和重复条目", async () => {
        const {service} = await setup();
        for (const entries of [[{...definition.entries[0]!, content: "{{unknown}}"}], [{...definition.entries[0]!, content: "无作品参数"}], [definition.entries[0]!, definition.entries[0]!]]) {
            await expect(service.mutate({action: "save", purposeId: definition.purposeId, expectedRevision: 0, name: "无效", entries})).rejects.toMatchObject({statusCode: 400});
        }
        const results = await Promise.allSettled(["一", "二"].map(name => service.mutate({action: "save", purposeId: definition.purposeId, expectedRevision: 0, name, entries: custom(name)})));
        expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
        expect((await service.catalog()).revision).toBe(1);
        expect(renderPromptText("{{novel}}", {novel: "正文包含 {{unknown}}"})).toBe("正文包含 {{unknown}}");
    });
});
