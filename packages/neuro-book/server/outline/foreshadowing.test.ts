import fs from "node:fs/promises";
import path from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {createTestTmpRoot, resolveTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import {contentHash, parseForeshadowingMarkdown, serializeEntryMarkdown, serializeManifest, type OutlineId} from "./format";
import {deriveForeshadowingElapsed, deriveForeshadowingStates, prepareForeshadowingAction} from "./foreshadowing";
import {inspectFixedLine} from "./line-analysis";
import {publishPlanningFiles, readForeshadowingSnapshot, readPlanningSnapshot, type PlanningSnapshot} from "./index";
import {publishOutlineFiles} from "./transaction";
import {buildDesignGraph, PlanningFixture, type DesignNodeKey} from "./line-graph.fixture";

const roots: string[] = [];
afterEach(async () => {
    const tmpRoot = path.resolve(resolveTmpRoot());
    for (const root of roots.splice(0)) {
        const relative = path.relative(tmpRoot, path.resolve(root));
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
            throw new Error("测试目录必须位于 Agent 临时根下");
        }
        await fs.rm(root, {recursive: true, force: true});
    }
});

type Action = "plant" | "reinforce" | "recover";
type LineName = "main" | "branch" | "branch2" | "characterA" | "characterB";
type Marks = Partial<Record<DesignNodeKey, readonly (readonly [string, Action])[]>>;

const mark = (foreshadowId: OutlineId, marker: string, action: Action) =>
    `<!-- nb:foreshadow marker="fm-${marker}" foreshadow="${foreshadowId}" action="${action}" -->${marker}<!-- /nb:foreshadow marker="fm-${marker}" -->`;

/** 创建并确认伏笔定义；只有正式伏笔的标记才进入状态派生。 */
function adoptedForeshadowing(fixture: PlanningFixture, title = "线索"): OutlineId {
    const created = prepareForeshadowingAction(fixture.snapshot, {kind: "create-foreshadowing", title, body: "银纹"});
    fixture.publish(created.publish);
    const source = fixture.snapshot.foreshadowing.find(({value}) => value.id === created.id)!;
    fixture.publish(prepareForeshadowingAction(fixture.snapshot, {kind: "confirm-foreshadowing", id: created.id,
        expectedVersion: source.value.version, expectedContentHash: source.contentHash}).publish);
    return created.id;
}

/**
 * 图示线路图 + 一条正式伏笔：先写入章节标记（修改条目会撤回包含它的固定线路），再固定指定线路。
 * 默认固定全部五条线路。
 */
async function designWithMarks(marks: Marks, fixedLines?: readonly LineName[]) {
    const fixture = new PlanningFixture();
    const foreshadowId = adoptedForeshadowing(fixture);
    const design = buildDesignGraph(fixture);
    for (const [key, items] of Object.entries(marks) as [DesignNodeKey, readonly (readonly [string, Action])[]][]) {
        const source = fixture.entry(design.entries[key]);
        fixture.library({kind: "edit-entry", planId: design.planId, entryId: source.value.id, expectedVersion: source.value.version,
            expectedContentHash: source.contentHash, title: source.value.title,
            body: items.map(([marker, action]) => mark(foreshadowId, marker, action)).join("\n")});
        // 修改条目会退回草稿，重新采用后才能作为固定线路节点。
        const edited = fixture.entry(design.entries[key]);
        fixture.library({kind: "adopt-entry", planId: design.planId, entryId: edited.value.id, expectedVersion: edited.value.version,
            expectedContentHash: edited.contentHash});
    }
    for (const name of fixedLines ?? (Object.keys(design.lines) as LineName[])) await fixture.fix(design.lines[name]);
    return {...design, foreshadowId};
}

const summary = (snapshot: PlanningSnapshot) => {
    const [view] = deriveForeshadowingStates(snapshot);
    return {status: view!.status, issues: view!.issues.map(({code, marker}) => [code, marker]),
        sources: view!.sources.map(({marker, column, valid}) => [marker, column, valid])};
};

