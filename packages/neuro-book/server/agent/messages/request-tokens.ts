import type {Tool} from "nbook/server/agent/messages/types";
import type {StoredMessageLike} from "nbook/server/agent/messages/stored-message-presentation";
import {estimateStoredContextTokens, estimateStoredMessageTokens} from "nbook/server/agent/messages/stored-message-tokens";
import {storedMessageForEstimate} from "nbook/server/agent/messages/stored-message-presentation";

/** 请求前估算；Provider usage 是校准值，非 ASCII 文本需避免统一 chars/4 的低估。 */
export function estimateRequestTextTokens(text: string): number {
    let ascii = 0;
    let unicode = 0;
    for (const character of text) {
        if (character.codePointAt(0)! < 128) ascii += 1;
        else unicode += 1;
    }
    return Math.ceil(ascii / 4 + unicode * 1.5);
}

export function estimateRequestMessageTokens(message: StoredMessageLike): number {
    return Math.max(estimateStoredMessageTokens(message), estimateRequestTextTokens(JSON.stringify(storedMessageForEstimate(message))));
}

export function estimateRequestOverheadTokens(input: {systemPrompt?: string; tools?: readonly Tool[]}): number {
    return estimateRequestTextTokens(input.systemPrompt ?? "")
        + (input.tools?.length ? estimateRequestTextTokens(JSON.stringify(input.tools)) + input.tools.length * 8 : 0);
}

export function estimateFinalRequestTokens(input: {
    messages: readonly StoredMessageLike[];
    systemPrompt?: string;
    tools?: readonly Tool[];
}): number {
    const structural = input.messages.reduce((tokens, message) => tokens + estimateRequestMessageTokens(message), 0)
        + estimateRequestOverheadTokens(input);
    // 最近一次 Provider usage 已包含当时的 system/tools，不在校准值上重复追加固定前缀。
    return Math.max(estimateStoredContextTokens(input.messages).tokens, structural);
}
