import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {createRequire} from "node:module";
import type * as TypeScript from "typescript";
import type {RuntimePaths} from "nbook/server/runtime/paths/runtime-paths";
import {resolveSystemSeedNbookRoot} from "nbook/server/workspace-files/system-workspace-assets";
import type {PromptEntry, PromptPurposeDefinition} from "nbook/shared/dto/prompt-management.dto";

// TypeScript is a Product package island; Nitro must not bundle the compiler into the application graph.
const ts = createRequire(import.meta.url)("typescript") as typeof TypeScript;

const DESIGN_PROFILES = ["inspiration", "inspiration.character", "inspiration.faction", "inspiration.instruction", "inspiration.item", "inspiration.location", "inspiration.note", "inspiration.system", "inspiration.world"];
const OUTLINE_PROFILES = ["outline.planner", "outline.outline", "outline.detailed", "outline.foreshadowing"];
const ASSISTANT_MODES = {
    "plan-scenes": ["场景规划", "renderScenePlanningMode"],
    "review-scene": ["场景审阅", "renderSceneReviewMode"],
    "plan-rewrite": ["改写规划", "renderRewritePlanningMode"],
    "review-rewrite": ["改写审阅", "renderRewriteReviewMode"],
    "plan-chapter": ["整章规划（预留）", "renderChapterPlanningMode"],
    "review-chapter": ["整章审阅（预留）", "renderChapterReviewMode"],
} as const;

/** Built-in sources are read from the application seed; mutable installed Profiles cannot redefine the recovery preset. */
export async function loadAgentPromptDefinitions(paths: RuntimePaths): Promise<PromptPurposeDefinition[]> {
    const seed = resolveSystemSeedNbookRoot(paths.applicationRoot);
    const definitions: PromptPurposeDefinition[] = [];
    for (const profileKey of [...DESIGN_PROFILES, ...OUTLINE_PROFILES, "writing.lead", "writing.assistant", "writing.material-review"]) {
        const source = ts.createSourceFile(`${profileKey}.profile.tsx`, await readFile(join(seed, "agent", "profiles", "builtin", `${profileKey}.profile.tsx`), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const manifest = manifestStrings(source);
        const module = profileKey.startsWith("inspiration") ? "design" : profileKey.startsWith("outline") ? "outline" : "writing";
        if (profileKey === "writing.assistant") {
            for (const [kind, [label, renderer]] of Object.entries(ASSISTANT_MODES)) {
                const text = [functionPrompt(source, "renderBasePrompt"), functionPrompt(source, renderer), functionPrompt(source, "renderFooter")].join("\n\n");
                definitions.push(definition(`${profileKey}.${kind}`, module, `写作助手 · ${label}`, manifest.description, [entry("system", "系统提示词", text, "system")]));
            }
            continue;
        }
        const messages: PromptEntry[] = [entry("system", "系统提示词", systemPrompt(source), "system")];
        if (module === "outline") {
            messages.push(entry("project", "当前作品绑定", "当前会话绑定的 Project：{{projectRoot}}", "user"));
            const imports = importPaths(source);
            for (let index = 0; index < imports.length; index += 1) {
                const importPath = imports[index]!;
                const relativePath = importPath.replace(/^assets\/workspace\/\.nbook\//u, "");
                if (relativePath === importPath || relativePath.split("/").some(segment => segment === "..")) throw new Error(`提示词内置参考路径无效：${importPath}`);
                const content = await readFile(join(seed, relativePath), "utf8");
                messages.push(entry(`guide-${index}`, relativePath.split("/").at(-1) ?? "操作指南", content, "user"));
            }
        }
        definitions.push(definition(profileKey, module, manifest.name, manifest.description, messages));
    }
    return definitions;
}

function entry(id: string, name: string, content: string, role: PromptEntry["role"]): PromptEntry {
    return {id, name, role, content};
}

function definition(purposeId: string, module: PromptPurposeDefinition["module"], label: string, description: string, entries: PromptEntry[]): PromptPurposeDefinition {
    const variables = [...new Set(entries.flatMap(message => [...message.content.matchAll(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/gu)].map(match => match[1]!)))];
    return {purposeId, module, label, description, variables, requiredVariables: variables, entries};
}

function descendants(root: TypeScript.Node, predicate: (node: TypeScript.Node) => boolean): TypeScript.Node[] {
    const found: TypeScript.Node[] = [];
    const visit = (node: TypeScript.Node): void => {
        if (predicate(node)) found.push(node);
        ts.forEachChild(node, visit);
    };
    visit(root);
    return found;
}

function manifestStrings(source: TypeScript.SourceFile): {name: string; description: string} {
    const manifest = descendants(source, node => ts.isVariableDeclaration(node) && node.name.getText(source) === "profileManifest")[0];
    if (!manifest) throw new Error(`内置 Profile 缺少 manifest：${source.fileName}`);
    const values = new Map<string, string>();
    for (const node of descendants(manifest, ts.isPropertyAssignment)) {
        if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.initializer)) values.set(node.name.getText(source), node.initializer.text);
    }
    return {name: values.get("name") ?? source.fileName, description: values.get("description") ?? ""};
}

function systemPrompt(source: TypeScript.SourceFile): string {
    const system = descendants(source, node => ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === "System")[0];
    if (!system || !ts.isJsxElement(system)) throw new Error(`内置 Profile 缺少 System：${source.fileName}`);
    const expression = system.children.find(ts.isJsxExpression)?.expression;
    if (!expression) throw new Error(`内置 Profile System 缺少正文：${source.fileName}`);
    if (ts.isCallExpression(expression) && expression.expression.getText(source) === "renderSystemPrompt") return functionPrompt(source, "renderSystemPrompt");
    return promptExpression(source, expression);
}

function functionPrompt(source: TypeScript.SourceFile, name: string): string {
    const fn = descendants(source, node => ts.isFunctionDeclaration(node) && node.name?.text === name)[0];
    if (!fn || !ts.isFunctionDeclaration(fn) || !fn.body) throw new Error(`内置提示词函数不存在：${source.fileName}/${name}`);
    const returned = fn.body.statements.find(ts.isReturnStatement)?.expression;
    if (!returned) throw new Error(`内置提示词函数缺少返回值：${source.fileName}/${name}`);
    return promptExpression(source, returned);
}

/** Only the supported literal/template syntax is converted; changed source syntax fails instead of executing application code. */
function promptExpression(source: TypeScript.SourceFile, expression: TypeScript.Expression): string {
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
    if (ts.isTaggedTemplateExpression(expression) && expression.tag.getText(source) === "profileText") return dedent(promptExpression(source, expression.template));
    if (ts.isTemplateExpression(expression)) {
        return expression.head.text + expression.templateSpans.map(span => variablePlaceholder(source, span.expression) + span.literal.text).join("");
    }
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === "join" && ts.isArrayLiteralExpression(expression.expression.expression)) {
        const separator = expression.arguments[0];
        if (!separator || !ts.isStringLiteral(separator)) throw new Error(`提示词 join 分隔符无效：${source.fileName}`);
        return expression.expression.expression.elements.map(element => promptExpression(source, element)).join(separator.text);
    }
    throw new Error(`内置提示词语法不受支持：${source.fileName} ${expression.getText(source).slice(0, 120)}`);
}

