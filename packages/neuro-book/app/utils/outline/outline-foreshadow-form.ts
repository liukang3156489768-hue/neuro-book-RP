import {renderMarkdownForeshadowMarker, type ForeshadowMarkerAction} from "nbook/shared/markdown-workbench";
import type {OutlineWorkbenchForeshadowingDefinition} from "nbook/app/composables/useOutlineWorkbenchData";

export type ForeshadowFormValue = {
    title: string;
    body: string;
    surface: string;
    connection: string;
    plant: {situation: string; presentation: string; subtlety: string};
    recover: {condition: string; echo: string; effect: string};
};

type Plant = ForeshadowFormValue["plant"];
type Recover = ForeshadowFormValue["recover"];
type DesignPayload = {surface: string | null; connection: string | null; plant: Plant | null; recover: Recover | null};

export function emptyForeshadowForm(): ForeshadowFormValue {
    return {title: "", body: "", surface: "", connection: "",
        plant: {situation: "", presentation: "", subtlety: ""}, recover: {condition: "", echo: "", effect: ""}};
}

export function foreshadowToForm(value: OutlineWorkbenchForeshadowingDefinition): ForeshadowFormValue {
    return {title: value.title, body: value.body, surface: value.surface ?? "", connection: value.connection ?? "",
        plant: {situation: "", presentation: "", subtlety: "", ...value.plant},
        recover: {condition: "", echo: "", effect: "", ...value.recover}};
}

function trimGroup<T extends Record<string, string>>(group: T): T | null {
    const trimmed = Object.fromEntries(Object.entries(group).map(([key, text]) => [key, text.trim()])) as T;
    return Object.values(trimmed).some(Boolean) ? trimmed : null;
}

/** 埋设与回收设计在服务端是三项齐全的整体，部分填写会被整体拒绝，所以前端先拦截。 */
export function validateForeshadowForm(form: ForeshadowFormValue): string | null {
    if (!form.title.trim()) return "伏笔标题不能为空";
    const plant = trimGroup(form.plant);
    if (plant && Object.values(plant).some((text) => !text)) return "埋设设计需要同时填写场景、呈现方式和隐蔽程度，或全部留空";
    const recover = trimGroup(form.recover);
    if (recover && Object.values(recover).some((text) => !text)) return "回收设计需要同时填写触发条件、呼应和效果，或全部留空";
    return null;
}

function toDesign(form: ForeshadowFormValue): DesignPayload {
    return {surface: form.surface.trim() || null, connection: form.connection.trim() || null,
        plant: trimGroup(form.plant), recover: trimGroup(form.recover)};
}

/** 新建时空分项直接省略；服务端 create 不接受 null。 */
export function formToCreateDesign(form: ForeshadowFormValue): Partial<{surface: string; connection: string; plant: Plant; recover: Recover}> {
    return Object.fromEntries(Object.entries(toDesign(form)).filter(([, value]) => value !== null));
}

/** 编辑时缺省表示沿用原值，因此清空的分项必须显式发送 null。 */
export function formToEditDesign(form: ForeshadowFormValue): DesignPayload {
    return toDesign(form);
}

export type MarkerInsertion = Readonly<{body: string; selectionStart: number; selectionEnd: number}>;

/**
 * 用伏笔标记包住选中文字。标记不能嵌套或交叉，选区触及已有标记时直接拒绝，
 * 否则保存时整篇正文会因解析失败被服务端拒绝。
 */
export function insertForeshadowMarker(
    body: string, start: number, end: number,
    attrs: Readonly<{foreshadowId: string; action: ForeshadowMarkerAction; marker: string}>,
): MarkerInsertion | string {
    if (end <= start || !body.slice(start, end).trim()) return "请先在正文中选中要标记的文字";
    if (/<!--|-->/u.test(body.slice(start, end)) || isInsideMarker(body, start)) return "选中的文字已在其他伏笔标记内，标记不能嵌套或交叉";
    const wrapped = renderMarkdownForeshadowMarker(attrs, body.slice(start, end));
    return {body: body.slice(0, start) + wrapped + body.slice(end), selectionStart: start, selectionEnd: start + wrapped.length};
}

function isInsideMarker(body: string, offset: number): boolean {
    const before = body.slice(0, offset);
    const lastOpen = before.search(/<!--\s*nb:foreshadow\b(?![\s\S]*<!--\s*nb:foreshadow\b)/u);
    if (lastOpen < 0) return false;
    return !/<!--\s*\/nb:foreshadow\b/u.test(before.slice(lastOpen));
}

export function createMarkerId(): string {
    return `fm-${crypto.randomUUID()}`;
}
