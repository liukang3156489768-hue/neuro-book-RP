import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const upstreamCommit = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
export const sourceHashes = {
  'src__prompt-converters.js': 'eadc6ccd7961273c887c0986c2ed1ffe61e2e7da03f83afeb8ba4dc5a5041a13',
  'public__scripts__PromptManager.js': 'b0054793b763d92b265f5f487645b68b4eca0867cb5ad6b5deb1034004b2c1cc',
  'public__scripts__openai.js': '0b77c30282825540265d5a09e681e5ccacf6760b05111ec880ffe237a9250604',
  'public__scripts__variables.js': '92e1bfa793e6072c2daeecdbb6d7429faf990e251bfc5f8d97c0ba7088a1282a',
  'public__scripts__macros.js': '1926c394e22a35827f594a4c4bfb044ed4c80dcc911680875991a880f8e53f11',
  'public__scripts__utils.js': '2a2cfe240d5a84ce2e09ba053db6c0c71473b6406173f614f3521d89f50ada61',
  'public__scripts__extensions__regex__engine.js': '091bb3402a12552cf1754d6e4d2b44df38d3553aa374539896c716e78905d350',
};
const upstreamDirectory = process.env.NBOOK_TAVERN_UPSTREAM_DIR ? pathToFileURL(process.env.NBOOK_TAVERN_UPSTREAM_DIR.replace(/\\/g, '/') + '/') : new URL('../../../../.local/tavern/upstream/', import.meta.url);
const sources = Object.fromEntries(Object.entries(sourceHashes).map(([name, expected]) => {
  const bytes = readFileSync(new URL(name, upstreamDirectory));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, `Changed upstream source: ${name}`);
  return [name, bytes.toString('utf8').split('\n')];
}));
function slice(name, start, end) {
  return sources[name].slice(start - 1, end).join('\n').replace(/^export /gm, '');
}
const PM = 'public__scripts__PromptManager.js';
const OAI = 'public__scripts__openai.js';
const VAR = 'public__scripts__variables.js';
const MAC = 'public__scripts__macros.js';
const REG = 'public__scripts__extensions__regex__engine.js';
const UTIL = 'public__scripts__utils.js';
// Only module export keywords are stripped. Every selected function/class body is upstream code.
const upstreamCode = [
  slice('src__prompt-converters.js', 15, 26), slice('src__prompt-converters.js', 85, 105),
  slice('src__prompt-converters.js', 827, 954),
  slice(VAR, 22, 210), slice(VAR, 238, 261), slice(MAC, 610, 715),
  slice(PM, 80, 298), slice(PM, 300, 1999),
  slice(OAI, 3485, 4268), slice(OAI, 789, 801), slice(OAI, 810, 1347),
  slice(OAI, 1367, 1625),
  slice(OAI, 239, 246), slice(OAI, 2545, 2664),
  slice(UTIL, 1387, 1402), slice(REG, 40, 90), slice(REG, 298, 324), slice(REG, 334, 465),
  'globalThis.upstream = { PromptManager, preparePromptsForChatCompletion, prepareOpenAIMessages, getReasoningEffort, getRegexedString, runRegexScript, regexFromString, evaluateMacros, mergeMessages, postProcessPrompt, ChatCompletion };',
].join('\n');

/** Oracle scope: relative and depth injection, legacy user/char/persona/setvar/getvar/comment/trim macros,
 * text history, no plugins/tools/media. Token accounting is zero unless an explicit counter is supplied.
 */
