/**
 * 正文写作模块（writing.prose-binding）对外 DTO。
 * 章节状态每次从规划与正文文件头重新派生，不持久化；这里只描述派生结果。
 */

import type {ThinkingLevelDto} from "nbook/shared/dto/app-settings.dto";

export type WritingSettingsDto = {
    schema: "nbook.writing-settings/v1";
    writingPlanId: string | null;
    stylePath: string | null;
};

export type WritingChapterStatus =
    | "outline-not-adopted"
    | "detail-not-reviewed"
    | "unwritten"
    | "written"
    | "source-stale"
    | "ownership-conflict";

export type WritingPlanStateDto =
    | {state: "unset"}
    /** 设置中的方案 id 在大纲中已不存在，按写作方案为空处理。 */
    | {state: "missing"; planId: string; message: string}
    /** 大纲数据不可读；已有正文全部列入未关联正文，仍可查看编辑。 */
    | {state: "unreadable"; planId: string; message: string}
    | {state: "ready"; planId: string; title: string; revision: number};

export type WritingProseRefDto = {
    /** 正文所在 `index.md` 的工作区相对路径。 */
    path: string;
    title: string;
    /** 正文去掉文件头后只有空白。 */
    empty: boolean;
    hasSource: boolean;
};

export type WritingChapterDto = {
    entryId: string;
    title: string;
    version: number;
    contentHash: string;
    volume: {entryId: string; title: string} | null;
    details: {entryId: string; title: string; version: number; contentHash: string}[];
    status: WritingChapterStatus;
    writable: boolean;
    /** 规划交接给出的不可写原因；归属冲突时仍保留，便于同时显示。 */
    block?: {code: "OUTLINE_NOT_ADOPTED" | "DETAIL_NOT_REVIEWED"; message: string};
    /** 归属本章的正文；超过一份即归属冲突。 */
    prose: WritingProseRefDto[];
};

export type WritingUnlinkedReason = "no-link" | "invalid-link" | "not-in-plan" | "plan-unavailable";

export type WritingUnlinkedProseDto = {
    path: string;
    title: string;
    reason: WritingUnlinkedReason;
    /** `invalid-link` 时的格式错误说明。 */
    message?: string;
    /** 文件头记录的归属；`not-in-plan` 与 `plan-unavailable` 时可能存在。 */
    chapterEntryId?: string;
};

export type WritingOverviewDto = {
    settings: WritingSettingsDto;
    /** 设置文件存在但格式非法；此时 settings 按空设置返回。 */
    settingsError?: string;
    /** 大纲可读时列出全部方案，供用户选择写作方案。 */
    plans: {id: string; title: string}[];
    plan: WritingPlanStateDto;
    chapters: WritingChapterDto[];
    unlinkedProse: WritingUnlinkedProseDto[];
};

/** 问题代码见 writing.issue-feedback；`OTHER` 由助手登记，级别与说明自填。 */
export type WritingIssueCode =
    | "MISSING_SCENE_STRUCTURE"
    | "PLANNING_CHANGED"
    | "SOURCE_UNREADABLE"
    | "GUIDANCE_CONFLICT"
    | "PENDING_REFERENCE"
    | "WORD_TARGET_MISMATCH"
    | "UNASSIGNED_FORESHADOW"
    | "MISSING_PREVIOUS_CHAPTER"
    | "OTHER";

export type WritingIssueSeverity = "blocking" | "hint";

/** 相关位置：entryId 是细纲或章节大纲条目；缺省表示整章。 */
export type WritingIssueLocation = {
    entryId?: string;
    sceneIndex?: number;
    guidanceMarker?: string;
};

/** 尚未登记的问题；登记时再补章节、版本、登记方与时间。 */
export type WritingIssueDraft = {
    code: WritingIssueCode;
    severity: WritingIssueSeverity;
    message: string;
    location: WritingIssueLocation;
};

export type WritingIssueRegistrar = "assistant" | "workflow";

