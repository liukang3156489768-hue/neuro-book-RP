import {Type} from "typebox";
import {normalizeToolResultDetails} from "nbook/server/agent/messages/message-utils";
import type {JsonValue} from "nbook/server/agent/messages/types";
import {defineAgentTool, type NeuroToolResult, type ToolExecutionContext} from "nbook/server/agent/tools/types";
import type {ReadyProjectSessionRef} from "nbook/server/workspace-files/project-session-types";
import {assistantCanRead, chapterReferencePaths, normalizeAssistantPath} from "nbook/server/writing/assistant-scope";
import {markdownBlocks} from "nbook/shared/markdown-structure";
import {stripFrontmatter} from "nbook/server/writing/materials";
import {parseMarkdownDocument} from "nbook/server/workspace-files/workspace-files";
import {WritingError} from "nbook/server/writing/prose-binding";
import {REWRITE_CONFIRM_TITLE, type RewriteTarget} from "nbook/server/writing/rewrite";
import type {WritingRunService, WritingRunSummary} from "nbook/server/writing/run-service";
import type {WritingChapterDto, WritingChapterIssuesDto, WritingChapterStatus} from "nbook/shared/dto/writing.dto";

// 写作 host 经受跟踪写入依赖 project-history，而工具注册表在 project-history → config → harness 的加载链上；
// 静态导入会成环，原生 ESM（Profile 编译 Worker）里 project-history 的常量会在初始化前被读取。
const loadWritingHost = () => import("nbook/server/writing/host");
// 运行报告经进度投影引用工作流活动，后者静态依赖 host，同样按需加载。
const loadRunReport = () => import("nbook/server/writing/run-report");

async function writingRunService(context: ToolExecutionContext, project: ReadyProjectSessionRef): Promise<WritingRunService> {
    const {useWritingRunService} = await import("nbook/server/writing/runtime");
    return useWritingRunService(context.harness, project);
}

const ChapterEntryId = Type.String({pattern: "^ol-[a-z0-9][a-z0-9-]*$", description: "章节大纲条目 id（get_writing_status 列出的 entryId）"});
const Mode = Type.Union([Type.Literal("auto"), Type.Literal("discussion")], {
    description: "auto：主创核对通过即开写；discussion：主创核对后再交用户确认场景规划",
});

const CHAPTER_STATUS: Record<WritingChapterStatus, string> = {
    "outline-not-adopted": "大纲未采纳",
    "detail-not-reviewed": "细纲未审阅",
    unwritten: "未写",
    written: "已写",
    "source-stale": "正文依据已过期",
    "ownership-conflict": "正文归属冲突",
};

function requireProject(context: ToolExecutionContext): ReadyProjectSessionRef {
    if (!context.currentProject) throw new Error("写作工具必须绑定当前已打开的 Project");
    return context.currentProject;
}

function textResult(text: string, details: unknown): NeuroToolResult {
    return {content: [{type: "text", text}], details: normalizeToolResultDetails(details as JsonValue)};
}

/** 段号与摘录定位、改写定位同一口径（markdownBlocks）。 */
function numberParagraphs(body: string): string {
    return markdownBlocks(body).map((block, index) => `[${index + 1}] ${body.slice(block.start, block.end)}`).join("\n\n");
}

function describeChapter(chapter: WritingChapterDto): string {
    const prose = chapter.prose.length === 0 ? "无正文" : chapter.prose.map(({path, empty}) => `${path}${empty ? "（空）" : ""}`).join("、");
    const block = chapter.block ? `；${chapter.block.message}` : "";
    return `- ${chapter.title}（${chapter.entryId}）：${CHAPTER_STATUS[chapter.status]}，${chapter.writable ? "可写" : "不可写"}${block}；正文：${prose}`;
}

function describeIssues(issues: WritingChapterIssuesDto | undefined): string[] {
    const open = issues?.issues.filter(({status}) => status === "open" || status === "pending-review") ?? [];
    if (open.length === 0) return ["未处理问题：无"];
    return ["未处理问题：", ...open.map((issue) =>
        `- [${issue.severity === "blocking" ? "阻断" : "提示"}${issue.status === "pending-review" ? "，待复核" : ""}] ${issue.code}：${issue.message}`)];
}

async function requireChapterTitle(project: ReadyProjectSessionRef, chapterEntryId: string): Promise<string> {
    const chapter = (await (await loadWritingHost()).readReadyWritingOverview(project)).chapters.find(({entryId}) => entryId === chapterEntryId);
    if (!chapter) throw new WritingError("CHAPTER_NOT_IN_PLAN", `写作方案中没有该章节：${chapterEntryId}`);
    return chapter.title;
}