export function createOracle(preset, bindings = {}) {
  const trace = [];
  const errors = [];
  const settings = {
    scenario_format: '{{scenario}}', personality_format: '{{personality}}', wi_format: '{0}',
    group_nudge_prompt: '', impersonation_prompt: '', new_chat_prompt: '', new_example_chat_prompt: '',
    openai_max_context: 1000000, openai_max_tokens: 1, names_behavior: -1,
    ...structuredClone(preset),
    ...(bindings.budget ? {openai_max_context: bindings.budget.contextTokens, openai_max_tokens: bindings.budget.responseTokens} : {}),
  };
  const context = {
    PROMPT_PLACEHOLDER: "Let's get started.",
    console: { log() {}, debug() {}, warn(...args) { errors.push(args.map(String).join(' ')); }, error(...args) { errors.push(args.map(String).join(' ')); } },
    structuredClone, uuidv4: randomUUID,
    chat_metadata: { variables: structuredClone(bindings.localVariables ?? {}) },
    extension_settings: { variables: { global: structuredClone(bindings.globalVariables ?? {}) }, disabledExtensions: [] },
    saveSettingsDebounced() {}, saveMetadataDebounced() {}, convertValueType: value => value,
    DEFAULT_ORDER: 100, DEFAULT_DEPTH: 4, INJECTION_POSITION: { RELATIVE: 0, ABSOLUTE: 1 },
    oai_settings: settings,
    power_user: { console_log_prompts: false, pin_examples: bindings.budget?.pinExamples ?? false, persona_description: bindings.persona ?? '', persona_description_position: 0 },
    persona_description_positions: { IN_PROMPT: 0 },
    extension_prompt_types: { BEFORE_PROMPT: 0, IN_PROMPT: 2, IN_CHAT: 1 },
    extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
    character_names_behavior: { NONE: -1, DEFAULT: 0, COMPLETION: 1, CONTENT: 2 },
    chat_completion_sources: Object.fromEntries(['CLAUDE', 'OPENAI', 'AZURE_OPENAI', 'CUSTOM', 'XAI', 'AIMLAPI', 'OPENROUTER',
      'POLLINATIONS', 'PERPLEXITY', 'COMETAPI', 'ELECTRONHUB', 'CHUTES', 'DEEPSEEK', 'FIREWORKS'].map(name => [name, name.toLowerCase()])),
    selected_group: null, name1: bindings.user ?? '', name2: bindings.char ?? '',
    tokenHandler: { async countAsync(message) { return bindings.budget ? bindings.budget.count(message) : 0; } },
    ToolManager: { canPerformToolCalls() { return false; }, isToolCallingSupported() { return false; } },
    isImageInliningSupported() { return false; }, isVideoInliningSupported() { return false; }, isAudioInliningSupported() { return false; },
    isReasoningSignatureSupported() { return false; }, interleaved_reasoning_providers: [], tool_reasoning_modes: { DISABLED: 'disabled' },
    getExtensionPromptMaxDepth() { return Math.max(0, ...(settings.prompts ?? []).filter(prompt => prompt.injection_position === 1).map(prompt => prompt.injection_depth ?? 4)); }, async getExtensionPrompt() { return ''; },
    stringFormat: (format, value) => format.replace('{0}', value),
    toastr: { error(message) { errors.push(message); }, warning(message) { errors.push(message); } },
    event_types: { CHAT_COMPLETION_PROMPT_READY: 'prompt_ready' }, eventSource: { async emit() {} },
    MacrosParser: { populateEnv() {}, sanitizeMacroValue: value => value == null ? '' : String(value) },
    escapeRegex: value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    getInstructMacros() { return []; },
    $() { throw new Error('UI-dependent macro is outside the oracle scope'); },
    getRegexScripts() { return context.regexScripts; }, regexScripts: [],
  };
  // These factories are referenced when the legacy evaluator builds its table,
  // but are not used by the declared sample macro subset. Reject their syntax up front.
  for (const name of ['getDiceRollMacro', 'getTimeDiffMacro', 'getBannedWordsMacro', 'getRandomReplaceMacro', 'getPickReplaceMacro']) {
    context[name] = () => ({ regex: /(?!){{/g, replace() { throw new Error('Unsupported macro'); } });
  }
  vm.createContext(context);
  vm.runInContext(upstreamCode, context, { filename: `SillyTavern@${upstreamCommit}:fixed-source-slices` });
  context.substituteParams = (content, options = {}) => {
    if (/{{(?:random|pick|roll|timeDiff|banned)\b/i.test(content ?? '')) throw new Error('Macro outside oracle scope');
    const env = {
      user: options.name1Override ?? bindings.user ?? '',
      char: options.name2Override ?? bindings.char ?? '', persona: bindings.persona ?? '',
      scenario: bindings.scenario ?? '', personality: bindings.charPersonality ?? '',
      original: options.original ?? '', group: options.groupOverride ?? '', ...options.dynamicMacros,
    };
    const result = context.upstream.evaluateMacros(content, env, options.postProcessFn);
    trace.push({ input: content, output: result, localVariables: structuredClone(context.chat_metadata.variables) });
    return result;
  };
  context.substituteParamsExtended = (content, extra = {}, postProcessFn) => context.substituteParams(content, { dynamicMacros: extra, postProcessFn });
  const manager = Object.create(context.upstream.PromptManager.prototype);
  manager.activeCharacter = { id: bindings.characterId ?? 100001 };
  manager.serviceSettings = settings;
  manager.configuration = { promptOrder: { dummyId: 100001, strategy: 'global' } };
  manager.log = () => {};
  manager.tokenHandler = { counts: false };
  manager.render = () => {};
  manager.setChatCompletion = result => { manager.messages = result.getMessages(); };
  context.promptManager = manager;
  return {
    async compile({ squashSystemMessages = settings.squash_system_messages ?? false } = {}) {
      context.oai_settings.squash_system_messages = squashSystemMessages;
      const [messages] = await context.upstream.prepareOpenAIMessages({
        name2: bindings.char ?? '', charDescription: bindings.charDescription ?? '', charPersonality: bindings.charPersonality ?? '',
        scenario: bindings.scenario ?? '', worldInfoBefore: bindings.worldInfoBefore ?? '', worldInfoAfter: bindings.worldInfoAfter ?? '',
        bias: '', type: bindings.generationType ?? 'normal', cyclePrompt: bindings.generationType === 'continue' ? bindings.history?.at(-1)?.content : undefined,
        quietPrompt: '', extensionPrompts: {}, systemPromptOverride: bindings.systemPromptOverride,
        jailbreakPromptOverride: bindings.jailbreakPromptOverride,
        messages: structuredClone(bindings.history ?? []).reverse(), messageExamples: structuredClone(bindings.examples ?? []),
      }, false);
      if (errors.length) throw new Error(errors.join('\n'));
      return { messages: JSON.parse(JSON.stringify(messages)), localVariables: structuredClone(context.chat_metadata.variables), globalVariables: structuredClone(context.extension_settings.variables.global), trace: structuredClone(trace) };
    },
    macro: context.substituteParams,
    customReasoningEffort(effort, model) {
      return context.upstream.getReasoningEffort({chat_completion_source: 'custom', reasoning_effort: effort}, model);
    },
    strict(messages) {
      return JSON.parse(JSON.stringify(context.upstream.mergeMessages(structuredClone(messages),
        {userName: bindings.user ?? '', charName: bindings.char ?? '', startsWithGroupName() {return false;}}, {strict: true, placeholders: true})));
    },
    postProcess(messages, type) {
      return JSON.parse(JSON.stringify(context.upstream.postProcessPrompt(structuredClone(messages), type === 'none' ? '' : type,
        {userName: bindings.user ?? '', charName: bindings.char ?? '', startsWithGroupName() {return false;}})));
    },
    async squash(entries) {
      const completion = new context.upstream.ChatCompletion();
      completion.messages.collection = entries.map(entry => ({...structuredClone(entry.message), identifier: entry.identifier}));
      await completion.squashSystemMessages();
      return completion.messages.collection.map(({identifier, role, content, name}) => ({identifier,
        message: {role, content, ...(name === undefined ? {} : {name})}}));
    },
    regex(raw, scripts, placement, params = {}) {
      context.regexScripts = structuredClone(scripts);
      return context.upstream.getRegexedString(raw, placement, params);
    },
    regexFromString: context.upstream.regexFromString,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const preset = {
    prompts: [{ identifier: 'first', system_prompt: false, role: 'system', content: '{{setvar::x::2}}' }, { identifier: 'second', system_prompt: false, role: 'user', content: ' {{getvar::x}}/{{user}}/{{setvar::mokuai}} ' }, { identifier: 'charDescription', marker: true, system_prompt: true }, { identifier: 'personaDescription', marker: true, system_prompt: true }, { identifier: 'space', system_prompt: false, role: 'assistant', content: '  ' }],
    prompt_order: [{ character_id: 100001, order: ['charDescription', 'personaDescription', 'first', 'second', 'space'].map(identifier => ({ identifier, enabled: true })) }],
  };
  const oracle = createOracle(preset, { user: 'Author', char: 'Writer', persona: '{{getvar::x}} persona', charDescription: '{{getvar::x}} character' });
  const result = await oracle.compile();
  assert.deepEqual(result.messages, [{ role: 'system', content: '2 character' }, { role: 'system', content: '2 persona' }, { role: 'user', content: ' 2/Author/{{setvar::mokuai}} ' }, { role: 'assistant', content: '  ' }]);
  assert.equal(oracle.macro('{{getvar::v}}/{{setvar::v::3}}/{{getvar::v}} {{// comment }}A{{trim}}\n'), '3//3 A');
  assert.equal(oracle.regexFromString('a').flags, '');
  assert.equal(oracle.regexFromString('/a/g').flags, 'g');
  const script = { disabled: false, findRegex: 'a', replaceString: 'b', trimStrings: [], placement: [2], promptOnly: true, markdownOnly: false, substituteRegex: 0, minDepth: 2, maxDepth: 4 };
  assert.equal(oracle.regex('aaa', [script], 2, { isPrompt: true, depth: 1 }), 'aaa');
  assert.equal(oracle.regex('aaa', [script], 2, { isPrompt: true, depth: 2 }), 'baa');
  assert.equal(oracle.regex('aaa', [script], 2, { isPrompt: true, depth: 4 }), 'baa');
  assert.equal(oracle.regex('aaa', [script], 2, { isPrompt: true, depth: 5 }), 'aaa');
  assert.equal(oracle.regex('aaa', [script], 2, { isPrompt: true }), 'baa');
  console.log(JSON.stringify({ smoke: 'passed', upstreamCommit, result }, null, 2));
}
