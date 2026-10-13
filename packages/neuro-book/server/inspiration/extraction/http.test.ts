import {describe, expect, it} from "vitest";
import {OutlineStructureError} from "../outline-structure";
import {ExtractionFatalError, ExtractionTaskError, ExtractionValidationFailure} from "./errors";
import {agentConfirmer, createTaskSerializer, USER_CONFIRMER} from "./host";
import {createExtractionHttpError} from "./http";
import {MaterialReviewError} from "./material-review";
import {ExtractionModelError} from "./model-adapter";
import {createGate} from "./testing";

describe("按任务串行队列", () => {
    it("同一任务的操作按提交顺序执行，前一个失败不阻塞后一个，不同任务互不等待", async () => {
        const serialize = createTaskSerializer();
        const log: string[] = [];
        const gate = createGate();
        const first = serialize("a", async () => { log.push("a1:start"); await gate.wait; log.push("a1:end"); });
        const failing = serialize("a", async () => { log.push("a2"); throw new Error("失败"); });
        const third = serialize("a", async () => { log.push("a3"); });
        const other = serialize("b", async () => { log.push("b1"); });
        await other;
        expect(log).toEqual(["a1:start", "b1"]);
        gate.open();
        await first;
        await expect(failing).rejects.toThrow("失败");
        await third;
        expect(log).toEqual(["a1:start", "b1", "a1:end", "a2", "a3"]);
    });
});

describe("确认者", () => {
    it("界面确认者固定为用户；Agent 确认者携带会话 ID 且不可变", () => {
        expect(USER_CONFIRMER).toEqual({kind: "user"});
        expect(Object.isFrozen(USER_CONFIRMER)).toBe(true);
        expect(agentConfirmer("9")).toEqual({kind: "agent", sessionId: "9"});
    });
});

describe("领域错误到 HTTP 的映射", () => {
    it.each<[Error, number, string]>([
        [new ExtractionTaskError("NOT_FOUND", "x"), 404, "NOT_FOUND"],
        [new ExtractionTaskError("CONFLICT", "x"), 409, "CONFLICT"],
        [new ExtractionTaskError("INVALID_STATE", "x"), 409, "INVALID_STATE"],
        [new ExtractionTaskError("SOURCE_CHANGED", "x"), 409, "SOURCE_CHANGED"],
        [new ExtractionTaskError("INVALID_INPUT", "x"), 422, "INVALID_INPUT"],
        [new ExtractionTaskError("PIPELINE_UNREGISTERED", "x"), 503, "PIPELINE_UNREGISTERED"],
        [new MaterialReviewError("NOT_FOUND", "x"), 404, "REVIEW_NOT_FOUND"],
        [new MaterialReviewError("INVALID", "x"), 422, "REVIEW_INVALID"],
        [new MaterialReviewError("LOCKED", "x"), 409, "REVIEW_LOCKED"],
        [new ExtractionValidationFailure(["x"]), 422, "MODEL_OUTPUT_INVALID"],
        [new ExtractionModelError("x"), 503, "MODEL_UNAVAILABLE"],
    ])("%o", (error, statusCode, code) => {
        expect(createExtractionHttpError(error)).toMatchObject({statusCode, data: {code}});
    });

    it("划卷违反规则 422；来源变化的致命错误 409；未知错误不吞掉", () => {
        const structure = new OutlineStructureError("VOLUME_GAP", "划卷无效");
        expect(createExtractionHttpError(structure)).toMatchObject({statusCode: 422, data: {code: structure.code}});
        expect(createExtractionHttpError(new ExtractionFatalError("source-changed", "x"))).toMatchObject({statusCode: 409, data: {code: "SOURCE_CHANGED"}});
        expect(createExtractionHttpError(new ExtractionFatalError("model-unavailable", "x"))).toMatchObject({statusCode: 503});
        expect(createExtractionHttpError(new Error("意外"))).toBeNull();
    });
});
