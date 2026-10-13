import {MacroEngine} from './engine/MacroEngine.mjs';
import {MacroRegistry} from './engine/MacroRegistry.mjs';
import {registerCoreMacros} from './definitions/core-macros.mjs';
import {registerVariableMacros} from './definitions/variable-macros.mjs';
import {registerEnvMacros} from './definitions/env-macros.mjs';
import {registerTimeMacros} from './definitions/time-macros.mjs';
import {registerChatMacros} from './definitions/chat-macros.mjs';
import {createNativeContext, withNativeContext, getStringHash} from './host.mjs';
import {getDiagnostics, resetDiagnostics} from './engine/MacroDiagnostics.mjs';

registerCoreMacros();
registerVariableMacros();
registerEnvMacros();
registerTimeMacros();
registerChatMacros();
MacroRegistry.registerMacro('lastGenerationType', {handler: ({env}) => env.extra.lastGenerationType ?? ''});
MacroRegistry.registerMacro('hasExtension', {unnamedArgs: [{name: 'extensionName', type: 'string'}], handler: () => 'false'});

export const nativeMacroNames = Object.freeze(MacroRegistry.getAllMacros().map(macro => macro.name.toLowerCase()));

export function createNativeMacroEvaluator(input) {
    const context = createNativeContext(input);
    return (text, postProcess = input.environment.functions.postProcess) => withNativeContext(context, () => {
        resetDiagnostics();
        const result = MacroEngine.evaluate(text, {...input.environment, functions: {...input.environment.functions, postProcess}, content: text, contentHash: getStringHash(text)});
        const failures = getDiagnostics().filter(item => item.severity === 'error');
        if (failures.length) throw new Error(`酒馆原生宏缺少宿主能力：${failures.map(item => `${item.name ?? 'macro'}: ${item.detail ?? item.message}`).join('; ')}`);
        return result;
    });
}
