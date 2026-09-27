import {describe, expect, it} from "vitest";
import type {OutlineWorkbenchGraph, OutlineWorkbenchLine} from "nbook/app/composables/useOutlineWorkbenchData";
import {cellToPosition, columnCount, connectionProblem, lineColors, lockedGraphParts, pointToCell, positionToCell, resolveLineChain}
    from "./outline-line-graph";

const graph: OutlineWorkbenchGraph = {id: "gr-1", planId: "plan-1", version: 3,
    nodes: [{id: "nd-a", entryId: "ol-a", column: 0, row: 0}, {id: "nd-b", entryId: "ol-b", column: 2, row: 0},
        {id: "nd-c", entryId: null, column: 2, row: 1}, {id: "nd-d", entryId: "ol-d", column: 4, row: 0}],
    edges: [{id: "eg-ab", from: "nd-a", to: "nd-b"}, {id: "eg-bd", from: "nd-b", to: "nd-d"}]};

const line = (id: string, nodeIds: string[], extra: Partial<OutlineWorkbenchLine> = {}): OutlineWorkbenchLine =>
    ({schema: "nbook.outline-line/v3", id, planId: "plan-1", version: 0, title: id, type: "branch", fixed: false, nodeIds, ...extra});

describe("线路图画布坐标与规则", () => {
    it("单元格与坐标互相换算，拖到附近时吸附到最近的格×行", () => {
        for (const cell of [{column: 0, row: 0}, {column: 3, row: 2}]) expect(positionToCell(cellToPosition(cell))).toEqual(cell);
        const {x, y} = cellToPosition({column: 3, row: 2});
        expect(positionToCell({x: x + 90, y: y - 40})).toEqual({column: 3, row: 2});
        expect(positionToCell({x: x + 130, y: y + 70})).toEqual({column: 4, row: 3});
        expect(positionToCell({x: -500, y: -500})).toEqual({column: 0, row: 0});
        expect(pointToCell({x: 219, y: 111})).toEqual({column: 0, row: 1});
        expect(columnCount(graph)).toBe(6);
        expect(columnCount(null)).toBe(2);
    });

    it("连线只能向右，同格、向左、自连和重复连线都被拦截", () => {
        expect(connectionProblem(graph, "nd-a", "nd-c")).toBeNull();
        expect(connectionProblem(graph, "nd-b", "nd-c")).toMatch(/同一格/);
        expect(connectionProblem(graph, "nd-d", "nd-a")).toMatch(/小格号/);
        expect(connectionProblem(graph, "nd-a", "nd-a")).toMatch(/自身/);
        expect(connectionProblem(graph, "nd-a", "nd-b")).toMatch(/已存在/);
        expect(connectionProblem(graph, "nd-a", "nd-x")).toMatch(/不存在/);
    });

    it("勾选节点按格号排序后校验链，固定线路锁定自己的节点与连线", () => {
        expect(resolveLineChain(graph, ["nd-d", "nd-a", "nd-b"])).toMatchObject({problem: null,
            nodes: [{id: "nd-a"}, {id: "nd-b"}, {id: "nd-d"}], edges: [{id: "eg-ab"}, {id: "eg-bd"}]});
        expect(resolveLineChain(graph, ["nd-a"]).problem).toBe("TOO_SHORT");
        expect(resolveLineChain(graph, ["nd-a", "nd-b", "nd-c"]).problem).toBe("SAME_COLUMN");
        expect(resolveLineChain(graph, ["nd-a", "nd-d"]).problem).toBe("MISSING_EDGE");
        expect(resolveLineChain(graph, ["nd-a", "nd-gone"]).problem).toBe("UNKNOWN_NODE");
        const locked = lockedGraphParts(graph, [line("ln-main", ["nd-a", "nd-b"], {fixed: true}), line("ln-draft", ["nd-b", "nd-d"])]);
        expect([...locked.nodeIds]).toEqual(["nd-a", "nd-b"]);
        expect([...locked.edgeIds]).toEqual(["eg-ab"]);
    });

    it("主线总是第一种颜色，其余线路循环取色", () => {
        const colors = lineColors([line("ln-1", []), line("ln-main", [], {type: "main"}), line("ln-2", [])]);
        expect(colors.get("ln-main")).toBe("#2563eb");
        expect(new Set(colors.values()).size).toBe(3);
    });
});
