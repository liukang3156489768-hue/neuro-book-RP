import {createError, defineEventHandler, readBody} from "h3";
import {CharacterProfileSaveRequestSchema} from "nbook/shared/dto/character-workspace.dto";
import {characterProfilePath, readCharacterFile, readCharacterWorkspace, serializeCharacterProfile} from "nbook/server/character/character-files";
import {runtimePathsFromEnv} from "nbook/server/runtime/paths/runtime-paths";
import {resolveWorkspaceFileTarget} from "nbook/server/workspace-files/novel-workspace";
import {withProjectTargetMutation} from "nbook/server/workspace-files/project-open-guard";
import {assertWorkspaceStorageBoundary} from "nbook/server/workspace-files/workspace-storage-boundary";
import {readWorkspaceTextFile, statWorkspacePath} from "nbook/server/workspace-files/workspace-files";
import {buildWorkspaceWriteConflict} from "nbook/server/workspace-files/workspace-file-conflict";
import {validateProjectCoverUpload, ProjectCoverUploadError} from "nbook/server/workspace-files/project-cover-upload";
import {USER_LOCAL_ACTOR, writeWorkspaceBinaryFileTracked, writeWorkspaceTextFileTracked} from "nbook/server/workspace-history/tracked-workspace-files";

const MAX_AVATAR_BYTES = 20 * 1024 * 1024;

export default defineEventHandler(async event => {
    const parsed = CharacterProfileSaveRequestSchema.safeParse(await readBody(event));
    if (!parsed.success) throw createError({statusCode: 400, message: parsed.error.issues[0]?.message ?? "角色资料格式无效"});
    const body = parsed.data;
    if (body.profile.id !== body.characterId) {
        throw createError({statusCode: 400, message: "角色资料 id 必须与角色目录一致"});
    }
    const filePath = characterProfilePath(body.characterId);
    const target = await resolveWorkspaceFileTarget(runtimePathsFromEnv(), {projectRoot: body.projectRoot});
    return withProjectTargetMutation(target, async handles => {
        await assertWorkspaceStorageBoundary(target, filePath, "mutation");
        const previous = await readCharacterFile(target.root, filePath);
        if (!previous) throw createError({statusCode: 404, message: "角色 index.md 不存在，不能通过管理页新建角色"});
        const node = await statWorkspacePath(target.root, filePath);
        if (body.expectedMtimeMs !== null && node.mtimeMs !== body.expectedMtimeMs) {
            throw createError({statusCode: 409, message: "角色文件已被外部修改，请刷新后重试", data: await buildWorkspaceWriteConflict({path: filePath, expectedMtimeMs: body.expectedMtimeMs, actualMtimeMs: node.mtimeMs, baseContent: previous.content, localContent: serializeCharacterProfile(body.profile, previous), remoteContent: await readWorkspaceTextFile(target.root, filePath), remoteExists: true, node})});
        }
        let profile = body.profile;
        let avatar: {bytes: Uint8Array; extension: "png" | "jpg" | "webp"} | null = null;
        if (body.avatarUpload) {
            if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(body.avatarUpload.base64)) {
                throw createError({statusCode: 400, message: "角色图片编码无效"});
            }
            const bytes = Buffer.from(body.avatarUpload.base64, "base64");
            if (bytes.length > MAX_AVATAR_BYTES) {
                throw createError({statusCode: 413, message: "角色图片超过 20 MiB 大小限制"});
            }
            try {
                avatar = await validateProjectCoverUpload({bytes, declaredMimeType: body.avatarUpload.mime});
            } catch (error) {
                if (error instanceof ProjectCoverUploadError) throw createError({statusCode: 422, message: error.message, data: {code: error.code}});
                throw error;
            }
            profile = {...body.profile, avatar: `avatar.${avatar.extension}`};
            await writeWorkspaceBinaryFileTracked({target, history: handles?.history, filePath: `lorebook/character/${body.characterId}/${profile.avatar}`, bytes: avatar.bytes, actor: USER_LOCAL_ACTOR});
        }
        await writeWorkspaceTextFileTracked({target, history: handles?.history, filePath, content: serializeCharacterProfile(profile, previous), actor: USER_LOCAL_ACTOR, knownBefore: previous.content});
        return readCharacterWorkspace(target.root);
    });
});
