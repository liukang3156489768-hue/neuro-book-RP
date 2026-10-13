import {tracedCompleteSimple} from "nbook/server/agent/observability/traced-provider";
import type {PiTraceBinding} from "nbook/server/agent/observability/traced-provider";
import type {Models} from "@earendil-works/pi-ai";
import {estimateStoredContextTokens, estimateStoredMessageTokens} from "nbook/server/agent/messages/stored-message-tokens";
import {estimateRequestTextTokens, estimateRequestMessageTokens, estimateRequestOverheadTokens} from "nbook/server/agent/messages/request-tokens";
import {
    type StoredMessageLike,
    storedMessagesForText,
} from "nbook/server/agent/messages/stored-message-presentation";
import type {AgentMessage, AssistantMessage, JsonValue, Message, Model, ThinkingLevel, Tool, ToolResultMessage, Usage} from "nbook/server/agent/messages/types";
import {
    COMPACTION_PROMPT,
    COMPACTION_SUMMARY_PREFIX,
    DEFAULT_PROFILE_RUNTIME_SETTINGS,
    resolveProfileRuntimeSettings,
} from "nbook/server/agent/profiles/profile-runtime-settings";
import type {ProfileCompactionRuntimePatch} from "nbook/shared/agent/profile-runtime-settings";
import type {JsonlSessionRepository} from "nbook/server/agent/session/session-repo";
import type {CompactionSessionEntry, CustomMessageSessionEntry, MessageSessionEntry, SessionEntry, SessionSnapshot} from "nbook/server/agent/session/types";
import {createUserMessage, EMPTY_USAGE, messageText, sumUsage} from "nbook/server/agent/messages/message-utils";
import {sanitizeProviderErrorMessage} from "nbook/server/agent/observability/provider-error-sanitizer";
import {mergePiRequestHeaders, parsePiSimpleRequestOptions, piRequestAuthOptions} from "nbook/server/agent/harness/pi-request-options";
import type {StoredAgentMessage, StoredToolResultMessage} from "nbook/server/agent/messages/stored-types";

export {COMPACTION_PROMPT, COMPACTION_SUMMARY_PREFIX};

export type CompactionProgress = {
    status: "running" | "completed" | "failed" | "cancelled";
    stage: "pruning" | "summarizing";
    startedAt: number;
    updatedAt: number;
    completedBatches: number;
    totalBatches?: number;
    tokensBefore: number;
    tokensAfter?: number;
    usage?: Usage;
    error?: string;
};

type CompactionRequestContext = {
    systemPrompt?: string;
    tools?: Tool[];
    /** Complete request overhead; excludes the messages supplied to the compactor. */
    requestOverheadTokens?: number;
    onProgress?: (progress: CompactionProgress) => Promise<void>;
};

export type CompactionOptions = {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
    triggerPercent?: number;
    triggerTokens?: number;
    prompt: string;
    summaryPrefix: string;
    promptSource: "default" | "profile";
    summaryPrefixSource: "default" | "profile";
};

export const DEFAULT_NEURO_COMPACTION_OPTIONS: Omit<CompactionOptions, "enabled"> = {
    reserveTokens: DEFAULT_PROFILE_RUNTIME_SETTINGS.compaction.reserveTokens,
    keepRecentTokens: DEFAULT_PROFILE_RUNTIME_SETTINGS.compaction.keepRecent.value,
    prompt: COMPACTION_PROMPT,
    summaryPrefix: COMPACTION_SUMMARY_PREFIX,
    promptSource: "default",
    summaryPrefixSource: "default",
};

type CompactionPlan = {
    firstKeptEntry: ModelVisibleSessionEntry | null;
    messagesToSummarize: StoredMessageLike[];
    previousSummary?: string;
    metrics: {
        recentTokens: number;
        summarizedTokens: number;
        firstKeptEntryType?: ModelVisibleSessionEntry["type"];
        visibleEntryCountBefore: number;
        recentEntryCount: number;
        summarizedEntryCount: number;
    };
};

