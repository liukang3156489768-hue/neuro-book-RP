// SillyTavern 06bde939fb1e9c4c8d8641d810f0a916b5bce127, AGPL-3.0-or-later.
// Original legacy evaluator/helpers and variable macro table; provenance is recorded alongside the native engine.
import {randomUUID as uuidv4} from 'node:crypto';
import {chat, chat_metadata, main_api, getContext, getMaxPromptTokens, getMaxContextTokens, getMaxResponseTokens,
    getCurrentChatId, extension_prompts, inject_ids, textgenerationwebui_banned_in_macros, seedrandom, droll,
    moment, timestampToMoment, getStringHash, createNativeContext, withNativeContext, parseMesExamples} from './tavern-native/host.mjs';

let failures = [];
const console = {debug() {}, log() {}, warn(_message, error) {failures.push(error instanceof Error ? error.message : String(error));}};
const document = {querySelector: () => getContext().firstDisplayedElement};
const $ = () => ({val: () => getContext().input});
const isDigitsOnly = value => /^\d+$/.test(value);
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const getInstructMacros = () => [];
const MacrosParser = {populateEnv() {}, sanitizeMacroValue: value => value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)};
const operations = scope => getContext().variables[scope];
const setLocalVariable = (key, value) => operations('local').set(key, value);
const addLocalVariable = (key, value) => operations('local').add(key, value);
const incrementLocalVariable = key => operations('local').inc(key);
const decrementLocalVariable = key => operations('local').dec(key);
const getLocalVariable = key => operations('local').get(key);
const setGlobalVariable = (key, value) => operations('global').set(key, value);
const addGlobalVariable = (key, value) => operations('global').add(key, value);
const incrementGlobalVariable = key => operations('global').inc(key);
const decrementGlobalVariable = key => operations('global').dec(key);
const getGlobalVariable = key => operations('global').get(key);

function getChatIdHash() {
    const cachedIdHash = chat_metadata.chat_id_hash;

    // If chat_id_hash is not already set, calculate it
    if (!cachedIdHash) {
        // Use the main_chat if it's available, otherwise get the current chat ID
        const chatId = chat_metadata.main_chat ?? getCurrentChatId();
        const chatIdHash = getStringHash(chatId);
        chat_metadata.chat_id_hash = chatIdHash;
        return chatIdHash;
    }

    return cachedIdHash;
}

/**
 * Returns the ID of the last message in the chat
 *
 * Optionally can only choose specific messages, if a filter is provided.
 *
 * @param {object} param0 - Optional arguments
 * @param {boolean} [param0.exclude_swipe_in_propress=true] - Whether a message that is currently being swiped should be ignored
 * @param {function(object):boolean} [param0.filter] - A filter applied to the search, ignoring all messages that don't match the criteria. For example to only find user messages, etc.
 * @returns {number|null} The message id, or null if none was found
 */
export function getLastMessageId({ exclude_swipe_in_propress = true, filter = null } = {}) {
    for (let i = chat?.length - 1; i >= 0; i--) {
        let message = chat[i];

        // If ignoring swipes and the message is being swiped, continue
        // We can check if a message is being swiped by checking whether the current swipe id is not in the list of finished swipes yet
        if (exclude_swipe_in_propress && message.swipes && message.swipe_id >= message.swipes.length) {
            continue;
        }

        // Check if no filter is provided, or if the message passes the filter
        if (!filter || filter(message)) {
            return i;
        }
    }

    return null;
}

/**
 * Returns the ID of the first message included in the context
 *
 * @returns {number|null} The ID of the first message in the context
 */
function getFirstIncludedMessageId() {
    return chat_metadata.lastInContextMessageId;
}

/**
 * Returns the ID of the first displayed message in the chat.
 *
 * @returns {number|null} The ID of the first displayed message
 */
function getFirstDisplayedMessageId() {
    const mesId = Number(document.querySelector('#chat .mes')?.getAttribute('mesid'));

    if (!isNaN(mesId) && mesId >= 0) {
        return mesId;
    }

    return null;
}

/**
 * Returns the last message in the chat
 *
 * @returns {string} The last message in the chat
 */
function getLastMessage() {
    const mid = getLastMessageId();
    return chat[mid]?.mes ?? '';
}

