import fs from "node:fs/promises";
import {createError, getQuery, setResponseHeader} from "h3";
import {z} from "zod";
import {characterProfilePath, readCharacterFile} from "nbook/server/character/character-files";
import {runtimePathsFromEnv} from "nbook/server/runtime/paths/runtime-paths";
import {resolveWorkspaceFileTarget} from "nbook/server/workspace-files/novel-workspace";
import {withProjectTargetOperation} from "nbook/server/workspace-files/project-open-guard";
import {assertRealPathContained, resolveContainedFilePath} from "nbook/server/runtime/paths/file-path";

const querySchema = z.object({projectRoot: z.string().min(1), path: z.string().min(1)});
const avatarPath = /^lorebook\/character\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/avatar\.(png|jpg|webp)$/u;
const mimeByExtension = {png: "image/png", jpg: "image/jpeg", webp: "image/webp"} as const;

export default defineEventHandler(async (event) => {
    const parsedQuery = querySchema.safeParse(getQuery(event));
    if (!parsedQuery.success) throw createError({statusCode: 400, message: "projectRoot 或头像路径无效"});
    const query = parsedQuery.data;
    const match = avatarPath.exec(query.path);
    if (!match) throw createError({statusCode: 400, message: "头像路径无效"});
    const target = await resolveWorkspaceFileTarget(runtimePathsFromEnv(), {projectRoot: query.projectRoot});
    return withProjectTargetOperation(target, async () => {
        if (!await readCharacterFile(target.root, characterProfilePath(match[1]!))) throw createError({statusCode: 404, message: "角色不存在"});
        const absolutePath = resolveContainedFilePath(target.root, query.path);
        await assertRealPathContained(target.root, absolutePath);
        let bytes: Buffer;
        try { bytes = await fs.readFile(absolutePath); } catch { throw createError({statusCode: 404, message: "头像不存在"}); }
        setResponseHeader(event, "Content-Type", mimeByExtension[match[2] as keyof typeof mimeByExtension]);
        setResponseHeader(event, "Content-Length", bytes.byteLength);
        setResponseHeader(event, "Content-Disposition", "inline");
        setResponseHeader(event, "Cache-Control", "private, max-age=0, must-revalidate");
        setResponseHeader(event, "X-Content-Type-Options", "nosniff");
        return bytes;
    });
});
