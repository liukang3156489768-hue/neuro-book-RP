import type {TavernBindings, TavernOutputPolicy, TavernWriterPreset} from "nbook/shared/dto/tavern-preset.dto";
import {TavernOutputPolicySchema} from "nbook/shared/dto/tavern-preset.dto";
import {applyTavernRegex, parseTavernPreset, type TavernState} from "nbook/server/prompt-management/tavern-preset";
import {createTavernMacroEvaluator} from "nbook/server/prompt-management/tavern-macros";
import {isSupportedTuringQualityScript, scanTuringQuality, type TavernQualityReport} from "./tavern-output-quality";

export type TavernWriterOutput = {
    raw: string; stored: string; display: string; prose: string | null; extractionError: string | null;
    variablesAfter: TavernState; quality: TavernQualityReport[]; extensionWarnings: string[]; fullEnvironmentEquivalent: false;
};

function extractProse(stored: string, policy: TavernOutputPolicy): Pick<TavernWriterOutput, "prose" | "extractionError"> {
    if (policy.mode === "full") return {prose: stored.trim(), extractionError: null};
    const tag = policy.tag!;
    const opening = new RegExp(`<${tag}>`, "gi"), closing = new RegExp(`</${tag}>`, "gi");
    const opens = [...stored.matchAll(opening)], closes = [...stored.matchAll(closing)];
    // A missing or ambiguous envelope must not turn preamble, analysis or a partial response into chapter prose.
    if (opens.length !== 1 || closes.length !== 1 || opens[0]!.index >= closes[0]!.index) {
        return {prose: null, extractionError: `写手输出必须包含唯一完整的 <${tag}> 正文标签`};
    }
    const prose = stored.slice(opens[0]!.index + opens[0]![0].length, closes[0]!.index).trim();
    return prose ? {prose, extractionError: null} : {prose: null, extractionError: `写手输出的 <${tag}> 正文为空`};
}

/** Preserve provider text for audit; only stored regex output can become history or extracted chapter prose. */
export function processTavernWriterOutput(input: {
    sourceJson: string; raw: string; user: string; char: string; state?: TavernState;
    policy: TavernOutputPolicy; qualityScopeTag?: string; bindings?: TavernBindings; macroEngine?: TavernWriterPreset["macroEngine"];
}): TavernWriterOutput {
    const source = parseTavernPreset(input.sourceJson);
    const policy = TavernOutputPolicySchema.parse(input.policy);
    const state: TavernState = {local: {...input.state?.local}, global: {...input.state?.global}};
    const identity = {user: input.user, char: input.char};
    const bindings: TavernBindings = {...input.bindings, ...identity, slots: input.bindings?.slots ?? {}};
    const expand = createTavernMacroEvaluator(bindings, {...identity,
        persona: bindings.slots.personaDescription?.[0]?.content ?? "", scenario: bindings.slots.scenario?.[0]?.content ?? "",
        personality: bindings.slots.charPersonality?.[0]?.content ?? "", description: bindings.slots.charDescription?.[0]?.content ?? ""}, state, input.macroEngine);
    const stored = applyTavernRegex(source, input.raw, 2, "stored", 0, identity, state, expand);
    const display = applyTavernRegex(source, stored, 2, "display", 0, identity, state, expand);
    const quality: TavernQualityReport[] = [], extensionWarnings: string[] = [];
    for (const script of source.extensions?.tavern_helper?.scripts ?? []) {
        if (!script.enabled) continue;
        const content = script.content;
        if (typeof content === "string" && isSupportedTuringQualityScript(content)) {
            if (policy.qualityCheck !== false) quality.push(scanTuringQuality(stored, input.qualityScopeTag));
            extensionWarnings.push(`${script.name}：已适配本地扫描；云端复核、交互补丁和聊天统计尚未配置`);
        } else extensionWarnings.push(`${script.name}：未适配脚本，保留源码但不执行`);
    }
    return {raw: input.raw, stored, display, ...extractProse(stored, policy), variablesAfter: state,
        quality, extensionWarnings, fullEnvironmentEquivalent: false};
}