/**
 * Returns the last message from the user
 *
 * @returns {string} The last message from the user
 */
function getLastUserMessage() {
    const mid = getLastMessageId({ filter: m => m.is_user && !m.is_system });
    return chat[mid]?.mes ?? '';
}

/**
 * Returns the last message from the bot
 *
 * @returns {string} The last message from the bot
 */
function getLastCharMessage() {
    const mid = getLastMessageId({ filter: m => !m.is_user && !m.is_system });
    return chat[mid]?.mes ?? '';
}

/**
 * Returns the 1-based ID (number) of the last swipe
 *
 * @returns {number|null} The 1-based ID of the last swipe
 */
function getLastSwipeId() {
    // For swipe macro, we are accepting using the message that is currently being swiped
    const mid = getLastMessageId({ exclude_swipe_in_propress: false });
    const swipes = chat[mid]?.swipes;
    return swipes?.length;
}

/**
 * Returns the 1-based ID (number) of the current swipe
 *
 * @returns {number|null} The 1-based ID of the current swipe
 */
function getCurrentSwipeId() {
    // For swipe macro, we are accepting using the message that is currently being swiped
    const mid = getLastMessageId({ exclude_swipe_in_propress: false });
    const swipeId = chat[mid]?.swipe_id;
    return swipeId !== null ? swipeId + 1 : null;
}

/**
 * Replaces banned words in macros with an empty string.
 * Adds them to textgenerationwebui ban list.
 * @returns {Macro}
 */
function getBannedWordsMacro() {
    const banPattern = /{{banned "(.*)"}}/gi;
    const banReplace = (match, bannedWord) => {
        if (main_api == 'textgenerationwebui') {
            console.log('Found banned word in macros: ' + bannedWord);
            textgenerationwebui_banned_in_macros.push(bannedWord);
        }
        return '';
    };

    return { regex: banPattern, replace: banReplace };
}

function getTimeSinceLastMessage() {
    const now = moment();

    if (Array.isArray(chat) && chat.length > 0) {
        let lastMessage;
        let takeNext = false;

        for (let i = chat.length - 1; i >= 0; i--) {
            const message = chat[i];

            if (message.is_system) {
                continue;
            }

            if (message.is_user && takeNext) {
                lastMessage = message;
                break;
            }

            takeNext = true;
        }

        if (lastMessage?.send_date) {
            const lastMessageDate = timestampToMoment(lastMessage.send_date);
            const duration = moment.duration(now.diff(lastMessageDate));
            return duration.humanize();
        }
    }

    return 'just now';
}

/**
 * Returns a macro that picks a random item from a list.
 * @returns {Macro} The random replace macro
 */
