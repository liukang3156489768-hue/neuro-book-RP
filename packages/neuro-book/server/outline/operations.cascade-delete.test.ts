import {describe, expect, it} from "vitest";
import {inspectPlanningObject, preparePlanningObjectDeletionFromSnapshot} from "./operations";
import {PlanningFixture} from "./line-graph.fixture";

describe("级联删除逻辑", () => {
    it("删除章节（叶子条目）直接删除，不要求解除引用", () => {
        const fixture = new PlanningFixture();
        const created = fixture.library({kind: "create-plan", title: "方案A"});
        const planId = created.planId!;
        const totalId = created.entryId!;
        const volumeId = fixture.library({kind: "create-entry", planId, parentId: totalId, entryKind: "volume", title: "第一卷", body: "卷纲"}).entryId!;
        const chapterId = fixture.library({kind: "create-entry", planId, parentId: volumeId, entryKind: "chapter", title: "第一章", body: "章节"}).entryId!;

        const impact = inspectPlanningObject(fixture.snapshot, chapterId);

        expect(impact.canDeleteObject).toBe(true);
        expect(impact.entryKind).toBe("chapter");
        expect(impact.children).toEqual([]);
        expect(impact.cascadeCount).toBe(1);
        expect(impact.references.length).toBeGreaterThan(0); // 有 placement 引用，但不阻止删除

        const deletion = preparePlanningObjectDeletionFromSnapshot(fixture.snapshot, chapterId);
        expect(deletion.mutations.some(m => m.content === null)).toBe(true); // 有文件删除
    });

    it("删除卷纲会级联删除所有子章节", () => {
        const fixture = new PlanningFixture();
        const created = fixture.library({kind: "create-plan", title: "方案A"});
        const planId = created.planId!;
        const totalId = created.entryId!;
        const volumeId = fixture.library({kind: "create-entry", planId, parentId: totalId, entryKind: "volume", title: "第一卷", body: "卷纲"}).entryId!;
        const chapter1Id = fixture.library({kind: "create-entry", planId, parentId: volumeId, entryKind: "chapter", title: "第一章", body: "章节1"}).entryId!;
        const chapter2Id = fixture.library({kind: "create-entry", planId, parentId: volumeId, entryKind: "chapter", title: "第二章", body: "章节2"}).entryId!;
        const detail1Id = fixture.library({kind: "create-entry", planId, parentId: chapter1Id, entryKind: "detail", title: "细纲1", body: "细纲1"}).entryId!;

        const impact = inspectPlanningObject(fixture.snapshot, volumeId);

        expect(impact.canDeleteObject).toBe(true);
        expect(impact.entryKind).toBe("volume");
        expect(impact.children.sort()).toEqual([chapter1Id, chapter2Id].sort());
        expect(impact.cascadeCount).toBe(4); // 卷纲 + 2章节 + 1细纲

        const deletion = preparePlanningObjectDeletionFromSnapshot(fixture.snapshot, volumeId);

        // 验证删除了所有相关文件
        const deletedFiles = deletion.mutations.filter(m => m.content === null);
        expect(deletedFiles.length).toBe(4); // 卷纲 + 2章节 + 1细纲

        // 验证 manifest 中移除了所有条目
        const manifestMutation = deletion.mutations.find(m => m.relativePath === "outline/manifest.yaml");
        expect(manifestMutation).toBeDefined();
        expect(manifestMutation!.content).toBeDefined();

        // 简单验证 manifest 内容不包含被删除的 ID
        const manifestContent = manifestMutation!.content!;
        expect(manifestContent).not.toContain(volumeId);
        expect(manifestContent).not.toContain(chapter1Id);
        expect(manifestContent).not.toContain(chapter2Id);
        expect(manifestContent).not.toContain(detail1Id);
    });

    it("删除预览列出以该条目为总纲的方案与受影响方案", () => {
        const fixture = new PlanningFixture();
        const created = fixture.library({kind: "create-plan", title: "方案A"});
        const planId = created.planId!;
        const totalId = created.entryId!;
        const volumeId = fixture.library({kind: "create-entry", planId, parentId: totalId, entryKind: "volume", title: "第一卷", body: "卷纲"}).entryId!;
        const otherPlanId = fixture.library({kind: "create-plan", title: "方案B"}).planId!;

        const totalImpact = inspectPlanningObject(fixture.snapshot, totalId);
        expect(totalImpact.entryKind).toBe("total");
        expect(totalImpact.usedByPlanIds).toEqual([planId]);
        expect(totalImpact.affectedPlanIds).toEqual([planId]);
        expect(totalImpact.canDeleteObject).toBe(false);

        // 非总纲条目不会被任何方案当作总纲使用；挂载了它的方案才算受影响。
        const volumeImpact = inspectPlanningObject(fixture.snapshot, volumeId);
        expect(volumeImpact.usedByPlanIds).toEqual([]);
        expect(volumeImpact.affectedPlanIds).toEqual([planId]);
        expect(volumeImpact.affectedPlanIds).not.toContain(otherPlanId);
        expect(volumeImpact.canDeleteObject).toBe(true);
    });

    it("总纲仍被方案使用时拒绝删除，即使带 confirmedTotal；共用总纲的方案都列入 usedByPlanIds", () => {
        const fixture = new PlanningFixture();
        const created = fixture.library({kind: "create-plan", title: "方案A"});
        const planId = created.planId!;
        const totalId = created.entryId!;
        const sharingPlanId = fixture.library({kind: "create-plan", title: "方案B"}).planId!;
        fixture.library({kind: "associate-total", planId: sharingPlanId, totalId: totalId});

        const impact = inspectPlanningObject(fixture.snapshot, totalId);
        expect([...impact.usedByPlanIds].sort()).toEqual([planId, sharingPlanId].sort());
        expect([...impact.affectedPlanIds].sort()).toEqual([planId, sharingPlanId].sort());
        expect(impact.canDeleteObject).toBe(false);

        expect(() => preparePlanningObjectDeletionFromSnapshot(fixture.snapshot, totalId, false)).toThrow("总纲仍被方案使用");
        expect(() => preparePlanningObjectDeletionFromSnapshot(fixture.snapshot, totalId, true)).toThrow("总纲仍被方案使用");
    });

    it("孤立总纲（不再被任何方案使用）仍需 confirmedTotal 才能删除", () => {
        const fixture = new PlanningFixture();
        const created = fixture.library({kind: "create-plan", title: "方案A"});
        const planId = created.planId!;
        const orphanId = created.entryId!;
        const otherTotalId = fixture.library({kind: "create-plan", title: "方案B"}).entryId!;
        // 空总纲无需 confirmReplace；方案A 改用方案B 的总纲后，原总纲成为孤立条目。
        fixture.library({kind: "associate-total", planId, totalId: otherTotalId});

        const impact = inspectPlanningObject(fixture.snapshot, orphanId);
        expect(impact.entryKind).toBe("total");
        expect(impact.usedByPlanIds).toEqual([]);
        expect(impact.canDeleteObject).toBe(true);

        expect(() => preparePlanningObjectDeletionFromSnapshot(fixture.snapshot, orphanId, false))
            .toThrow("删除总纲需要二次确认");

        const deletion = preparePlanningObjectDeletionFromSnapshot(fixture.snapshot, orphanId, true);
        expect(deletion.mutations.filter((m) => m.content === null).length).toBeGreaterThan(0);
        fixture.publish(deletion);
        expect(fixture.snapshot.entries.some(({value}) => value.id === orphanId)).toBe(false);
        // 仍在使用的总纲不受影响。
        expect(fixture.snapshot.manifest.plans.every((plan) => plan.totalId === otherTotalId)).toBe(true);
    });

    it("线路图节点引用不阻止删除，但会在 affectedGraphNodes 中列出", () => {
        const fixture = new PlanningFixture();
        const created = fixture.library({kind: "create-plan", title: "方案A"});
        const planId = created.planId!;
        const totalId = created.entryId!;
        const chapterId = fixture.library({kind: "create-entry", planId, parentId: totalId, entryKind: "chapter", title: "第一章", body: "章节"}).entryId!;

        // 创建线路图并添加节点
        fixture.graph("add-graph-node", planId, {column: 0, row: 0, entryId: chapterId});

        const impact = inspectPlanningObject(fixture.snapshot, chapterId);

        expect(impact.canDeleteObject).toBe(true);
        expect(impact.affectedGraphNodes.length).toBeGreaterThan(0);
        expect(impact.affectedGraphNodes[0].planId).toBe(planId);

        // 仍然可以删除
        const deletion = preparePlanningObjectDeletionFromSnapshot(fixture.snapshot, chapterId);
        expect(deletion.mutations.some(m => m.content === null)).toBe(true);
    });
});