function variablePlaceholder(source: TypeScript.SourceFile, expression: TypeScript.Expression): string {
    const text = expression.getText(source);
    const mappings: Record<string, string> = {
        "ctx.initial.fields.join(\"、\") || \"写作指导与参考资料按当前需求组织，不预设必填字段\"": "fields",
        "JSON.stringify(initial.scope)": "scope",
        "initial.projectRoot": "projectRoot", "initial.mode": "mode", "initial.model": "model",
        "initial.temperature": "temperature", "initial.thinking": "thinking", "initial.chapterEntryId": "chapterEntryId",
        "initial.creationMode": "creationMode",
    };
    if (text.startsWith("initial.chapterEntryId === undefined ?")) return "{{chapterBinding}}";
    const name = mappings[text];
    if (!name) throw new Error(`内置提示词动态值未登记：${source.fileName} ${text}`);
    return `{{${name}}}`;
}

function importPaths(source: TypeScript.SourceFile): string[] {
    const imports = descendants(source, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === "Import");
    return imports.map(node => {
        if (!ts.isJsxSelfClosingElement(node)) throw new Error("Import 节点无效");
        const attribute = node.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.getText(source) === "path");
        if (!attribute || !ts.isJsxAttribute(attribute) || !attribute.initializer || !ts.isStringLiteral(attribute.initializer)) throw new Error(`Import path 必须是静态路径：${source.fileName}`);
        return attribute.initializer.text;
    });
}

function dedent(text: string): string {
    const lines = text.replace(/\r\n/gu, "\n").split("\n");
    while (lines.length && !lines[0]!.trim()) lines.shift();
    while (lines.length && !lines.at(-1)!.trim()) lines.pop();
    const indent = Math.min(...lines.filter(line => line.trim()).map(line => /^\s*/u.exec(line)![0].length));
    return lines.map(line => line.slice(indent)).join("\n");
}
