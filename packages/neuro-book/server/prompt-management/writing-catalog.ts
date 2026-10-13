import type {PromptPurposeDefinition} from "nbook/shared/dto/prompt-management.dto";
import {WRITER_SYSTEM_SECTIONS, SCENE_WRITER_SECTIONS, REWRITE_WRITER_SECTIONS} from "nbook/shared/prompt-management/writing-templates";
import {promptVariableNames} from "./render";

/** 文风文件本身允许「禁用写法」「样文」留空，是仅有的两个允许整条停用的写手变量；其余都是程序从源文件截取的事实，停用会被拒绝保存。 */
const OPTIONAL_VARIABLES = new Set(["forbidden", "sample"]);

export function loadWritingPromptDefinitions(): PromptPurposeDefinition[] {
    return [
        {purposeId: "writing.writer.scene", label: "写手 · 场景正文", description: "将场景规划写成正文，衔接已通过的内容。", entries: [...WRITER_SYSTEM_SECTIONS, ...SCENE_WRITER_SECTIONS]},
        {purposeId: "writing.writer.rewrite", label: "写手 · 局部改写", description: "依据修改要求重写目标片段，保留上下文衔接。", entries: [...WRITER_SYSTEM_SECTIONS, ...REWRITE_WRITER_SECTIONS]},
    ].map(({entries, ...purpose}) => {
        const variables = [...promptVariableNames(entries)];
        return {...purpose, module: "writing" as const, entries, variables, requiredVariables: variables.filter(name => !OPTIONAL_VARIABLES.has(name))};
    });
}
