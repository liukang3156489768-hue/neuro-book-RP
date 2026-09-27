import {z} from "zod";
import {canParentEntry, type OutlineEntryKind, type OutlineId} from "./format";
import type {PlanningSnapshot} from "./index";
import {OutlineLibraryError} from "./library";

export class OutlineGenerationError extends Error {
    constructor(message: string, readonly code: "MODEL_UNAVAILABLE" | "MODEL_FAILED" | "INVALID_RESULT", cause?: unknown) {
        super(message, {cause});
        this.name = "OutlineGenerationError";
    }
}

export type DirectionInput = Readonly<{
    planId: string;
    parentId: OutlineId;
    entryKind: Exclude<OutlineEntryKind, "total">;
    direction: string;
}>;

export type DirectionDraft = DirectionInput & Readonly<{
    expectedRevision: number;
    parentContentHash: string;
    title: string;
    body: string;
}>;

const DraftSchema = z.object({title: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(20_000)}).strict();

/** 模型只有建议权；调用方必须独立审阅，并通过带 revision 的领域创建入口保存草稿。 */
export async function generateDirectionDraft(
    snapshot: PlanningSnapshot, input: DirectionInput, complete: (prompt: string) => Promise<string>,
): Promise<DirectionDraft> {
    const plan = snapshot.manifest.plans.find(({id}) => id === input.planId);
    const parent = snapshot.entries.find(({value}) => value.id === input.parentId);
    if (!plan || !parent || !plan.placements.some(({entryId}) => entryId === input.parentId)
        || !canParentEntry(parent.value.kind, input.entryKind)) {
        throw new OutlineLibraryError("方向生成的方案或父级不存在，或父级类型不合法");
    }
    const direction = input.direction.trim();
    if (!direction || direction.length > 4000) throw new OutlineLibraryError("请提供不超过 4000 字的简单方向");
    const entries = new Map(snapshot.entries.map(({value}) => [value.id, value]));
    const siblings = plan.placements.filter(({parentId}) => parentId === input.parentId)
        .slice(0, 30).map(({entryId}) => entries.get(entryId)?.title).filter((title): title is string => Boolean(title));
    const prompt = JSON.stringify({direction, plan: plan.title, parent: {title: parent.value.title,
        body: parent.value.body.slice(0, 4000)}, siblingTitles: siblings, entryKind: input.entryKind});
    let raw: string;
    try {
        raw = await complete(prompt);
    } catch (error) {
        if (error instanceof OutlineGenerationError) throw error;
        throw new OutlineGenerationError("生成草案失败，请检查模型配置或稍后重试", "MODEL_FAILED", error);
    }
    let decoded: unknown;
    try {
        decoded = JSON.parse(raw);
    } catch (error) {
        throw new OutlineGenerationError("模型没有返回合法的草案 JSON", "INVALID_RESULT", error);
    }
    const result = DraftSchema.safeParse(decoded);
    if (!result.success) throw new OutlineGenerationError("模型草案缺少有效标题或正文", "INVALID_RESULT", result.error);
    return {...input, direction, expectedRevision: snapshot.manifest.revision, parentContentHash: parent.contentHash,
        title: result.data.title, body: result.data.body};
}