type ModelVisibleSessionEntry = MessageSessionEntry | CustomMessageSessionEntry;

/**
 * 自动压缩：超过上下文预算时追加 compaction entry。
 */
export async function compactIfNeeded(input: CompactionRequestContext & {
    repo: JsonlSessionRepository;
    snapshot: SessionSnapshot;
    messages: StoredMessageLike[];
    models: Models;
    model: Model<any>;
    apiKey?: string;
    timeoutMs?: number | null;
    requestOptions?: Record<string, JsonValue>;
    thinkingLevel?: ThinkingLevel;
    compaction?: ProfileCompactionRuntimePatch;
    /** Prepare 的 AppendingSet 和当前输入必须整体保留，不能按近期预算裁掉。 */
    minRecentMessages?: number;
    trace?: PiTraceBinding;
    /** 为空表示调用方没有可取消生命周期；非空时透传给摘要 Provider。 */
    signal?: AbortSignal;
    writeCompactionEntry: (entry: Omit<CompactionSessionEntry, "id" | "parentId" | "timestamp">) => Promise<void>;
}): Promise<boolean> {
    if (!input.compaction) {
        return false;
    }
    const options = resolveCompactionOptions(input.compaction, input.model);
    if (!options.enabled) {
        return false;
    }

    const tokensBefore = estimateCompactionRequestTokens(input);
    if (!shouldCompactWithOptions(tokensBefore, input.model.contextWindow, options)) {
        return false;
    }
    await appendCompaction({
        repo: input.repo,
        snapshot: input.snapshot,
        messages: input.messages,
        models: input.models,
        tokensBefore,
        systemPrompt: input.systemPrompt,
        tools: input.tools,
        requestOverheadTokens: input.requestOverheadTokens,
        onProgress: input.onProgress,
        model: input.model,
        apiKey: input.apiKey,
        timeoutMs: input.timeoutMs,
        requestOptions: input.requestOptions,
        thinkingLevel: input.thinkingLevel,
        options,
        minRecentMessages: input.minRecentMessages,
        trace: input.trace,
        signal: input.signal,
        writeCompactionEntry: input.writeCompactionEntry,
    });
    return true;
}

/**
 * 追加 compaction entry。摘要由 LLM 生成，失败时不写入 session。
 */
