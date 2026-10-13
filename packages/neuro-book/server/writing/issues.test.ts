import {describe, expect, it} from "vitest";
import type {WritingIssueBasis, WritingIssueDraft} from "nbook/shared/dto/writing.dto";
import {
    chapterIssuesDto, deriveIssueStatus, hasActiveBlockingDrafts, ignoreIssue, issueFileChapter, parseIssueFile, registerIssues, resolveIssues,
    sameIssueBasis, serializeIssueFile, WritingIssueDraftSchema, type RegisterOptions, type StoredIssue,
} from "./issues";

const basis: WritingIssueBasis = {chapterVersion: 2, details: [{entryId: "ol-d1", version: 3}, {entryId: "ol-d2", version: 1}]};

function options(overrides: Partial<RegisterOptions> = {}): RegisterOptions {
    let counter = 0;
    return {registrar: "workflow", basis, now: "2026-09-29T08:00:00.000Z", createId: () => `wi-${++counter}`, ...overrides};
}

const hint: WritingIssueDraft = {code: "PENDING_REFERENCE", severity: "hint", message: "参考资料待补", location: {entryId: "ol-d1"}};
const blocking: WritingIssueDraft = {code: "MISSING_SCENE_STRUCTURE", severity: "blocking", message: "没有一级标题", location: {entryId: "ol-d2"}};

describe("登记与去重", () => {
    it("代码与位置相同的问题只保留一条，更新时间和版本", () => {
        const first = registerIssues([], [hint, blocking], options());
        expect(first.map(({id, status}) => [id, status])).toEqual([["wi-1", "open"], ["wi-2", "open"]]);
        const newer = {chapterVersion: 3, details: basis.details};
        const second = registerIssues(first, [hint, {...hint}], options({now: "2026-09-30T08:00:00.000Z", basis: newer}));
        expect(second).toHaveLength(2);
        expect(second[0]).toMatchObject({id: "wi-1", status: "open", registeredAt: "2026-09-30T08:00:00.000Z", basis: newer});
        expect(second[1]).toBe(first[1]);
    });

    it("位置不同或 OTHER 的说明不同时分开登记", () => {
        const other = (message: string): WritingIssueDraft => ({code: "OTHER", severity: "hint", message, location: {entryId: "ol-d1"}});
        const issues = registerIssues([], [hint, {...hint, location: {entryId: "ol-d1", sceneIndex: 2}}, other("甲"), other("乙"), other("甲 ")],
            options());
        expect(issues.map(({id}) => id)).toEqual(["wi-1", "wi-2", "wi-3", "wi-4"]);
    });

    it("生成的 id 已存在时重新生成", () => {
        const ids = ["wi-1", "wi-1", "wi-2"];
        const issues = registerIssues([], [hint, blocking], options({createId: () => ids.shift()!}));
        expect(issues.map(({id}) => id)).toEqual(["wi-1", "wi-2"]);
    });

    it("已忽略的提示问题再次登记仍保持忽略；已解决的问题重新打开", () => {
        const [ignored, resolved] = registerIssues([], [hint, blocking], options());
        const issues = [{...ignored!, status: "ignored" as const}, {...resolved!, status: "resolved" as const}];
        const next = registerIssues(issues, [hint, blocking], options({now: "2026-09-30T08:00:00.000Z"}));
        expect(next.map(({status, registeredAt}) => [status, registeredAt])).toEqual([
            ["ignored", "2026-09-30T08:00:00.000Z"], ["open", "2026-09-30T08:00:00.000Z"]]);
    });

    it("固定代码的级别必须与规范一致，OTHER 自填", () => {
        expect(WritingIssueDraftSchema.safeParse(hint).success).toBe(true);
        expect(WritingIssueDraftSchema.safeParse({...hint, severity: "blocking"}).success).toBe(false);
        expect(WritingIssueDraftSchema.safeParse({code: "OTHER", severity: "blocking", message: "冲突", location: {}}).success).toBe(true);
        expect(WritingIssueDraftSchema.safeParse({...hint, location: {entryId: "d1"}}).success).toBe(false);
        expect(WritingIssueDraftSchema.safeParse({...hint, extra: 1}).success).toBe(false);
    });
});