describe("伏笔状态按方案线路图格号派生", () => {
    it("先埋后收跨线路按格号判定：角色线埋设、支线回收仍有效", async () => {
        const {fixture, planId, nodes, lines} = await designWithMarks({k1: [["p", "plant"]], m3: [["f", "reinforce"]], b4: [["r", "recover"]]});
        const [view] = deriveForeshadowingStates(fixture.snapshot);
        expect(view).toMatchObject({status: "recovered", issues: []});
        expect(view!.sources.map(({marker, planId: owner, nodeId, column, lineIds, valid}) => [marker, owner, nodeId, column, [...lineIds].sort(), valid]))
            .toEqual([
                ["fm-p", planId, nodes.k1, 1, [lines.characterB], true],
                ["fm-f", planId, nodes.m3, 3, [lines.main, lines.branch2].sort(), true],
                ["fm-r", planId, nodes.b4, 4, [lines.branch2], true],
            ]);
    });

    it("同格不同节点不算之后，同一节点内按标记位置判定", async () => {
        const sameColumn = await designWithMarks({b2: [["p", "plant"]], a2: [["r", "recover"]]});
        expect(summary(sameColumn.fixture.snapshot)).toEqual({status: "planted", issues: [["RECOVER_BEFORE_PLANT", "fm-r"]],
            sources: [["fm-p", 2, true], ["fm-r", 2, false]]});
        const sameNode = await designWithMarks({m1: [["p", "plant"], ["r", "recover"]]});
        expect(summary(sameNode.fixture.snapshot)).toMatchObject({status: "recovered", issues: []});
        const reversed = await designWithMarks({m1: [["r", "recover"], ["p", "plant"]]});
        expect(summary(reversed.fixture.snapshot)).toEqual({status: "planted", issues: [["RECOVER_BEFORE_PLANT", "fm-r"]],
            sources: [["fm-r", 1, false], ["fm-p", 1, true]]});
        // 回收在更小的格号：跨线路也能发现先收后埋。
        const early = await designWithMarks({k1: [["r", "recover"]], b4: [["p", "plant"], ["x", "reinforce"]]});
        expect(summary(early.fixture.snapshot)).toMatchObject({status: "planted", issues: [["RECOVER_BEFORE_PLANT", "fm-r"]]});
    });

    it("被多条固定线路共享的汇合节点只产生一次来源", async () => {
        const {fixture, nodes, lines} = await designWithMarks({j4: [["p", "plant"]]});
        const [view] = deriveForeshadowingStates(fixture.snapshot);
        expect(view!.sources).toHaveLength(1);
        expect(view!.sources[0]).toMatchObject({nodeId: nodes.j4, column: 4, valid: true});
        expect([...view!.sources[0]!.lineIds].sort()).toEqual([lines.characterA, lines.characterB].sort());
    });

    it("只有有效固定线路上的正式章节贡献来源；草稿线路或失效节点不证明顺序", async () => {
        // branch2 未固定：b4 不在任何固定线路上，回收不计入。
        const unfixed = await designWithMarks({k1: [["p", "plant"]], b4: [["r", "recover"]]}, ["main", "characterB"]);
        expect(summary(unfixed.fixture.snapshot)).toEqual({status: "planted", issues: [], sources: [["fm-p", 1, true]]});
        const {fixture, entries, lines} = await designWithMarks({m1: [["p", "plant"]], m3: [["r", "recover"]]});
        // 埋设节点内容变化（未经领域操作撤回固定）：含该节点的线路只有该节点变黄，不含它的线路因方案上下文变化整条变黄。
        const stale: PlanningSnapshot = {...fixture.snapshot, entries: fixture.snapshot.entries.map((entry) => entry.value.id === entries.m1
            ? {...entry, contentHash: contentHash(serializeEntryMarkdown({...entry.value, body: `${entry.value.body}改`}))} : entry)};
        expect(inspectFixedLine(stale, lines.main).nodes.map(({status}) => status)).toEqual(["valid", "yellow", "valid", "valid"]);
        expect(inspectFixedLine(stale, lines.branch2).nodes.every(({status}) => status === "yellow")).toBe(true);
        expect(summary(stale)).toEqual({status: "pending", issues: [["RECOVER_BEFORE_PLANT", "fm-r"]], sources: [["fm-r", 3, false]]});
        // 伏笔定义为草稿时不派生正式状态。
        const draftDefinition: PlanningSnapshot = {...fixture.snapshot, foreshadowing: fixture.snapshot.foreshadowing.map((source) =>
            ({...source, value: {...source.value, status: "draft" as const}}))};
        expect(summary(draftDefinition)).toEqual({status: "draft", issues: [], sources: []});
    });

    it("已过格数按格号差计算，未回收时截至方案最后一个固定章节节点，插列后随之重算", async () => {
        const {fixture, planId, foreshadowId, entries} = await designWithMarks({k1: [["p", "plant"]], b4: [["r", "recover"]]});
        expect(deriveForeshadowingElapsed(fixture.snapshot)).toEqual([{id: foreshadowId, plans: [{planId,
            plantedAt: {entryId: entries.k1, title: "章节 k1"}, recoveredAt: {entryId: entries.b4, title: "章节 b4"}, elapsed: 3}]}]);
        fixture.graph("insert-graph-column", planId, {column: 2});
        expect(deriveForeshadowingElapsed(fixture.snapshot)[0]!.plans[0]!.elapsed).toBe(4);
        const open = await designWithMarks({k1: [["p", "plant"]]});
        expect(deriveForeshadowingElapsed(open.fixture.snapshot)[0]!.plans).toEqual([{planId: open.planId,
            plantedAt: {entryId: open.entries.k1, title: "章节 k1"}, elapsed: 5}]);
        const none = await designWithMarks({});
        expect(deriveForeshadowingElapsed(none.fixture.snapshot)[0]!.plans).toEqual([{planId: none.planId, elapsed: null}]);
    });

    it("各方案分别判定：另一方案的埋设不能授权本方案的回收", async () => {
        const fixture = new PlanningFixture();
        const foreshadowId = adoptedForeshadowing(fixture);
        // 两个方案各有自己的总纲，章节挂在各自总纲下。
        const created = ["甲", "乙"].map((title) => fixture.library({kind: "create-plan", title}));
        const plans = created.map(({planId}) => planId!);
        const chain = async (planId: string, actions: readonly (readonly [string, Action])[]) => {
            const totalId = created[plans.indexOf(planId)]!.entryId!;
            const nodeIds = [];
            for (const [index, [marker, action]] of actions.entries()) {
                const entryId = fixture.adoptedChapter(planId, totalId, `${planId}-${marker}`, mark(foreshadowId, marker, action));
                nodeIds.push(fixture.graph("add-graph-node", planId, {column: index * 2, row: 0, entryId}).nodeId!);
            }
            fixture.graph("connect-graph-nodes", planId, {from: nodeIds[0]!, to: nodeIds[1]!});
            await fixture.fix(fixture.createLine(planId, `${planId}主线`, "main", nodeIds));
        };
        await chain(plans[0]!, [["a", "plant"], ["b", "reinforce"]]);
        await chain(plans[1]!, [["c", "reinforce"], ["d", "recover"]]);
        const [view] = deriveForeshadowingStates(fixture.snapshot);
        expect(view!.status).toBe("planted");
        expect(view!.issues.map(({code, planId, marker}) => [code, planId, marker])).toEqual([
            ["REINFORCE_BEFORE_PLANT", plans[1], "fm-c"], ["RECOVER_BEFORE_PLANT", plans[1], "fm-d"]]);
        expect(deriveForeshadowingElapsed(fixture.snapshot)[0]!.plans).toEqual([
            {planId: plans[0], plantedAt: {entryId: expect.any(String), title: `${plans[0]}-a`}, elapsed: 2},
            {planId: plans[1], elapsed: null}]);
    });

    it("只读隔离损坏章节标记，正式读取仍拒绝且保留其他章节来源", async () => {
        const projectRoot = await createTestTmpRoot("outline-foreshadowing", "damaged-markers");
        roots.push(projectRoot);
        // 埋设与损坏章节同在主线上，损坏章节变黄时埋设节点仍有效。
        const {fixture, entries} = await designWithMarks({m0: [["p", "plant"]], m3: [["r", "recover"]]});
        await publishOutlineFiles({projectRoot}, [...fixture.files].map(([relativePath, content]) => ({relativePath, content})));
        const manifest = fixture.snapshot.manifest;
        await expect(readPlanningSnapshot({projectRoot})).resolves.toMatchObject({manifest});

        // 外部编辑同步更新 manifest hash，以隔离标记语法和文件一致性错误。
        const target = fixture.entry(entries.m3);
        const damaged = serializeEntryMarkdown({...target.value,
            body: `<!-- nb:foreshadow marker="fm-bad" foreshadow="${fixture.snapshot.foreshadowing[0]!.value.id}" action="recover" -->未闭合`});
        const nextManifest = {...manifest, entries: manifest.entries.map((reference) => reference.path === target.path
            ? {...reference, contentHash: contentHash(damaged)} : reference)};
        await fs.writeFile(path.join(projectRoot, target.path), damaged);
        await fs.writeFile(path.join(projectRoot, "outline/manifest.yaml"), serializeManifest(nextManifest));

        await expect(readPlanningSnapshot({projectRoot})).rejects.toThrow(/未闭合/);
        await expect(publishPlanningFiles({projectRoot}, {expectedManifestRevision: manifest.revision,
            mutations: [{relativePath: "outline/manifest.yaml",
                content: serializeManifest({...nextManifest, revision: manifest.revision + 1})}]})).rejects.toThrow(/未闭合/);
        const {snapshot, markerIssues} = await readForeshadowingSnapshot({projectRoot});
        expect(markerIssues).toEqual([{entryId: entries.m3, path: target.path,
            diagnostics: [expect.objectContaining({code: "UNMATCHED_MARKER_START", path: target.path})]}]);
        expect(snapshot.entries.find(({value}) => value.id === entries.m3)?.markers).toEqual([]);
        expect(deriveForeshadowingStates(snapshot)[0]).toMatchObject({status: "planted",
            sources: [expect.objectContaining({marker: "fm-p", chapterId: entries.m0, valid: true})]});
        expect(await fs.readFile(path.join(projectRoot, target.path), "utf8")).toBe(damaged);
        await fs.writeFile(path.join(projectRoot, "outline/manifest.yaml"), serializeManifest(manifest));
        await expect(readForeshadowingSnapshot({projectRoot})).rejects.toThrow(/hash/);
        const invalidFrontmatter = "章节损坏但保留原始字节";
        await fs.writeFile(path.join(projectRoot, target.path), invalidFrontmatter);
        await fs.writeFile(path.join(projectRoot, "outline/manifest.yaml"), serializeManifest({...manifest,
            entries: manifest.entries.map((reference) => reference.path === target.path
                ? {...reference, contentHash: contentHash(invalidFrontmatter)} : reference)}));
        await expect(readForeshadowingSnapshot({projectRoot})).rejects.toThrow(/front matter/);
        expect(await fs.readFile(path.join(projectRoot, target.path), "utf8")).toBe(invalidFrontmatter);
    });
});