export async function appendCompaction(input: CompactionRequestContext & {
    repo: JsonlSessionRepository;
    snapshot: SessionSnapshot;
    messages: StoredMessageLike[];
    models: Models;
    model: Model<any>;
    apiKey?: string;
    timeoutMs?: number | null;
    requestOptions?: Record<string, JsonValue>;
    thinkingLevel?: ThinkingLevel;
    tokensBefore?: number;
    instructions?: string;
    compaction?: ProfileCompactionRuntimePatch;
    options?: CompactionOptions;
    minRecentMessages?: number;
    trace?: PiTraceBinding;
    /** 为空表示调用方没有可取消生命周期；非空时透传给摘要 Provider。 */
    signal?: AbortSignal;
    writeCompactionEntry: (entry: Omit<CompactionSessionEntry, "id" | "parentId" | "timestamp">) => Promise<void>;
}): Promise<void> {
    if (!input.options && !input.compaction) {
        throw new Error("缺少 profile compaction 配置，无法执行压缩。");
    }
    const options = input.options ?? resolveCompactionOptions(input.compaction!, input.model);
    const path = input.repo.modelVisiblePath(input.snapshot);
    const visibleEntries = path.filter(isModelVisibleEntry);
    assertNoPendingToolCall(visibleEntries.map(entryMessage));
    const plan = selectCompactionPlan(path, options, input.minRecentMessages ?? 0);
    const tokensBefore = input.tokensBefore ?? estimateCompactionRequestTokens(input);
    const startedAt = Date.now();
    let progress: CompactionProgress = {status: "running", stage: "summarizing", startedAt, updatedAt: startedAt,
        completedBatches: 0, tokensBefore};
    const publish = async (patch: Partial<CompactionProgress>) => {
        progress = {...progress, ...patch, updatedAt: Date.now()};
        await input.onProgress?.(progress);
    };
    try {
        await publish({});
        const generated = await generateCompactionSummary({
            messages: plan.messagesToSummarize,
            models: input.models,
            model: input.model,
            apiKey: input.apiKey,
            timeoutMs: input.timeoutMs,
            requestOptions: input.requestOptions,
            instructions: input.instructions,
            previousSummary: plan.previousSummary,
            thinkingLevel: input.thinkingLevel,
            reserveTokens: options.reserveTokens,
            prompt: options.prompt,
            trace: input.trace,
            signal: input.signal,
            systemPrompt: input.systemPrompt,
            tools: input.tools,
            onBatchProgress: async (completedBatches, totalBatches, usage) => publish({completedBatches, totalBatches, usage}),
        });
        const summary = `${options.summaryPrefix}\n\n${generated.summary}`;

        const entry = {
            type: "compaction",
            summary,
            firstKeptEntryId: plan.firstKeptEntry?.id ?? null,
            tokensBefore,
            details: {
                instructions: input.instructions,
                reserveTokens: options.reserveTokens,
                keepRecentTokens: options.keepRecentTokens,
                triggerPercent: options.triggerPercent,
                triggerTokens: options.triggerTokens,
                promptSource: options.promptSource,
                summaryPrefixSource: options.summaryPrefixSource,
                recentTokens: plan.metrics.recentTokens,
                summarizedTokens: plan.metrics.summarizedTokens,
                visibleTokensBefore: tokensBefore,
                firstKeptEntryType: plan.metrics.firstKeptEntryType,
                visibleEntryCountBefore: plan.metrics.visibleEntryCountBefore,
                recentEntryCount: plan.metrics.recentEntryCount,
                summarizedEntryCount: plan.metrics.summarizedEntryCount,
                usage: generated.usage,
                totalBatches: generated.totalBatches,
            },
        } satisfies Omit<CompactionSessionEntry, "id" | "parentId" | "timestamp">;

        input.signal?.throwIfAborted();
        await input.writeCompactionEntry(entry);
        const keptIndex = plan.firstKeptEntry ? path.findIndex(entry => entry.id === plan.firstKeptEntry!.id) : path.length;
        const recentMessages = path.slice(keptIndex).filter(isModelVisibleEntry).map(entryMessage)
            .map(message => message.role === "assistant" ? {...message, usage: EMPTY_USAGE} : message);
        await publish({status: "completed", tokensAfter: estimateCompactionRequestTokens({...input,
            messages: [createUserMessage({text: summary}), ...recentMessages]})});
    } catch (error) {
        await publish({status: input.signal?.aborted ? "cancelled" : "failed",
            error: sanitizeProviderErrorMessage(error instanceof Error ? error.message : "上下文压缩失败")});
        throw error;
    }
}

function estimateCompactionRequestTokens(input: CompactionRequestContext & {messages: StoredMessageLike[]}): number {
    const structural = input.messages.reduce((total, message) => total + estimateRequestMessageTokens(message), 0)
        + (input.requestOverheadTokens ?? estimateRequestOverheadTokens(input));
    return Math.max(estimateStoredContextTokens(input.messages).tokens, structural);
}

/**
 * 将 profile compaction plan 解析成当前模型下的执行策略。
 */
export function resolveCompactionOptions(patch: ProfileCompactionRuntimePatch, model: Model<any>): CompactionOptions {
    const plan = resolveProfileRuntimeSettings(undefined, {compaction: patch}).compaction;
    const keepRecentTokens = plan.keepRecent.kind === "percent"
        ? Math.max(1, Math.floor(model.contextWindow * plan.keepRecent.value))
        : plan.keepRecent.value;
    return {
        enabled: plan.enabled,
        reserveTokens: plan.reserveTokens,
        keepRecentTokens,
        triggerPercent: plan.trigger.kind === "percent" ? plan.trigger.value : undefined,
        triggerTokens: plan.trigger.kind === "tokens"
            ? Math.min(plan.trigger.value, Math.max(1, model.contextWindow - plan.reserveTokens))
            : undefined,
        prompt: plan.prompt,
        summaryPrefix: plan.summaryPrefix,
        promptSource: plan.prompt === COMPACTION_PROMPT ? "default" : "profile",
        summaryPrefixSource: plan.summaryPrefix === COMPACTION_SUMMARY_PREFIX ? "default" : "profile",
    };
}

