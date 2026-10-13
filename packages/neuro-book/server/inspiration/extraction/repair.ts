import {createHash} from "node:crypto";
import {ExtractionModelError, ExtractionValidationFailure} from "./errors";
import {usePromptManagement} from "nbook/server/prompt-management/service";
import {renderManagedPrompt} from "nbook/server/prompt-management/render";
import {buildExtractionPrompt, type RepairSlot} from "./prompt";
import {CHARACTER_OUTPUT_CONTRACT} from "./material-prompts";
import type {ExtractionModelPort, ExtractionModelRequest, ExtractionPromptParts, ValidationResult} from "./types";

/** 同一次调用最多发起的模型请求数：首次 + 一次带错误信息的修复重试。 */
export const MAX_GENERATION_ATTEMPTS = 2;

/** 长度截断只允许一次压缩重试，避免在已经达到 Provider 上限时重复发送同样的长提示。 */
const LENGTH_RETRY_INSTRUCTION = [
    "【长度修复】上一次输出达到模型长度上限。请压缩后完整重写，不要解释过程。",
    "删除重复描写和非必要铺陈；每个场景保留地点、在场角色、服饰状态、具体情节和写作指导的必要信息。",
    "仍须输出完整模板、所有必需标题和末尾引用行，不要省略后半章。",
].join("\n");

const CHARACTER_LENGTH_RETRY_INSTRUCTION = [
    "【长度修复】上一次输出达到模型长度上限。请压缩后完整重写，不要解释过程。",
    "角色基础字段、经历和关系使用简明表述，删除重复信息，保留明确事实及其 P 引用。",
    "仍须返回全部目标角色和完整 JSON 结构，不要省略后面的角色或生成章节正文。",
].join("\n");

export type CallWithRepairOptions<T> = Readonly<{
    model: ExtractionModelPort;
    signal: AbortSignal;
    prompt: ExtractionPromptParts;
    validate: (output: string) => ValidationResult<T>;
    system?: string;
    modelKey?: string;
    purposeId?: string;
    variables?: Readonly<Record<string, string>>;
    promptSnapshotId?: string;
    /** 每次模型请求之前执行（来源哈希复核、计数）；抛错则不发请求。 */
    beforeCall?: () => Promise<void> | void;
    metadata?: Readonly<{
        taskId?: string;
        unitId?: string;
        purposeId?: string;
        block?: number;
        characterKeys?: readonly string[];
        tier?: string;
    }>;
}>;

/**
 * 调用模型并校验产出。第一次不通过时，把本次产出与错误信息写入提示词末尾的预留位再调用一次；
 * 第二次仍不通过抛 `ExtractionValidationFailure`，不再自动重试（手动重试重新计数）。
 * 只有“产出未通过校验”才触发修复；模型端口抛出的错误（超时、配置缺失）原样上抛，不当作可修复。
 */
