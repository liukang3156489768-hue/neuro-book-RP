import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as chevrotain from 'chevrotain';
import seedrandom from 'seedrandom';
import actualMoment from 'moment';

/** Loads original pinned ESM modules, without using production vendor/parser/variable implementations. */
export async function createNativeOracle(bindings, mode = 'native') {
    const directory = process.env.NBOOK_TAVERN_UPSTREAM_DIR;
    if (!directory) throw new Error('NBOOK_TAVERN_UPSTREAM_DIR is required');
    const manifest = JSON.parse(readFileSync(new URL('../../server/prompt-management/tavern-native/UPSTREAM.json', import.meta.url), 'utf8'));
    const sources = new Map(manifest.files.map(file => {
        const bytes = readFileSync(`${directory}/${file.source.replaceAll('/', '__')}`);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.source);
        return [`/${file.source}`, bytes.toString('utf8')];
    }));
    const original = name => {
        const bytes = readFileSync(`${directory}/${name}`);
        const file = manifest.hostSources.find(file => file.source.replaceAll('/', '__') === name);
        if (!file) throw new Error(`Missing pinned host source ${name}`);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, name);
        return bytes.toString('utf8');
    };
    const extract = (source, name) => {
        const found = source.match(new RegExp(`export function ${name}\\([\\s\\S]*?\\n\\}`, 'u'))?.[0];
        if (!found) throw new Error(`Missing original function ${name}`);
        return found.replace('export function', 'function');
    };
    const local = structuredClone(bindings.localVariables ?? {}), global = structuredClone(bindings.globalVariables ?? {});
    const native = bindings.nativeContext ?? {};
    const rng = seedrandom(native.randomSeed);
    const chat = (bindings.slots.chatHistory ?? []).map(message => ({mes: message.content, is_user: message.role === 'user', is_system: message.role === 'system'}));
    const chat_metadata = {variables: local, pick_reroll_seed: native.pickRerollSeed, main_chat: native.chatId,
        lastInContextMessageId: native.firstIncludedMessageId};
    const context = vm.createContext({console: {warn() {}, error() {}, debug() {}, log() {}},
        chat_metadata, extension_settings: {variables: {global}}, saveMetadataDebounced() {}, saveSettingsDebounced() {},
        convertValueType: value => value, main_api: 'openai', power_user: {context: {}}, substituteParams: text => text,
        module: {exports: {}}, Math: Object.assign(Object.create(Math), {random: rng}),
    });
    const varSource = original('public__scripts__variables.js');
    const varNames = ['getLocalVariable', 'setLocalVariable', 'addLocalVariable', 'incrementLocalVariable', 'decrementLocalVariable',
        'getGlobalVariable', 'setGlobalVariable', 'addGlobalVariable', 'incrementGlobalVariable', 'decrementGlobalVariable',
        'existsLocalVariable', 'existsGlobalVariable', 'deleteLocalVariable', 'deleteGlobalVariable'];
    vm.runInContext(varNames.map(name => extract(varSource, name)).join('\n'), context);
    vm.runInContext(readFileSync(createRequire(import.meta.url).resolve('droll'), 'utf8'), context);
    const droll = context.module.exports;
    const moment = (...args) => {
        const input = args[0] === undefined ? [native.now] : args;
        const zoneLess = typeof input[0] === 'string' && !/(?:Z|[+-]\d{2}:?\d{2}|(?:GMT|UTC)(?:[+-]\d{4})?)\s*$/i.test(input[0]);
        return (zoneLess ? actualMoment.utc(...input) : actualMoment(...input)).locale(native.locale ?? 'en')
            .utcOffset(native.utcOffsetMinutes ?? 0, zoneLess, true);
    };
    moment.duration = (...args) => actualMoment.duration(...args).locale(native.locale ?? 'en');
    const utils = original('public__scripts__utils.js');
    vm.runInContext(['getStringHash', 'isFalseBoolean', 'isTrueBoolean'].map(name => extract(utils, name)).join('\n'), context);
    vm.runInContext(extract(original('public__script.js'), 'parseMesExamples'), context);
    const makeVariables = scope => {
        const title = scope === 'local' ? 'Local' : 'Global';
        return Object.fromEntries(Object.entries({get: `get${title}Variable`, set: `set${title}Variable`, add: `add${title}Variable`,
            inc: `increment${title}Variable`, dec: `decrement${title}Variable`, has: `exists${title}Variable`, del: `delete${title}Variable`})
            .map(([method, name]) => [method, context[name]]));
    };
    context.SillyTavern = {getContext: () => ({variables: {local: makeVariables('local'), global: makeVariables('global')}})};
    context.document = {querySelector: selector => selector === '#send_textarea' ? {value: native.input ?? ''}
        : native.firstDisplayedMessageId === undefined ? undefined : {getAttribute: () => String(native.firstDisplayedMessageId)}};
    const host = {chevrotain, seedrandom: (seed, options) => options?.entropy ? rng : seedrandom(seed, options), droll,
        chat, chat_metadata, main_api: 'openai', getCurrentChatId: () => native.chatId ?? '',
        getMaxPromptTokens: () => (native.maxContext ?? 0) - (native.maxResponse ?? 0),
        getMaxContextTokens: () => native.maxContext ?? 0, getMaxResponseTokens: () => native.maxResponse ?? 0,
        extension_prompts: {}, inject_ids: {CUSTOM_WI_OUTLET: name => name}, textgenerationwebui_banned_in_macros: [],
        getStringHash: context.getStringHash, isFalseBoolean: context.isFalseBoolean, isTrueBoolean: context.isTrueBoolean,
        moment, timestampToMoment: moment, isMobile: () => false, power_user: {instruct: {enabled: false}},
        parseMesExamples: context.parseMesExamples, formatInstructModeExamples: () => [],
    };
    if (mode === 'legacy') {
        Object.assign(context, host, {uuidv4: () => 'oracle-nonce', $: () => ({val: () => native.input ?? ''}), getInstructMacros: () => [],
            MacrosParser: {populateEnv() {}, sanitizeMacroValue: value => value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)},
            escapeRegex: value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), isDigitsOnly: value => /^\d+$/.test(value)});
        for (const slice of manifest.legacySlices) {
            const bytes = readFileSync(`${directory}/${slice.source.replaceAll('/', '__')}`);
            assert.equal(createHash('sha256').update(bytes).digest('hex'), slice.sha256, slice.source);
            vm.runInContext(bytes.toString('utf8').split('\n').slice(slice.lines[0] - 1, slice.lines[1]).join('\n').replace(/^export /gm, ''), context);
        }
        const environment = {...native.character, user: bindings.user, char: bindings.char, group: native.names?.group ?? bindings.char,
            groupNotMuted: native.names?.groupNotMuted ?? bindings.char, notChar: native.names?.notChar ?? bindings.user,
            persona: bindings.slots.personaDescription?.[0]?.content ?? '', scenario: bindings.slots.scenario?.[0]?.content ?? '',
            personality: bindings.slots.charPersonality?.[0]?.content ?? '', description: bindings.slots.charDescription?.[0]?.content ?? '',
            charDescription: bindings.slots.charDescription?.[0]?.content ?? '', model: native.model ?? '', original: () => native.original ?? '',
            mesExamples: () => context.parseMesExamples(native.character?.mesExamplesRaw ?? '').join(''),
            isMobile: 'false', lastGenerationType: native.lastGenerationType ?? bindings.generationType ?? 'normal'};
        return {evaluate: text => context.evaluateMacros(text, {...environment}), state: () => ({
            local: Object.fromEntries(Object.entries(local).map(([key, value]) => [key, String(value)])),
            global: Object.fromEntries(Object.entries(global).map(([key, value]) => [key, String(value)])),
        })};
    }
    const diagnostics = {createMacroRuntimeError: ({message}) => Object.assign(new Error(message), {isMacroRuntimeError: true})};
    for (const name of ['logMacroRuntimeWarning', 'logMacroInternalError', 'logMacroRegisterWarning', 'logMacroRegisterError', 'logMacroGeneralError', 'logMacroSyntaxWarning']) diagnostics[name] = () => {};
    const synthetic = values => new vm.SyntheticModule(Object.keys(values), function () {for (const [key, value] of Object.entries(values)) this.setExport(key, value);}, {context});
    const hostModule = synthetic(host), diagnosticsModule = synthetic(diagnostics);
    const modules = new Map([...sources].map(([name, source]) => [name, new vm.SourceTextModule(source, {context, identifier: name})]));
    const linker = (specifier, referencing) => {
        const name = new URL(specifier, `https://upstream.invalid${referencing.identifier}`).pathname;
        if (name.endsWith('/MacroDiagnostics.js')) return diagnosticsModule;
        return modules.get(name) ?? hostModule;
    };
    const engine = modules.get('/public/scripts/macros/engine/MacroEngine.js');
    await engine.link(linker);
    await engine.evaluate();
    for (const definition of ['core', 'variable', 'env', 'time', 'chat']) {
        const module = modules.get(`/public/scripts/macros/definitions/${definition}-macros.js`);
        if (module.status === 'unlinked') await module.link(linker);
        if (module.status !== 'evaluated') await module.evaluate();
        const register = `register${definition[0].toUpperCase()}${definition.slice(1)}Macros`;
        module.namespace[register]();
    }
    const character = {persona: bindings.slots.personaDescription?.[0]?.content ?? '', scenario: bindings.slots.scenario?.[0]?.content ?? '',
        personality: bindings.slots.charPersonality?.[0]?.content ?? '', description: bindings.slots.charDescription?.[0]?.content ?? '', ...native.character};
    return {evaluate(text) {
        return engine.namespace.MacroEngine.evaluate(text, {content: text, contentHash: context.getStringHash(text),
            names: {user: bindings.user, char: bindings.char, group: native.names?.group ?? bindings.char,
                groupNotMuted: native.names?.groupNotMuted ?? bindings.char, notChar: native.names?.notChar ?? bindings.user},
            character, system: {model: native.model ?? ''}, functions: {original: () => native.original ?? '', postProcess: text => text},
            dynamicMacros: {}, extra: {}});
    }, state() {return {local: Object.fromEntries(Object.entries(local).map(([key, value]) => [key, String(value)])),
        global: Object.fromEntries(Object.entries(global).map(([key, value]) => [key, String(value)]))};}};
}

export const createLegacyOracle = bindings => createNativeOracle(bindings, 'legacy');

/** Node isolates the experimental VM flag to this read-only oracle instead of requiring a global test flag. */
export async function runNativeOracle(bindings, texts) {
    if (!vm.SourceTextModule) {
        const result = spawnSync(process.execPath, ['--experimental-vm-modules', fileURLToPath(import.meta.url), '--evaluate-batch'], {
            input: JSON.stringify({bindings, texts}), encoding: 'utf8', env: process.env, maxBuffer: 4_000_000,
        });
        if (result.status !== 0) throw new Error('Native oracle child failed: ' + (result.error?.message ?? result.stderr));
        return JSON.parse(result.stdout);
    }
    const oracle = await createNativeOracle(bindings);
    return texts.map(text => ({text: oracle.evaluate(text), state: oracle.state()}));
}

if (process.argv[2] === '--evaluate-batch') {
    const {bindings, texts} = JSON.parse(readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify(await runNativeOracle(bindings, texts)));
}
