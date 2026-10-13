import type {ExtractionSourceRef, ExtractionTask, ExtractionUnit, JsonRecord} from "nbook/shared/dto/inspiration-extraction-task.dto";
import {ExtractionTaskError} from "./errors";
import type {ExtractionLaunch} from "./manager";
import type {
    ExtractionModelPort,
    ExtractionModelRequest,
    ExtractionPipeline,
    ExtractionTaskPatch,
    ExtractionUnitContext,
    PipelineSettlement,
    PreparedExtraction,
} from "./types";

/**
 * 提取框架的测试替身：脚本化 Mock 模型、可手动中止的宿主、以及两条演示流水线。
 * 大纲／素材切片的流水线测试可以直接复用模型与宿主替身。只在测试中使用，不接入真实模型。
 */

export type ScriptedModelHandler = (request: ExtractionModelRequest, callIndex: number) => string | Promise<string>;

export type ScriptedModel = ExtractionModelPort & {
    readonly requests: ExtractionModelRequest[];
};

/** 每次调用先记录请求，再交给脚本；取消信号会让进行中的调用像真实模型一样立即中止。 */
export function createScriptedModel(handler: ScriptedModelHandler): ScriptedModel {
    const requests: ExtractionModelRequest[] = [];
    return {
        requests,
        async complete(request) {
            const index = requests.length;
            requests.push(request);
            request.signal.throwIfAborted();
            const aborted = new Promise<never>((_, reject) => {
                request.signal.addEventListener("abort", () => reject(request.signal.reason), {once: true});
            });
            return Promise.race([Promise.resolve(handler(request, index)), aborted]);
        },
    };
}

/** 一道可手动放行的门，用来把模型调用停在“进行中”。 */
export function createGate(): {readonly wait: Promise<void>; open(): void} {
    let open!: () => void;
    const wait = new Promise<void>(resolve => { open = resolve; });
    return {wait, open};
}

export type TestLaunch = {
    readonly launch: ExtractionLaunch;
    /** 模拟项目关闭：中止生命周期信号。 */
    closeProject(): void;
    /** 模拟项目未打开：此后 `launch` 同步抛错。 */
    readonly launched: () => number;
};

export function createTestLaunch(options: Readonly<{rejectWith?: Error}> = {}): TestLaunch {
    const lifecycle = new AbortController();
    let count = 0;
    return {
        launch(body) {
            if (options.rejectWith) throw options.rejectWith;
            count += 1;
            void body(lifecycle.signal);
        },
        closeProject: () => lifecycle.abort(new Error("项目已关闭")),
        launched: () => count,
    };
}

export function testSource(path = "reference/novel.md", sha256 = "a".repeat(64)): ExtractionSourceRef {
    return {path, sha256};
}

function textOf(output: string, tag: string): string {
    return output.startsWith(`${tag}:`) ? output.slice(tag.length + 1) : "";
}

/** 演示用校验：产出必须以 `OK:` 开头。 */
export function validateOk(output: string) {
    const body = textOf(output, "OK");
    return body ? {ok: true as const, value: body} : {ok: false as const, error: `产出必须以 OK: 开头，实际是「${output.slice(0, 40)}」`};
}

function stateResult(task: ExtractionTask, unitId: string): string {
    const value = task.state[`result:${unitId}`];
    return typeof value === "string" ? value : "";
}

function resolved(unit: ExtractionUnit): boolean {
    return unit.status === "done" || unit.status === "skipped";
}

/**
 * 大纲形态的演示流水线：章节单元 → 每卷一个汇总单元 → 一个总纲单元。
 * 汇总依赖本卷全部章节“完成或已跳过”，总纲依赖全部卷汇总完成；章节失败会让所属卷的汇总留在等待，
 * 直到该章节被重试成功或被明确跳过。
 * `params.layout` 形如 `{"v1": ["c1", "c2"]}`。
 */
