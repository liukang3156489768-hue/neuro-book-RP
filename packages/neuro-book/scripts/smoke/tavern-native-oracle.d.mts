import type {TavernBindings} from "nbook/shared/dto/tavern-preset.dto";
export function createNativeOracle(bindings: TavernBindings): Promise<{
    evaluate(text: string): string;
    state(): {local: Record<string, string>; global: Record<string, string>};
}>;
export const createLegacyOracle: typeof createNativeOracle;
export function runNativeOracle(bindings: TavernBindings, texts: string[]): Promise<Array<{text: string; state: {local: Record<string, string>; global: Record<string, string>}}>>;
