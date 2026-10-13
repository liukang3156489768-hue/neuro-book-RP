import {describe, expect, it, vi} from "vitest";
import {generateMaterialNoteIndex, noteIndexKey} from "./material-note-index";
import type {MaterialDraftItem} from "./material-data";
import type {GenerateRequest} from "./types";

function item(position: number): MaterialDraftItem {
    return {category: "writing-technique", title: `手法${position}`, aliases: [], nodes: [{role: "main", entries: [{block: position + 1, fields: {手法名称: `手法${position}`, 手法说明: `完整说明${position}`, 参考片段: `P${position + 1}`}}], citations: [{firstParagraphId: `P${position + 1}`, lastParagraphId: `P${position + 1}`}]}]};
}

function validOutput(request: GenerateRequest<unknown>) {
    const inputs = JSON.parse(request.prompt.prefix.slice("【待索引条目】\n".length)) as Array<{key: string}>;
    return {entries: inputs.map(input => ({key: input.key, group: "叙事", summary: "制造悬念，适合开篇", keywords: ["悬念"]}))};
}

describe("素材检索索引", () => {
    it("逐批阅读所有完整条目，缓存命中不重复调用，编辑后只重建变更条目的注释", async () => {
        const items = Array.from({length: 55}, (_, position) => item(position));
        const prefixes: string[] = [];
        const called = vi.fn();
        const generate = async <T>(request: GenerateRequest<T>): Promise<T> => {
            called();
            prefixes.push(request.prompt.prefix);
            const result = request.validate(JSON.stringify(validOutput(request)));
            if (!result.ok) throw new Error(result.error);
            return result.value;
        };
        const signal = new AbortController().signal;
        const index = await generateMaterialNoteIndex({category: "writing-technique", items, signal, generate});
        expect(called).toHaveBeenCalledTimes(3);
        expect(index.entries).toHaveLength(55);
        for (let position = 0; position < 55; position++) expect(prefixes.join("\n")).toContain(`完整说明${position}`);
        await generateMaterialNoteIndex({category: "writing-technique", items, cached: index, signal, generate});
        expect(called).toHaveBeenCalledTimes(3);
        const changed = {...items[0]!, title: "新标题"};
        const updated = await generateMaterialNoteIndex({category: "writing-technique", items: [changed, ...items.slice(1)], cached: index, signal, generate});
        expect(called).toHaveBeenCalledTimes(4);
        expect(updated.entries).toHaveLength(55);
        expect(updated.entries[0]!.key).toBe(noteIndexKey(changed));
    });

    it("拒绝遗漏、重复和未知条目，不能用不完整索引报告成功", async () => {
        const items = [item(0), item(1)];
        const generate = async <T>(request: GenerateRequest<T>): Promise<T> => {
            const output = validOutput(request);
            const invalid = [[], [output.entries[0], output.entries[0]], [{...output.entries[0], key: "a".repeat(64)}, output.entries[1]]];
            for (const entries of invalid) expect(request.validate(JSON.stringify({entries}))).toMatchObject({ok: false});
            throw new Error("输出不完整");
        };
        await expect(generateMaterialNoteIndex({category: "writing-technique", items, signal: new AbortController().signal, generate})).rejects.toThrow("输出不完整");
    });

    it("取消后不调用模型", async () => {
        const controller = new AbortController();
        controller.abort();
        const generate = vi.fn();
        await expect(generateMaterialNoteIndex({category: "writing-technique", items: [item(0)], signal: controller.signal, generate})).rejects.toThrow();
        expect(generate).not.toHaveBeenCalled();
    });
});
