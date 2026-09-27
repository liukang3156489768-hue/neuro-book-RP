import {describe, expect, it} from "vitest";
import {
    OUTLINE_ENTRY_SCHEMA,
    OUTLINE_GRAPH_SCHEMA,
    OUTLINE_LINE_SCHEMA,
    type OutlineEntryKind,
    type OutlineGraph,
    type OutlineId,
    type OutlineLine,
    type OutlineLineType,
    OutlineFormatError,
    createEmptyManifest,
    parseEntryMarkdown,
    parseForeshadowMarkers,
    parseForeshadowingMarkdown,
    parseGraphYaml,
    parseGuidanceAnnotations,
    serializeForeshadowingMarkdown,
    parseLineYaml,
    resolveLineChain,
    serializeGraphYaml,
    serializeLineYaml,
    parseManifest,
    serializeManifest,
    serializeEntryMarkdown,
    slugify,
    validateManifestAndEntries,
    validatePlanningGraphs,
    stableFileName,
} from "./format";

describe("outline format", () => {
    it("解析并确定性序列化 entry，改名不改变稳定 ID", () => {
        const entry = parseEntryMarkdown(`---\nschema: ${OUTLINE_ENTRY_SCHEMA}\nid: ol-total-001\nkind: total\nversion: 0\nstatus: draft\ntitle: 总纲\nparentId: null\nchapterId: null\n---\n正文\n`);
        expect(entry.id).toBe("ol-total-001");
        expect(parseEntryMarkdown(serializeEntryMarkdown({...entry, title: "新标题"})).id).toBe(entry.id);
        expect(slugify("  Hello, 世界  ")).toBe("hello");
        expect(stableFileName("新标题", entry.id, "md")).toBe("untitled--ol-total-001.md");
    });

    it("线路图解析与序列化往返，连线只能向右且单元格唯一", () => {
        const yaml = `schema: ${OUTLINE_GRAPH_SCHEMA}\nid: gr-a\nplanId: plan-a\nversion: 1\nnodes:\n  - {id: nd-a, entryId: ol-a, column: 0, row: 0}\n  - {id: nd-b, entryId: null, column: 2, row: 1}\nedges:\n  - {id: eg-ab, from: nd-a, to: nd-b}\n`;
        const graph = parseGraphYaml(yaml);
        expect(graph.nodes[1]).toEqual({id: "nd-b", entryId: null, column: 2, row: 1});
        expect(parseGraphYaml(serializeGraphYaml(graph))).toEqual(graph);
        expect(() => parseGraphYaml(yaml.replace("column: 2", "column: 0"))).toThrow(/小格号指向大格号/);
        const duplicatePath = (content: string) => {
            try { parseGraphYaml(content); } catch (error) { return (error as OutlineFormatError).diagnostics[0]?.path; }
            return undefined;
        };
        expect(duplicatePath(yaml.replace("column: 2, row: 1", "column: 0, row: 0"))).toMatch(/单元格/);
        expect(duplicatePath(yaml.replace("entryId: null", "entryId: ol-a"))).toMatch(/entryId/);
        expect(() => parseGraphYaml(yaml.replace("column: 2", "column: -1"))).toThrow(OutlineFormatError);
        expect(duplicatePath(`${yaml}  - {id: eg-dup, from: nd-a, to: nd-b}\n`)).toMatch(/端点/);
        expect(() => parseGraphYaml(yaml.replace("to: nd-b", "to: nd-x"))).toThrow(/不存在的节点/);
    });

    it("v3 线路只保存节点集合，旧 v1/v2 线路不再读取", () => {
        const yaml = `schema: ${OUTLINE_LINE_SCHEMA}\nid: ln-main\nplanId: plan-a\nversion: 0\ntitle: 主线\ntype: main\nfixed: false\nnodeIds: [nd-a, nd-b]\n`;
        const line = parseLineYaml(yaml);
        expect(line).toMatchObject({planId: "plan-a", nodeIds: ["nd-a", "nd-b"]});
        expect(parseLineYaml(serializeLineYaml(line))).toEqual(line);
        expect(() => parseLineYaml(yaml.replace("planId: plan-a\n", ""))).toThrow(OutlineFormatError);
        expect(() => parseLineYaml(yaml.replace("[nd-a, nd-b]", "[nd-a, nd-a]"))).toThrow(OutlineFormatError);
        expect(() => parseLineYaml(yaml.replace("fixed: false", "fixed: true"))).toThrow(/分析报告/);
        for (const legacy of ["nbook.outline-line/v1", "nbook.outline-line/v2"]) {
            expect(() => parseLineYaml(yaml.replace(OUTLINE_LINE_SCHEMA, legacy))).toThrow(OutlineFormatError);
        }
    });

    it("旧 v1 manifest 读取时丢弃线路引用，并以 v2 写回", () => {
        const manifest = parseManifest(`schema: nbook.outline/v1\nrevision: 3\ntotalId: null\nplans: []\nentries: []\nforeshadowing: []\nlines:\n  - {id: ln-old, path: outline/lines/old--ln-old.yaml, version: 1, contentHash: "sha256:${"0".repeat(64)}"}\n`);
        expect(manifest).toMatchObject({schema: "nbook.outline/v2", revision: 3, graphs: [], lines: []});
        expect(parseManifest(serializeManifest(manifest))).toEqual(manifest);
    });

    it("方案图校验节点条目归属、细纲与每方案一条主线", () => {
        const plans = [
            {id: "plan-a", title: "甲", placements: [{entryId: "ol-total" as const, parentId: null, position: 0},
                {entryId: "ol-a" as const, parentId: "ol-total" as const, position: 1}]},
            {id: "plan-b", title: "乙", placements: [{entryId: "ol-total" as const, parentId: null, position: 0}]},
        ];
        const kinds = new Map<string, OutlineEntryKind>([["ol-total", "total"], ["ol-a", "chapter"]]);
        const graph = (planId: string, entryId: OutlineId | null, id = "gr-a"): OutlineGraph => ({schema: OUTLINE_GRAPH_SCHEMA,
            id: id as OutlineId, planId, version: 1, edges: [],
            nodes: [{id: `nd-${planId}-0` as OutlineId, entryId: "ol-total", column: 0, row: 0},
                {id: `nd-${planId}-1` as OutlineId, entryId, column: 1, row: 0}]});
        const line = (planId: string, type: OutlineLineType, id: string): OutlineLine => ({schema: OUTLINE_LINE_SCHEMA,
            id: id as OutlineId, planId, version: 0, title: id, type, fixed: false, nodeIds: [`nd-${planId}-0` as OutlineId]});
        const check = (graphs: OutlineGraph[], lines: OutlineLine[], entryKinds = kinds) =>
            validatePlanningGraphs(graphs, lines, plans, entryKinds);
        // 不同方案可以共享总纲条目，也各自有主线。
        expect(() => check([graph("plan-a", "ol-a"), graph("plan-b", null, "gr-b")],
            [line("plan-a", "main", "ln-a"), line("plan-b", "main", "ln-b")])).not.toThrow();
        expect(() => check([graph("plan-b", "ol-a")], [])).toThrow(/不属于所属方案/);
        expect(() => check([graph("plan-a", "ol-a"), graph("plan-a", null, "gr-b")], [])).toThrow(/只能有一张线路图/);
        expect(() => check([graph("plan-a", "ol-a")], [], new Map([...kinds, ["ol-a", "detail"]]))).toThrow(/细纲/);
        expect(() => check([graph("missing", null)], [])).toThrow(/方案不存在/);
        expect(() => check([graph("plan-a", "ol-a")], [line("plan-a", "main", "ln-a"), line("plan-a", "main", "ln-b")]))
            .toThrow(/主线/);
        expect(() => check([graph("plan-a", "ol-a"), graph("plan-b", null, "gr-b")],
            [{...line("plan-b", "branch", "ln-x"), nodeIds: ["nd-plan-a-0"]}])).toThrow(/不在所属方案/);
        // 丢失的条目只核对方案归属，交给节点状态标红。
        expect(() => check([graph("plan-a", "ol-a")], [], new Map([["ol-total", "total"]]))).not.toThrow();
    });

    it("线路链要求格号严格递增、相邻节点有连线且至少两个节点", () => {
        const graph: OutlineGraph = {schema: OUTLINE_GRAPH_SCHEMA, id: "gr-a", planId: "plan-a", version: 1,
            nodes: [{id: "nd-a", entryId: null, column: 0, row: 0}, {id: "nd-b", entryId: null, column: 2, row: 0},
                {id: "nd-c", entryId: null, column: 2, row: 1}, {id: "nd-d", entryId: null, column: 5, row: 3}],
            edges: [{id: "eg-ab", from: "nd-a", to: "nd-b"}, {id: "eg-bd", from: "nd-b", to: "nd-d"}, {id: "eg-ac", from: "nd-a", to: "nd-c"}]};
        const chain = resolveLineChain(graph, ["nd-d", "nd-a", "nd-b"]);
        expect(chain).toMatchObject({problem: null, edges: [{id: "eg-ab"}, {id: "eg-bd"}]});
        expect(chain.nodes.map(({id}) => id)).toEqual(["nd-a", "nd-b", "nd-d"]);
        expect(resolveLineChain(graph, ["nd-a"]).problem).toBe("TOO_SHORT");
        expect(resolveLineChain(graph, ["nd-a", "nd-x"]).problem).toBe("UNKNOWN_NODE");
        expect(resolveLineChain(graph, ["nd-a", "nd-b", "nd-c"]).problem).toBe("SAME_COLUMN");
        expect(resolveLineChain(graph, ["nd-c", "nd-d"]).problem).toBe("MISSING_EDGE");
        expect(resolveLineChain(undefined, ["nd-a", "nd-b"]).problem).toBe("UNKNOWN_NODE");
    });

    it("伏笔定义支持草稿和确认状态，旧 v1 文件按草稿恢复", () => {
        const original = `---\nschema: nbook.outline-foreshadowing/v1\nid: fo-old\nversion: 0\ntitle: 线索\n---\n内容`;
        expect(parseForeshadowingMarkdown(original).status).toBe("draft");
        const confirmed = parseForeshadowingMarkdown(serializeForeshadowingMarkdown({
            ...parseForeshadowingMarkdown(original), status: "adopted",
        }));
        expect(confirmed.status).toBe("adopted");
        expect(() => parseForeshadowingMarkdown(original.replace("version: 0", "version: 0\nstatus: unknown"))).toThrow();
    });

    it("拒绝未知 schema、细纲脱离章节和损坏伏笔标记", () => {
        expect(() => parseManifest("schema: unknown\nrevision: 0\ntotalId: null\nplans: []\nentries: []\nforeshadowing: []\nlines: []\n")).toThrow(/不支持/);
        expect(() => parseEntryMarkdown(`---\nschema: ${OUTLINE_ENTRY_SCHEMA}\nid: ol-detail-001\nkind: detail\nversion: 0\nstatus: draft\ntitle: 细纲\nparentId: null\nchapterId: null\n---\n`)).toThrow(/细纲/);
        expect(() => parseForeshadowMarkers("<!-- nb:foreshadow marker=\"fm-1\" foreshadow=\"fo-001\" action=\"plant\" -->x", new Set(["fo-001"]))).toThrow(/未闭合/);
        expect(() => parseForeshadowMarkers("<!-- nb:foreshadow marker=\"fm-1\" foreshadow=\"fo-001\" action=\"recover\" -->x<!-- /nb:foreshadow marker=\"fm-1\" -->", new Set(["fo-002"]))).toThrow(/未知伏笔/);
    });

    it("解析成对伏笔标记", () => {
        const markers = parseForeshadowMarkers(
            "前 <!-- nb:foreshadow marker=\"fm-1\" foreshadow=\"fo-001\" action=\"plant\" -->银纹<!-- /nb:foreshadow marker=\"fm-1\" --> 后",
            new Set(["fo-001"]),
        );
        expect(markers).toEqual([expect.objectContaining({marker: "fm-1", foreshadowId: "fo-001", action: "plant", content: "银纹"})]);
    });

    it("损坏或嵌套冲突的伏笔标记不会被静默忽略", () => {
        const start = '<!-- nb:foreshadow marker="fm-1" foreshadow="fo-001" action="plant" -->';
        const end = '<!-- /nb:foreshadow marker="fm-1" -->';
        const known = new Set(["fo-001"]);
        expect(() => parseForeshadowMarkers(`${start}可见文字<!-- /nb:foreshadow marker="fm-1"`, known)).toThrow();
        expect(() => parseForeshadowMarkers(`${start}可见文字<!-- /nb:foreshadow marker="fm-1" <!-- note -->${end}`, known)).toThrow();
        expect(() => parseForeshadowMarkers(`${start}一${start}二${end}${end}`, known)).toThrow();
        expect(() => parseForeshadowMarkers(`${start}一<!-- nb:foreshadow marker="fm-2" foreshadow="fo-001" action="plant" -->二${end}<!-- /nb:foreshadow marker="fm-2" -->`, known)).toThrow();
        expect(parseForeshadowMarkers(`普通注释 <!-- memo --> ${start}银纹${end}`, known)).toHaveLength(1);
    });
    it("拒绝方案 placement 和条目 parentId 的循环层级", () => {
        const total = {schema: OUTLINE_ENTRY_SCHEMA, id: "ol-total" as const, kind: "total" as const, version: 0,
            status: "draft" as const, title: "总纲", parentId: null, chapterId: null, body: ""};
        const first = {...total, id: "ol-a" as const, kind: "volume" as const, title: "甲", parentId: "ol-b" as const};
        const second = {...total, id: "ol-b" as const, kind: "volume" as const, title: "乙", parentId: "ol-a" as const};
        const manifest = {...createEmptyManifest(), totalId: total.id, plans: [{id: "p", title: "方案", placements: [
            {entryId: total.id, parentId: null, position: 0},
            {entryId: first.id, parentId: second.id, position: 1},
            {entryId: second.id, parentId: first.id, position: 2},
        ]}]};
        expect(() => validateManifestAndEntries(manifest, [total, first, second])).toThrow(/循环|根/);
        const cyclicEntries = {...manifest, plans: [{...manifest.plans[0]!, placements: [
            {entryId: total.id, parentId: null, position: 0},
            {entryId: first.id, parentId: total.id, position: 1},
            {entryId: second.id, parentId: first.id, position: 2},
        ]}]};
        expect(() => validateManifestAndEntries(cyclicEntries, [total, first, second])).toThrow(/循环/);
    });
    it("拒绝规范快照中绕开领域操作写入的错误层级和细纲章节关联", () => {
        const base = {schema: OUTLINE_ENTRY_SCHEMA, version: 0, status: "draft" as const, body: ""};
        const total = {...base, id: "ol-total" as const, kind: "total" as const, title: "总纲", parentId: null, chapterId: null};
        const volume = {...base, id: "ol-volume" as const, kind: "volume" as const, title: "卷纲", parentId: total.id, chapterId: null};
        const chapter = {...base, id: "ol-chapter" as const, kind: "chapter" as const, title: "章节", parentId: volume.id, chapterId: null};
        const detail = {...base, id: "ol-detail" as const, kind: "detail" as const, title: "细纲", parentId: chapter.id, chapterId: chapter.id};
        const placements = [
            {entryId: total.id, parentId: null, position: 0},
            {entryId: volume.id, parentId: total.id, position: 1},
            {entryId: chapter.id, parentId: volume.id, position: 2},
            {entryId: detail.id, parentId: chapter.id, position: 3},
        ];
        const manifest = {...createEmptyManifest(), totalId: total.id, plans: [{id: "plan-a", title: "方案", placements}]};
        expect(() => validateManifestAndEntries(manifest, [total, volume, chapter, detail])).not.toThrow();
        expect(() => validateManifestAndEntries(manifest, [total, {...volume, parentId: chapter.id}, chapter, detail])).toThrow();
        expect(() => validateManifestAndEntries(manifest, [total, volume, {...chapter, parentId: total.id}, detail])).not.toThrow();
        expect(() => validateManifestAndEntries(manifest, [total, volume, chapter, {...detail, chapterId: volume.id}])).toThrow();
        expect(() => validateManifestAndEntries(manifest, [total, volume, chapter, {...detail, parentId: volume.id}])).toThrow();
        const wrongPlacement = {...manifest, plans: [{...manifest.plans[0]!, placements: placements.map((place) =>
            place.entryId === detail.id ? {...place, parentId: volume.id} : place)}]};
        expect(() => validateManifestAndEntries(wrongPlacement, [total, volume, chapter, detail])).toThrow();
    });
    it("丢失条目的诊断校验仅豁免依赖该对象的关系", () => {
        const base = {schema: OUTLINE_ENTRY_SCHEMA, version: 0, status: "draft" as const, body: ""};
        const total = {...base, id: "ol-total" as const, kind: "total" as const, title: "总纲", parentId: null, chapterId: null};
        const missingChapterId = "ol-chapter" as const;
        const detail = {...base, id: "ol-detail" as const, kind: "detail" as const, title: "细纲",
            parentId: missingChapterId, chapterId: missingChapterId};
        const placements = [
            {entryId: total.id, parentId: null, position: 0},
            {entryId: missingChapterId, parentId: total.id, position: 1},
            {entryId: detail.id, parentId: missingChapterId, position: 2},
        ];
        const manifest = {...createEmptyManifest(), totalId: total.id, plans: [{id: "plan-a", title: "方案", placements}]};
        const sharedPath = "outline/entries/shared.md";
        expect(() => parseManifest(serializeManifest({...manifest, entries: [
            {id: total.id, path: sharedPath, version: 0, contentHash: `sha256:${"0".repeat(64)}`},
            {id: missingChapterId, path: sharedPath, version: 0, contentHash: `sha256:${"0".repeat(64)}`},
        ]}))).toThrow(/路径.*重复/);
        const missing = new Set<OutlineId>([missingChapterId]);
        expect(() => validateManifestAndEntries(manifest, [total, detail])).toThrow(/不存在|关联/);
        expect(() => validateManifestAndEntries(manifest, [total, detail], "outline", missing)).not.toThrow();
        expect(() => validateManifestAndEntries({...manifest, plans: [manifest.plans[0]!, manifest.plans[0]!] },
            [total, detail], "outline", missing)).toThrow(/方案 ID 重复/);
        expect(() => validateManifestAndEntries(manifest, [total, {...detail, parentId: total.id}],
            "outline", missing)).toThrow(/父级类型不合法/);
        expect(() => validateManifestAndEntries(manifest, [total, {...detail, chapterId: "ol-unknown"}],
            "outline", missing)).toThrow(/细纲必须关联章节大纲|未知章节大纲/);
    });
    it("细纲参考与篇幅要求按结构化字段往返且拒绝越界文件引用", () => {
        const entry = {schema: OUTLINE_ENTRY_SCHEMA, id: "ol-detail" as const, kind: "detail" as const,
            version: 0, status: "draft" as const, title: "细纲", parentId: "ol-chapter" as const,
            chapterId: "ol-chapter" as const, body: "按场景写", materialRefs: ["lorebook/人物/阿青.md"],
            writingGuidance: "视角保持克制", references: [{path: "research/背景/雨夜.md"}], targetWords: 2400};
        expect(parseEntryMarkdown(serializeEntryMarkdown(entry))).toMatchObject(entry);
        expect(() => parseEntryMarkdown(serializeEntryMarkdown({...entry, references: [{path: "../workspace/secret"}]}))).toThrow();
        expect(() => parseEntryMarkdown(serializeEntryMarkdown({...entry, targetWords: -1}))).toThrow();
        for (const invalid of ["/absolute.md", "lorebook/../secret.md", "lorebook//empty.md", "lorebook\\backslash.md", "C:/secret.md"]) {
            expect(() => parseEntryMarkdown(serializeEntryMarkdown({...entry, materialRefs: [invalid]}))).toThrow();
        }
        expect(() => parseEntryMarkdown(serializeEntryMarkdown({...entry, materialRefs: ["same.md", "same.md"]}))).toThrow();
        expect(() => parseEntryMarkdown(serializeEntryMarkdown({...entry, references: "not-an-array" as never}))).toThrow();
        expect(() => parseEntryMarkdown(serializeEntryMarkdown({...entry, targetWords: 1.5}))).toThrow();
    });
    it("参考文件升级为结构化 references；待补资料可无路径但必须说明所需资料", () => {
        const head = "---\nschema: nbook.outline-entry/v1\nid: ol-detail\nkind: detail\nversion: 0\nstatus: draft\ntitle: 细纲\nparentId: ol-chapter\nchapterId: ol-chapter\n";
        expect(parseEntryMarkdown(`${head}referenceFiles:\n  - research/雨夜.md\n---\n正文`)).toMatchObject({
            schema: OUTLINE_ENTRY_SCHEMA, references: [{path: "research/雨夜.md"}]});
        expect(() => parseEntryMarkdown(`${head}referenceFiles: [a.md]\nreferences: [{path: a.md}]\n---\n`)).toThrow(/不能同时出现/);
        const entry = parseEntryMarkdown(`${head}---\n正文`);
        const pending = {...entry, references: [{path: "research/雨夜.md", locator: "第二节", purpose: "天气细节"},
            {locator: "旧城区地图", purpose: "确认街道走向", pending: true}]};
        const restored = parseEntryMarkdown(serializeEntryMarkdown(pending));
        expect(restored.references).toEqual(pending.references);
        expect(serializeEntryMarkdown(restored)).toBe(serializeEntryMarkdown(pending));
        expect(() => parseEntryMarkdown(serializeEntryMarkdown({...entry, references: [{locator: "无路径"}]}))).toThrow(/路径/);
        expect(() => parseEntryMarkdown(serializeEntryMarkdown({...entry, references: [{pending: true}]}))).toThrow(/locator/);
        expect(() => parseEntryMarkdown(serializeEntryMarkdown({...entry,
            references: [{path: "a.md"}, {path: "a.md", pending: true}]}))).toThrow();
        expect(() => parseEntryMarkdown(`${head}references: [{path: a.md, note: x}]\n---\n`)).toThrow(/未知字段/);
    });
    it("写作指导按场景锚定并 fail-closed 解析篇幅预算", () => {
        const guide = (marker: string, attrs: string, text: string) =>
            `<!-- nb:guidance marker="${marker}" ${attrs} -->${text}<!-- /nb:guidance marker="${marker}" -->`;
        expect(parseGuidanceAnnotations(`开头${guide("g1", 'scene="雨夜" words="800"', "略写")}${guide("g2", 'scene="对峙"', "展开")}`))
            .toMatchObject([{marker: "g1", scene: "雨夜", words: 800, text: "略写"}, {marker: "g2", scene: "对峙", text: "展开"}]);
        expect(() => parseGuidanceAnnotations(guide("g1", 'words="800"', "缺场景"))).toThrow(/场景/);
        expect(() => parseGuidanceAnnotations(guide("g1", 'scene="雨夜" words="0"', "零"))).toThrow(/正整数/);
        expect(() => parseGuidanceAnnotations(guide("g1", 'scene="雨夜" tone="冷"', "未知"))).toThrow(/未知属性/);
        expect(() => parseGuidanceAnnotations(`${guide("g1", 'scene="a"', "x")}${guide("g1", 'scene="b"', "y")}`)).toThrow(/不唯一/);
        expect(() => parseGuidanceAnnotations('<!-- nb:guidance marker="g1" scene="a" -->未闭合')).toThrow(/未闭合/);
    });
    it("提供空 manifest，避免新项目自行拼接 schema", () => {
        const manifest = createEmptyManifest();
        expect(manifest.revision).toBe(0);
        expect(manifest).toMatchObject({schema: "nbook.outline/v2", graphs: [], lines: []});
    });
});
