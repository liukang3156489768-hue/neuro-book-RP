import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import type {ReadyProjectSessionRef} from "../workspace-files/project-session-types";
import {absoluteFsPath} from "../runtime/paths/file-path";
import {openProject} from "../workspace-files/project-session";
import {projectWorkspaceRef} from "../workspace-files/project-identity";

let sharedWorkspaceRoot: string | null = null;

export async function createTestReadyProject(): Promise<ReadyProjectSessionRef> {
    if (!sharedWorkspaceRoot) {
        sharedWorkspaceRoot = join(tmpdir(), `neuro-book-test-ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    }
    const workspaceRoot = absoluteFsPath(sharedWorkspaceRoot);
    const projectSlug = `test-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    const projectRoot = join(workspaceRoot, projectSlug);
    await mkdir(projectRoot, {recursive: true});
    await mkdir(join(projectRoot, "lorebook", "instruction"), {recursive: true});
    await mkdir(join(projectRoot, "plot"), {recursive: true});

    await writeFile(join(projectRoot, "project.yaml"), "kind: novel\ntitle: 测试作品\nsummary: ''\n", "utf-8");

    return openProject(projectWorkspaceRef(projectSlug), {kind: "job", source: "writing-host-test"}, workspaceRoot);
}
