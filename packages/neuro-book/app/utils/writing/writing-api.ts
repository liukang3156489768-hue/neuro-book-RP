import type {
    WritingChapterIssuesDto, WritingChapterSessionDto, WritingChapterSessionItemDto, WritingRole, WritingRoleModelsDto, WritingRoleModelSettingsDto, WritingEntryDto, WritingIssuesDto, WritingOverviewDto, WritingRunProgressDto, WritingRunSummaryDto,
    WritingStyleCreatedDto, WritingStyleOptionDto, WritingWriterOutputDto,
} from "nbook/shared/dto/writing.dto";
import {apiFetch} from "nbook/app/utils/api-fetch";

/** 用户在进度卡片上的决定：场景规划通过或带意见退回，改写替换或放弃。 */
export type WritingUserDecision = Readonly<{approved: boolean; comments?: string}> | Readonly<{replace: boolean}>;

export type WritingFetch = (url: string, options: {method?: "GET" | "POST"; query: Record<string, string>; body?: Record<string, unknown>}) => Promise<unknown>;

/**
 * 写作 API 客户端。界面不能发起写作和改写（只经主创），这里也没有对应方法。
 * fetch 可注入，测试据此断言请求形状。
 */
export function createWritingApi(projectRoot: string, fetcher: WritingFetch = (url, options) => apiFetch(url, options)) {
    const get = <T>(segment: string, query: Record<string, string> = {}) =>
        fetcher(`/api/projects/writing/${segment}`, {query: {projectRoot, ...query}}) as Promise<T>;
    const post = <T>(segment: string, body: Record<string, unknown>) =>
        fetcher(`/api/projects/writing/${segment}`, {method: "POST", query: {projectRoot}, body}) as Promise<T>;
    return {
        overview: () => get<WritingOverviewDto>("overview"),
        issues: () => get<WritingIssuesDto>("issues"),
        styles: () => get<WritingStyleOptionDto[]>("styles"),
        entry: (entryId: string) => get<WritingEntryDto>("entry", {entryId}),
        setPlan: (planId: string | null) => post<WritingOverviewDto>("set-plan", {planId}),
        setStyle: (stylePath: string | null) => post<WritingOverviewDto>("set-style", {stylePath}),
        createStyle: (title: string) => post<WritingStyleCreatedDto>("create-style", {title}),
        deleteStyle: (stylePath: string) => post<WritingOverviewDto>("delete-style", {stylePath}),
        linkProse: (path: string, chapterEntryId: string) => post<WritingOverviewDto>("link-prose", {path, chapterEntryId}),
        unlinkProse: (path: string) => post<WritingOverviewDto>("unlink-prose", {path}),
        ignoreIssue: (chapterEntryId: string, issueId: string) => post<WritingChapterIssuesDto>("ignore-issue", {chapterEntryId, issueId}),
        runs: (chapterEntryId: string) => get<WritingRunSummaryDto[]>("runs", {chapterEntryId}),
        activeRuns: () => get<WritingRunSummaryDto[]>("active-runs"),
        run: (runId: string) => get<WritingRunProgressDto>("run", {runId}),
        readWriterOutput: (runId: string, sessionId: number) => get<WritingWriterOutputDto>("writer-output", {runId, sessionId: String(sessionId)}),
        stop: (runId: string) => post<WritingRunProgressDto>("stop", {runId}),
        continue: (chapterEntryId: string) => post<WritingRunProgressDto>("continue", {chapterEntryId}),
        answer: (runId: string, key: string, decision: WritingUserDecision) => post<WritingRunProgressDto>("answer", {runId, key, decision}),
        chapterSession: (chapterEntryId: string) => get<WritingChapterSessionDto>("chapter-session", {chapterEntryId}),
        ensureChapterSession: (chapterEntryId: string) => post<WritingChapterSessionDto>("chapter-session", {chapterEntryId}),
        startChapterSession: (chapterEntryId: string) => post<WritingChapterSessionDto>("chapter-session", {chapterEntryId, fresh: true}),
        chapterSessions: (chapterEntryId: string) => get<WritingChapterSessionItemDto[]>("chapter-sessions", {chapterEntryId}),
        deleteChapterSession: (chapterEntryId: string, sessionId: number) =>
            post<WritingChapterSessionItemDto[]>("delete-chapter-session", {chapterEntryId, sessionId}),
        roleModels: () => get<WritingRoleModelsDto>("role-models"),
        saveRoleModel: (role: WritingRole, settings: WritingRoleModelSettingsDto) => post<WritingRoleModelsDto>("role-model", {role, settings}),
    };
}

export type WritingApi = ReturnType<typeof createWritingApi>;
