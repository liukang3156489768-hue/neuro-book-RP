import {randomUUID} from "node:crypto";
import type {TavernBindings, TavernNativeContext, TavernWriterPreset} from "nbook/shared/dto/tavern-preset.dto";
import {createNativeMacroEvaluator, nativeMacroNames} from "./tavern-native/index.mjs";
import {createLegacyMacroEvaluator, legacyMacroNames} from "./tavern-legacy.mjs";
import {createTavernVariableOperations} from "./tavern-variable-operations";

export type TavernState = {local: Record<string, string>; global: Record<string, string>};
export type TavernMacroEvaluator = (text: string, postProcess?: (value: string) => string) => string;
export type MacroEnvironment = Pick<TavernBindings, "user" | "char"> & {
    persona?: string; scenario?: string; personality?: string; description?: string;
};
export const TAVERN_ENV_MACROS = ["user", "char", "persona", "scenario", "personality", "trim", "noop", "newline", "description", "charDescription"] as const;
export const supportedTavernMacroNames = (engine: TavernWriterPreset["macroEngine"] = "legacy") => new Set(engine === "native" ? nativeMacroNames : legacyMacroNames);

/** Legacy evaluates variable categories in passes, not left-to-right or recursively. */
export function expandTavernMacros(text: string, bindings: MacroEnvironment, state: TavernState): string {
    return createTavernMacroEvaluator({...bindings, slots: {}}, bindings, state, "legacy")(text);
}

export function resolveTavernNativeContext(bindings: TavernBindings): TavernNativeContext {
    const supplied = bindings.nativeContext;
    const now = supplied?.now ?? new Date().toISOString();
    return {...supplied, now, randomSeed: supplied?.randomSeed ?? randomUUID(), locale: supplied?.locale ?? "en",
        utcOffsetMinutes: supplied?.utcOffsetMinutes ?? -new Date(now).getTimezoneOffset()};
}

export function createTavernMacroEvaluator(bindings: TavernBindings, environment: MacroEnvironment, state: TavernState,
    engine: TavernWriterPreset["macroEngine"] = "legacy",
    readonly = false,
): TavernMacroEvaluator {
    const native = resolveTavernNativeContext(bindings);
    const input: Parameters<typeof createNativeMacroEvaluator>[0] = {native, variables: {local: createTavernVariableOperations(state.local, readonly), global: createTavernVariableOperations(state.global, readonly)},
        history: (bindings.slots.chatHistory ?? []).map(message => ({mes: message.content, is_user: message.role === "user", is_system: message.role === "system"})),
        environment: {
            names: {user: bindings.user, char: bindings.char, group: native.names?.group ?? bindings.char,
                groupNotMuted: native.names?.groupNotMuted ?? bindings.char, notChar: native.names?.notChar ?? bindings.user},
            character: {description: environment.description, persona: environment.persona, scenario: environment.scenario,
                personality: environment.personality, ...native.character},
            system: {model: native.model ?? ""}, functions: {original: () => native.original ?? "", postProcess: text => text},
            dynamicMacros: {}, extra: {lastGenerationType: native.lastGenerationType ?? bindings.generationType ?? "normal"},
        },
    };
    return engine === "legacy" ? createLegacyMacroEvaluator(input) : createNativeMacroEvaluator(input);
}