/** 主创工具发起或推进的运行，报告交回发起调用的主创会话。 */
async function trackRun(context: ToolExecutionContext, toolCallId: string, service: WritingRunService, summary: WritingRunSummary,
    chapterTitle: string): Promise<NeuroToolResult> {
    const what = summary.kind === "rewrite" ? "改写运行" : "写作运行";
    const {job} = (await loadRunReport()).trackWritingRun({harness: context.harness, ownerSessionId: context.sessionId, originToolCallId: toolCallId, service, summary, chapterTitle});
    return textResult([
        `${what} ${summary.runId} 已在后台推进（任务 ${job.jobId}）。`,
        "运行停在等待核对或确认、结束或停止时，报告会以后续消息交回本会话。现在向用户简述进展并结束本回合，不要轮询。",
    ].join("\n"), {runId: summary.runId, jobId: job.jobId, status: summary.status, chapterEntryId: summary.chapterEntryId});
}

/** 主创工具：运行调度、状态与正文读取，以及用户授权的限域正文删改；不直接读写规划和资料。 */
export function createWritingLeadTools() {
    const getWritingStatus = defineAgentTool({
        key: "get_writing_status",
        description: "查看写作状态。不传 chapterEntryId：写作方案、文风与各章状态；传入：该章状态、最近的写作与改写运行、待应答的场景规划或改写确认与未处理问题。",
        parameters: Type.Object({chapterEntryId: Type.Optional(ChapterEntryId)}),
        async executeWithContext(context, _toolCallId, params): Promise<NeuroToolResult> {
            const project = requireProject(context);
            const {chapterEntryId} = params as {chapterEntryId?: string};
            const overview = await (await loadWritingHost()).readReadyWritingOverview(project);
            if (chapterEntryId === undefined) {
                const plan = overview.plan.state === "ready" ? `${overview.plan.title}（${overview.plan.planId}）`
                    : overview.plan.state === "unset" ? "未设置" : overview.plan.message;
                const lines = [`写作方案：${plan}`, `文风：${overview.settings.stylePath ?? "未设置"}`, "章节：",
                    ...(overview.chapters.length === 0 ? ["- （无）"] : overview.chapters.map(describeChapter))];
                return textResult(lines.join("\n"), {plan: overview.plan, stylePath: overview.settings.stylePath,
                    chapters: overview.chapters.map(({entryId, title, status, writable}) => ({entryId, title, status, writable}))});
            }
            const chapter = overview.chapters.find(({entryId}) => entryId === chapterEntryId);
            if (!chapter) throw new WritingError("CHAPTER_NOT_IN_PLAN", `写作方案中没有该章节：${chapterEntryId}`);
            const service = await writingRunService(context, project);
            const runs = (await service.listChapterRuns(chapterEntryId)).slice(-3);
            const issues = (await (await loadWritingHost()).readReadyWritingIssues(project)).chapters.find((item) => item.chapterEntryId === chapterEntryId);
            const lines = [describeChapter(chapter), ...describeIssues(issues), "最近的写作与改写运行："];
            if (runs.length === 0) lines.push("- （无）");
            for (const run of runs) lines.push(await (await loadRunReport()).describeRun(service, run, chapter.title));
            return textResult(lines.join("\n"), {chapter: {entryId: chapter.entryId, title: chapter.title, status: chapter.status},
                runs: runs.map((run) => ({runId: run.runId, kind: run.kind, status: run.status, interrupted: run.interrupted,
                    ...(run.kind === "chapter" ? {task: run.task, mode: run.mode} : {})}))});
        },
    });

    const startWriting = defineAgentTool({
        key: "start_writing",
        description: "发起一章的写作：new 新写，rewrite 整章重写（先征得用户同意）。重写默认保留已确认的场景规划，从场景 1 重新写正文；细纲或资料变更时重新规划审核。reusePlan=false 明确放弃旧场景规划。运行在后台推进，报告以后续消息交回。",
        parameters: Type.Object({
            chapterEntryId: ChapterEntryId,
            task: Type.Union([Type.Literal("new"), Type.Literal("rewrite")]),
            mode: Mode,
            reusePlan: Type.Optional(Type.Boolean({description: "整章重写默认 true；仅用户要求重新规划时设 false"})),
        }),
        mutatesWorkspace: true,
        async executeWithContext(context, toolCallId, params): Promise<NeuroToolResult> {
            const project = requireProject(context);
            const input = params as {chapterEntryId: string; task: "new" | "rewrite"; mode: "auto" | "discussion"; reusePlan?: boolean};
            const title = await requireChapterTitle(project, input.chapterEntryId);
            const service = await writingRunService(context, project);
            return trackRun(context, toolCallId, service, await service.start({...input, ownerSessionId: context.sessionId}), title);
        },
    });

    const continueWriting = defineAgentTool({
        key: "continue_writing",
        description: "续写该章最近一次停止、中断或失败的写作运行，从第一个未通过的场景继续；mode 缺省沿用上次。",
        parameters: Type.Object({chapterEntryId: ChapterEntryId, mode: Type.Optional(Mode)}),
        mutatesWorkspace: true,
        async executeWithContext(context, toolCallId, params): Promise<NeuroToolResult> {
            const project = requireProject(context);
            const input = params as {chapterEntryId: string; mode?: "auto" | "discussion"};
            const title = await requireChapterTitle(project, input.chapterEntryId);
            const service = await writingRunService(context, project);
            return trackRun(context, toolCallId, service, await service.continue(input), title);
        },
    });

    const stopWriting = defineAgentTool({
        key: "stop_writing",
        description: "停止该章正在进行或等待应答的写作或改写运行；已通过的场景保留，之后可续写；改写停止时正文不变。",
        parameters: Type.Object({chapterEntryId: ChapterEntryId}),
        async executeWithContext(context, _toolCallId, params): Promise<NeuroToolResult> {
            const project = requireProject(context);
            const {chapterEntryId} = params as {chapterEntryId: string};
            const title = await requireChapterTitle(project, chapterEntryId);
            const service = await writingRunService(context, project);
            const active = (await service.listChapterRuns(chapterEntryId)).filter(({status}) => status === "running" || status === "waiting").at(-1);
            if (!active) throw new WritingError("RUN_NOT_FOUND", "该章没有正在进行的写作运行");
            const stopped = await service.stop(active.runId);
            return textResult(await (await loadRunReport()).describeRun(service, stopped, title), {runId: stopped.runId, status: stopped.status});
        },
    });

    const answerScenePlan = defineAgentTool({
        key: "answer_scene_plan",
        description: "应答写作运行等待中的场景规划：approved=true 通过；false 退回，comments 写明要改什么。讨论模式的用户确认只能转交用户本人的决定。",
        parameters: Type.Object({
            runId: Type.String({description: "写作运行 id"}),
            approved: Type.Boolean(),
            comments: Type.Optional(Type.String({description: "退回意见；通过时可留空"})),
        }),
        mutatesWorkspace: true,
        async executeWithContext(context, toolCallId, params): Promise<NeuroToolResult> {
            const project = requireProject(context);
            const input = params as {runId: string; approved: boolean; comments?: string};
            const service = await writingRunService(context, project);
            const asks = (await service.view(input.runId)).pendingAsks;
            if (asks.length !== 1 || asks[0]!.spec.title === REWRITE_CONFIRM_TITLE) {
                throw new WritingError("RUN_ANSWER_INVALID", "该运行当前没有等待应答的场景规划");
            }
            if (!input.approved && (input.comments ?? "").trim() === "") throw new WritingError("RUN_ANSWER_INVALID", "退回场景规划时必须写明意见");
            const answer: JsonValue = input.comments === undefined ? {approved: input.approved} : {approved: input.approved, comments: input.comments};
            const summary = await service.answer(input.runId, {[asks[0]!.key]: answer});
            return trackRun(context, toolCallId, service, summary, await requireChapterTitle(project, summary.chapterEntryId));
        },
    });

    const startRewrite = defineAgentTool({
        key: "start_rewrite",
        description: [
            "发起局部改写：目标扩展到完整段落，写手参考上下各两段改写，改写结果先交用户确认，确认前正文不变。",
            "target 二选一：paragraphs 用 read_chapter_prose 显示的段号 [n]；quote 摘一段正文原话（须在正文中只出现一次）。",
            "requirement 整理用户的修改要求。运行在后台推进，报告以后续消息交回。",
        ].join(""),
        parameters: Type.Object({
            chapterEntryId: ChapterEntryId,
            target: Type.Union([
                Type.Object({paragraphs: Type.Object({from: Type.Integer({minimum: 1}), to: Type.Optional(Type.Integer({minimum: 1}))})}),
                Type.Object({quote: Type.String({minLength: 1})}),
            ]),
            requirement: Type.String({minLength: 1, description: "用户的修改要求，写清要改什么、改成什么样"}),
        }),
        mutatesWorkspace: true,
        async executeWithContext(context, toolCallId, params): Promise<NeuroToolResult> {
            const project = requireProject(context);
            const input = params as {chapterEntryId: string; target: RewriteTarget; requirement: string};
            if (input.requirement.trim() === "") throw new WritingError("RUN_ANSWER_INVALID", "改写必须写明修改要求");
            const title = await requireChapterTitle(project, input.chapterEntryId);
            const service = await writingRunService(context, project);
            return trackRun(context, toolCallId, service, await service.startRewrite({...input, ownerSessionId: context.sessionId, requirement: input.requirement.trim()}), title);
        },
    });

    const answerRewrite = defineAgentTool({
        key: "answer_rewrite",
        description: "转交用户对改写新旧对照的决定：replace=true 替换目标段落，false 放弃改写、正文不变。只能转交用户本人明确的决定。",
        parameters: Type.Object({runId: Type.String({description: "改写运行 id"}), replace: Type.Boolean()}),
        mutatesWorkspace: true,
        async executeWithContext(context, toolCallId, params): Promise<NeuroToolResult> {
            const project = requireProject(context);
            const input = params as {runId: string; replace: boolean};
            const service = await writingRunService(context, project);
            const asks = (await service.view(input.runId)).pendingAsks;
            if (asks.length !== 1 || asks[0]!.spec.title !== REWRITE_CONFIRM_TITLE) {
                throw new WritingError("RUN_ANSWER_INVALID", "该运行当前没有等待确认的改写");
            }
            const summary = await service.answer(input.runId, {[asks[0]!.key]: input.replace});
            return trackRun(context, toolCallId, service, summary, await requireChapterTitle(project, summary.chapterEntryId));
        },
    });

    const readChapterProse = defineAgentTool({
        key: "read_chapter_prose",
        description: "读取该章正文（不含文件头），用于向用户汇报或讨论。每段前标注段号 [n]，发起改写时用这些段号定位。",
        parameters: Type.Object({chapterEntryId: ChapterEntryId}),
        async executeWithContext(context, _toolCallId, params): Promise<NeuroToolResult> {
            const project = requireProject(context);
            const {chapterEntryId} = params as {chapterEntryId: string};
            const facts = await (await loadWritingHost()).readReadyWritingRunFacts(project, {chapterEntryId});
            if (facts.prose === null) return textResult(`${facts.chapter.title} 尚无正文文件`, {path: null});
            const {path, body, hash} = facts.prose;
            if (body.trim() === "") return textResult(`${path} 正文为空；版本 ${hash}`, {path, hash});
            return textResult(`正文版本：${hash}\n\n${numberParagraphs(body)}`, {path, hash, paragraphs: markdownBlocks(body).length});
        },
    });

    const editChapterProse = defineAgentTool({
        key: "edit_chapter_prose",
        description: "按用户明确决定删除或替换正文。先 read_chapter_prose 获取正文版本 baseHash。target 指定段号或唯一原文，操作扩展到完整段落；不传 target 则作用于全章。replacement 为空表示删除，非空仅写入用户提供或已确认的替换文案。不能自行生成正文；需模型润色用 start_rewrite，整章重写用 start_writing。确认前不得调用。旧正文保留在历史，大纲和已确认场景规划保留。",
        parameters: Type.Object({
            chapterEntryId: ChapterEntryId,
            baseHash: Type.String({pattern: "^sha256:[0-9a-f]{64}$"}),
            target: Type.Optional(Type.Union([
                Type.Object({paragraphs: Type.Object({from: Type.Integer({minimum: 1}), to: Type.Optional(Type.Integer({minimum: 1}))})}),
                Type.Object({quote: Type.String({minLength: 1})}),
            ])),
            replacement: Type.String(),
            confirmed: Type.Boolean({description: "仅用户已明确同意此次范围和删改内容时为 true"}),
        }),
        mutatesWorkspace: true,
        async executeWithContext(context, _toolCallId, params): Promise<NeuroToolResult> {
            const input = params as {chapterEntryId: string; baseHash: string; target?: RewriteTarget; replacement: string; confirmed: boolean};
            if (!input.confirmed) throw new WritingError("RUN_ANSWER_INVALID", "正文删改需要用户明确确认");
            const service = await writingRunService(context, requireProject(context));
            const {confirmed: _confirmed, ...edit} = input;
            const result = await service.editProse(edit);
            return textResult(result.status === "conflict" ? "正文在读取后已改变，本次没有修改；请重新读取并确认。"
                : result.status === "unchanged" ? "正文没有变化。" : "正文已按用户要求修改，旧正文保留在文件历史中；大纲和已确认场景规划保留。", result);
        },
    });

    return {getWritingStatus, startWriting, continueWriting, stopWriting, answerScenePlan, startRewrite, answerRewrite, readChapterProse, editChapterProse};
}