function getRandomReplaceMacro() {
    const randomPattern = /{{random\s?::?([^}]+)}}/gi;
    const randomReplace = (match, listString) => {
        // Split on either double colons or comma. If comma is the separator, we are also trimming all items.
        const list = listString.includes('::')
            ? listString.split('::')
            // Replaced escaped commas with a placeholder to avoid splitting on them
            : listString.replace(/\\,/g, '##�COMMA�##').split(',').map(item => item.trim().replace(/##�COMMA�##/g, ','));

        if (list.length === 0) {
            return '';
        }
        const rng = seedrandom('added entropy.', { entropy: true });
        const randomIndex = Math.floor(rng() * list.length);
        return list[randomIndex];
    };

    return { regex: randomPattern, replace: randomReplace };
}

/**
 * Returns a macro that picks a random item from a list with a consistent seed.
 * @param {string} rawContent The raw content of the string
 * @returns {Macro} The pick replace macro
 */
function getPickReplaceMacro(rawContent) {
    // We need to have a consistent chat hash, otherwise we'll lose rolls on chat file rename or branch switches
    // No need to save metadata here - branching and renaming will implicitly do the save for us, and until then loading it like this is consistent
    const chatIdHash = getChatIdHash();
    const rawContentHash = getStringHash(rawContent);

    const pickPattern = /{{pick\s?::?([^}]+)}}/gi;
    const pickReplace = (match, listString, offset) => {
        // Split on either double colons or comma. If comma is the separator, we are also trimming all items.
        const list = listString.includes('::')
            ? listString.split('::')
            // Replaced escaped commas with a placeholder to avoid splitting on them
            : listString.replace(/\\,/g, '##�COMMA�##').split(',').map(item => item.trim().replace(/##�COMMA�##/g, ','));

        if (list.length === 0) {
            return '';
        }

        // We build a hash seed based on: unique chat file, raw content, and the placement inside this content
        // This allows us to get unique but repeatable picks in nearly all cases
        const combinedSeedString = `${chatIdHash}-${rawContentHash}-${offset}`;
        const finalSeed = getStringHash(combinedSeedString);
        // @ts-ignore - have to use numbers for legacy picks
        const rng = seedrandom(finalSeed);
        const randomIndex = Math.floor(rng() * list.length);
        return list[randomIndex];
    };

    return { regex: pickPattern, replace: pickReplace };
}

/**
 * @returns {Macro} The dire roll macro
 */
function getDiceRollMacro() {
    const rollPattern = /{{roll[ : ]([^}]+)}}/gi;
    const rollReplace = (match, matchValue) => {
        let formula = matchValue.trim();

        if (isDigitsOnly(formula)) {
            formula = `1d${formula}`;
        }

        const isValid = droll.validate(formula);

        if (!isValid) {
            console.debug(`Invalid roll formula: ${formula}`);
            return '';
        }

        const result = droll.roll(formula);
        if (result === false) return '';
        return String(result.total);
    };

    return { regex: rollPattern, replace: rollReplace };
}

/**
 * Returns the difference between two times. Works with any time format acceptable by moment().
 * Can work with {{date}} {{time}} macros
 * @returns {Macro} The time difference macro
 */
function getTimeDiffMacro() {
    const timeDiffPattern = /{{timeDiff::(.*?)::(.*?)}}/gi;
    const timeDiffReplace = (_match, matchPart1, matchPart2) => {
        const time1 = moment(matchPart1);
        const time2 = moment(matchPart2);

        const timeDifference = moment.duration(time1.diff(time2));
        return timeDifference.humanize(true);
    };

    return { regex: timeDiffPattern, replace: timeDiffReplace };
}

/**
 * Returns the outlet prompt for a given outlet key.
 * @param {string} key - The outlet key
 * @returns {string} The outlet prompt
 */
function getOutletPrompt(key) {
    const value = extension_prompts[inject_ids.CUSTOM_WI_OUTLET(key)]?.value;
    return value || '';
}

/**
 * Substitutes {{macro}} parameters in a string.
 * @param {string} content - The string to substitute parameters in.
 * @param {EnvObject} env - Map of macro names to the values they'll be substituted with. If the param
 * values are functions, those functions will be called and their return values are used.
 * @param {function(string): string} postProcessFn - Function to run on the macro value before replacing it.
 * @returns {string} The string with substituted parameters.
 */
export function evaluateMacros(content, env, postProcessFn) {
    if (!content) {
        return '';
    }

    postProcessFn = typeof postProcessFn === 'function' ? postProcessFn : (x => x);
    const rawContent = content;

    /**
     * Built-ins running before the env variables
     * @type {Macro[]}
     * */
    const preEnvMacros = [
        // Legacy non-curly macros
        { regex: /<USER>/gi, replace: () => typeof env.user === 'function' ? env.user() : env.user },
        { regex: /<BOT>/gi, replace: () => typeof env.char === 'function' ? env.char() : env.char },
        { regex: /<CHAR>/gi, replace: () => typeof env.char === 'function' ? env.char() : env.char },
        { regex: /<CHARIFNOTGROUP>/gi, replace: () => typeof env.group === 'function' ? env.group() : env.group },
        { regex: /<GROUP>/gi, replace: () => typeof env.group === 'function' ? env.group() : env.group },
        getDiceRollMacro(),
        ...getInstructMacros(env),
        ...getVariableMacros(),
        { regex: /{{newline}}/gi, replace: () => '\n' },
        { regex: /(?:\r?\n)*{{trim}}(?:\r?\n)*/gi, replace: () => '' },
        { regex: /{{noop}}/gi, replace: () => '' },
        { regex: /{{input}}/gi, replace: () => String($('#send_textarea').val()) },
    ];

    /**
     * Built-ins running after the env variables
     * @type {Macro[]}
    */
    const postEnvMacros = [
        { regex: /{{maxPrompt}}/gi, replace: () => String(getMaxPromptTokens()) },
        { regex: /{{maxPromptTokens}}/gi, replace: () => String(getMaxPromptTokens()) },
        { regex: /{{maxContext}}/gi, replace: () => String(getMaxContextTokens()) },
        { regex: /{{maxContextTokens}}/gi, replace: () => String(getMaxContextTokens()) },
        { regex: /{{maxResponse}}/gi, replace: () => String(getMaxResponseTokens()) },
        { regex: /{{maxResponseTokens}}/gi, replace: () => String(getMaxResponseTokens()) },
        { regex: /{{lastMessage}}/gi, replace: () => getLastMessage() },
        { regex: /{{lastMessageId}}/gi, replace: () => String(getLastMessageId() ?? '') },
        { regex: /{{lastUserMessage}}/gi, replace: () => getLastUserMessage() },
        { regex: /{{lastCharMessage}}/gi, replace: () => getLastCharMessage() },
        { regex: /{{firstIncludedMessageId}}/gi, replace: () => String(getFirstIncludedMessageId() ?? '') },
        { regex: /{{firstDisplayedMessageId}}/gi, replace: () => String(getFirstDisplayedMessageId() ?? '') },
        { regex: /{{lastSwipeId}}/gi, replace: () => String(getLastSwipeId() ?? '') },
        { regex: /{{currentSwipeId}}/gi, replace: () => String(getCurrentSwipeId() ?? '') },
        { regex: /{{allChatRange}}/gi, replace: () => chat.length === 0 ? '' : `0-${chat.length - 1}` },
        { regex: /{{reverse:(.+?)}}/gi, replace: (_, str) => Array.from(str).reverse().join('') },
        { regex: /\{\{\/\/([\s\S]*?)\}\}/gm, replace: () => '' },
        { regex: /{{time}}/gi, replace: () => moment().format('LT') },
        { regex: /{{date}}/gi, replace: () => moment().format('LL') },
        { regex: /{{weekday}}/gi, replace: () => moment().format('dddd') },
        { regex: /{{isotime}}/gi, replace: () => moment().format('HH:mm') },
        { regex: /{{isodate}}/gi, replace: () => moment().format('YYYY-MM-DD') },
        { regex: /{{datetimeformat +([^}]*)}}/gi, replace: (_, format) => moment().format(format) },
        { regex: /{{idle_duration}}/gi, replace: () => getTimeSinceLastMessage() },
        { regex: /{{time_UTC([-+]\d+)}}/gi, replace: (_, offset) => moment().utc().utcOffset(parseInt(offset, 10)).format('LT') },
        { regex: /{{outlet::(.+?)}}/gi, replace: (_, key) => getOutletPrompt(key.trim()) || '' },
        getTimeDiffMacro(),
        getBannedWordsMacro(),
        getRandomReplaceMacro(),
        getPickReplaceMacro(rawContent),
    ];

    // Add all registered macros to the env object
    MacrosParser.populateEnv(env);
    const nonce = uuidv4();
    const envMacros = [];

    // Substitute passed-in variables
    for (const varName in env) {
        if (!Object.hasOwn(env, varName)) continue;

        const envRegex = new RegExp(`{{${escapeRegex(varName)}}}`, 'gi');
        const envReplace = () => {
            const param = env[varName];
            const value = MacrosParser.sanitizeMacroValue(typeof param === 'function' ? param(nonce) : param);
            return value;
        };

        envMacros.push({ regex: envRegex, replace: envReplace });
    }

    const macros = [...preEnvMacros, ...envMacros, ...postEnvMacros];

    for (const macro of macros) {
        // Stop if the content is empty
        if (!content) {
            break;
        }

        // Short-circuit if no curly braces are found
        if (!macro.regex.source.startsWith('<') && !content.includes('{{')) {
            break;
        }

        try {
            content = content.replace(macro.regex, (...args) => postProcessFn(macro.replace(...args)));
        } catch (e) {
            console.warn(`Macro content can't be replaced: ${macro.regex} in ${content}`, e);
        }
    }

    return content;
}
export function getVariableMacros() {
    return [
        // Replace {{setvar::name::value}} with empty string and set the variable name to value
        { regex: /{{setvar::([^:]+)::([^}]*)}}/gi, replace: (_, name, value) => { setLocalVariable(name.trim(), value); return ''; } },
        // Replace {{addvar::name::value}} with empty string and add value to the variable value
        { regex: /{{addvar::([^:]+)::([^}]+)}}/gi, replace: (_, name, value) => { addLocalVariable(name.trim(), value); return ''; } },
        // Replace {{incvar::name}} with empty string and increment the variable name by 1
        { regex: /{{incvar::([^}]+)}}/gi, replace: (_, name) => incrementLocalVariable(name.trim()) },
        // Replace {{decvar::name}} with empty string and decrement the variable name by 1
        { regex: /{{decvar::([^}]+)}}/gi, replace: (_, name) => decrementLocalVariable(name.trim()) },
        // Replace {{getvar::name}} with the value of the variable name
        { regex: /{{getvar::([^}]+)}}/gi, replace: (_, name) => getLocalVariable(name.trim()) },
        // Replace {{setglobalvar::name::value}} with empty string and set the global variable name to value
        { regex: /{{setglobalvar::([^:]+)::([^}]*)}}/gi, replace: (_, name, value) => { setGlobalVariable(name.trim(), value); return ''; } },
        // Replace {{addglobalvar::name::value}} with empty string and add value to the global variable value
        { regex: /{{addglobalvar::([^:]+)::([^}]+)}}/gi, replace: (_, name, value) => { addGlobalVariable(name.trim(), value); return ''; } },
        // Replace {{incglobalvar::name}} with empty string and increment the global variable name by 1
        { regex: /{{incglobalvar::([^}]+)}}/gi, replace: (_, name) => incrementGlobalVariable(name.trim()) },
        // Replace {{decglobalvar::name}} with empty string and decrement the global variable name by 1
        { regex: /{{decglobalvar::([^}]+)}}/gi, replace: (_, name) => decrementGlobalVariable(name.trim()) },
        // Replace {{getglobalvar::name}} with the value of the global variable name
        { regex: /{{getglobalvar::([^}]+)}}/gi, replace: (_, name) => getGlobalVariable(name.trim()) },
    ];
}

