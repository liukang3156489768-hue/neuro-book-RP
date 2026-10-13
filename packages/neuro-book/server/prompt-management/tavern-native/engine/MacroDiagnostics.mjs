// Browser diagnostics adapter: preserve raw syntax/arity recovery, surface host failures without prompt content logs.
let diagnostics = [];
export const resetDiagnostics = () => {diagnostics = [];};
export const getDiagnostics = () => diagnostics;
export function createMacroRuntimeError({message, call, def, macroName}) {
    return Object.assign(new Error(message), {name: 'MacroRuntimeError', isMacroRuntimeError: true,
        macroName: macroName ?? def?.name ?? call?.name, macroRange: call?.range ?? null});
}
const record = (severity, options) => diagnostics.push({severity, name: options.macroName ?? options.def?.name ?? options.call?.name,
    message: options.message, detail: options.error instanceof Error ? options.error.message : undefined});
export const logMacroRuntimeWarning = options => record('warning', options);
export const logMacroInternalError = options => record('error', options);
export const logMacroRegisterWarning = options => record('warning', options);
export const logMacroRegisterError = options => {throw new Error(options.message, {cause: options.error});};
export const logMacroGeneralError = options => record('error', options);
export const logMacroSyntaxWarning = options => {if (options.errors?.length) record('syntax', {message: `${options.phase}: ${options.errors.map(error => error.message).join('; ')}`});};
