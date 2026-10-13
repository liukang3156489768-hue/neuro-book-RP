import {createHash} from "node:crypto";
import {z} from "zod";
import type {JsonValue} from "nbook/server/agent/messages/types";
import type {SessionEntry, CustomSessionEntry} from "nbook/server/agent/session/types";
import {EMPTY_USAGE} from "nbook/server/agent/messages/message-utils";

export const TOOL_CONTEXT_PROJECTION_PREFIX = "context.toolResult:";
const ReplacementSchema = z.object({
    version: z.literal(1),
    sourceEntryId: z.string(),
    toolCallId: z.string(),
    originalHash: z.string(),
    text: z.string(),
    retainedEntryIds: z.array(z.string()),
});
const PlanningResultSchema = z.record(z.string(), z.json());
const SHARED_FIELDS = ["plans", "entries", "foreshadowing", "graphs", "lines"] as const;

function hash(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

function canonical(value: JsonValue): string {
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    if (value !== null && typeof value === "object") {
        return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key]!)).join(",") + "}";
    }
    return JSON.stringify(value);
}

/** 原日志和分支仍是审计真相；只投影当前路径上的、指纹匹配的工具观察。 */
export function projectToolContextPath(path: readonly SessionEntry[]): SessionEntry[] {
    const entries = new Map(path.map(entry => [entry.id, entry]));
    const replacements = new Map<string, z.infer<typeof ReplacementSchema>>();
    let lastProjectionIndex = -1;
    for (const [index, entry] of path.entries()) {
        if (entry.type !== "custom" || !entry.key.startsWith(TOOL_CONTEXT_PROJECTION_PREFIX)) continue;
        const parsed = ReplacementSchema.safeParse(entry.value);
        if (!parsed.success) throw new Error("工具上下文替换记录无效");
        const value = parsed.data;
        const source = entries.get(value.sourceEntryId);
        if (source?.type !== "message" || source.message.role !== "toolResult"
            || source.message.toolCallId !== value.toolCallId
            || hash(JSON.stringify(source.message.content)) !== value.originalHash
            || !value.retainedEntryIds.every(id => entries.has(id))) continue;
        replacements.set(value.sourceEntryId, value);
        lastProjectionIndex = index;
    }
    if (!replacements.size) return [...path];
    return path.map((entry, index) => {
        const replacement = replacements.get(entry.id);
        if (entry.type === "message" && entry.message.role === "toolResult" && replacement) {
            return {...entry, clientMessageId: undefined, intent: undefined, sourceQueueItemId: undefined,
                message: {...entry.message, content: [{type: "text" as const, text: replacement.text}]}};
        }
        // 历史 usage 描述的是替换前请求，只有模型估算投影失效；累计费用仍读原路径。
        if (index < lastProjectionIndex && entry.type === "message" && entry.message.role === "assistant") {
            return {...entry, clientMessageId: undefined, intent: undefined, sourceQueueItemId: undefined,
                message: {...entry.message, usage: EMPTY_USAGE}};
        }
        return entry;
    });
}

/** 只消除仍有完整可见副本的规划读取；正文、用户决定和写工具结果不做头尾裁剪。 */
export function planToolContextPruning(rawPath: readonly SessionEntry[], minRecentMessages = 0): Omit<CustomSessionEntry, "id" | "parentId" | "timestamp">[] {
    const path = projectToolContextPath(rawPath);
    const checkpoint = [...path].reverse().find(entry => entry.type === "compaction");
    const start = checkpoint?.type === "compaction"
        ? Math.max(0, path.findIndex(entry => entry.id === (checkpoint.firstKeptEntryId ?? checkpoint.id)))
        : 0;
    let protectedStart = path.length;
    let protectedCount = 0;
    for (let index = path.length - 1; index >= start && protectedCount < minRecentMessages; index -= 1) {
        const entry = path[index]!;
        if (entry.type === "message" || (entry.type === "custom_message" && entry.visibleToModel)) {
            protectedCount += 1;
            protectedStart = index;
        }
    }
    const fullResults = new Map<string, string>();
    const fieldResults = new Map<string, string>();
    // 既有引用依赖完整来源；后续维护不能把来源再改成引用链。
    const protectedSources = new Set<string>();
    for (const entry of rawPath) {
        if (entry.type !== "custom" || !entry.key.startsWith(TOOL_CONTEXT_PROJECTION_PREFIX)) continue;
        const parsed = ReplacementSchema.safeParse(entry.value);
        if (parsed.success) for (const id of parsed.data.retainedEntryIds) protectedSources.add(id);
    }
    const drafts: Omit<CustomSessionEntry, "id" | "parentId" | "timestamp">[] = [];
    for (let index = path.length - 1; index >= start; index -= 1) {
        const entry = path[index]!;
        if (entry.type !== "message" || entry.message.role !== "toolResult"
            || entry.message.toolName !== "get_planning_context" || entry.message.isError
            || entry.message.content.length !== 1 || entry.message.content[0]?.type !== "text") continue;
        let data: Record<string, JsonValue>;
        try {
            data = PlanningResultSchema.parse(JSON.parse(entry.message.content[0].text));
        } catch {
            continue;
        }
        // 已替换的引用不作为新引用的完整来源，避免跨多次维护形成引用链。
        if (data._contextReference || data._contextReferences) continue;
        const fingerprint = hash(canonical(data));
        const duplicate = fullResults.get(fingerprint);
        const references: Record<string, JsonValue> = {};
        const retainedIds = new Set<string>();
        let text: string | undefined;
        if (duplicate) {
            retainedIds.add(duplicate);
            text = JSON.stringify({_contextReference: {entryId: duplicate, contentHash: fingerprint,
                instruction: "相同规划读取的完整结果仍在本轮上下文中；需要最新资料时重新调用 get_planning_context。"}});
        } else {
            const projected = {...data};
            for (const field of SHARED_FIELDS) {
                if (data[field] === undefined) continue;
                const key = field + ":" + hash(canonical(data[field]!));
                const retainedId = fieldResults.get(key);
                if (retainedId) {
                    delete projected[field];
                    references[field] = {entryId: retainedId, contentHash: key.slice(field.length + 1)};
                    retainedIds.add(retainedId);
                } else {
                    fieldResults.set(key, entry.id);
                }
            }
            if (!retainedIds.size) fullResults.set(fingerprint, entry.id);
            if (retainedIds.size) text = JSON.stringify({...projected, _contextReferences: references});
        }
        if (!text || protectedSources.has(entry.id) || index >= protectedStart || entry.message.content[0].text.length - text.length < 512) continue;
        const original = rawPath.find(source => source.id === entry.id);
        if (original?.type !== "message" || original.message.role !== "toolResult") continue;
        drafts.push({type: "custom", key: TOOL_CONTEXT_PROJECTION_PREFIX + entry.id,
            value: {version: 1, sourceEntryId: entry.id, toolCallId: entry.message.toolCallId,
                originalHash: hash(JSON.stringify(original.message.content)), text, retainedEntryIds: [...retainedIds]}});
    }
    return drafts.reverse();
}
