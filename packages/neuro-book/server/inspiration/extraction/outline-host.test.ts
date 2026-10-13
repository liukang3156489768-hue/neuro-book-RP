import fs from "node:fs/promises";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import type {ReadyProjectSessionRef} from "nbook/server/workspace-files/project-session-types";
import {collectReleasedSqliteHandles} from "nbook/server/workspace-files/sqlite-handle-release";
import {detailBody} from "nbook/server/outline/detail.fixture";
import {ExtractionTaskManager} from "./manager";
import {readOutlineExtractionOutcome, createOutlinePipeline} from "./outline-pipeline";
import {createReadyOutlinePlanning, readPlanLayout} from "./outline-planning";
import {createMemoryExtractionStore} from "./store-memory";
import {createScriptedModel, createTestLaunch, testSource} from "./testing";

// 与 outline/host.test.ts 相同的宿主替身：真实文件系统与大纲领域操作，只替换会话、文件索引和历史。
const mocks = vi.hoisted(() => ({
    requireReadyModuleHandle: vi.fn(),
    requireActiveReadyProject: vi.fn(),
    runReadyProjectOperation: vi.fn(),
    recordProjectWrite: vi.fn(async () => undefined),
    recordProjectDelete: vi.fn(async () => undefined),
    recordProjectRename: vi.fn(async () => undefined),
}));

vi.mock("nbook/server/workspace-files/project-session", () => ({
    requireReadyModuleHandle: mocks.requireReadyModuleHandle,
    requireActiveReadyProject: mocks.requireActiveReadyProject,
    runReadyProjectOperation: mocks.runReadyProjectOperation,
}));
vi.mock("nbook/server/workspace-files/project-file-index", () => ({
    PROJECT_FILE_INDEX_MODULE_TOKEN: {name: "file-index"},
}));
vi.mock("nbook/server/workspace-history/project-history", () => ({
    PROJECT_HISTORY_MODULE_TOKEN: {name: "history"},
    recordProjectWrite: mocks.recordProjectWrite,
    recordProjectDelete: mocks.recordProjectDelete,
    recordProjectRename: mocks.recordProjectRename,
}));

const roots: string[] = [];
afterEach(async () => {
    collectReleasedSqliteHandles({force: true});
    await Promise.all(roots.splice(0).map(root => fs.rm(root, {recursive: true, force: true})));
});
beforeEach(() => vi.clearAllMocks());

describe("大纲提取流水线：真实大纲库（临时项目）", () => {
    it("2 章 1 卷经 Ready 宿主写入：正式条目、来源依据与方案命名", async () => {
        const projectRoot = await createTestTmpRoot("outline-extraction", "host-run");
        roots.push(projectRoot);
        const ready = {publicId: "ready-extraction", workspace: {root: projectRoot}} as ReadyProjectSessionRef;
        const fileIndex = {mutate: vi.fn(async <T>(operation: () => Promise<T>) => operation())};
        mocks.requireReadyModuleHandle.mockImplementation((_ready, token: {name: string}) => token.name === "file-index" ? fileIndex : {});
        mocks.runReadyProjectOperation.mockImplementation(async (_ready, operation) =>
            operation(new AbortController().signal, () => undefined, async () => undefined));

        const source = testSource("reference/novel.md", "a".repeat(64));
        const structure = {
            sourceSha256: source.sha256, mode: "chapters" as const,
            chapters: [1, 2].map(index => ({
                index, title: `标题${index}`, firstParagraphId: `P${index * 2 - 1}`, lastParagraphId: `P${index * 2}`, characterCount: 20,
            })),
            volumes: [{index: 1, title: "卷一", firstChapterIndex: 1, lastChapterIndex: 2}],
        };
        const paragraphs = [1, 2, 3, 4].map(id => ({id: `P${id}`, text: `原文${id}`}));
        const store = createMemoryExtractionStore();
        const planning = createReadyOutlinePlanning(ready);
        const pipeline = createOutlinePipeline({planning, loadParagraphs: async () => paragraphs, listTasks: () => store.list()});
        const model = createScriptedModel(({prompt}) => {
            if (prompt.includes("【任务】提取本章的细纲")) {
                const second = prompt.includes("【P3】");
                return `${detailBody({scenes: [{name: "场景", plot: [second ? "第二章事件" : "第一章事件"]}]})}\n【引用】${second ? "P3-P4" : "P1-P2"}`;
            }
            if (prompt.includes("【任务】提取本章的章节大纲")) {
                return `# 章节目标\n目标\n# 场景设定\n地点\n# 剧情概要\n概要\n# 章节结尾\n悬念\n【引用】${prompt.includes("【P3】") ? "P3-P4" : "P1-P2"}`;
            }
            return prompt.includes("的卷纲。")
                ? "# 本卷目标\n目标\n# 起始状态\n起点\n# 核心冲突\n冲突\n# 结束状态\n终点"
                : "# 核心冲突\n冲突\n# 主题\n主题\n# 结局方向\n结局";
        });
        const manager = new ExtractionTaskManager({
            store, model, verifySource: async () => undefined, resolvePipeline: () => pipeline, launch: createTestLaunch().launch,
        });

        const started = await manager.start({kind: "outline", source, params: {workTitle: "真实库", structure, corrections: [], destination: {kind: "new"}} as never});
        await manager.whenIdle();
        const task = await manager.get(started.id);
        expect(task.status).toBe("completed");
        // 2 章 x (细纲 + 章节大纲) + 1 卷 + 1 总纲。
        expect(model.requests).toHaveLength(6);

        const outcome = readOutlineExtractionOutcome(task);
        expect(outcome.planTitle).toBe("提取方案1·真实库");
        const snapshot = await planning.snapshot();
        const layout = readPlanLayout(snapshot, outcome.planId)!;
        expect(layout.chapterIds).toHaveLength(2);
        const entries = snapshot.entries.map(({value}) => value).filter(value => value.id === layout.totalId || layout.volumeIds.includes(value.id) || layout.chapterIds.includes(value.id));
        expect(entries.every(entry => entry.status === "adopted" && entry.body.trim() !== "")).toBe(true);
        const details = snapshot.entries.map(({value}) => value).filter(value => value.kind === "detail");
        expect(details).toHaveLength(2);
        expect(details.every(detail => detail.status === "adopted" && detail.basis?.kind === "source-extraction")).toBe(true);
    }, 60_000);
});
