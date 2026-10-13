import type {AbsoluteFsPath} from "nbook/server/runtime/paths/file-path";
import type {ExtractionSourceRef} from "nbook/shared/dto/inspiration-extraction-task.dto";
import {prepareInspirationSource} from "../source";

/**
 * 以磁盘上的来源文件为准复核启动时记录的内容哈希。来源被修改、移动、删除或不可读都视为变化，
 * 抛出的错误由任务框架转成“来源已变化”；不读取客户端传来的哈希或预览。
 * 每次校验会重读并哈希整份来源（上限 5 MiB），相对一次模型调用的耗时可以忽略。
 */
export function createSourceVerifier(root: AbsoluteFsPath): (source: ExtractionSourceRef) => Promise<void> {
    return async source => {
        const current = await prepareInspirationSource(root, source.path);
        if (current.source.sha256 !== source.sha256) {
            throw new Error(`作品「${source.path}」的内容已变化`);
        }
    };
}
