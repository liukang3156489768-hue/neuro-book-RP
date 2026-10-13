import type {OperationActor} from "@notnotype/nb-history";
import type {NeuroAgentHarness} from "nbook/server/agent/harness/neuro-agent-harness";
import {HarnessAgentPort} from "nbook/server/agent/workflow/workflow-agent-port";
import {NeuroWorkflowSessionPort} from "nbook/server/agent/workflow/workflow-session-port";
import type {ReadyProjectSessionRef} from "nbook/server/workspace-files/project-session-types";
import {renderManagedPrompt} from "nbook/server/prompt-management/render";
import {usePromptManagement} from "nbook/server/prompt-management/service";
import {WritingRunService} from "./run-service";
import {createTavernWriterAgentPort, FrozenTavernWriterOutputSchema, TAVERN_WRITER_OUTPUT_KEY} from "./tavern-agent-port";

/** 写作运行由程序推进，写入操作记为工作流而不是某个角色会话。 */
export const WRITING_WORKFLOW_ACTOR: OperationActor = {kind: "system", source: "writing-workflow"};

type Entry = Readonly<{publicId: string; service: WritingRunService}>;

/**
 * 章节锁和执行中的运行只记在 WritingRunService 实例里，同一项目必须共用一个实例。
 * 项目重新打开（publicId 变化）后换新实例，旧实例中的运行随旧会话结束。
 */
const services = new WeakMap<NeuroAgentHarness, Map<string, Entry>>();

export function useWritingRunService(harness: NeuroAgentHarness, ready: ReadyProjectSessionRef): WritingRunService {
    let byRoot = services.get(harness);
    if (!byRoot) {
        byRoot = new Map();
        services.set(harness, byRoot);
    }
    const key = ready.workspace.root;
    const existing = byRoot.get(key);
    if (existing?.publicId === ready.publicId) return existing.service;
    const service = new WritingRunService({
        ready,
        actor: WRITING_WORKFLOW_ACTOR,
        sessions: new NeuroWorkflowSessionPort(harness.repo, async (init) => {
            const parent = init.parentSessionId === undefined ? null : await harness.repo.readSession(init.parentSessionId);
            const archivedParent = parent !== null && harness.repo.reduce(parent).archived;
            // A completed run may outlive its archived chat; keep its prompt version without attaching a new child to that chat.
            const inherited = archivedParent && parent ? await harness.promptSnapshotForSession(parent.metadata.sessionId) : null;
            // Each stateless writer attempt adopts current settings; its stored snapshot also fixes the subsequent review.
            const currentWriter = init.profileKey === "writing.writer" && init.initial !== null && typeof init.initial === "object"
                && !Array.isArray(init.initial) && typeof init.initial.managedPurposeId === "string" && harness.runtimePaths
                ? await usePromptManagement(harness.runtimePaths).capture() : null;
            const promptSnapshotId = currentWriter?.id ?? inherited?.id;
            let tavernOwnerKey: string | undefined;
            if ((currentWriter || init.profileKey === "writing.assistant") && parent) {
                let owner = parent;
                const seen = new Set<number>([owner.metadata.sessionId]);
                while (owner.metadata.parentSessionId !== undefined && owner.metadata.profileKey !== "writing.lead") {
                    const ancestor = await harness.repo.readSession(owner.metadata.parentSessionId);
                    if (seen.has(ancestor.metadata.sessionId)) throw new Error("写作会话父链形成循环");
                    if (ancestor.metadata.currentProjectRoot !== owner.metadata.currentProjectRoot) break;
                    seen.add(ancestor.metadata.sessionId);
                    owner = ancestor;
                }
                const ownerInitial = owner.metadata.initial;
                tavernOwnerKey = ownerInitial && typeof ownerInitial === "object" && !Array.isArray(ownerInitial) && typeof ownerInitial.tavernOwnerKey === "string"
                    ? ownerInitial.tavernOwnerKey : owner.metadata.sessionIdentity ?? `${owner.metadata.sessionId}:${owner.metadata.createdAt}`;
            }
            return (await harness.createAgent({
                profileKey: init.profileKey,
                initial: tavernOwnerKey && init.initial && typeof init.initial === "object" && !Array.isArray(init.initial)
                    ? {...init.initial, tavernOwnerKey} : init.initial,
                ...(archivedParent ? {} : {parentSessionId: init.parentSessionId}),
                ...(promptSnapshotId ? {promptSnapshotId} : {}),
                // Runs saved before prompt management have no parent chat and must keep built-in defaults.
                promptSnapshotMode: "builtin",
                ...(init.title === undefined ? {} : {title: init.title}),
                ...(init.kind === undefined ? {} : {kind: init.kind}),
                ...(init.tags === undefined ? {} : {tags: init.tags}),
                currentProjectRoot: ready.workspace.ref.projectRoot,
            })).sessionId;
        }),
        agents: createTavernWriterAgentPort(harness, new HarnessAgentPort(harness)),
        async resolveWriterPrompt(sessionId, fallback) {
            if (!fallback.managed) return fallback;
            const compiled = await harness.compiledWriterPromptForSession(sessionId);
            if (compiled) {
                const messages = compiled.orderedMessages.flatMap(message => message.role === "system" ? [] : [{role: message.role, content: message.content}]);
                const session = await harness.repo.readSession(sessionId);
                const outputValue = harness.repo.reduce(session).customState[TAVERN_WRITER_OUTPUT_KEY];
                const processed = outputValue === undefined ? undefined : FrozenTavernWriterOutputSchema.parse(outputValue).output;
                return {system: compiled.systemPrompt, user: messages.map(message => message.content).join("\n\n"), preMessages: messages,
                    orderedMessages: compiled.orderedMessages, ...(processed ? {outputReport: {quality: processed.quality,
                        extractionError: processed.extractionError, extensionWarnings: processed.extensionWarnings}} : {})};
            }
            const snapshot = await harness.promptSnapshotForSession(sessionId);
            if (!snapshot) return fallback;
            if (snapshot.purposes[fallback.managed.purposeId]?.tavern) throw new Error("写手尚无当次酒馆编译结果，不能重新求值作为审阅依据");
            const rendered = renderManagedPrompt(snapshot, fallback.managed.purposeId, fallback.managed.variables);
            // Review receives the same version and role sequence as the writer, including configured examples.
            return {system: rendered.systemPrompt, user: rendered.messages.map(message => message.content).join("\n\n"), preMessages: rendered.messages,
                ...(rendered.orderedMessages ? {orderedMessages: rendered.orderedMessages} : {})};
        },
    });
    byRoot.set(key, {publicId: ready.publicId, service});
    return service;
}
