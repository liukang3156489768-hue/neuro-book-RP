import {createHash} from "node:crypto";
import {z} from "zod";
import type {AgentInvokeOutcome, AgentPort, InvokeOptions} from "@notnotype/nb-workflow";
import type {NeuroAgentHarness} from "nbook/server/agent/harness/neuro-agent-harness";
import {normalizeToolResultDetails} from "nbook/server/agent/messages/message-utils";
import {usePromptManagement} from "nbook/server/prompt-management/service";
import {defaultTavernOutputPolicy} from "nbook/shared/prompt-management/tavern-bindings";
import {FrozenWriterPromptSchema, TavernVariablesSchema} from "nbook/shared/dto/tavern-preset.dto";
import {WRITER_COMPILED_PROMPT_KEY} from "nbook/server/prompt-management/agent-runtime";
import {processTavernWriterOutput} from "./tavern-output";

export const TAVERN_WRITER_OUTPUT_KEY = "prompt.management.writer.output";
const StateSchema = z.object({local: TavernVariablesSchema, global: TavernVariablesSchema}).strict();
const QualitySchema = z.object({
    adapter: z.literal("turing-local-v3.11"), sourceSha256: z.string(), scopeTag: z.string(), scoped: z.boolean(),
    characters: z.number().int().nonnegative(), total: z.number().int().nonnegative(), cloudReview: z.literal("not-configured"),
    hits: z.array(z.object({name: z.string(), count: z.number().int().nonnegative(), samples: z.array(z.string()),
        note: z.string(), fix: z.string().optional()}).strict()),
}).strict();
const OutputSchema = z.object({
    raw: z.string(), stored: z.string(), display: z.string(), prose: z.string().nullable(), extractionError: z.string().nullable(),
    variablesAfter: StateSchema, quality: z.array(QualitySchema), extensionWarnings: z.array(z.string()), fullEnvironmentEquivalent: z.literal(false),
}).strict();
const OutcomeSchema = z.object({
    status: z.literal("completed"), message: z.string(), data: z.json(), newLeaf: z.string().nullable(),
    usage: z.object({inputTokens: z.number(), outputTokens: z.number(), cacheReadTokens: z.number(), cacheWriteTokens: z.number(),
        cacheWrite1hTokens: z.number().optional(), reasoningTokens: z.number().optional(), totalTokens: z.number(),
        cost: z.object({input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), total: z.number()}).strict(),
    }).strict().nullable().optional(),
}).strict();

export const FrozenTavernWriterOutputSchema = z.object({
    schemaVersion: z.literal(1), fromLeaf: z.string().nullable(), responseLeaf: z.string().nullable(),
    requestSha256: z.string().regex(/^[a-f0-9]{64}$/u), promptSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    output: OutputSchema, outcome: OutcomeSchema,
}).strict().refine(record => record.output.raw === record.outcome.message && record.responseLeaf === record.outcome.newLeaf,
    "酒馆写手输出记录与原始回复不一致");

function hash(value: unknown): string {return createHash("sha256").update(JSON.stringify(value)).digest("hex");}
function requestHash(options: InvokeOptions): string {
    return hash({mode: options.mode ?? "prompt", message: options.message ?? null,
        inputPresent: options.input !== undefined, input: options.input ?? null});
}

/** Frozen output owns regex side effects; retries consume its receipt before advancing persistent variables. */
export function createTavernWriterAgentPort(harness: NeuroAgentHarness, delegate: AgentPort): AgentPort {
    return {
        profileInfo: profileKey => delegate.profileInfo(profileKey),
        async invoke(sessionId, fromLeaf, options): Promise<AgentInvokeOutcome> {
            options.signal?.throwIfAborted();
            const before = await harness.repo.readSession(sessionId);
            if (before.metadata.profileKey !== "writing.writer") return delegate.invoke(sessionId, fromLeaf, options);
            const requestSha256 = requestHash(options);
            const receipts = before.entries.flatMap(entry => entry.type === "custom" && entry.key === TAVERN_WRITER_OUTPUT_KEY
                ? [{entry, record: FrozenTavernWriterOutputSchema.parse(entry.value)}] : []);
            for (const {entry, record} of receipts.reverse()) {
                if (record.fromLeaf === fromLeaf && record.requestSha256 === requestSha256) {
                    // Projection entries are session-wide; later projections cannot redefine an earlier receipt's compilation.
                    const receiptSnapshot = {...before, entries: before.entries.slice(0, before.entries.indexOf(entry) + 1), leafId: entry.id};
                    const branch = harness.repo.reduce(receiptSnapshot);
                    const previousCompiled = FrozenWriterPromptSchema.parse(branch.customState[WRITER_COMPILED_PROMPT_KEY]);
                    if (!previousCompiled.tavern || record.promptSha256 !== hash(previousCompiled)) {
                        throw new Error("酒馆写手输出记录与冻结提示词不一致，不能恢复");
                    }
                    if (entry.parentId !== record.responseLeaf || (before.leafId !== fromLeaf && before.leafId !== entry.id)) {
                        throw new Error("酒馆写手输出记录与会话游标不一致，不能恢复");
                    }
                    if (fromLeaf !== null && !harness.repo.activePath({...receiptSnapshot, leafId: record.responseLeaf}).some(parent => parent.id === fromLeaf)) {
                        throw new Error("酒馆写手原始游标不属于已冻结回复分支，不能恢复");
                    }
                    // Workflow retries may have moved back to their original cursor; the durable receipt can be on another branch.
                    if (before.leafId !== entry.id) await harness.repo.moveLeaf(sessionId, entry.id);
                    if (previousCompiled.variableScope && harness.runtimePaths) {
                        await usePromptManagement(harness.runtimePaths).applyWriterOutput(previousCompiled.variableScope, record.output.variablesAfter);
                    }
                    return {...record.outcome, message: record.output.prose ?? "", newLeaf: entry.id};
                }
            }
            // Persistent variable receipts belong to one stateless writer attempt, not a multi-turn conversation.
            if (receipts.length) throw new Error("写手会话已有冻结产出；不同请求必须创建新的写手尝试");
            const outcome = await delegate.invoke(sessionId, fromLeaf, options);
            if (outcome.status !== "completed") return outcome;
            const compiled = await harness.compiledWriterPromptForSession(sessionId);
            if (!compiled?.tavern) return outcome;
            if ((await harness.repo.readSession(sessionId)).leafId !== outcome.newLeaf) {
                throw new Error("写手回复游标已变化，不能冻结到其他分支");
            }
            const {tavern} = compiled;
            const output = processTavernWriterOutput({sourceJson: tavern.sourceJson, raw: outcome.message,
                user: tavern.bindings.user, char: tavern.bindings.char, state: compiled.tavernState,
                bindings: tavern.bindings, macroEngine: tavern.macroEngine,
                policy: tavern.outputPolicy ?? defaultTavernOutputPolicy(tavern.sourceJson)});
            const record = FrozenTavernWriterOutputSchema.parse({schemaVersion: 1, fromLeaf, requestSha256,
                promptSha256: hash(compiled), responseLeaf: outcome.newLeaf, output, outcome});
            const newLeaf = await harness.freezeWriterOutput(sessionId, normalizeToolResultDetails(record), outcome.newLeaf);
            // The session receipt survives a variable conflict; a retry then skips both network and regex evaluation.
            if (compiled.variableScope && harness.runtimePaths) {
                await usePromptManagement(harness.runtimePaths).applyWriterOutput(compiled.variableScope, output.variablesAfter);
            }
            return {...outcome, message: output.prose ?? "", newLeaf};
        },
    };
}
