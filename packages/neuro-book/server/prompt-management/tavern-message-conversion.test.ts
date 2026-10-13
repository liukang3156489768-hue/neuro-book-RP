import {describe, expect, it} from "vitest";
import type {TavernMessage} from "nbook/shared/dto/tavern-preset.dto";
import {postProcessTavernMessages, squashTavernSystemMessages, type TavernPostProcessing} from "./tavern-message-conversion";

const identity = {user: "作者", char: "写手"};
const messages: TavernMessage[] = [
    {role: "system", content: "总则"}, {role: "system", content: "补充"},
    {role: "assistant", content: "开场"}, {role: "system", content: "中途规则"},
    {role: "system", name: "example_user", content: "示例请求"},
    {role: "system", name: "example_assistant", content: "示例回复"},
    {role: "user", name: "委托助手", content: "任务"}, {role: "user", content: "其他任务"},
];

describe("酒馆文本请求后处理", () => {
    it("none保留role/name/边界；不修改原数组", () => {
        const before = structuredClone(messages);
        expect(postProcessTavernMessages(messages, identity, "none")).toEqual(messages);
        postProcessTavernMessages(messages, identity, "strict");
        expect(messages).toEqual(before);
    });
    it.each(["merge", "merge_tools", "claude"] as const)("%s合并相邻角色、将示例名字写入文本，保留中途system", mode => {
        expect(postProcessTavernMessages(messages, identity, mode)).toEqual([
            {role: "system", content: "总则\n\n补充"}, {role: "assistant", content: "开场"},
            {role: "system", content: "中途规则\n\n作者: 示例请求\n\n写手: 示例回复"},
            {role: "user", content: "委托助手: 任务\n\n其他任务"},
        ]);
    });
    it.each(["semi", "semi_tools"] as const)("%s将中途system转user，不补前置user", mode => {
        expect(postProcessTavernMessages(messages, identity, mode)).toEqual([
            {role: "system", content: "总则\n\n补充"}, {role: "assistant", content: "开场"},
            {role: "user", content: "中途规则\n\n作者: 示例请求\n\n写手: 示例回复\n\n委托助手: 任务\n\n其他任务"},
        ]);
    });
    it.each(["strict", "strict_tools"] as const)("%s在system之后assistant之前补默认user", mode => {
        expect(postProcessTavernMessages(messages, identity, mode)).toEqual([
            {role: "system", content: "总则\n\n补充"}, {role: "user", content: "Let's get started."},
            {role: "assistant", content: "开场"},
            {role: "user", content: "中途规则\n\n作者: 示例请求\n\n写手: 示例回复\n\n委托助手: 任务\n\n其他任务"},
        ]);
    });
    it("single把全部转user并合并，对原user/assistant补宏身份", () => {
        expect(postProcessTavernMessages(messages, identity, "single")).toEqual([{role: "user", content:
            "总则\n\n补充\n\n写手: 开场\n\n中途规则\n\n作者: 示例请求\n\n写手: 示例回复\n\n作者: 委托助手: 任务\n\n作者: 其他任务"}]);
    });
    it("空数组只有none保持为空，任何实际转换均补默认user", () => {
        expect(postProcessTavernMessages([], identity, "none")).toEqual([]);
        for (const mode of ["merge", "merge_tools", "semi", "semi_tools", "strict", "strict_tools", "single", "claude"] as TavernPostProcessing[]) {
            expect(postProcessTavernMessages([], identity, mode)).toEqual([{role: "user", content: "Let's get started."}]);
        }
    });
    it("不重复已有名字前缀，空白保留，空内容不与前一条合并", () => {
        expect(postProcessTavernMessages([
            {role: "user", name: "作者", content: "作者: 请求"}, {role: "user", content: ""},
            {role: "user", content: "  "}, {role: "system", name: "example_assistant", content: "写手: 回复"},
        ], identity, "merge")).toEqual([{role: "user", content: "作者: 请求"}, {role: "user", content: "\n\n  "}, {role: "system", content: "写手: 回复"}]);
    });
});

describe("酒馆system压缩", () => {
    it("单换行压缩相邻普通system，命名示例、聊天边界和非system隔开", () => {
        const entries = [
            {identifier: "a", message: {role: "system" as const, content: "A"}},
            {identifier: "empty", message: {role: "system" as const, content: ""}},
            {identifier: "b", message: {role: "system" as const, content: "B"}},
            {identifier: "newChat", message: {role: "system" as const, content: "边界"}},
            {identifier: "c", message: {role: "system" as const, content: "C"}},
            {identifier: "example", message: {role: "system" as const, name: "example_user", content: "示例"}},
            {identifier: "d", message: {role: "system" as const, content: "D"}},
            {identifier: "task", message: {role: "user" as const, content: ""}},
            {identifier: "e", message: {role: "system" as const, content: "E"}},
        ];
        const before = structuredClone(entries);
        expect(squashTavernSystemMessages(entries)).toEqual([{
            identifier: "a", message: {role: "system", content: "A\nB"}}, ...entries.slice(3)]);
        expect(entries).toEqual(before);
    });
    it.each(["newMainChat", "newChat", "groupNudge"])("%s边界不合并", identifier => {
        const entries = ["a", identifier, "b"].map(id => ({identifier: id, message: {role: "system" as const, content: id}}));
        expect(squashTavernSystemMessages(entries)).toEqual(entries);
    });
});
