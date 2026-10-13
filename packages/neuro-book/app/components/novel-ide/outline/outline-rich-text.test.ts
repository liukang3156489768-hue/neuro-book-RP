// @vitest-environment jsdom
import {Editor} from "@tiptap/core";
import {TextSelection} from "@tiptap/pm/state";
import {afterEach, describe, expect, it} from "vitest";
import {createMarkdownDialectExtensions} from "nbook/app/components/markdown-studio/tiptap/markdown-dialect-extensions";
import {collectMarkdownOutlineAnchors} from "nbook/shared/markdown-workbench";
import {
    annotationProblem, applyOutlineMark, collectOutlineMarks, formatProblem, OutlineMarkIntegrity, outlineMarksAtCursor, removeOutlineMark, updateForeshadowMark,
} from "./outline-rich-text";

const editors: Editor[] = [];
afterEach(() => {
    for (const editor of editors.splice(0)) editor.destroy();
});

function createEditor(content: string): Editor {
    const editor = new Editor({content, contentType: "markdown", extensions: [...createMarkdownDialectExtensions(), OutlineMarkIntegrity]});
    editors.push(editor);
    return editor;
}

/** 按可见文字选中第 occurrence 次出现的 text；位置换算走文档，避免手算注释长度。 */
function select(editor: Editor, text: string): void {
    let found: {from: number; to: number} | undefined;
    editor.state.doc.descendants((node, pos) => {
        if (found || !node.isTextblock) return;
        const offset = node.textContent.indexOf(text);
        if (offset >= 0) found = {from: pos + 1 + offset, to: pos + 1 + offset + text.length};
    });
    if (!found) throw new Error(`找不到 ${text}`);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, found.from, found.to)));
}

const guidance = (marker: string, text: string) => `<!-- nb:guidance marker="${marker}" -->${text}<!-- /nb:guidance marker="${marker}" -->`;
const reference = (marker: string, text: string) => `<!-- nb:reference marker="${marker}" -->${text}<!-- /nb:reference marker="${marker}" -->`;
const foreshadow = (marker: string, text: string, action = "plant") =>
    `<!-- nb:foreshadow marker="${marker}" foreshadow="fo-1" action="${action}" -->${text}<!-- /nb:foreshadow marker="${marker}" -->`;