export function createLayeredPipeline(): ExtractionPipeline {
    function layout(params: JsonRecord): Record<string, string[]> {
        const value = params.layout;
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new ExtractionTaskError("INVALID_INPUT", "缺少 layout");
        return Object.fromEntries(Object.entries(value).map(([volume, chapters]) => [volume, (chapters as string[]).slice()]));
    }
    return {
        async prepare({params}): Promise<PreparedExtraction> {
            const volumes = layout(params);
            return {
                units: [
                    ...Object.entries(volumes).flatMap(([volume, chapters]) => chapters.map(chapter => ({id: `chapter:${chapter}`, step: "chapter", label: `章节 ${chapter}`, group: volume}))),
                    ...Object.keys(volumes).map(volume => ({id: `volume:${volume}`, step: "volume", label: `卷 ${volume}`, group: volume})),
                    {id: "total", step: "total", label: "总纲", group: null},
                ],
            };
        },
        readyUnits(task) {
            const chapters = task.units.filter(unit => unit.step === "chapter");
            const volumes = task.units.filter(unit => unit.step === "volume");
            const ready: ExtractionUnit[] = chapters.filter(unit => unit.status === "pending");
            for (const volume of volumes) {
                const members = chapters.filter(unit => unit.group === volume.group);
                if (volume.status === "pending" && members.every(resolved)) ready.push(volume);
            }
            const total = task.units.find(unit => unit.step === "total");
            if (total?.status === "pending" && volumes.every(resolved)) ready.push(total);
            return ready;
        },
        async execute(unit, context: ExtractionUnitContext): Promise<ExtractionTaskPatch> {
            const members = context.task.units.filter(candidate => unit.step === "volume" ? candidate.step === "chapter" && candidate.group === unit.group : unit.step === "total" && candidate.step === "volume");
            const supplements = members.filter(member => member.status === "done").map(member => `${member.id} => ${stateResult(context.task, member.id)}`);
            const value = await context.generate({
                prompt: {prefix: `【原文】${unit.id}`, supplements, goal: `请提取 ${unit.id}`},
                validate: validateOk,
            });
            return {state: {[`result:${unit.id}`]: value}};
        },
        settle(): PipelineSettlement {
            return {kind: "finished"};
        },
    };
}

/**
 * 素材形态的演示流水线：块 × 类别单元全部完成后暂停等待人工归类，
 * 输入被接受后追加整合单元并继续（用 `settle` 的 `continue` 追加）。
 * `params.blocks` 与 `params.categories` 都是字符串数组。
 */
export function createClassifyingPipeline(): ExtractionPipeline {
    return {
        async prepare({params}): Promise<PreparedExtraction> {
            const blocks = params.blocks as string[];
            const categories = params.categories as string[];
            return {units: blocks.flatMap(block => categories.map(category => ({id: `extract:${block}:${category}`, step: "extract", label: `${block}/${category}`, group: block})))};
        },
        readyUnits: task => task.units.filter(unit => unit.status === "pending"),
        async execute(unit, context) {
            const value = await context.generate({
                // 同一块的不同类别共享逐字节相同的前缀，目标不同。
                prompt: {prefix: `【原文】${unit.group}`, goal: `请提取 ${unit.id}`},
                validate: validateOk,
            });
            return {state: {[`result:${unit.id}`]: value}};
        },
        settle(task): PipelineSettlement {
            if (task.state.classified !== true) return {kind: "awaiting-input", reason: "等待归类确认"};
            if (task.state.integrationQueued !== true) {
                const categories = [...new Set(task.units.filter(unit => unit.step === "extract").map(unit => unit.id.split(":")[2]!))];
                return {
                    kind: "continue",
                    patch: {appendUnits: categories.map(category => ({id: `integrate:${category}`, step: "integrate", label: `整合 ${category}`, group: "整合"})), state: {integrationQueued: true}},
                };
            }
            return {kind: "finished"};
        },
        acceptInput(_task, input) {
            if (!input || typeof input !== "object" || (input as {confirmed?: unknown}).confirmed !== true) {
                throw new ExtractionTaskError("INVALID_INPUT", "归类结果必须带 confirmed: true");
            }
            return {state: {classified: true}};
        },
    };
}
