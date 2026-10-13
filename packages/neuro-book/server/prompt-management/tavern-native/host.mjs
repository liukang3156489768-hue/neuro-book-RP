import actualSeedrandom from 'seedrandom';
import actualDroll from 'droll';
import actualMoment from 'moment';

let active;
const context = () => {
    if (!active) throw new Error('Native Tavern macros require a synchronous compilation context');
    return active;
};

/** The upstream singleton parser is synchronous; restore the owning context even after a failed macro. */
export function createNativeContext(value) {
    return {...value, metadata: {pick_reroll_seed: value.native.pickRerollSeed, main_chat: value.native.chatId,
        lastInContextMessageId: value.native.firstIncludedMessageId}, rng: actualSeedrandom(value.native.randomSeed)};
}
export function withNativeContext(value, evaluate) {
    const previous = active;
    active = value;
    try {return evaluate();} finally {active = previous;}
}

// Upstream modules capture these facades during registration, before any compilation is active.
const variables = Object.fromEntries(['local', 'global'].map(scope => [scope,
    Object.fromEntries(['get', 'set', 'add', 'inc', 'dec', 'has', 'del'].map(method => [method, (...args) => context().variables[scope][method](...args)])),
]));
const facade = {variables,
    get input() {return context().native.input ?? '';},
    get firstDisplayedElement() {
        const id = context().native.firstDisplayedMessageId;
        if (id === undefined) throw new Error('firstDisplayedMessageId requires explicit nativeContext.firstDisplayedMessageId');
        return {getAttribute: () => String(id)};
    },
};
export const getContext = () => facade;
export const chat = new Proxy([], {get: (_target, key) => Reflect.get(context().history, key)});
export const chat_metadata = new Proxy({}, {
    get: (_target, key) => Reflect.get(context().metadata, key),
    set: (_target, key, value) => Reflect.set(context().metadata, key, value),
});
export const main_api = 'openai';
export const getCurrentChatId = () => context().native.chatId ?? '';
export const getMaxContextTokens = () => context().native.maxContext ?? 0;
export const getMaxResponseTokens = () => context().native.maxResponse ?? 0;
export const getMaxPromptTokens = () => getMaxContextTokens() - getMaxResponseTokens();
export const textgenerationwebui_banned_in_macros = [];
export const inject_ids = {CUSTOM_WI_OUTLET: name => name};
export const extension_prompts = new Proxy({}, {get: () => {throw new Error('outlet requires a world-info outlet binding');}});
export const power_user = {instruct: {enabled: false}};
export const isMobile = () => false;
export const formatInstructModeExamples = () => {throw new Error('Text Completion instruct mode is outside the Chat Completion compiler');};
/** Pinned public/script.js parseMesExamples, with the owning compiler's fixed OpenAI block heading. */
export function parseMesExamples(examplesStr) {
    if (!examplesStr || examplesStr.length === 0 || examplesStr === '<START>') return [];
    if (!examplesStr.startsWith('<START>')) examplesStr = '<START>\n' + examplesStr.trim();
    return examplesStr.split(/<START>/gi).slice(1).map(block => `<START>\n${block.trim()}\n`);
}

/** Entropy is captured once at compilation; deterministic pick still uses its exact upstream seed. */
export function seedrandom(seed, options) {
    return options?.entropy ? context().rng : actualSeedrandom(seed, options);
}
export const droll = {
    validate: actualDroll.validate,
    roll(formula) {
        const parsed = actualDroll.parse(formula);
        if (!parsed) return false;
        if (!Number.isSafeInteger(parsed.numDice) || parsed.numDice > 100_000) throw new Error('roll exceeds the supported dice count');
        // droll 0.2.1 has no RNG argument. Preserve its algorithm while using the compilation-owned RNG.
        const rolls = Array.from({length: parsed.numDice}, () => 1 + Math.floor(context().rng() * parsed.numSides));
        return {rolls, modifier: parsed.modifier, total: rolls.reduce((sum, roll) => sum + roll, parsed.modifier)};
    },
};
export function moment(...args) {
    const native = context().native;
    const input = args[0] === undefined ? [native.now] : args;
    const naive = typeof input[0] === 'string' && !/(?:Z|[+-]\d{2}:?\d{2}|(?:GMT|UTC)(?:[+-]\d{4})?)\s*$/i.test(input[0]);
    // A browser parses zone-less dates in its local zone. Use the frozen zone, independent of the server's TZ.
    const result = naive ? actualMoment.utc(...input) : actualMoment(...input);
    if (native.locale) result.locale(native.locale);
    if (native.utcOffsetMinutes !== undefined) result.utcOffset(native.utcOffsetMinutes, naive, true);
    return result;
}
moment.duration = (...args) => actualMoment.duration(...args).locale(context().native.locale ?? 'en');
export const timestampToMoment = value => moment(value);

// Exact pure helpers from public/scripts/utils.js at the pinned upstream revision.
export function isTrueBoolean(arg) {return ['on', 'true', '1'].includes(arg?.trim()?.toLowerCase());}
export function isFalseBoolean(arg) {return ['off', 'false', '0'].includes(arg?.trim()?.toLowerCase());}
export function getStringHash(str, seed = 0) {
    if (typeof str !== 'string') return 0;
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);}
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