/**
 * 根据 profile/harness 策略判断是否需要自动压缩。
 */
export function shouldCompactWithOptions(contextTokens: number, contextWindow: number, options: CompactionOptions): boolean {
    if (!options.enabled) {
        return false;
    }
    if (typeof options.triggerTokens === "number") {
        return contextTokens >= options.triggerTokens;
    }
    if (typeof options.triggerPercent === "number") {
        return contextTokens / contextWindow >= options.triggerPercent;
    }
    return contextTokens > contextWindow - options.reserveTokens;
}

/**
 * 把压缩策略折算成一个绝对 token 触发线，供上下文面板展示「离压缩还有多远」。
 *
 * 必须与 `shouldCompactWithOptions` 的判定顺序一致（tokens 优先、其次 percent、
 * 最后 window - reserve），否则面板显示的线和真实触发时机会对不上。
 * 关闭压缩、或按窗口推算却拿不到窗口时返回 null。
 */
export function resolveCompactionTriggerTokens(options: CompactionOptions, contextWindow: number | null): number | null {
    if (!options.enabled) {
        return null;
    }
    if (typeof options.triggerTokens === "number") {
        return options.triggerTokens;
    }
    if (contextWindow === null) {
        return null;
    }
    if (typeof options.triggerPercent === "number") {
        return Math.floor(contextWindow * options.triggerPercent);
    }
    return contextWindow - options.reserveTokens;
}

/**
 * 构造真实 LLM 摘要。这里不做 fallback，避免失败时写入误导性摘要。
 */