describe("伏笔定义操作", () => {
    it("创建与确认操作维护规范文件与 manifest 版本门禁", () => {
        const fixture = new PlanningFixture();
        const created = prepareForeshadowingAction(fixture.snapshot, {kind: "create-foreshadowing", title: " 新伏笔 ", body: "设计"});
        expect(created.publish.mutations).toHaveLength(2);
        expect(created.publish.expectedManifestRevision).toBe(0);
        fixture.publish(created.publish);
        expect(deriveForeshadowingStates(fixture.snapshot)[0]).toMatchObject({status: "draft", sources: []});
        expect(() => prepareForeshadowingAction(fixture.snapshot, {kind: "confirm-foreshadowing", id: created.id,
            expectedVersion: 0, expectedContentHash: "bad"})).toThrow(/版本/);
        adoptedForeshadowing(fixture, "另一条");
        expect(deriveForeshadowingStates(fixture.snapshot).map(({status}) => status)).toEqual(["draft", "pending"]);
    });

    it("伏笔设计分项随创建写入 v2 文件，编辑时缺省沿用、null 清除", () => {
        const fixture = new PlanningFixture();
        const design = {surface: "袖口银纹", connection: "与失踪者同源",
            plant: {situation: "初遇", presentation: "一笔带过", subtlety: "高"},
            recover: {condition: "身份揭晓", echo: "再现银纹", effect: "反转"}};
        const created = prepareForeshadowingAction(fixture.snapshot, {kind: "create-foreshadowing", title: "银纹", body: "设计", ...design});
        const file = created.publish.mutations[0]!;
        const parsed = parseForeshadowingMarkdown(file.content!, file.relativePath);
        expect(file.content).toContain("schema: nbook.outline-foreshadowing/v2");
        expect(parsed).toMatchObject(design);
        fixture.publish(created.publish);
        const edited = prepareForeshadowingAction(fixture.snapshot, {kind: "edit-foreshadowing", id: parsed.id, expectedVersion: 0,
            expectedContentHash: contentHash(file.content!), title: "银纹", body: "设计", surface: "袖口暗纹", recover: null});
        const next = parseForeshadowingMarkdown(edited.publish.mutations[0]!.content!);
        expect(next).toMatchObject({surface: "袖口暗纹", connection: design.connection, plant: design.plant, version: 1});
        expect(next).not.toHaveProperty("recover");
    });
});