/** `pending-review` 由当前版本与登记时版本比较得出，不写入问题文件。 */
export type WritingIssueStatus = "open" | "pending-review" | "resolved" | "ignored";

/** 登记时的规划版本；只比较版本号，不比较内容哈希。 */
export type WritingIssueBasis = {
    chapterVersion: number;
    details: {entryId: string; version: number}[];
};

export type WritingIssueDto = WritingIssueDraft & {
    id: string;
    chapterEntryId: string;
    registrar: WritingIssueRegistrar;
    basis: WritingIssueBasis;
    status: WritingIssueStatus;
    registeredAt: string;
};

export type WritingChapterIssuesDto = {
    chapterEntryId: string;
    /** 未处理与待复核问题按级别计数，供徽标使用；已解决与已忽略不计。 */
    blocking: number;
    hint: number;
    issues: WritingIssueDto[];
};

/** 只列当前写作方案中有问题记录的章节；方案不可用时为空。 */
export type WritingIssuesDto = {
    chapters: WritingChapterIssuesDto[];
    /** 问题文件无法读取的章节；这些章节不显示徽标。 */
    unreadable: {chapterEntryId: string; message: string}[];
};

/*
 * 写作运行（writing.collaboration、writing.workspace-ui 的进度卡片）。
 * 进度每次从运行记录重新投影，不单独保存；刷新页面后按同一份记录恢复。
 */

export type WritingRunKind = "chapter" | "rewrite";

export type WritingRunStatus = "running" | "waiting" | "completed" | "failed" | "cancelled";

export type WritingRunSummaryDto = {
    runId: string;
    kind: WritingRunKind;
    chapterEntryId: string;
    status: WritingRunStatus;
    /** 记录为运行中但不在服务进程中执行：进程曾在运行中退出，续写时按记录恢复。 */
    interrupted: boolean;
    /** 运行本身失败（例如模型调用重试后仍失败）的原因；领域上的停止在 result 里。 */
    error: string | null;
    createdAt: string;
    updatedAt: string;
};

/**
 * - `lead-review`：主创核对场景规划，只由主创应答；
 * - `user-confirm`：讨论模式下交用户确认场景规划；
 * - `rewrite-confirm`：确认替换改写段落。
 */
export type WritingAskRole = "lead-review" | "user-confirm" | "rewrite-confirm";

export type WritingPendingAskDto = {
    key: string;
    role: WritingAskRole;
    title: string;
    /** 场景规划摘要或改写的新旧对照（Markdown）。 */
    description: string | null;
};

/** 写手的一次产出及其审阅；尚未产出或尚未审阅时对应字段为 null。 */
export type WritingAttemptDto = {
    /** 对应的写手会话，用于按需读取完整输出与订阅生成事件；创建前为 null，旧客户端可缺省。 */
    writerSessionId?: number | null;
    /** 渲染后的写手提示；改写在写手返回前还取不到用户提示，此时为 null。 */
    prompt: {system: string; user: string} | null;
    output: string | null;
    /** 程序综合审阅结果、空输出与字数得出的判定。 */
    judgement: {passed: boolean; problems: string[]} | null;
};

/** 按运行关联读取的完整已保存写手内容，不受聊天预览字节预算截断。 */
export type WritingWriterOutputDto = {
    sessionId: number;
    thinking: string;
    output: string;
};

export type WritingSceneState = "unplanned" | "planning" | "pending" | "writing" | "reviewing" | "retrying" | "passed" | "failed";

export type WritingSceneProgressDto = {
    index: number;
    heading: string;
    state: WritingSceneState;
    /** state 为 `retrying` 时是第几次重写，其余为 0。 */
    retry: number;
    /** 本次运行中的尝试；续写沿用的已通过场景在上一次运行里，这里为空。 */
    attempts: WritingAttemptDto[];
};