describe("状态派生", () => {
    const [issue] = registerIssues([], [hint], options());

    it("版本不同或细纲增减时为待复核，细纲顺序调整不算变化", () => {
        expect(deriveIssueStatus(issue!, basis)).toBe("open");
        expect(deriveIssueStatus(issue!, {...basis, details: [...basis.details].reverse()})).toBe("open");
        expect(deriveIssueStatus(issue!, {...basis, chapterVersion: 3})).toBe("pending-review");
        expect(deriveIssueStatus(issue!, {...basis, details: [{entryId: "ol-d1", version: 4}, basis.details[1]!]})).toBe("pending-review");
        expect(deriveIssueStatus(issue!, {...basis, details: basis.details.slice(0, 1)})).toBe("pending-review");
        expect(sameIssueBasis(basis, {...basis, details: [...basis.details, {entryId: "ol-d3", version: 1}]})).toBe(false);
        expect(deriveIssueStatus({...issue!, status: "ignored"}, {...basis, chapterVersion: 9})).toBe("ignored");
    });

    it("徽标只计未处理与待复核问题", () => {
        const issues = registerIssues([], [hint, blocking, {...hint, location: {}}], options());
        const summary = chapterIssuesDto("ol-ch", [issues[0]!, issues[1]!, {...issues[2]!, status: "ignored"}], {...basis, chapterVersion: 5});
        expect(summary).toMatchObject({chapterEntryId: "ol-ch", blocking: 1, hint: 1});
        expect(summary.issues.map(({status}) => status)).toEqual(["pending-review", "pending-review", "ignored"]);
    });
});

describe("复核与忽略", () => {
    const issues = registerIssues([], [hint, blocking], options());

    it("复核后标为已解决，重新登记则回到未处理", () => {
        const resolved = resolveIssues(issues, ["wi-1"]);
        expect(resolved.map(({status}) => status)).toEqual(["resolved", "open"]);
        expect(registerIssues(resolved, [hint], options())[0]!.status).toBe("open");
        expect(() => resolveIssues(issues, ["wi-9"])).toThrow(expect.objectContaining({code: "ISSUE_NOT_FOUND"}));
    });

    it("未解决的提示和阻断问题都可忽略，重复操作幂等", () => {
        expect(ignoreIssue(issues, "wi-1")[0]!.status).toBe("ignored");
        expect(ignoreIssue(ignoreIssue(issues, "wi-1"), "wi-1")[0]!.status).toBe("ignored");
        const ignored = ignoreIssue(issues, "wi-2");
        expect(ignored[1]!.status).toBe("ignored");
        const registered = registerIssues(ignored, [blocking], options({basis: {...basis, chapterVersion: 9}}));
        const summary = chapterIssuesDto("ol-ch", registered, basis);
        expect(summary.blocking).toBe(0);
        expect(registered[1]!.status).toBe("ignored");
        expect(hasActiveBlockingDrafts([blocking], summary.issues)).toBe(false);
        expect(hasActiveBlockingDrafts([blocking], chapterIssuesDto("ol-ch", issues, basis).issues)).toBe(true);
        expect(() => ignoreIssue(resolveIssues(issues, ["wi-1"]), "wi-1")).toThrow(expect.objectContaining({code: "ISSUE_NOT_IGNORABLE"}));
        expect(() => ignoreIssue(issues, "wi-9")).toThrow(expect.objectContaining({code: "ISSUE_NOT_FOUND"}));
    });
});

describe("问题文件", () => {
    const issues: StoredIssue[] = registerIssues([], [hint], options());

    it("序列化后可原样解析；章节 id 须与文件名一致", () => {
        const content = serializeIssueFile("ol-ch", issues);
        expect(content).toContain("schema: nbook.writing-issues/v1");
        expect(parseIssueFile(content, "ol-ch")).toEqual({ok: true, issues});
        expect(parseIssueFile(content, "ol-other")).toMatchObject({ok: false, message: expect.stringContaining("文件名")});
    });

    it("格式非法、YAML 损坏或 id 重复时报告原因", () => {
        expect(parseIssueFile("issues: [", "ol-ch")).toMatchObject({ok: false, message: expect.stringContaining("无法解析")});
        expect(parseIssueFile("schema: nbook.writing-issues/v1\nchapterEntryId: ol-ch\nissues: 1\n", "ol-ch"))
            .toMatchObject({ok: false, message: expect.stringContaining("格式非法")});
        const duplicated = serializeIssueFile("ol-ch", [issues[0]!, {...issues[0]!, code: "WORD_TARGET_MISMATCH"}]);
        expect(parseIssueFile(duplicated, "ol-ch")).toMatchObject({ok: false, message: expect.stringContaining("重复")});
    });

    it("只把 ol- 开头的 yaml 文件视为问题文件", () => {
        expect(issueFileChapter("ol-ch-1.yaml")).toBe("ol-ch-1");
        expect(issueFileChapter("notes.yaml")).toBeNull();
        expect(issueFileChapter("ol-ch.yml")).toBeNull();
    });
});
