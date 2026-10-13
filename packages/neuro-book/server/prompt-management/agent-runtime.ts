import {createAssistantTextMessage, createStoredUserMessage} from "nbook/server/agent/messages/message-utils";
import type {JsonValue} from "nbook/server/agent/messages/types";
import type {StoredAgentMessage} from "nbook/server/agent/messages/stored-types";
import type {PromptMessage, PromptSnapshot} from "nbook/shared/dto/prompt-management.dto";
import {FrozenWriterPromptSchema} from "nbook/shared/dto/tavern-preset.dto";
import {renderManagedPrompt} from "./render";
import type {TavernCompilationBudget} from "./tavern-budget";

export const AGENT_PROMPT_SNAPSHOT_KEY = "prompt.management.snapshot";
export const WRITER_COMPILED_PROMPT_KEY = "prompt.management.writer.compiled";

const MANAGED_PROFILES = new Set([
    "inspiration", "inspiration.character", "inspiration.faction", "inspiration.instruction", "inspiration.item", "inspiration.location", "inspiration.note", "inspiration.system", "inspiration.world",
    "outline.planner", "outline.outline", "outline.detailed", "outline.foreshadowing", "writing.lead", "writing.assistant", "writing.writer", "writing.material-review",
]);

export function isManagedAgentProfile(profileKey: string): boolean {
    return MANAGED_PROFILES.has(profileKey);
}

export type ManagedAgentPrompt = {systemPrompt: string; messages: StoredAgentMessage[]; orderedMessages?: PromptMessage[]; replacesInvocation: boolean;
    writerCompilation?: ReturnType<typeof FrozenWriterPromptSchema.parse>};

export function restoreFrozenWriterPrompt(value: unknown): ManagedAgentPrompt {
    const frozen = FrozenWriterPromptSchema.parse(value);
    return {systemPrompt: frozen.systemPrompt, orderedMessages: frozen.orderedMessages, replacesInvocation: true, writerCompilation: frozen,
        messages: frozen.orderedMessages.flatMap(message => message.role === "system" ? [] : [message.role === "user"
            ? createStoredUserMessage(message.content, 0) : createAssistantTextMessage({text: message.content, timestamp: 0})])};
}

export function prepareManagedAgentPrompt(snapshot: PromptSnapshot, profileKey: string, initial: JsonValue, payload?: JsonValue,
    tavernInitial?: {local: Record<string, string>; global: Record<string, string>},
    budget?: TavernCompilationBudget,
): ManagedAgentPrompt | null {
    if (!isManagedAgentProfile(profileKey)) return null;
    const fields = record(initial);
    let purposeId = profileKey;
    if (profileKey === "writing.assistant") {
        const kind = record(payload).kind;
        if (typeof kind !== "string") return null;
        purposeId = `${profileKey}.${kind}`;
    }
    if (profileKey === "writing.writer") {
        if (typeof fields.managedPurposeId !== "string") return null;
        purposeId = fields.managedPurposeId;
    }
    if (profileKey === "writing.material-review" && !snapshot.purposes[purposeId]) return null;
    const variables: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        variables[key] = typeof value === "string" ? value : JSON.stringify(value);
    }
    variables.fields = Array.isArray(fields.fields) && fields.fields.length ? fields.fields.join("、") : "写作指导与参考资料按当前需求组织，不预设必填字段";
    // 旧会话可能没有持久化创作模式；内置 Profile 的合同将其视为原创模式。
    if (typeof variables.creationMode !== "string") variables.creationMode = "original";
    variables.chapterBinding = typeof fields.chapterEntryId === "string"
        ? `本会话是章节 ${fields.chapterEntryId} 的写作会话：用户没有另外指定时，写作、续写、改写都针对这一章；用户要处理其他章节时，建议在写作视图中选中那一章，到它的会话里进行。`
        : "";
    if (profileKey === "writing.writer") {
        for (const [key, value] of Object.entries(record(fields.managedVariables))) {
            if (typeof value !== "string") throw new Error(`写手提示词变量必须是字符串：${key}`);
            variables[key] = value;
        }
    }
    const rendered = renderManagedPrompt(snapshot, purposeId, variables, tavernInitial, budget);
    if (profileKey === "writing.writer" && rendered.orderedMessages) {
        return restoreFrozenWriterPrompt({snapshotId: snapshot.id, systemPrompt: rendered.systemPrompt, orderedMessages: rendered.orderedMessages,
            ...(rendered.tavernState ? {tavernState: rendered.tavernState} : {}), ...(rendered.tavern ? {tavern: rendered.tavern} : {}),
            ...(rendered.generation ? {generation: rendered.generation} : {}), ...(rendered.budgetReport ? {budgetReport: rendered.budgetReport} : {})});
    }
    return {
        systemPrompt: rendered.systemPrompt,
        orderedMessages: rendered.orderedMessages,
        messages: rendered.messages.map(message => message.role === "user"
            ? createStoredUserMessage(message.content, 0)
            : createAssistantTextMessage({text: message.content, timestamp: 0})),
        replacesInvocation: profileKey === "writing.writer",
    };
}

function record(value: JsonValue | undefined): {[key: string]: JsonValue | undefined} {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
