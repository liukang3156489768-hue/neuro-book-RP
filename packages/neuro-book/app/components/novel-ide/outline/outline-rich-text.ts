import {Extension, type Editor} from "@tiptap/core";
import type {Mark, MarkType, Node as ProseMirrorNode} from "@tiptap/pm/model";
import {Plugin, PluginKey, type EditorState} from "@tiptap/pm/state";
import type {ForeshadowMarkerAction, OutlineAnchorKind} from "nbook/shared/markdown-workbench";

/** 只有章节大纲能标伏笔；细纲的写作信息按正文模板书写，"detail" 只用于宿主区分层级，不提供标注入口。 */
export type OutlineRichTextAnnotations = "detail" | "chapter" | "none";
export type OutlineMarkKind = OutlineAnchorKind | "foreshadow";
export type OutlineMarkRange = Readonly<{kind: OutlineMarkKind; marker: string; from: number; to: number; attrs: Record<string, unknown>}>;

export const OUTLINE_MARK_NAMES: Readonly<Record<OutlineMarkKind, string>> = {
    guidance: "outlineGuidanceAnchor",
    reference: "outlineReferenceAnchor",
    foreshadow: "foreshadowMarker",
};

export function creatableMarkKinds(annotations: OutlineRichTextAnnotations): OutlineMarkKind[] {
    if (annotations === "chapter") return ["foreshadow"];
    return [];
}

export function createOutlineMarker(kind: OutlineMarkKind): string {
    const prefix = kind === "guidance" ? "g" : kind === "reference" ? "r" : "fm";
    return `${prefix}-${crypto.randomUUID()}`;
}

function kindOfMark(mark: Mark): OutlineMarkKind | null {
    for (const [kind, name] of Object.entries(OUTLINE_MARK_NAMES)) {
        if (mark.type.name === name) return kind as OutlineMarkKind;
    }
    return null;
}

/**
 * 按 marker 收集标注区间。同一 marker 只取第一段连续文本：分段或交叉编辑后 ProseMirror 会把
 * 一个 mark 拆成多段，序列化会写出重复 marker，服务端整篇拒绝；完整性插件据此去掉后续段。
 */
export function collectOutlineMarks(doc: ProseMirrorNode): {ranges: OutlineMarkRange[]; strays: {from: number; to: number; mark: Mark}[]} {
    const open = new Map<string, {kind: OutlineMarkKind; marker: string; from: number; to: number; attrs: Record<string, unknown>}>();
    const closed = new Set<string>();
    const strays: {from: number; to: number; mark: Mark}[] = [];
    doc.descendants((node, pos) => {
        if (!node.isText) return;
        const end = pos + node.nodeSize;
        for (const mark of node.marks) {
            const kind = kindOfMark(mark);
            if (!kind) continue;
            const marker = String(mark.attrs.marker ?? "");
            const key = `${kind}:${marker}`;
            const current = open.get(key);
            if (current && !closed.has(key) && current.to === pos) {
                current.to = end;
            } else if (current) {
                closed.add(key);
                strays.push({from: pos, to: end, mark});
            } else {
                open.set(key, {kind, marker, from: pos, to: end, attrs: {...mark.attrs}});
            }
        }
        // 一段文本不带某个已打开的 marker，说明那段标注已经结束，之后再出现就是拆出来的碎片。
        for (const [key, range] of open) {
            if (range.to <= pos) closed.add(key);
        }
    });
    return {ranges: [...open.values()].sort((left, right) => left.from - right.from), strays};
}

const integrityKey = new PluginKey("outline-mark-integrity");

/** 保证每个 marker 在正文里只有一段连续文本，拆分出的后续碎片去掉标注、保留文字。 */
export const OutlineMarkIntegrity = Extension.create({
    name: "outlineMarkIntegrity",
    addProseMirrorPlugins() {
        return [new Plugin({
            key: integrityKey,
            appendTransaction(transactions, _oldState, newState) {
                if (!transactions.some((transaction) => transaction.docChanged)) return null;
                const {strays} = collectOutlineMarks(newState.doc);
                if (!strays.length) return null;
                const tr = newState.tr;
                for (const stray of strays) tr.removeMark(stray.from, stray.to, stray.mark);
                return tr;
            },
        })];
    },
});

function markType(state: EditorState, kind: OutlineMarkKind): MarkType | undefined {
    return state.schema.marks[OUTLINE_MARK_NAMES[kind]];
}

/**
 * 检查选区能否加一类标注，返回拒绝原因。规则与服务端解析一致：不能跨段落，同类不能嵌套或交叉，
 * 写作指导与段落参考之间只能完整包含；这样作者添加的标注保存时不会被整篇拒绝。
 */