async function generateCompactionSummary(input: {
    messages: StoredMessageLike[];
    models: Models;
    model: Model<any>;
    apiKey?: string;
    timeoutMs?: number | null;
    requestOptions?: Record<string, JsonValue>;
    instructions?: string;
    previousSummary?: string;
    thinkingLevel?: ThinkingLevel;
    reserveTokens: number;
    prompt: string;
    trace?: PiTraceBinding;
    /** 为空表示此次摘要不可由上层取消；非空时直接传给 Pi Provider。 */
    signal?: AbortSignal;
    systemPrompt?: string;
    tools?: Tool[];
    onBatchProgress: (completed: number, total: number | undefined, usage: Usage) => Promise<void>;
}): Promise<{summary: string; usage: Usage; totalBatches: number}> {
    const requestOptions = parsePiSimpleRequestOptions(input.requestOptions);
    const maxTokens = Math.min(Math.floor(input.reserveTokens * 0.8), input.model.maxTokens);
    const inputBudget = Math.floor(input.model.contextWindow * 0.8) - maxTokens;
    const completeOptions = {
        ...requestOptions,
        ...piRequestAuthOptions({
            api: input.model.api,
            apiKey: input.apiKey,
            env: requestOptions.env,
        }),
        headers: mergePiRequestHeaders(input.model.headers, requestOptions.headers),
        timeoutMs: input.timeoutMs ?? undefined,
        maxTokens,
        reasoning: input.thinkingLevel && input.thinkingLevel !== "off" ? input.thinkingLevel as never : undefined,
        signal: input.signal,
        sessionId: input.trace?.correlation.sessionId === undefined ? undefined : String(input.trace.correlation.sessionId),
    };
    const instruction = [input.prompt,
        "Merge this chronological batch with the previous checkpoint. Preserve current user decisions, creative constraints, stable references, versions and unfinished work. Consolidate redundant retrieved material. Return only the handoff summary; do not call tools.",
        input.instructions ? `Additional instructions:\n${input.instructions}` : "",
    ].filter(Boolean).join("\n\n");
    const overhead = estimateRequestOverheadTokens(input);
    // Reserve space for the checkpoint produced by an earlier batch, so growing summaries cannot overflow later requests.
    const batchBudget = inputBudget - overhead - estimateRequestTextTokens(instruction) - maxTokens - 128;
    const groups = summaryMessageGroups(storedMessagesForText(input.messages));
    const allMessages = groups.flat();
    const completeTokens = overhead + [...(input.previousSummary ? [createUserMessage({text: input.previousSummary})] : []),
        ...allMessages, createUserMessage({text: instruction})]
        .reduce((total, message) => total + estimateRequestMessageTokens(message), 0);
    if (completeTokens > inputBudget && batchBudget < 1) throw new Error("压缩摘要与指令已超过摘要请求预算，无法继续压缩。");
    const batches = completeTokens <= inputBudget ? [allMessages] : buildSummaryBatches(groups, batchBudget);
    let summary = input.previousSummary;
    let usage = EMPTY_USAGE;
    let completed = 0;
    await input.onBatchProgress(0, batches.length, usage);
    for (const batch of batches) {
        const checkpoint = summary ? [createUserMessage({text: summary})] : [];
        const messages = [...checkpoint, ...batch, createUserMessage({text: instruction})];
        const requestTokens = overhead + messages.reduce((total, message) => total + estimateRequestMessageTokens(message), 0);
        if (requestTokens > inputBudget) throw new Error("压缩摘要与指令已超过摘要请求预算，无法继续压缩。");
        // The original system, tools and message roles form the reusable request prefix; compaction instructions only extend its tail.
        const completeContext = {systemPrompt: input.systemPrompt, tools: input.tools, messages};
        input.signal?.throwIfAborted();
        const response = await tracedCompleteSimple(input.models, input.model, completeContext, completeOptions, input.trace);
        usage = sumUsage([usage, response.usage]) ?? EMPTY_USAGE;
        await input.onBatchProgress(completed, batches.length, usage);
        input.signal?.throwIfAborted();
        if (response.stopReason === "error" || response.stopReason === "aborted") {
            throw new Error(sanitizeProviderErrorMessage(response.errorMessage || "compaction summary 生成失败"));
        }
        if (response.stopReason === "length") {
            throw new Error("压缩摘要达到输出上限，无法保存不完整的上下文摘要。");
        }
        if (response.content.some(block => block.type === "toolCall")) {
            throw new Error("压缩摘要返回了工具调用，无法保存尚未完成的上下文摘要。");
        }
        summary = response.content.filter(block => block.type === "text").map(block => block.text.trim()).filter(Boolean).join("\n").trim();
        if (!summary) throw new Error("compaction summary 为空");
        completed += 1;
        await input.onBatchProgress(completed, batches.length, usage);
    }
    return {summary: summary!, usage, totalBatches: batches.length};
}

function summaryMessageGroups(messages: Message[]): Message[][] {
    const groups: Message[][] = [];
    const pending = new Set<string>();
    for (const message of messages) {
        if (pending.size === 0) groups.push([]);
        groups.at(-1)!.push(message);
        if (message.role === "assistant") {
            for (const block of message.content) if (block.type === "toolCall") pending.add(block.id);
        } else if (message.role === "toolResult") {
            pending.delete(message.toolCallId);
        }
    }
    return groups;
}

