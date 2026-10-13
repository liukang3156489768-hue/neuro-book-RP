import type {TavernNativeContext} from "nbook/shared/dto/tavern-preset.dto";
import type {createTavernVariableOperations} from "../tavern-variable-operations";

export const nativeMacroNames: readonly string[];
export function createNativeMacroEvaluator(input: {
    native: TavernNativeContext;
    variables: {local: ReturnType<typeof createTavernVariableOperations>; global: ReturnType<typeof createTavernVariableOperations>};
    history: {mes: string; is_user: boolean; is_system: boolean}[];
    environment: {
        names: {user: string; char: string; group: string; groupNotMuted: string; notChar: string};
        character: NonNullable<TavernNativeContext["character"]>;
        system: {model: string};
        functions: {original(): string; postProcess(text: string): string};
        dynamicMacros: Record<string, string>;
        extra: {lastGenerationType: string};
    };
}): (text: string, postProcess?: (value: string) => string) => string;
