import {createHash} from "node:crypto";
import ts from "typescript";
import {TavernMessageSchema, type TavernMessage} from "nbook/shared/dto/tavern-preset.dto";

/** Parse only literal data and string concatenation; the supplied log is never evaluated. */
export function parseTavernConsoleRequest(text: string): {messages: TavernMessage[]; postProcessing?: string} | null {
    const header = "Chat Completion request: ";
    const start = text.indexOf(header);
    if (start < 0) return null;
    const code = `const request = ${text.slice(start + header.length).trim()};`;
    if (code.length > 2_000_000) throw new Error("对照日志过大");
    const diagnostics = ts.transpileModule(code, {reportDiagnostics: true, compilerOptions: {target: ts.ScriptTarget.ESNext}}).diagnostics ?? [];
    if (diagnostics.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) throw new Error("对照日志的消息对象语法不完整");
    const parsed = ts.createSourceFile("reference.js", code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
    const statement = parsed.statements[0];
    if (parsed.statements.length !== 1 || !statement || !ts.isVariableStatement(statement)) throw new Error("对照日志必须只包含请求对象");
    let nodes = 0;
    const literal = (node: ts.Node, depth = 0): unknown => {
        if (++nodes > 20_000 || depth > 30) throw new Error("对照日志结构过深");
        if (ts.isStringLiteral(node)) return node.text;
        if (ts.isNumericLiteral(node)) return Number(node.text);
        if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
        if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
        if (node.kind === ts.SyntaxKind.NullKeyword) return null;
        if (ts.isIdentifier(node) && node.text === "undefined") return undefined;
        if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return -Number(node.operand.text);
        if (ts.isArrayLiteralExpression(node)) return node.elements.map(element => literal(element, depth + 1));
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
            const pending: ts.Node[] = [node], parts: string[] = [];
            while (pending.length) {
                const next = pending.pop()!;
                if (++nodes > 20_000) throw new Error("对照日志结构过大");
                if (ts.isBinaryExpression(next) && next.operatorToken.kind === ts.SyntaxKind.PlusToken) pending.push(next.right, next.left);
                else {
                    const part = literal(next, depth + 1);
                    if (typeof part !== "string") throw new Error("对照日志只允许字符串拼接");
                    parts.push(part);
                }
            }
            return parts.join("");
        }
        if (ts.isObjectLiteralExpression(node)) {
            const result: Record<string, unknown> = {};
            for (const property of node.properties) {
                if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) throw new Error("对照日志含非字面属性");
                const key = property.name.text;
                if (Object.hasOwn(result, key)) throw new Error("对照日志含重复属性");
                Object.defineProperty(result, key, {value: literal(property.initializer, depth + 1), enumerable: true});
            }
            return result;
        }
        throw new Error("对照日志含可执行表达式，已拒绝");
    };
    const initializer = statement.declarationList.declarations[0]?.initializer;
    if (!initializer || !ts.isObjectLiteralExpression(initializer)) throw new Error("对照日志缺少请求对象");
    const payload = literal(initializer);
    const messages = TavernMessageSchema.array().parse(Reflect.get(Object(payload), "messages"));
    return {messages, postProcessing: text.match(/^Applying custom prompt post-processing of type (\w+)/mu)?.[1]};
}

/** A clipped console dump is evidence of visible fields, never a replayable API request. */
export function inspectTavernRequestReference(text: string, source: Record<string, unknown>, messages: TavernMessage[],
    origins: {identifier: string; marker: boolean}[] = [],
    finalMessages: TavernMessage[] = messages,
) {
    const normalized = text.replace(/\r\n/gu, "\n");
    const boundary = normalized.lastIndexOf("\n  ],\n  prompt:");
    if (boundary < 0) throw new Error("对照文档不是受支持的截断 console 请求日志：缺少参数尾部边界");
    const tail = normalized.slice(boundary);
    const fields: Record<string, string | number | boolean> = {};
    for (const match of tail.matchAll(/^  (model|temperature|max_tokens|max_completion_tokens|stream|presence_penalty|frequency_penalty|top_p|top_k|reasoning_effort): ([^\n]+)$/gmu)) {
        const key = match[1]!, literal = match[2]!.replace(/,$/u, "");
        if (literal === "undefined") continue;
        if (/^-?\d+(?:\.\d+)?$/u.test(literal)) fields[key] = Number(literal);
        else if (literal === "true" || literal === "false") fields[key] = literal === "true";
        else if (/^'[\w./:-]+'$/u.test(literal)) fields[key] = literal.slice(1, -1);
        else throw new Error(`对照日志参数不是受支持的字面值：${key}`);
    }
    const request = parseTavernConsoleRequest(normalized);
    const content = request ? request.messages.map(message => message.content).join("\n\n") : normalized.slice(0, boundary);
    const withoutBlankLines = (value: string) => value.split("\n").filter(line => line.trim().length > 0).join("\n");
    const nonemptyContent = withoutBlankLines(content);
    const matches = messages.map((message, index) => {
        const value = message.content.replace(/\r\n/gu, "\n").trim();
        return {index, ...(origins[index] ?? {}), role: message.role, characters: value.length, offset: value ? content.indexOf(value) : -1,
            matchedIgnoringBlankLines: value.length > 0 && nonemptyContent.includes(withoutBlankLines(value))};
    });
    const settings = {temperature: "temperature", top_p: "top_p", max_tokens: "openai_max_tokens",
        presence_penalty: "presence_penalty", frequency_penalty: "frequency_penalty"};
    const sampling = Object.entries(settings).filter(([requestKey, presetKey]) => fields[requestKey] !== undefined && source[presetKey] !== undefined)
        .map(([requestKey, presetKey]) => ({field: requestKey, preset: source[presetKey], observed: fields[requestKey], equal: source[presetKey] === fields[requestKey]}));
    const continuation = typeof source.continue_nudge_prompt === "string" && source.continue_nudge_prompt.length > 0
        && (request ? request.messages.at(-1)?.content === source.continue_nudge_prompt : content.includes(`content: '${source.continue_nudge_prompt}'`));
    const ordinary = matches.filter(match => match.marker === false);
    const roles = request?.messages.map(message => message.role);
    return {sourceSha256: createHash("sha256").update(text).digest("hex"), format: request ? "console-request" : "clipped-console-log", completeMessages: false,
        messageBoundariesAvailable: request !== null, postProcessing: request?.postProcessing,
        visibleTrailingRoles: roles ?? [...content.matchAll(/^      role: '(system|user|assistant)',$/gmu)].map(match => match[1]),
        ...(request ? {finalMessageComparison: {roles: JSON.stringify(roles) === JSON.stringify(finalMessages.map(message => message.role)),
            exactContent: JSON.stringify(request.messages) === JSON.stringify(finalMessages), observedCount: request.messages.length, compiledCount: finalMessages.length}} : {}),
        requestFields: fields, sampling, continuationNudgeObserved: continuation,
        textMatches: {matched: matches.filter(match => match.offset >= 0).length,
            matchedIgnoringBlankLines: matches.filter(match => match.matchedIgnoringBlankLines).length, total: matches.length, messages: matches},
        presetTextMatches: {matched: ordinary.filter(match => match.offset >= 0).length,
            matchedIgnoringBlankLines: ordinary.filter(match => match.matchedIgnoringBlankLines).length, total: ordinary.length},
        unverified: ["endpoint-and-provider", ...(request ? ["removed-source-content"] : ["complete-message-boundaries"]), "response-body", "sillytavern-version", "macro-engine", "plugin-settings"]};
}
