import {z} from "zod";
import type {OperationActor} from "@notnotype/nb-history";
import {createWorkspaceContentFrontmatterDefaults} from "nbook/server/workspace-files/content-node-schema";
import type {ProjectDataPlaneHandles} from "nbook/server/workspace-files/project-open-guard";
import type {WorkspaceFileTarget} from "nbook/server/workspace-files/workspace-file-target";
import {parseMarkdownDocument, readWorkspaceTextFile, renderMarkdownDocument, workspacePathExists} from "nbook/server/workspace-files/workspace-files";
import {createWorkspaceFileTracked, writeWorkspaceTextFileTracked} from "nbook/server/workspace-history/tracked-workspace-files";
import {materialCategorySpec} from "./material-data";
import {MaterialNoteIndexSchema, noteIndexKey, type MaterialNoteIndex, type NoteIndexCategory} from "./material-note-index";
import type {MaterialReview} from "./material-review";

const PublishedEntrySchema = MaterialNoteIndexSchema.shape.entries.element.omit({key: true}).extend({
    path: z.string().min(1),
    title: z.string().min(1),
    taskId: z.string().uuid(),
    sourcePath: z.string().min(1),
    blocks: z.array(z.number().int().positive()),
}).strict();
const PublishedIndexSchema = z.object({
    version: z.literal(1), category: z.enum(["writing-technique", "material-feature"]), entries: z.array(PublishedEntrySchema),
}).strict();
type PublishedEntry = z.infer<typeof PublishedEntrySchema>;

export function publishedNoteIndexPath(category: NoteIndexCategory): string {
    return `lorebook/note/${category === "writing-technique" ? "写作手法" : "写作素材"}索引.md`;
}

function renderIndex(category: NoteIndexCategory, entries: readonly PublishedEntry[]): string {
    const title = `${category === "writing-technique" ? "写作手法" : "写作素材"}索引`;
    const groups = new Map<string, PublishedEntry[]>();
    for (const entry of entries) {
        const list = groups.get(entry.group) ?? [];
        list.push(entry);
        groups.set(entry.group, list);
    }
    const body = [`# ${title}`, "先根据分类、摘要和检索词选择条目，再读取链接指向的文档。链接按项目相对路径定位，正文无需全部加载。"];
    const plain = (text: string) => text.replace(/[\r\n]+/gu, " ").replace(/[\\`*_\[\]<>#]/gu, "");
    for (const [group, items] of [...groups].sort(([left], [right]) => left.localeCompare(right, "zh-CN"))) {
        body.push(`## ${plain(group)}`);
        for (const entry of items) {
            const relativeLink = `./${entry.path.slice("lorebook/note/".length).split("/").map(segment => encodeURIComponent(segment).replace(/[!'()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join("/")}`;
            body.push([
                `- [${plain(entry.title)}](${relativeLink})：${plain(entry.summary)}`,
                `  - 检索词：${entry.keywords.map(plain).join("、")}`,
                `  - 项目路径：\`${entry.path}\``,
                `  - 来源：${plain(entry.sourcePath)}${entry.blocks.length ? `；分块：${entry.blocks.join("、")}` : ""}`,
            ].join("\n"));
        }
    }
    const frontmatter = createWorkspaceContentFrontmatterDefaults({title, type: "note", status: "active"});
    frontmatter.subtype = "material-index";
    frontmatter.summary = `按分类检索${entries.length}条${category === "writing-technique" ? "写作手法" : "写作素材"}，根据链接按需读取正文。`;
    frontmatter.governance = {source: "generated", review: "reviewed"};
    frontmatter.ext = {materialIndex: PublishedIndexSchema.parse({version: 1, category, entries})};
    return renderMarkdownDocument(frontmatter, body.join("\n\n"));
}

/** 索引按实际成功路径更新，保留其他任务的条目；无法识别的同名文件绝不自动覆盖。 */
export async function writePublishedNoteIndex(input: {
    target: WorkspaceFileTarget;
    handles: ProjectDataPlaneHandles | undefined;
    before: MaterialReview;
    review: MaterialReview;
    index: MaterialNoteIndex;
    sourcePath: string;
    actor: OperationActor;
}): Promise<string | null> {
    const category = input.index.category;
    const written = input.review.items.filter(item => item.category === category && item.write.status === "written");
    if (!written.length) return null;
    const filePath = publishedNoteIndexPath(category);
    let before: string | undefined;
    const directory = materialCategorySpec(category).directory;
    const entries = new Map<string, PublishedEntry>();
    if (await workspacePathExists(input.target.root, filePath)) {
        before = await readWorkspaceTextFile(input.target.root, filePath);
        const metadata = parseMarkdownDocument(before).frontmatter;
        const ext = z.object({materialIndex: PublishedIndexSchema}).safeParse(metadata.ext);
        if (metadata.subtype !== "material-index" || !ext.success || ext.data.materialIndex.category !== category) {
            throw new Error(`索引路径 ${filePath} 已有其他内容，请先移动该文件后重新确认写入`);
        }
        for (const entry of ext.data.materialIndex.entries) {
            if (!entry.path.startsWith(directory) || !entry.path.endsWith("/index.md") || entry.path.split("/").some(segment => segment === "." || segment === ".." || segment.includes("\\"))) {
                throw new Error(`已有素材索引包含无效路径：${entry.path}`);
            }
            if (await workspacePathExists(input.target.root, entry.path)) entries.set(entry.path.toLowerCase(), entry);
        }
    }
    const annotations = new Map(input.index.entries.map(entry => [entry.key, entry]));
    const originals = new Map(input.before.items.map(item => [item.id, item]));
    for (const item of written) {
        // 另存为会改标题但不会改正文；摘要取写入前身份，路径取写入后的真实目录。
        const annotation = annotations.get(noteIndexKey(originals.get(item.id) ?? item));
        if (!annotation) throw new Error(`“${item.title}”缺少有效的 AI 索引，请重新确认写入`);
        const entry: PublishedEntry = {
            group: annotation.group, summary: annotation.summary, keywords: annotation.keywords,
            path: `${directory}${item.directoryName}/index.md`, title: item.title,
            taskId: input.review.taskId, sourcePath: input.sourcePath,
            blocks: [...new Set(item.nodes.flatMap(node => node.entries.flatMap(entry => entry.block === null ? [] : [entry.block])))].sort((left, right) => left - right),
        };
        const existing = entries.get(entry.path.toLowerCase());
        // 其他任务后来覆盖了同一路径时，重确认旧任务不能把索引倒退为旧正文的注释。
        if (existing && existing.taskId !== input.review.taskId && originals.get(item.id)?.write.status === "written") continue;
        if (await workspacePathExists(input.target.root, entry.path)) entries.set(entry.path.toLowerCase(), entry);
    }
    const content = renderIndex(category, [...entries.values()]);
    if (content === before) return null;
    if (before === undefined) {
        await createWorkspaceFileTracked({target: input.target, history: input.handles?.history, filePath, content, actor: input.actor});
    } else {
        await writeWorkspaceTextFileTracked({target: input.target, history: input.handles?.history, filePath, content, actor: input.actor, knownBefore: before});
    }
    return filePath;
}