export type WritingChapterRunResultDto = {
    outcome: "completed" | "stopped";
    reason: string | null;
    message: string;
    passedScenes: number;
    totalScenes: number | null;
    failedScene: {index: number; heading: string; problems: string[]} | null;
    words: number | null;
    targetWords: number | null;
    withinTarget: boolean | null;
    hints: {id: string; code: string; message: string}[];
    notes: string[];
};

export type WritingRewriteRunResultDto = {
    outcome: "replaced" | "discarded" | "stopped";
    reason: string | null;
    message: string;
    range: {from: number; to: number} | null;
    original: string | null;
    replacement: string | null;
    problems: string[];
    notes: string[];
};

type WritingRunProgressBase = WritingRunSummaryDto & {
    /** 工作流当前阶段：planning、material-review、writing；整章还有 finishing，改写还有 confirming。 */
    phase: string | null;
    asks: WritingPendingAskDto[];
    logs: string[];
};

export type WritingChapterRunProgressDto = WritingRunProgressBase & {
    kind: "chapter";
    task: "new" | "continue" | "rewrite";
    mode: "auto" | "discussion";
    /** 准备完成即包含整章场景，区分尚未规划、规划中与已规划待写。 */
    scenes: WritingSceneProgressDto[];
    result: WritingChapterRunResultDto | null;
};

export type WritingRewriteRunProgressDto = WritingRunProgressBase & {
    kind: "rewrite";
    requirement: string;
    /** 目标定位完成之前为 null。 */
    range: {from: number; to: number} | null;
    original: string | null;
    /** 最近一次通过审阅的改写；尚未通过时为 null。 */
    replacement: string | null;
    attempts: WritingAttemptDto[];
    result: WritingRewriteRunResultDto | null;
};

export type WritingRunProgressDto = WritingChapterRunProgressDto | WritingRewriteRunProgressDto;

/** 一章一个主创会话；尚未创建时 sessionId 为 null。 */
export type WritingChapterSessionDto = {
    chapterEntryId: string;
    sessionId: number | null;
};

export type WritingRole = "lead" | "assistant" | "writer";

/** 为空表示沿用全局设置或模型默认；reasoningEffort 为 "off" 即关闭思考。 */
export type WritingRoleModelSettingsDto = {
    modelKey: string | null;
    reasoningEffort: ThinkingLevelDto | null;
    temperature: number | null;
};

export type WritingRoleModelDto = {
    role: WritingRole;
    label: string;
    profileKey: string;
    /** 本作品 Project Config 里的设置。 */
    override: WritingRoleModelSettingsDto;
    /** 合并全局设置后的实际生效值。 */
    effective: WritingRoleModelSettingsDto;
};

export type WritingRoleModelsDto = {
    roles: WritingRoleModelDto[];
    models: {key: string; label: string}[];
    defaultModelLabel: string | null;
};

/** 一章的主创会话列表项；列表按 updatedAt 倒序，第一项是当前会话。 */
export type WritingChapterSessionItemDto = {
    sessionId: number;
    title: string;
    updatedAt: number;
    preview?: string;
};

/**
 * 大纲视图中间只读显示的条目：只给当前写作方案里的卷、章节大纲与细纲。
 * 字段与大纲工作台的条目一致，界面按工作台的样式呈现正文。
 */
export type WritingEntryDto = {
    id: string;
    kind: "total" | "volume" | "chapter" | "detail";
    version: number;
    status: "draft" | "adopted";
    title: string;
    parentId: string | null;
    chapterId: string | null;
    body: string;
    materialRefs?: string[];
    writingGuidance?: string;
    references?: {path?: string; locator?: string; purpose?: string; pending?: boolean}[];
    targetWords?: number;
};

/** 写作设置里可选的文风文件：`lorebook/instruction/` 下类型为 instruction、子类型为 writing-style 的条目。 */
export type WritingStyleOptionDto = {
    path: string;
    title: string;
};

export type WritingStyleCreatedDto = {
    overview: WritingOverviewDto;
    /** 新文风文件路径，界面据此打开编辑 */
    stylePath: string;
};
