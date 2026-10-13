import {PlanningFixture} from "nbook/server/outline/line-graph.fixture";
import {prepareSourceExtractionDetail} from "nbook/server/outline/library";
import {preparePlanningObjectDeletionFromSnapshot, preparePlanningPlanRemoval} from "nbook/server/outline/operations";
import type {OutlinePlanningPort} from "./outline-planning";

/**
 * 测试用端口：规划文件集放在内存里，但每次提交都走与磁盘读取相同的完整解析与 CAS，
 * 因此流水线测试使用的是真实的大纲领域操作，只是不经过 ready Project。
 * `failNext` 让下一次满足条件的写入抛错，用来验证“写入失败保留原内容”。
 */
export type FixturePlanning = OutlinePlanningPort & Readonly<{
    fixture: PlanningFixture;
    /** 之后的写入中，`when` 返回 true 的那一次抛出错误（一次性）。 */
    failNext(when: (write: FixtureWrite) => boolean, message?: string): void;
    /** 已发生的写入次数（create-plan、create-entry 等各算一次）。 */
    readonly writes: readonly FixtureWrite[];
}>;

export type FixtureWrite = Readonly<{kind: string; entryId?: string; title?: string}>;

export function createFixturePlanning(fixture = new PlanningFixture()): FixturePlanning {
    const writes: FixtureWrite[] = [];
    let failure: {when: (write: FixtureWrite) => boolean; message: string} | null = null;
    function record(write: FixtureWrite): void {
        if (failure?.when(write)) {
            const {message} = failure;
            failure = null;
            throw new Error(message);
        }
        writes.push(write);
    }
    return {
        fixture,
        writes,
        failNext(when, message = "模拟写入失败") { failure = {when, message}; },
        async snapshot() { return fixture.snapshot; },
        async apply(action) {
            record({kind: action.kind, ...("title" in action ? {title: action.title} : {}), ...("entryId" in action ? {entryId: action.entryId} : {})});
            const change = fixture.library(action);
            return {...(change.entryId ? {entryId: change.entryId} : {}), ...(change.planId ? {planId: change.planId} : {})};
        },
        async createDetail(input) {
            record({kind: "source-detail", title: input.title});
            const change = prepareSourceExtractionDetail(fixture.snapshot, input);
            fixture.publish(change.publish);
            return change.entryId!;
        },
        async removeEntry(entryId, options = {}) {
            record({kind: "remove-entry", entryId});
            fixture.publish(preparePlanningObjectDeletionFromSnapshot(fixture.snapshot, entryId, options.confirmedTotal === true));
        },
        async removePlan(planId) {
            record({kind: "remove-plan"});
            fixture.publish(preparePlanningPlanRemoval(fixture.snapshot, planId));
        },
    };
}
