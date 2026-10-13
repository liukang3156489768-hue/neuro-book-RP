// @vitest-environment jsdom
import {describe, expect, it} from "vitest";
import {mount} from "@vue/test-utils";
import WritingOutlineTree from "./WritingOutlineTree.vue";
import type {WritingChapterDto, WritingChapterIssuesDto, WritingIssueDto, WritingUnlinkedProseDto} from "nbook/shared/dto/writing.dto";
import {groupChaptersByVolume} from "nbook/app/utils/writing/writing-tree";

const chapter = (entryId: string, extra: Partial<WritingChapterDto> = {}): WritingChapterDto => ({
    entryId, title: `章节${entryId}`, version: 1, contentHash: "h", volume: {entryId: "v1", title: "第一卷"},
    details: [], status: "unwritten", writable: true, prose: [], ...extra,
});
const issue = (id: string, extra: Partial<WritingIssueDto> = {}): WritingIssueDto => ({
    id, chapterEntryId: "c1", code: "OTHER", severity: "hint", message: `问题${id}`, location: {},
    registrar: "assistant", basis: {chapterVersion: 1, details: []}, status: "open", registeredAt: "2026-09-30T00:00:00Z", ...extra,
});

function mountTree(props: {
    chapters: WritingChapterDto[] | null;
    unlinked?: WritingUnlinkedProseDto[];
    issues?: WritingChapterIssuesDto[];
    expanded?: string[];
    running?: string[];
    pending?: boolean;
}) {
    return mount(WritingOutlineTree, {
        props: {
            groups: props.chapters && groupChaptersByVolume(props.chapters),
            unlinked: props.unlinked ?? [],
            linkTargets: (props.chapters ?? []).filter(({prose}) => prose.length === 0).map(({entryId, title}) => ({value: entryId, label: title})),
            issues: new Map((props.issues ?? []).map((item) => [item.chapterEntryId, item])),
            selectedKey: null,
            collapsedVolumes: new Set<string>(),
            expandedChapters: new Set(props.expanded ?? []),
            runningChapters: new Set(props.running ?? []),
            pending: props.pending ?? false,
        },
    });
}

describe("WritingOutlineTree", () => {
    it("没有可用方案时不说“方案里没有章节”，只列未关联正文", () => {
        const wrapper = mountTree({chapters: null, unlinked: [{path: "manuscript/a/index.md", title: "散稿", reason: "no-link"}]});
        expect(wrapper.text()).not.toContain("还没有章节");
        expect(wrapper.text()).toContain("散稿");
        expect(mountTree({chapters: []}).text()).toContain("这个写作方案里还没有章节");
    });

    it("点章节标题选中章节大纲并展开；没有正文时列出“正文（未写）”", async () => {
        const wrapper = mountTree({chapters: [chapter("c1", {details: [{entryId: "d1", title: "细纲一", version: 1, contentHash: "h"}]})], expanded: ["c1"]});
        await wrapper.get(".chapter-main").trigger("click");
        expect(wrapper.emitted("select")?.[0]).toEqual([{kind: "entry", entryId: "c1"}]);
        // 已展开的章节不再发出展开
        expect(wrapper.emitted("toggle-chapter")).toBeUndefined();

        const children = wrapper.findAll(".child-row");
        expect(children.map((row) => row.text())).toEqual(["细纲一", "正文（未写）"]);
        await children[1]!.trigger("click");
        expect(wrapper.emitted("select")?.[1]).toEqual([{kind: "empty-prose", chapterEntryId: "c1"}]);
    });

    it("不可写章节灰显、写出原因且不显示状态徽标；运行中的章节带“写作中”", () => {
        const wrapper = mountTree({
            chapters: [
                chapter("c1", {status: "detail-not-reviewed", writable: false, block: {code: "DETAIL_NOT_REVIEWED", message: "x"}}),
                chapter("c2"),
            ],
            running: ["c2"],
        });
        const items = wrapper.findAll(".chapter-item");
        expect(items[0]!.attributes("data-blocked")).toBe("true");
        expect(items[0]!.text()).toContain("细纲未审阅");
        expect(items[1]!.text()).toContain("写作中");
    });

    it("问题徽标展开列表：提示与阻断都可忽略，跳转到问题所在条目", async () => {
        const wrapper = mountTree({
            chapters: [chapter("c1")],
            issues: [{chapterEntryId: "c1", blocking: 1, hint: 1, issues: [
                issue("i1", {severity: "blocking", location: {entryId: "d1"}}),
                issue("i2", {status: "pending-review"}),
                issue("i3", {status: "ignored"}),
            ]}],
        });
        const badge = wrapper.get(".issue-badge");
        expect(badge.attributes("data-severity")).toBe("blocking");
        await badge.trigger("click");

        const listed = wrapper.findAll(".issue-item");
        expect(listed.map((row) => row.get(".issue-message").text())).toEqual(["问题i1", "问题i2"]);
        expect(listed[0]!.text()).toContain("忽略");
        expect(listed[1]!.text()).toContain("待复核");

        await listed[0]!.findAll("button").find((button) => button.text() === "在大纲工作台中打开")!.trigger("click");
        expect(wrapper.emitted("open-outline")?.[0]).toEqual(["d1"]);
        await listed[1]!.findAll("button").find((button) => button.text() === "忽略")!.trigger("click");
        expect(wrapper.emitted("ignore-issue")?.[0]).toEqual(["c1", "i2"]);
        await listed[0]!.findAll("button").find((button) => button.text() === "忽略")!.trigger("click");
        expect(wrapper.emitted("ignore-issue")?.[1]).toEqual(["c1", "i1"]);
    });

    it("归属冲突的每份正文都能解除关联；写入中按钮禁用", () => {
        const prose = (path: string) => ({path, title: path, empty: false, hasSource: true});
        const wrapper = mountTree({
            chapters: [chapter("c1", {status: "ownership-conflict", writable: false, prose: [prose("a/index.md"), prose("b/index.md")]})],
            expanded: ["c1"],
            pending: true,
        });
        const unlink = wrapper.findAll("button").filter((button) => button.text() === "解除关联");
        expect(unlink).toHaveLength(2);
        expect(unlink.every((button) => button.attributes("disabled") !== undefined)).toBe(true);
    });

    it("未关联正文：格式错误的可解除关联，没有写作字段的不能", () => {
        const wrapper = mountTree({
            chapters: [chapter("c1")],
            unlinked: [
                {path: "x/index.md", title: "散稿", reason: "no-link"},
                {path: "y/index.md", title: "坏头", reason: "invalid-link", message: "格式错误"},
            ],
        });
        const rows = wrapper.findAll(".unlinked-item");
        expect(rows[0]!.text()).not.toContain("解除关联");
        expect(rows[1]!.text()).toContain("解除关联");
        expect(rows[1]!.text()).toContain("格式错误");
        // 没选目标前不能关联
        const linkButton = rows[0]!.findAll("button").find((button) => button.text() === "关联")!;
        expect(linkButton.attributes("disabled")).toBeDefined();
    });
});