function buildSummaryBatches(groups: Message[][], budget: number): Message[][] {
    const batches: Message[][] = [];
    let current: Message[] = [];
    let currentTokens = 0;
    for (const group of groups) {
        const tokens = group.reduce((total, message) => total + estimateRequestMessageTokens(message), 0);
        if (tokens > budget) {
            if (current.length) {batches.push(current); current = []; currentTokens = 0;}
            // Oversized tool groups must not be replayed with orphan calls/results. Serialize the complete group as labelled data instead.
            const text = JSON.stringify(group);
            let offset = 0;
            while (offset < text.length) {
                const header = `[Oversized conversation group, serialized JSON fragment, UTF-16 offset ${offset}]\n`;
                const end = summaryChunkEnd(text, offset, budget, header);
                if (end <= offset) throw new Error("摘要请求预算不足以容纳完整字符。");
                batches.push([createUserMessage({text: header + text.slice(offset, end)})]);
                offset = end;
            }
        } else {
            if (current.length && currentTokens + tokens > budget) {batches.push(current); current = []; currentTokens = 0;}
            current.push(...group);
            currentTokens += tokens;
        }
    }
    if (current.length) batches.push(current);
    return batches.length ? batches : [[]];
}

function summaryChunkEnd(text: string, offset: number, maxTokens: number, header: string): number {
    let low = offset;
    let high = text.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        const tokens = estimateRequestMessageTokens(createUserMessage({text: header + text.slice(offset, middle)}));
        if (tokens <= maxTokens) low = middle;
        else high = middle - 1;
    }
    const last = text.charCodeAt(low - 1);
    return low < text.length && last >= 0xD800 && last <= 0xDBFF ? low - 1 : low;
}

/**
 * 选择压缩边界，并保证保留下来的历史不会从 toolResult 半截开始。
 */
function selectCompactionPlan(path: SessionEntry[], options: CompactionOptions, minRecentMessages: number): CompactionPlan {
    const visibleEntries = path.filter(isModelVisibleEntry);
    if (visibleEntries.length === 0) {
        return {
            firstKeptEntry: null,
            messagesToSummarize: [],
            metrics: {
                recentTokens: 0,
                summarizedTokens: 0,
                visibleEntryCountBefore: 0,
                recentEntryCount: 0,
                summarizedEntryCount: 0,
            },
        };
    }

    const previousCompaction = [...path].reverse().find((entry) => entry.type === "compaction");
    const previousFirstKeptIndex = previousCompaction?.type === "compaction" && previousCompaction.firstKeptEntryId
        ? path.findIndex((entry) => entry.id === previousCompaction.firstKeptEntryId)
        : -1;
    const boundaryStart = previousFirstKeptIndex >= 0
        ? previousFirstKeptIndex
        : previousCompaction
            ? path.findIndex((entry) => entry.id === previousCompaction.id) + 1
            : 0;

    let tokens = 0;
    let selectedCount = 0;
    let selectedPathIndex = -1;
    for (let index = path.length - 1; index >= boundaryStart; index -= 1) {
        const entry = path[index];
        if (!entry || !isModelVisibleEntry(entry)) {
            continue;
        }
        const entryTokens = estimateStoredMessageTokens(entryMessage(entry));
        // Keep the latest entry, but do not pull a huge older read into the recent tail merely to fill its budget.
        if (selectedPathIndex >= 0 && selectedCount >= minRecentMessages && tokens + entryTokens > options.keepRecentTokens) break;
        tokens += entryTokens;
        selectedCount += 1;
        selectedPathIndex = index;
        if (selectedCount >= minRecentMessages && tokens >= options.keepRecentTokens) {
            break;
        }
    }

    if (selectedPathIndex < 0) {
        const summarizableMessages = path
            .slice(boundaryStart)
            .filter(isModelVisibleEntry)
            .map(entryMessage);
        return {
            firstKeptEntry: null,
            messagesToSummarize: summarizableMessages,
            previousSummary: previousCompaction?.type === "compaction" ? previousCompaction.summary : undefined,
            metrics: {
                recentTokens: 0,
                summarizedTokens: sumMessageTokens(summarizableMessages),
                visibleEntryCountBefore: countVisibleEntries(path.slice(boundaryStart)),
                recentEntryCount: 0,
                summarizedEntryCount: summarizableMessages.length,
            },
        };
    }

    selectedPathIndex = moveCutBeforeToolResult(path, selectedPathIndex, boundaryStart);
    const selectedEntry = path[selectedPathIndex];
    const firstKeptEntry = selectedEntry && isModelVisibleEntry(selectedEntry) ? selectedEntry : null;
    const messagesToSummarize = path
        .slice(boundaryStart, selectedPathIndex)
        .filter(isModelVisibleEntry)
        .map(entryMessage);
    const recentEntries = path.slice(selectedPathIndex).filter(isModelVisibleEntry);

    return {
        firstKeptEntry,
        messagesToSummarize,
        previousSummary: previousCompaction?.type === "compaction" ? previousCompaction.summary : undefined,
        metrics: {
            recentTokens: sumVisibleEntryTokens(path.slice(selectedPathIndex)),
            summarizedTokens: sumMessageTokens(messagesToSummarize),
            firstKeptEntryType: firstKeptEntry?.type,
            visibleEntryCountBefore: countVisibleEntries(path.slice(boundaryStart)),
            recentEntryCount: recentEntries.length,
            summarizedEntryCount: messagesToSummarize.length,
        },
    };
}

