import {beforeEach, describe, expect, it, vi} from "vitest";
import {PromptSnapshotSchema, type PromptSnapshot} from "nbook/shared/dto/prompt-management.dto";
import {ExtractionModelError, ExtractionValidationFailure} from "./errors";
import {callWithRepair} from "./repair";
import {createScriptedModel, validateOk} from "./testing";
import {CHARACTER_OUTPUT_CONTRACT} from "./material-prompts";

const state = vi.hoisted(() => ({snapshots: new Map<string, PromptSnapshot>()}));
vi.mock("nbook/server/prompt-management/service", () => ({usePromptManagement: () => ({
    readSnapshot: async (id: string) => {const snapshot = state.snapshots.get(id); if (!snapshot) throw new Error("快照不存在"); return snapshot;},
})}));
beforeEach(() => state.snapshots.clear());

const prompt = {prefix: "【原文】甲", goal: "提取"};
const signal = () => new AbortController().signal;

describe("callWithRepair", () => {
    it("首次通过时只调用一次，并把 modelKey 与 system 原样交给模型端口", async () => {
        const model = createScriptedModel(() => "OK:好");
        await expect(callWithRepair({model, signal: signal(), prompt, validate: validateOk, system: "系统", modelKey: "p/m"})).resolves.toBe("好");
        expect(model.requests).toHaveLength(1);
        expect(model.requests[0]).toMatchObject({system: "系统", modelKey: "p/m", prompt: `${prompt.prefix}\n\n${prompt.goal}`});
    });

    it("首次未通过校验时，带上次产出与错误重写一次；首次提示词是重试提示词的严格前缀", async () => {
        const model = createScriptedModel((_, index) => index === 0 ? "坏产出" : "OK:修好");
        await expect(callWithRepair({model, signal: signal(), prompt, validate: validateOk})).resolves.toBe("修好");
        const [first, second] = model.requests.map(request => request.prompt);
        expect(second!.startsWith(first!)).toBe(true);
        expect(second).toContain("坏产出");
        expect(second).toContain("产出必须以 OK: 开头");
    });

    it("连续两次未通过校验抛带每次摘要的失败，不再发第三次请求", async () => {
        const model = createScriptedModel((_, index) => `坏${index}`);
        const failure = await callWithRepair({model, signal: signal(), prompt, validate: validateOk}).catch(error => error);
        expect(failure).toBeInstanceOf(ExtractionValidationFailure);
        expect(failure.errors).toHaveLength(2);
        expect(failure.message).toContain("连续 2 次");
        expect(model.requests).toHaveLength(2);
    });

    it("模型端口自身的错误不当作可修复的校验失败", async () => {
        const model = createScriptedModel(() => { throw new Error("超时"); });
        await expect(callWithRepair({model, signal: signal(), prompt, validate: validateOk})).rejects.toThrow("超时");
        expect(model.requests).toHaveLength(1);
    });

    it("长度截断只进行一次压缩重试，并把压缩要求追加到第二次提示词", async () => {
        const model = createScriptedModel((_, index) => {
            if (index === 0) throw new ExtractionModelError("length");
            return "OK:压缩后";
        });
        await expect(callWithRepair({model, signal: signal(), prompt, validate: validateOk})).resolves.toBe("压缩后");
        expect(model.requests).toHaveLength(2);
        expect(model.requests[1]!.prompt).toContain("长度修复");
        expect(model.requests[1]!.prompt).toContain("删除重复描写");
    });

    it("记录稳定前缀哈希，动态任务目标不会改变同一原文前缀", async () => {
        const model = createScriptedModel(() => "OK:好");
        await callWithRepair({model, signal: signal(), prompt: {prefix: "原文", goal: "目标甲"}, system: "系统", metadata: {taskId: "t", unitId: "u1"}, validate: validateOk});
        await callWithRepair({model, signal: signal(), prompt: {prefix: "原文", goal: "目标乙"}, system: "系统", metadata: {taskId: "t", unitId: "u2"}, validate: validateOk});
        expect(model.requests[0]!.metadata?.prefixHash).toBe(model.requests[1]!.metadata?.prefixHash);
        expect(model.requests[0]!.metadata).toMatchObject({taskId: "t", unitId: "u1"});
    });

    it("托管角色预设把原文和字段模板放在动态目标前，已知名单不改变公共前缀哈希", async () => {
        const snapshot = PromptSnapshotSchema.parse({schemaVersion: 1, id: "b".repeat(64), purposes: {
            "extraction.character.focused": {
                presetId: "builtin", presetRevision: 1, messageOrder: "configured",
                entries: [
                    {id: "system", name: "系统", role: "system", content: "固定规则"},
                    {id: "example", name: "示例", role: "assistant", content: "示例输出"},
                    {id: "task", name: "任务", role: "user", content: "处理 {{characterName}}，范围 {{range}}"},
                ],
            },
        }});
        state.snapshots.set(snapshot.id, snapshot);
        const model = createScriptedModel(() => "valid");
        const invoke = (name: string, aliases: string) => callWithRepair({model, signal: signal(), promptSnapshotId: snapshot.id,
            purposeId: "extraction.character.focused", variables: {characterName: name, range: "P1-P2"},
            prompt: {prefix: "原文", supplements: ["角色字段模板", `【已知角色】${aliases}`], goal: "旧目标"},
            metadata: {unitId: name}, validate: output => ({ok: true, value: output})});
        await invoke("甲", "乙");
        await invoke("丙", "丁");
        expect(model.requests[0]!.orderedMessages).toEqual([
            {role: "system", content: "固定规则"},
            {role: "user", content: "原文\n\n角色字段模板"},
            {role: "assistant", content: "示例输出"},
            {role: "user", content: `【已知角色】乙\n\n处理 甲，范围 P1-P2\n\n${CHARACTER_OUTPUT_CONTRACT}`},
        ]);
        expect(model.requests[0]!.metadata?.prefixHash).toBe(model.requests[1]!.metadata?.prefixHash);
    });

    it("每次请求前执行 beforeCall，其失败阻止请求；已取消的信号不发请求", async () => {
        const beforeCall = vi.fn();
        const model = createScriptedModel((_, index) => index === 0 ? "坏" : "OK:好");
        await callWithRepair({model, signal: signal(), prompt, validate: validateOk, beforeCall});
        expect(beforeCall).toHaveBeenCalledTimes(2);

        const blocked = createScriptedModel(() => "OK:好");
        await expect(callWithRepair({model: blocked, signal: signal(), prompt, validate: validateOk, beforeCall: () => { throw new Error("来源变了"); }})).rejects.toThrow("来源变了");
        expect(blocked.requests).toHaveLength(0);

        const controller = new AbortController();
        controller.abort(new Error("取消"));
        await expect(callWithRepair({model: blocked, signal: controller.signal, prompt, validate: validateOk})).rejects.toThrow("取消");
        expect(blocked.requests).toHaveLength(0);
    });

    it("角色截断重试在实际有序消息末尾追加压缩要求，修复重试也保留公共前缀", async () => {
        const model = createScriptedModel((_, index) => {
            if (index === 0) throw new ExtractionModelError("length");
            return "OK:好";
        });
        await callWithRepair({model, signal: signal(), purposeId: "extraction.character.grouped",
            system: "系统", prompt: {prefix: "原文", supplements: ["角色模板"], goal: "提取甲乙"}, validate: validateOk});
        expect(model.requests[0]!.orderedMessages).toEqual([
            {role: "system", content: "系统"}, {role: "user", content: "原文\n\n角色模板"}, {role: "user", content: `提取甲乙\n\n${CHARACTER_OUTPUT_CONTRACT}`},
        ]);
        expect(model.requests[1]!.orderedMessages?.slice(0, 3)).toEqual(model.requests[0]!.orderedMessages);
        expect(model.requests[1]!.orderedMessages?.at(-1)?.content).toContain("长度修复");
        expect(model.requests[1]!.metadata?.prefixHash).toBe(model.requests[0]!.metadata?.prefixHash);

        const repairModel = createScriptedModel((_, index) => index === 0 ? "坏产出" : "OK:修好");
        await callWithRepair({model: repairModel, signal: signal(), purposeId: "extraction.character.focused",
            system: "系统", prompt: {prefix: "原文", supplements: ["角色模板"], goal: "提取甲"}, validate: validateOk});
        expect(repairModel.requests[1]!.orderedMessages?.slice(0, 3)).toEqual(repairModel.requests[0]!.orderedMessages);
        expect(repairModel.requests[1]!.orderedMessages?.some(message => message.content.includes("坏产出"))).toBe(true);
        expect(repairModel.requests[1]!.orderedMessages?.at(-1)?.content).toContain("entity.references");
        expect(repairModel.requests[0]!.metadata?.prefixHash).toBe(model.requests[0]!.metadata?.prefixHash);
    });
});