export function annotationProblem(state: EditorState, kind: OutlineMarkKind): string | null {
    const {from, to, $from, $to, empty} = state.selection;
    if (empty || !state.doc.textBetween(from, to).trim()) return "请先选中要标注的文字";
    if (!$from.sameParent($to) || !$from.parent.isTextblock) return "标注不能跨段落，请只选中同一段内的文字";
    const type = markType(state, kind);
    if (!type) return "当前正文不支持这类标注";
    if (state.doc.rangeHasMark(from, to, type)) {
        return kind === "foreshadow" ? "选中的文字已有伏笔标记，标记不能嵌套或交叉" : kind === "guidance" ? "选中的文字已有写作指导" : "选中的文字已有段落参考";
    }
    const crossing = crossingMarks(state, from, to);
    if (crossing.some((mark) => kindOfMark(mark) !== null)) return "写作指导与段落参考只能完整包含，不能交叉，请调整选区";
    if (crossing.length) return "选区与加粗等格式部分重叠，请让标注完整包含或完全位于格式之内";
    return null;
}

/**
 * 与 [from, to] 部分重叠（既不包含也不被包含）的行内 mark。Markdown 序列化遇到这种交叉会把
 * 外层 mark 断开重写，标注因此出现重复 marker；标注与格式只允许完整包含。
 */
export function crossingMarks(state: EditorState, from: number, to: number): Mark[] {
    const runs: {mark: Mark; from: number; to: number}[] = [];
    // 只有选区两端所在的段落可能被部分覆盖，中间整段都在选区内。
    const ends = [state.doc.resolve(from), state.doc.resolve(to)];
    for (const $end of ends[0]!.sameParent(ends[1]!) ? ends.slice(0, 1) : ends) {
        const start = $end.start();
        $end.parent.forEach((child, offset) => {
            const childFrom = start + offset;
            for (const mark of child.marks) {
                const last = runs.findLast((run) => run.mark.eq(mark));
                if (last && last.to === childFrom) last.to = childFrom + child.nodeSize;
                else runs.push({mark, from: childFrom, to: childFrom + child.nodeSize});
            }
        });
    }
    return runs.filter((run) => run.from < to && run.to > from && !(run.from >= from && run.to <= to) && !(run.from <= from && run.to >= to))
        .map(({mark}) => mark);
}

/** 加粗、斜体等格式同样不能与已有标注部分重叠，原因见 crossingMarks。 */
export function formatProblem(state: EditorState): string | null {
    const {from, to, empty} = state.selection;
    if (empty) return null;
    return crossingMarks(state, from, to).some((mark) => kindOfMark(mark) !== null) ? "选区与标注部分重叠，格式需完整包含标注或位于标注之内" : null;
}

export type OutlineMarkAttrs = Readonly<{foreshadowId?: string; action?: ForeshadowMarkerAction}>;

/** 给当前选区加标注，成功返回新 marker，失败返回原因。 */
export function applyOutlineMark(editor: Editor, kind: OutlineMarkKind, attrs: OutlineMarkAttrs = {}): {marker: string} | string {
    const problem = annotationProblem(editor.state, kind);
    if (problem) return problem;
    const marker = createOutlineMarker(kind);
    const markAttrs = kind === "foreshadow" ? {marker, foreshadowId: attrs.foreshadowId ?? "", action: attrs.action ?? "plant"} : {marker};
    editor.chain().focus().setMark(OUTLINE_MARK_NAMES[kind], markAttrs).run();
    return {marker};
}

export function findOutlineMark(doc: ProseMirrorNode, kind: OutlineMarkKind, marker: string): OutlineMarkRange | undefined {
    return collectOutlineMarks(doc).ranges.find((range) => range.kind === kind && range.marker === marker);
}

/** 去掉标注只移除 mark，被标注的文字原样保留。 */
export function removeOutlineMark(editor: Editor, kind: OutlineMarkKind, marker: string): void {
    const type = markType(editor.state, kind);
    if (!type) return;
    const tr = editor.state.tr;
    editor.state.doc.descendants((node, pos) => {
        if (!node.isText) return;
        const mark = node.marks.find((item) => item.type === type && item.attrs.marker === marker);
        if (mark) tr.removeMark(pos, pos + node.nodeSize, mark);
    });
    if (tr.docChanged) editor.view.dispatch(tr);
}

/** 只改伏笔标记的指向或动作，marker 与被标注文字不变。 */
export function updateForeshadowMark(editor: Editor, marker: string, attrs: OutlineMarkAttrs): void {
    const range = findOutlineMark(editor.state.doc, "foreshadow", marker);
    const type = markType(editor.state, "foreshadow");
    if (!range || !type) return;
    const tr = editor.state.tr
        .removeMark(range.from, range.to, type)
        .addMark(range.from, range.to, type.create({...range.attrs, ...attrs}));
    editor.view.dispatch(tr);
}

/** 光标所在位置的标注；光标落在标注两端也算，方便作者从边界处操作。 */
export function outlineMarksAtCursor(state: EditorState): OutlineMarkRange[] {
    const {$from} = state.selection;
    const marks = [...$from.nodeBefore?.marks ?? [], ...$from.nodeAfter?.marks ?? []];
    const seen = new Set<string>();
    const {ranges} = collectOutlineMarks(state.doc);
    return marks.flatMap((mark) => {
        const kind = kindOfMark(mark);
        const marker = String(mark.attrs.marker ?? "");
        if (!kind || seen.has(`${kind}:${marker}`)) return [];
        seen.add(`${kind}:${marker}`);
        const range = ranges.find((item) => item.kind === kind && item.marker === marker);
        return range ? [range] : [];
    });
}