describe("大纲富文本正文", () => {
    it.each([
        ["各级标题、列表与强调", "# 第一卷\n\n## 目标\n\n- 主线：**复仇**\n- 支线：*成长*\n  - 嵌套\n\n1. 开端\n2. 发展\n\n> 引言"],
        ["细纲锚点与嵌套", `雨夜，${guidance("g1", `林默${reference("r1", "推门")}进屋`)}，灯灭了。`],
        ["伏笔标记", `她看见${foreshadow("fm-1", "银纹", "recover")}。`],
        ["独立成段的注释", "正文\n\n<!-- 作者备注 -->\n\n继续"],
        ["段首标注", `${guidance("g1", "整段")}

- ${foreshadow("fm-1", "银纹")}。
- 第二项

> ${reference("r1", "引")}文`],
        ["段首损坏标注保留源码", '<!-- nb:guidance marker="g1" -->原文<!-- /nb:guidance marker="g2" -->'],
        ["空正文", ""],
    ])("%s 打开再保存不改变正文", (_label, body) => {
        expect(createEditor(body).getMarkdown()).toBe(body);
    });

    it("回车拆开标注时只保留第一段，保存结果不出现重复 marker", () => {
        const editor = createEditor(`开头${guidance("g1", "甲乙丙丁")}结尾`);
        select(editor, "乙");
        editor.commands.setTextSelection(editor.state.selection.to);
        editor.commands.splitBlock();
        const markdown = editor.getMarkdown();
        expect(collectMarkdownOutlineAnchors(markdown, "guidance").map(({marker}) => marker)).toEqual(["g1"]);
        expect(markdown.match(/marker="g1"/gu)).toHaveLength(2);
        expect(markdown).toContain("丙丁结尾");
    });

    it("粘贴带同一 marker 的文字时后出现的一段去掉标注", () => {
        const editor = createEditor(`${foreshadow("fm-1", "银纹")}。`);
        select(editor, "。");
        editor.commands.setTextSelection(editor.state.selection.to);
        editor.commands.insertContent(`又见${foreshadow("fm-1", "银纹")}`, {contentType: "markdown"} as never);
        const markdown = editor.getMarkdown();
        expect(markdown.match(/<!-- nb:foreshadow marker="fm-1"/gu)).toHaveLength(1);
        expect(markdown).toContain("又见银纹");
        expect(collectOutlineMarks(editor.state.doc).strays).toEqual([]);
    });

    it("写作指导与段落参考只能完整包含，交叉与同类重叠被拒绝", () => {
        const editor = createEditor(`雨夜${guidance("g1", "林默推门")}进屋。`);
        select(editor, "推门进屋");
        expect(annotationProblem(editor.state, "reference")).toMatch(/交叉/);
        select(editor, "默推");
        expect(annotationProblem(editor.state, "guidance")).toMatch(/已有写作指导/);
        expect(applyOutlineMark(editor, "reference")).toMatchObject({marker: expect.stringMatching(/^r-/)});
        select(editor, "雨夜林默推门进屋");
        expect(annotationProblem(editor.state, "reference")).toMatch(/已有段落参考/);
        const markdown = editor.getMarkdown();
        expect(collectMarkdownOutlineAnchors(markdown, "reference")[0]?.text).toBe("默推");
    });

    it("段首标注解析为富文本标注而不是源码块", () => {
        const editor = createEditor(`${guidance("g1", "整段")}进屋`);
        expect(collectOutlineMarks(editor.state.doc).ranges.map(({kind, marker}) => [kind, marker])).toEqual([["guidance", "g1"]]);
    });

    it("格式与标注部分重叠时拒绝，避免序列化截断标注", () => {
        const editor = createEditor(`甲乙${guidance("g1", "林默推门")}丙丁`);
        select(editor, "乙林");
        expect(formatProblem(editor.state)).toMatch(/部分重叠/);
        select(editor, "乙林默推门丙");
        expect(formatProblem(editor.state)).toBeNull();
        editor.commands.toggleBold();
        select(editor, "丙丁");
        expect(annotationProblem(editor.state, "reference")).toMatch(/加粗等格式部分重叠/);
    });

    it("空选区、跨段落选区不能添加标注", () => {
        const editor = createEditor("第一段\n\n第二段");
        expect(annotationProblem(editor.state, "guidance")).toMatch(/选中/);
        editor.commands.setTextSelection({from: 2, to: 8});
        expect(annotationProblem(editor.state, "guidance")).toMatch(/跨段落/);
    });

    it("伏笔标记可以改动作、移除后保留原文", () => {
        const editor = createEditor("她看见银纹。");
        select(editor, "银纹");
        const created = applyOutlineMark(editor, "foreshadow", {foreshadowId: "fo-1", action: "plant"});
        if (typeof created === "string") throw new Error(created);
        select(editor, "纹");
        expect(annotationProblem(editor.state, "foreshadow")).toMatch(/不能嵌套/);
        editor.commands.setTextSelection(editor.state.selection.from);
        expect(outlineMarksAtCursor(editor.state).map(({kind, marker}) => [kind, marker])).toEqual([["foreshadow", created.marker]]);
        updateForeshadowMark(editor, created.marker, {action: "recover"});
        expect(editor.getMarkdown()).toBe(`她看见${foreshadow(created.marker, "银纹", "recover")}。`);
        removeOutlineMark(editor, "foreshadow", created.marker);
        expect(editor.getMarkdown()).toBe("她看见银纹。");
    });
});
