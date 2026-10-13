import fs from "node:fs/promises";
import {afterEach, describe, expect, it, vi} from "vitest";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import {createEmptyManifest, serializeManifest} from "./format";
import {publishPlanningFiles, readPlanningSnapshot} from "./index";
import {prepareLibraryAction} from "./library";
import {generateDirectionDraft, OutlineGenerationError} from "./direction";
import {createOutlineRepository} from "./repository";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true}))));

async function setup() {
    const projectRoot = await createTestTmpRoot("outline-direction", "direction-draft");
    roots.push(projectRoot);
    await createOutlineRepository({projectRoot}).ensureLayout(serializeManifest(createEmptyManifest()));
    const perform = async (action: Parameters<typeof prepareLibraryAction>[1]) => {
        const change = prepareLibraryAction(await readPlanningSnapshot({projectRoot}), action);
        await publishPlanningFiles({projectRoot}, change.publish);
        return change;
    };
    const created = await perform({kind: "create-plan", title: "方案甲"});
    const planId = created.planId!;
    const totalId = created.entryId!;
    return {projectRoot, totalId: totalId!, planId: planId!, perform};
}

describe("简单方向生成大纲草案", () => {
    it("把方案上下文交给生成器，只返回可审阅草案而不写文件", async () => {
        const {projectRoot, totalId, planId, perform} = await setup();
        await perform({kind: "create-entry", planId, parentId: totalId, entryKind: "volume", title: "第一卷", body: "开端"});
        const before = await readPlanningSnapshot({projectRoot});
        const complete = vi.fn(async (prompt: string) => {
            expect(prompt).toContain("方案甲");
            expect(prompt).toContain("第一卷");
            expect(prompt).toContain("寻找失踪的朋友");
            return JSON.stringify({title: " 寻人 ", body: " 城中调查 "});
        });
        const result = await generateDirectionDraft(before, {planId, parentId: totalId, entryKind: "chapter",
            direction: "寻找失踪的朋友"}, complete);
        expect(result).toEqual({expectedRevision: before.manifest.revision, direction: "寻找失踪的朋友", parentContentHash: before.entries.find(({value}) => value.id === totalId)?.contentHash,
            planId, parentId: totalId, entryKind: "chapter", title: "寻人", body: "城中调查"});
        expect(complete).toHaveBeenCalledTimes(1);
        expect(await readPlanningSnapshot({projectRoot})).toEqual(before);
    });

    it("拒绝无效父级、损坏结果和模型失败，均不改变规范文件", async () => {
        const {projectRoot, totalId, planId} = await setup();
        const before = await readPlanningSnapshot({projectRoot});
        const input = {planId, parentId: totalId, entryKind: "detail" as const, direction: "场景"};
        const complete = vi.fn(async () => JSON.stringify({title: "场景", body: "描述"}));
        await expect(generateDirectionDraft(before, input, complete)).rejects.toThrow(/父级/);
        expect(complete).not.toHaveBeenCalled();
        const valid = {...input, entryKind: "chapter" as const};
        await expect(generateDirectionDraft(before, valid, async () => "```json\n{}\n```"))
            .rejects.toBeInstanceOf(OutlineGenerationError);
        await expect(generateDirectionDraft(before, valid, async () => JSON.stringify({title: "", body: ""})))
            .rejects.toBeInstanceOf(OutlineGenerationError);
        await expect(generateDirectionDraft(before, valid, async () => { throw new Error("private provider response"); }))
            .rejects.toMatchObject({code: "MODEL_FAILED"});
        expect(await readPlanningSnapshot({projectRoot})).toEqual(before);
    });
});

