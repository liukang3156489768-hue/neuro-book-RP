import type {AgentMessage} from "nbook/app/components/novel-ide/agent/agent-message";
import type {OutlineWorkbenchCreationMode} from "nbook/shared/storage/outline-workbench";

export type OutlineWorkbenchMessageContext = Readonly<{
    creationMode: OutlineWorkbenchCreationMode;
    targetPlanId: string | null;
}>;

const CONTEXT_START = "[大纲工作台当前任务]\n";
const CONTEXT_END = "\n[/大纲工作台当前任务]\n\n";

/** 当前任务随每轮正文保存供模型读取，聊天展示只投影去掉这一层封装。 */
export function formatOutlineWorkbenchPrompt(text: string, context: OutlineWorkbenchMessageContext): string {
    const encoded = JSON.stringify({creationMode: context.creationMode, targetPlanId: context.targetPlanId});
    return `${CONTEXT_START}${encoded}${CONTEXT_END}${text}`;
}

function contextPrefixLength(text: string): number {
    if (!text.startsWith(CONTEXT_START)) return 0;
    const end = text.indexOf(CONTEXT_END, CONTEXT_START.length);
    if (end < 0) return 0;
    const encoded = text.slice(CONTEXT_START.length, end);
    let value: unknown;
    try { value = JSON.parse(encoded); } catch { return 0; }
    if (typeof value !== "object" || value === null || Array.isArray(value)
        || !("creationMode" in value) || !("targetPlanId" in value)
        || (value.creationMode !== "original" && value.creationMode !== "adaptation")
        || (value.targetPlanId !== null && typeof value.targetPlanId !== "string")
        || Object.keys(value).length !== 2) return 0;
    const context: OutlineWorkbenchMessageContext = {creationMode: value.creationMode, targetPlanId: value.targetPlanId};
    // 只识别编码器的精确格式，避免把普通标签、未知版本和自由书写的 JSON 当作隐藏上下文。
    if (JSON.stringify(context) !== encoded) return 0;
    return end + CONTEXT_END.length;
}

/** 仅用于工作台 ChatFlow；不能将展示副本送回会话恢复、重试或持久化链路。 */
export function projectOutlineWorkbenchMessage(message: AgentMessage): AgentMessage {
    if (message.type !== "user") return message;
    const prefixLength = contextPrefixLength(message.content);
    if (!prefixLength) return message;
    const prefix = message.content.slice(0, prefixLength);
    const blocks = message.contentBlocks;
    const firstBlock = blocks?.[0];
    const contentBlocks = blocks !== undefined && firstBlock?.type === "text" && firstBlock.content.preview.startsWith(prefix)
        ? [{...firstBlock, content: {...firstBlock.content, preview: firstBlock.content.preview.slice(prefixLength)}}, ...blocks.slice(1)]
        : blocks;
    return {
        ...message,
        content: message.content.slice(prefixLength),
        ...(contentBlocks === undefined ? {} : {contentBlocks}),
    };
}
