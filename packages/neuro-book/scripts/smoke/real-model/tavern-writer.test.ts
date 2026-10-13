import {createHash} from "node:crypto";
import {readFile, writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {describe, expect, it} from "vitest";
import {createModels, createProvider, envApiKeyAuth, lazyApi, type Model} from "@earendil-works/pi-ai";
import {compileTavernPreset, parseTavernPreset, activeTavernPrompts, applyTavernRegex} from "nbook/server/prompt-management/tavern-preset";
import {prepareOrderedProviderRequest} from "nbook/server/prompt-management/ordered-provider-request";
import {sanitizeProviderErrorMessage} from "nbook/server/agent/observability/provider-error-sanitizer";
import type {TavernBindings, TavernMessage} from "nbook/shared/dto/tavern-preset.dto";

const configured = process.env.NBOOK_TAVERN_PROVIDER_CONFIG && process.env.NBOOK_TAVERN_SAMPLE && process.env.NBOOK_TAVERN_UPSTREAM_DIR;

/** Explicit opt-in reads one saved Provider; no credentials or user settings are copied into the repository. */
describe.skipIf(!configured)("写手酒馆兼容的真实模型对照", () => {
    it("同一已配置 Provider 与参数分别接受兼容编译和固定上游消息", async () => {
        const config = JSON.parse(await readFile(resolve(process.env.NBOOK_TAVERN_PROVIDER_CONFIG!), "utf8"));
        const provider = config.models.providers.find((item: {id: string; name: string}) => item.name === process.env.NBOOK_TAVERN_PROVIDER || item.id === process.env.NBOOK_TAVERN_PROVIDER);
        if (!provider || !provider.enabled || provider.modelApi !== "openai-completions") throw new Error("指定 Provider 不存在、停用或不是 Chat Completions 接口");
        const modelId = process.env.NBOOK_TAVERN_MODEL!;
        const selected = provider.models.find((item: {id: string; enabled: boolean}) => item.id === modelId && item.enabled);
        if (!selected || !provider.options.apiKey) throw new Error("指定模型不可用或缺少已保存凭据");
        const raw = await readFile(resolve(process.env.NBOOK_TAVERN_SAMPLE!), "utf8");
        const source = parseTavernPreset(raw);
        const task = "现在直接完成正文，不要确认任务或询问资料。人物、地点、时间与事件资料已在故事卡和场景中齐备。陈越与林岚在雨夜车站修复一盏坏掉的灯，借修灯的动作和简短对白表现彼此重新建立信任。从两人走进候车室写起，以灯重新亮起后两人一起收拾工具结束。全部人物是成年人，无色情或暴力。使用第三人称中文，净正文1800字以上，以<content>和</content>包裹正文并输出预设所要求的时间栏，不添加来电、事故、陌生人或新的悬念。";
        const slots: TavernBindings["slots"] = Object.fromEntries(activeTavernPrompts(source).filter(prompt => prompt.marker).map(prompt => [prompt.identifier, []]));
        slots.chatHistory = [{role: "user", content: task}];
        slots.personaDescription = [{role: "system", content: "陈越，32岁，成年男性，车站设备检修员。穿灰色工作服与防滑鞋，手背有旧划痕。他做事谨慎，不善表达。用户宏指代小说中的陈越，允许按第三人称补充他的动作与对白。本轮创作安排已经明确，不需要用户另作角色选择。"}];
        slots.charDescription = [{role: "system", content: "故事名《雨夜换灯》。现代中国一座虚构小城的青禾车站，只有成年同事陈越与林岚登场。林岚31岁，成年女性，车站维修员，穿深蓝工作服，讲话利落，习惯先检查工具再动手。两人以前是配合默契的同事；上月陈越擅自替林岚交了检修记录，林岚觉得他不信任自己的判断，两人的配合由此生疏。本轮双方都想把工作做好，信任由一起检查、分工与接住对方递来的工具逐渐恢复。没有恋爱支线，没有其他人物，不使用未提供的背景。叙述者负责把两人的动作与对白写成小说。"}];
        slots.charPersonality = [{role: "system", content: "林岚务实、自尊心强，遇到小问题先排查再下结论；陈越谨慎、愿意承担责任，紧张时会反复对齐工具。两人不作宏大表白，以实际配合化解误会。"}];
        slots.scenario = [{role: "system", content: "时间：2026年6月15日，周一，20:10至20:35。地点：青禾车站，停运后的候车室，外面下着普通夏雨。候车室顶灯接触不良，工具箱、备用灯管、梯子与手电筒都已准备；陈越与林岚先断电、检查灯座，再换灯并复电。任务顺利完成，无伤害、无事故。此前没有正文历史，本轮是完整开篇场景，先建立两人进入候车室的起点即可。结尾明确灯亮、工具收好，留下关系变得自然的细微动作。"}];
        const bindings: TavernBindings = {user: "陈越", char: "林岚", slots, requestPostProcessing: "strict"};
        const compiled = compileTavernPreset(raw, bindings);
        const {createOracle} = await import("../tavern-upstream-oracle.mjs");
        const oracle = createOracle(JSON.parse(raw), {user: bindings.user, char: bindings.char, history: slots.chatHistory,
            persona: slots.personaDescription[0]!.content, charDescription: slots.charDescription[0]!.content,
            charPersonality: slots.charPersonality[0]!.content, scenario: slots.scenario[0]!.content});
        const upstream = await oracle.compile();
        const expected = oracle.strict(upstream.messages);
        expect(compiled.messages).toEqual(expected);
        const model: Model<"openai-completions"> = {id: selected.id, name: selected.name, api: "openai-completions", provider: provider.id,
            baseUrl: provider.options.baseURL, reasoning: selected.reasoning, input: ["text"], contextWindow: selected.contextWindowTokens,
            maxTokens: selected.maxTokens, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};
        const models = createModels();
        models.setProvider(createProvider({id: provider.id, name: provider.name, baseUrl: model.baseUrl, models: [model],
            auth: {apiKey: envApiKeyAuth("saved-provider", [])}, api: lazyApi(() => import("@earendil-works/pi-ai/api/openai-completions"))}));
        const preset = JSON.parse(raw);
        const parameters = {model: model.id, temperature: preset.temperature, top_p: preset.top_p, max_tokens: preset.openai_max_tokens,
            presence_penalty: preset.presence_penalty, frequency_penalty: preset.frequency_penalty, reasoning_effort: "none", stream: true};
        const results = [];
        for (const [kind, messages] of [["compatible", compiled.messages], ["upstream", expected]] as const) {
            let sent: {messages: TavernMessage[]; [key: string]: unknown} | undefined;
            const request = prepareOrderedProviderRequest(model, {messages: [], tools: []}, {apiKey: provider.options.apiKey, maxRetries: 0,
                signal: AbortSignal.timeout(240_000), onPayload: payload => ({...Object(payload), ...parameters})}, messages, 0);
            const hook = request.options.onPayload!;
            request.options.onPayload = async (payload, target) => {
                const final = await hook(payload, target);
                sent = final as typeof sent;
                return final;
            };
            const response = await models.completeSimple(model, request.context, request.options);
            if (response.stopReason === "error" || response.stopReason === "aborted") {
                const error = sanitizeProviderErrorMessage((response.errorMessage ?? response.stopReason).replaceAll(provider.options.apiKey, "[redacted]"));
                if (process.env.NBOOK_TAVERN_RESULT) await writeFile(resolve(process.env.NBOOK_TAVERN_RESULT), JSON.stringify({schema: "nbook.tavern-real-model/v1",
                    provider: provider.name, model: model.id, parameters, promptEquivalent: true, status: "failed", stage: kind,
                    error, requestMessageSha256: createHash("sha256").update(JSON.stringify(sent?.messages)).digest("hex")}, null, 2), {mode: 0o600});
                throw new Error(`真实模型 ${kind} 请求未成功：${error}`);
            }
            expect(sent?.messages).toEqual(messages);
            const text = response.content.flatMap(part => part.type === "text" ? [part.text] : []).join("");
            expect(text.length).toBeGreaterThan(0);
            const body = text.match(/<content>([\s\S]*?)<\/content>/u)?.[1] ?? "";
            const stored = applyTavernRegex(source, text, 2, "stored", 0, bindings, structuredClone(compiled.variablesAfter));
            const display = applyTavernRegex(source, stored, 2, "display", 0, bindings, structuredClone(compiled.variablesAfter));
            results.push({kind, stopReason: response.stopReason, usage: response.usage, characters: text.length,
                storedCharacters: stored.length, displayCharacters: display.length, contentTag: body.length > 0,
                bodyCharacters: body.replace(/<[^>]*>|\s/gu, "").length, timeTag: /<time>[\s\S]*<\/time>/u.test(text),
                messageSha256: createHash("sha256").update(JSON.stringify(sent?.messages)).digest("hex"), raw: text, stored, display});
        }
        const report = {schema: "nbook.tavern-real-model/v1", provider: provider.name, model: model.id, parameters,
            promptEquivalent: true, fullEnvironmentEquivalent: false, results,
            unverified: ["production-sampling-priority", "production-output-pipeline", "tavern-helper-reply-script", "literary-quality-blind-review"]};
        if (process.env.NBOOK_TAVERN_RESULT) await writeFile(resolve(process.env.NBOOK_TAVERN_RESULT), JSON.stringify(report, null, 2), {mode: 0o600});
        console.log(JSON.stringify({...report, results: results.map(({raw: _raw, stored: _stored, display: _display, ...metadata}) => metadata)}));
        for (const result of results) {
            expect(result.contentTag, `${result.kind} 未生成正文标签；原始输出保留在结果文件`).toBe(true);
            expect(result.bodyCharacters, `${result.kind} 正文未满足样本字数`).toBeGreaterThanOrEqual(1800);
            expect(result.timeTag, `${result.kind} 缺少时间栏`).toBe(true);
        }
    }, 510_000);
});
