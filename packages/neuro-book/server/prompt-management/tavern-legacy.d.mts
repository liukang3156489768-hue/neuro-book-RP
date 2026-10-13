import type {createNativeMacroEvaluator} from "./tavern-native/index.mjs";
export const legacyMacroNames: readonly string[];
export function createLegacyMacroEvaluator(input: Parameters<typeof createNativeMacroEvaluator>[0]): ReturnType<typeof createNativeMacroEvaluator>;