/** 助手会话在创建时绑定章节；可读范围按章节交接当前列出的参考路径计算，不接受模型传入章节。 */
async function assistantScope(context: ToolExecutionContext): Promise<Readonly<{project: ReadyProjectSessionRef; referencePaths: string[]}>> {
    const project = requireProject(context);
    const initial = (await context.harness.repo.readSession(context.sessionId)).metadata.initial;
    const chapterEntryId = initial !== null && typeof initial === "object" && !Array.isArray(initial) ? initial.chapterEntryId : undefined;
    if (typeof chapterEntryId !== "string") throw new Error("写作助手会话没有绑定章节");
    const facts = await (await loadWritingHost()).readReadyWritingRunFacts(project, {chapterEntryId});
    return {project, referencePaths: facts.context === null ? [] : chapterReferencePaths(facts.context)};
}

/** 助手工具：只读 `lorebook/` 与本章参考文件，伏笔定义除外。 */
export function createWritingAssistantTools() {
    const listWritingMaterials = defineAgentTool({
        key: "list_writing_materials",
        description: "列出本章可读的资料文件：lorebook/ 下的 Markdown 文件与本章交接列出的参考文件。",
        parameters: Type.Object({}),
        async executeWithContext(context): Promise<NeuroToolResult> {
            const {project, referencePaths} = await assistantScope(context);
            const listing = await (await loadWritingHost()).listReadyAssistantFiles(project, {referencePaths});
            const lines = [
                "本章参考文件：",
                ...(listing.references.length === 0 ? ["- （无）"] : listing.references.map(({path, readable}) => `- ${path}${readable ? "" : "（不可读）"}`)),
                "lorebook/ 文件：",
                ...(listing.lorebook.length === 0 ? ["- （无）"] : listing.lorebook.map((path) => `- ${path}`)),
            ];
            return textResult(lines.join("\n"), listing);
        },
    });

    const readWritingMaterial = defineAgentTool({
        key: "read_writing_material",
        description: "读取一份可读范围内的资料文件。角色文件同时返回 YAML 中的基础人设、记录和状态；其他文件只返回正文。正文每段前标注段号 [n]，摘录按段落引用时使用这些段号，结构化资料不参与编号。姓名或别名可用于角色入口，侧面文件请使用入口 id 对应的稳定目录路径。",
        parameters: Type.Object({path: Type.String({description: "工作区相对路径，来自 list_writing_materials 或规划材料"})}),
        async executeWithContext(context, _toolCallId, params): Promise<NeuroToolResult> {
            const {project, referencePaths} = await assistantScope(context);
            const path = normalizeAssistantPath((params as {path: string}).path);
            if (path === null || !assistantCanRead(path, referencePaths)) {
                throw new Error(`不在可读范围内：${(params as {path: string}).path}。只能读 lorebook/ 与本章参考文件，伏笔定义不可读`);
            }
            const content = (await (await loadWritingHost()).readReadyAssistantFiles(project, {paths: [path], referencePaths})).get(path);
            if (content === undefined) throw new Error(`文件不存在或不可读：${path}`);
            const body = stripFrontmatter(content);
            if (path.startsWith("lorebook/character/")) {
                const parsed = parseMarkdownDocument(content);
                if (parsed.error) throw new Error(`角色资料文件头无效：${path}：${parsed.error}`);
                const fm = parsed.frontmatter;
                const ext = typeof fm.ext === "object" && fm.ext !== null && !Array.isArray(fm.ext) ? fm.ext : {};
                const character = "character" in ext ? ext.character : undefined;
                // 角色真相源包含 YAML，单独展示必要字段，避免正文编号变化和整份提取来源清单进入上下文。
                const characterData = {id: fm.id, title: fm.title, aliases: fm.aliases, tags: fm.tags, summary: fm.summary,
                    character, records: fm.records, state: fm.state};
                return textResult(`${path}\n\n角色结构化资料（来自 YAML 文件头，不参与正文段号）：\n${JSON.stringify(characterData, null, 2)}\n\n正文：\n${numberParagraphs(body)}`,
                    {path, paragraphs: markdownBlocks(body).length, characterData});
            }
            return textResult(`${path}\n\n${numberParagraphs(body)}`, {path, paragraphs: markdownBlocks(body).length});
        },
    });

    return {listWritingMaterials, readWritingMaterial};
}