export async function callWithRepair<T>(options: CallWithRepairOptions<T>): Promise<T> {
    if (!options.prompt.prefix) throw new Error("提取提示词的前缀（本单元原文）不能为空");
    const errors: string[] = [];
    let repair: RepairSlot | undefined;
    const management = options.purposeId && options.promptSnapshotId ? usePromptManagement() : undefined;
    // 无版本的历史任务只读取内置方案，不能被当前全局选择影响。
    const snapshot = management && options.promptSnapshotId ? await management.readSnapshot(options.promptSnapshotId) : undefined;
    let managed: ReturnType<typeof renderManagedPrompt> | undefined;
    if (snapshot && options.purposeId) {
        try {
            managed = renderManagedPrompt(snapshot, options.purposeId, options.variables ?? {});
        } catch (error) {
            // 分组用途在本版本新增；旧任务快照没有该用途时沿用流程内置模板，避免恢复任务因快照缺项中断。
            if (options.purposeId !== "extraction.character.grouped" || !(error instanceof Error) || !error.message.includes("缺少调用用途")) throw error;
        }
    }
    const taskMessages = [...(managed?.messages ?? [])];
    const taskIndex = taskMessages.findLastIndex(message => message.role === "user");
    const goal = taskIndex >= 0 ? taskMessages.splice(taskIndex, 1)[0]!.content : managed ? "" : options.prompt.goal;
    const characterRequest = options.purposeId === "extraction.character.grouped" || options.purposeId === "extraction.character.focused";
    const parts = {...options.prompt, goal: characterRequest ? [goal, CHARACTER_OUTPUT_CONTRACT].filter(Boolean).join("\n\n") : goal};
    const stableSupplements = characterRequest ? (parts.supplements ?? []).slice(0, 1) : [];
    const dynamicSupplements = characterRequest ? (parts.supplements ?? []).slice(1) : [];
    // 哈希覆盖实际公共消息前缀（含角色及消息边界），不把可能含动态变量的自定义示例算进去。
    const characterPrefix: NonNullable<ExtractionModelRequest["orderedMessages"]> = [
        ...(managed?.orderedMessages?.filter(message => message.role === "system")
            ?? (managed?.systemPrompt ?? options.system ? [{role: "system" as const, content: (managed?.systemPrompt ?? options.system)!}] : [])),
        {role: "user", content: [parts.prefix, ...stableSupplements].filter(Boolean).join("\n\n")},
    ];
    const prefixHash = createHash("sha256").update(JSON.stringify(characterRequest ? characterPrefix : [
        {role: "system", content: managed?.systemPrompt ?? options.system ?? ""},
        ...taskMessages,
        {role: "user", content: parts.prefix},
    ]), "utf8").digest("hex");
    let lengthRetry = false;
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
        options.signal.throwIfAborted();
        await options.beforeCall?.();
        options.signal.throwIfAborted();
        const system = managed?.systemPrompt ?? options.system;
        const preMessages = characterRequest ? [] : taskMessages;
        let prompt = managed
            ? [parts.prefix, ...(parts.supplements ?? []).filter(Boolean), parts.goal].filter(Boolean).join("\n\n")
            : buildExtractionPrompt(parts);
        // 角色模板和原文是同一缓存前缀的一部分；这两个用途都把动态名单与任务要求留到末尾。
        const orderedMessages = characterRequest
            ? [...characterPrefix, ...taskMessages,
                {role: "user" as const, content: [...dynamicSupplements, parts.goal].filter(Boolean).join("\n\n")}]
            : managed?.orderedMessages
                ? [...managed.orderedMessages, {role: "user" as const, content: [parts.prefix, ...(parts.supplements ?? []).filter(Boolean)].filter(Boolean).join("\n\n")}]
                : undefined;
        if (repair && snapshot) {
            const correction = renderManagedPrompt(snapshot, "extraction.repair", {
                previousOutput: repair.previousOutput,
                error: repair.error.length > 4000 ? `${repair.error.slice(0, 4000)}……（已截断）` : repair.error,
            });
            const correctionText = [correction.systemPrompt, ...(correction.orderedMessages ?? correction.messages).map(message => message.content)]
                .filter(Boolean).join("\n\n");
            prompt += correctionText ? `\n\n${correctionText}` : "";
            if (orderedMessages && correctionText) orderedMessages.push({role: "user", content: correctionText});
        } else if (repair) {
            const corrected = buildExtractionPrompt(parts, repair);
            const correctionText = corrected.slice(buildExtractionPrompt(parts).length).trimStart();
            prompt = corrected;
            if (orderedMessages && correctionText) orderedMessages.push({role: "user", content: correctionText});
        }
        if (lengthRetry) {
            const instruction = characterRequest ? CHARACTER_LENGTH_RETRY_INSTRUCTION : LENGTH_RETRY_INSTRUCTION;
            prompt += `\n\n${instruction}`;
            orderedMessages?.push({role: "user", content: instruction});
        }
        if (repair && characterRequest) {
            const guidance = [
                "【角色定向修复】",
                '缺少基础引用或 references 类型/位置错误：将引用写在 entity.references（分组为 entities 中对应角色的 references）；从 fields 中移除错误放入的 references。值必须是字符串，保留已经正确的事实和引用。',
                "经历或关系错误：逐条核对模板中的精确键名，每条“参考片段”分别填写当前块内的 P 引用；不要将基础资料的引用替代所有记录的引用。",
                "引用倒序或越界：回到本次原文确认来源，修正对应编号，不能仅为了通过校验编造引用。",
                "JSON 错误：完整重写一个合法 JSON 对象，正确转义引号和反斜杠。",
                CHARACTER_OUTPUT_CONTRACT,
            ].join("\n");
            prompt += `\n\n${guidance}`;
            orderedMessages?.push({role: "user", content: guidance});
        }
        let output: string;
        try {
            const modelRequest: ExtractionModelRequest = {
                system,
                prompt,
                ...(preMessages.length ? {preMessages} : {}),
                ...(orderedMessages ? {orderedMessages} : {}),
                signal: options.signal,
                modelKey: options.modelKey,
                metadata: {...options.metadata, purposeId: options.purposeId, prefixHash},
            };
            output = await options.model.complete(modelRequest);
        } catch (error) {
            if (error instanceof ExtractionModelError && error.stopReason === "length" && attempt === 0) {
                lengthRetry = true;
                continue;
            }
            throw error;
        }
        const result = options.validate(output);
        if (result.ok) return result.value;
        errors.push(result.error);
        repair = {previousOutput: output, error: result.error};
    }
    throw new ExtractionValidationFailure(errors);
}
