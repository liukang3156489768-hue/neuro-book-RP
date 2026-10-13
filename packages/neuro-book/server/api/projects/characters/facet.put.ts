import {createError, defineEventHandler, readBody} from "h3";
import {CharacterFacetSaveRequestSchema} from "nbook/shared/dto/character-workspace.dto";
import {characterFacetPath, readCharacterFile, readCharacterWorkspace, serializeCharacterFacet} from "nbook/server/character/character-files";
import {runtimePathsFromEnv} from "nbook/server/runtime/paths/runtime-paths";
import {resolveWorkspaceFileTarget} from "nbook/server/workspace-files/novel-workspace";
import {withProjectTargetMutation} from "nbook/server/workspace-files/project-open-guard";
import {assertWorkspaceStorageBoundary} from "nbook/server/workspace-files/workspace-storage-boundary";
import {statWorkspacePath} from "nbook/server/workspace-files/workspace-files";
import {buildWorkspaceWriteConflict} from "nbook/server/workspace-files/workspace-file-conflict";
import {readWorkspaceTextFile} from "nbook/server/workspace-files/workspace-files";
import {USER_LOCAL_ACTOR, writeWorkspaceTextFileTracked} from "nbook/server/workspace-history/tracked-workspace-files";

export default defineEventHandler(async event => {
    const parsed = CharacterFacetSaveRequestSchema.safeParse(await readBody(event));
    if (!parsed.success) throw createError({statusCode: 400, message: parsed.error.issues[0]?.message ?? "角色方案资料格式无效"});
    const body = parsed.data;
    if (body.planId === "original") {
        throw createError({statusCode: 403, message: "原作资料只读，请通过底层文件或重新提取修改"});
    }
    const filePath = characterFacetPath(body.characterId, body.planId, body.kind);
    const target = await resolveWorkspaceFileTarget(runtimePathsFromEnv(), {projectRoot: body.projectRoot});
    return withProjectTargetMutation(target, async handles => {
        await assertWorkspaceStorageBoundary(target, filePath, "mutation");
        const previous = await readCharacterFile(target.root, filePath);
        const node = previous ? await statWorkspacePath(target.root, filePath) : null;
        if ((node?.mtimeMs ?? null) !== body.expectedMtimeMs) {
            const localContent = serializeCharacterFacet(body.kind, body.facet, previous);
            throw createError({
                statusCode: 409,
                message: "方案资料文件已被外部修改，请刷新后重试",
                data: await buildWorkspaceWriteConflict({
                    path: filePath,
                    expectedMtimeMs: body.expectedMtimeMs,
                    actualMtimeMs: node?.mtimeMs ?? null,
                    baseContent: previous?.content ?? "",
                    localContent,
                    remoteContent: previous ? await readWorkspaceTextFile(target.root, filePath) : "",
                    remoteExists: Boolean(node),
                    node,
                }),
            });
        }
        await writeWorkspaceTextFileTracked({target, history: handles?.history, filePath, content: serializeCharacterFacet(body.kind, body.facet, previous), actor: USER_LOCAL_ACTOR, knownBefore: previous?.content ?? null});
        return readCharacterWorkspace(target.root);
    });
});
