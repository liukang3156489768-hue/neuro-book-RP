import type {PlanningSnapshot} from "nbook/server/outline";
import type {OutlineId} from "nbook/server/outline/format";
import {renderSummaryPrefix, SUMMARY_SYSTEM_PROMPT, totalGoal, volumeGoal, type SummaryItem} from "./outline-prompts";
import {hasBody, readPlanLayout, type PlanLayout} from "./outline-planning";
import {validatePlainOutput, validateTotalBody, validateVolumeBody} from "./outline-validation";
import type {GenerateRequest} from "./types";

/**
 * 卷纲与总纲的汇总请求。流水线单元与“重新汇总本卷与总纲”服务共用，
 * 保证两处读到的输入、提示词和校验完全一致：输入只来自大纲库里的下级大纲，不含原文。
 */

function requireLayout(snapshot: PlanningSnapshot, planId: string): PlanLayout {
    const layout = readPlanLayout(snapshot, planId);
    if (!layout) throw new Error("提取方案已不存在，无法汇总");
    return layout;
}

function titled(label: string, title: string): string {
    return title.trim() === "" ? label : `${label}：${title.trim()}`;
}

export function volumeSummaryRequest(snapshot: PlanningSnapshot, planId: string, volumeId: OutlineId): GenerateRequest<string> {
    const layout = requireLayout(snapshot, planId);
    const volume = snapshot.entries.find(({value}) => value.id === volumeId)?.value;
    if (!volume) throw new Error("卷纲条目已不存在，无法汇总");
    const chapters = layout.childrenOf(volumeId).filter(({value}) => value.kind === "chapter");
    const items: SummaryItem[] = chapters.map(({value}, position) => ({
        label: titled(`第${position + 1}章`, value.title), body: hasBody(value) ? value.body : null,
    }));
    if (items.every(item => item.body === null)) throw new Error(`「${volume.title}」没有任何可汇总的章节大纲`);
    return {
        purposeId: "extraction.outline.volume",
        variables: {volumeTitle: volume.title, missingRule: items.some(item => item.body === null)
            ? "- 部分章节缺失：在相应部分说明哪些章节缺失，不要猜测它们的内容。" : ""},
        system: SUMMARY_SYSTEM_PROMPT,
        prompt: {
            prefix: renderSummaryPrefix(`${volume.title}的章节大纲`, items),
            goal: volumeGoal(volume.title, items.some(item => item.body === null)),
        },
        validate: validatePlainOutput(validateVolumeBody),
    };
}

export function totalSummaryRequest(snapshot: PlanningSnapshot, planId: string, workTitle: string): GenerateRequest<string> {
    const layout = requireLayout(snapshot, planId);
    const volumes = layout.volumeIds.map(id => snapshot.entries.find(({value}) => value.id === id)!.value);
    const items: SummaryItem[] = volumes.map((value, position) => ({
        label: titled(`第${position + 1}卷`, value.title), body: hasBody(value) ? value.body : null,
    }));
    if (items.length === 0 || items.every(item => item.body === null)) throw new Error("方案没有任何可汇总的卷纲");
    return {
        purposeId: "extraction.outline.total",
        variables: {workTitle, missingRule: items.some(item => item.body === null)
            ? "- 部分卷缺失：在相应部分说明哪些卷缺失，不要猜测它们的内容。" : ""},
        system: SUMMARY_SYSTEM_PROMPT,
        prompt: {
            prefix: renderSummaryPrefix("各卷卷纲", items),
            goal: totalGoal(workTitle, items.some(item => item.body === null)),
        },
        validate: validatePlainOutput(validateTotalBody),
    };
}
