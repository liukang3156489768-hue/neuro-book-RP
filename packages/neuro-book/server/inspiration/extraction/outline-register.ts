import type {AbsoluteFsPath} from "nbook/server/runtime/paths/file-path";
import type {ExtractionSourceRef} from "nbook/shared/dto/inspiration-extraction-task.dto";
import {prepareInspirationSource} from "../source";
import {ExtractionFatalError} from "./errors";
import {createOutlinePipeline, type SourceParagraph} from "./outline-pipeline";
import {createReadyOutlinePlanning} from "./outline-planning";
import {registerExtractionPipeline} from "./runtime";
import {createFileExtractionStore} from "./store-file";

/**
 * 每个单元都需要章节原文，但读取并切分一份最大 5 MiB 的来源不便宜；只缓存最近一份，
 * 因为同一时间一个项目里通常只有一个大纲提取任务在读来源。
 */
export function createParagraphLoader(root: AbsoluteFsPath): (source: ExtractionSourceRef) => Promise<readonly SourceParagraph[]> {
    let cached: {key: string; paragraphs: readonly SourceParagraph[]} | null = null;
    return async source => {
        const key = `${source.path}\n${source.sha256}`;
        if (cached?.key === key) return cached.paragraphs;
        const prepared = await prepareInspirationSource(root, source.path);
        if (prepared.source.sha256 !== source.sha256) {
            throw new ExtractionFatalError("source-changed", `作品「${source.path}」的内容已变化，任务不能继续。`);
        }
        cached = {key, paragraphs: prepared.paragraphs.map(({id, text}) => ({id, text}))};
        return cached.paragraphs;
    };
}

let registered = false;

/**
 * 向提取任务框架注册大纲流水线。幂等，用法与 `registerMaterialExtractionPipeline` 相同：
 * 路由层与测试都可以调用；测试清空注册表后需要重置这里的标记。
 */
export function registerOutlineExtractionPipeline(): void {
    if (registered) return;
    registerExtractionPipeline("outline", ({target, ready}) => createOutlinePipeline({
        planning: createReadyOutlinePlanning(ready),
        loadParagraphs: createParagraphLoader(target.root),
        listTasks: () => createFileExtractionStore(target).list(),
    }));
    registered = true;
}

/** 仅供测试：与 `resetExtractionPipelinesForTests` 配套使用。 */
export function resetOutlinePipelineRegistrationForTests(): void {
    registered = false;
}