export const legacyMacroNames = Object.freeze([
    'user', 'char', 'group', 'groupnotmuted', 'notchar', 'persona', 'scenario', 'personality', 'description', 'chardescription',
    'charprompt', 'charinstruction', 'mesexamplesraw', 'mesexamples', 'chardepthprompt', 'creatornotes', 'version', 'firstmessage',
    'model', 'original', 'lastgenerationtype', 'ismobile', 'newline', 'trim', 'noop', 'input',
    'setvar', 'addvar', 'incvar', 'decvar', 'getvar', 'setglobalvar', 'addglobalvar', 'incglobalvar', 'decglobalvar', 'getglobalvar',
    'maxprompt', 'maxprompttokens', 'maxcontext', 'maxcontexttokens', 'maxresponse', 'maxresponsetokens',
    'lastmessage', 'lastmessageid', 'lastusermessage', 'lastcharmessage', 'firstincludedmessageid', 'firstdisplayedmessageid',
    'lastswipeid', 'currentswipeid', 'allchatrange', 'reverse', 'time', 'date', 'weekday', 'isotime', 'isodate',
    'datetimeformat', 'idle_duration', 'time_utc', 'outlet', 'timediff', 'banned', 'random', 'pick', 'roll',
]);

export function createLegacyMacroEvaluator(input) {
    const context = createNativeContext(input);
    const {names, character, system, functions, extra} = input.environment;
    const env = {...character, user: names.user, char: names.char, group: names.group, groupNotMuted: names.groupNotMuted,
        notChar: names.notChar, charDescription: character.description ?? '', model: system.model, original: functions.original,
        mesExamples: () => parseMesExamples(character.mesExamplesRaw ?? '').join(''),
        lastGenerationType: extra.lastGenerationType, isMobile: 'false'};
    return (text, postProcess) => withNativeContext(context, () => {
        const previous = failures;
        failures = [];
        try {
            const value = evaluateMacros(text, {...env}, postProcess);
            if (failures.length) throw new Error('酒馆旧宏缺少宿主能力：' + failures.join('; '));
            return value;
        } finally {failures = previous;}
    });
}