/**
 * 如果保留区从 toolResult 开始，把 cut point 前移到对应 assistant toolCall。
 */
function moveCutBeforeToolResult(path: SessionEntry[], selectedPathIndex: number, boundaryStart: number): number {
    const selected = path[selectedPathIndex];
    if (!selected || !isModelVisibleEntry(selected)) {
        return selectedPathIndex;
    }
    const toolResult = entryMessage(selected);
    if (!isToolResultMessage(toolResult)) {
        return selectedPathIndex;
    }

    for (let index = selectedPathIndex - 1; index >= boundaryStart; index -= 1) {
        const entry = path[index];
        if (!entry || !isModelVisibleEntry(entry)) {
            continue;
        }
        const message = entryMessage(entry);
        if (!isAssistantMessage(message)) {
            continue;
        }
        const hasMatchingToolCall = message.content.some((block) => {
            return block.type === "toolCall" && block.id === toolResult.toolCallId;
        });
        if (hasMatchingToolCall) {
            return index;
        }
    }
    return selectedPathIndex;
}

/**
 * 未完成 tool call 会破坏 continue/approval 恢复语义，压缩前必须拒绝。
 */
function assertNoPendingToolCall(messages: StoredMessageLike[]): void {
    const completedToolCallIds = new Set(messages
        .filter(isToolResultMessage)
        .map((message) => message.toolCallId));
    const pendingToolCall = messages
        .filter(isAssistantMessage)
        .flatMap((message) => message.content.filter((block) => block.type === "toolCall"))
        .find((toolCall) => !completedToolCallIds.has(toolCall.id));
    if (pendingToolCall) {
        throw new Error(`当前 session 存在未完成 tool call，无法压缩：${pendingToolCall.name}`);
    }
}

function isModelVisibleEntry(entry: SessionEntry): entry is ModelVisibleSessionEntry {
    return entry.type === "message" || (entry.type === "custom_message" && entry.visibleToModel);
}

function entryMessage(entry: ModelVisibleSessionEntry): StoredMessageLike {
    return entry.message as AgentMessage | StoredAgentMessage;
}

function isAssistantMessage(message: StoredMessageLike): message is AssistantMessage {
    return message.role === "assistant";
}

function isToolResultMessage(message: StoredMessageLike): message is ToolResultMessage | StoredToolResultMessage {
    return message.role === "toolResult";
}

function countVisibleEntries(entries: SessionEntry[]): number {
    return entries.filter(isModelVisibleEntry).length;
}

function sumVisibleEntryTokens(entries: SessionEntry[]): number {
    return entries.reduce((total, entry) => {
        return isModelVisibleEntry(entry) ? total + estimateStoredMessageTokens(entryMessage(entry)) : total;
    }, 0);
}

function sumMessageTokens(messages: StoredMessageLike[]): number {
    return messages.reduce((total, message) => total + estimateStoredMessageTokens(message), 0);
}
