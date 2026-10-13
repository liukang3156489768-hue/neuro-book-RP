import type {AgentWorkflowContext, JsonValue} from "@notnotype/nb-workflow";
import {validateMaterialReview, type MaterialReview} from "./structures";
import {toJsonValue} from "./workflow-activities";

export const MATERIAL_REVIEW_PROFILE = "writing.material-review";
export const MATERIAL_REJECTION_LIMIT = 3;

/** Each revised draft gets an independent review session, without the preparer's conversation history. */
export async function reviewWritingMaterials(wf: AgentWorkflowContext, input: Readonly<{
    chapterEntryId: string; ownerSessionId?: number; draft: JsonValue;
}>): Promise<Readonly<{ok: true; review: MaterialReview}> | Readonly<{ok: false; errors: readonly string[]}>> {
    const reviewer = await wf.agents.create(MATERIAL_REVIEW_PROFILE, {
        ...(input.ownerSessionId === undefined ? {} : {parent: await wf.sessions.open(input.ownerSessionId)}),
        tags: [`writing:${input.chapterEntryId}`], ephemeral: true, initial: {chapterEntryId: input.chapterEntryId},
    });
    let errors: readonly string[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const reply = await reviewer.invoke({message: "请独立审核补充后的细纲，按需读取来源核验；只提交 materialReview，不改稿。",
            input: toJsonValue({draft: input.draft, feedback: {errors}})});
        const data = reply.status === "completed" ? reply.result.data : null;
        const value = data !== null && typeof data === "object" && !Array.isArray(data) ? data.materialReview : undefined;
        const checked = validateMaterialReview(value);
        if (checked.ok) return {ok: true, review: checked.value};
        errors = checked.errors;
        wf.log(`资料审核提交无效（第 ${attempt} 次）`);
    }
    return {ok: false, errors};
}
