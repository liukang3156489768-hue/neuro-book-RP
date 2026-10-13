/** ST variable semantics without browser persistence; the compilation receipt owns the commit boundary. */
export function createTavernVariableOperations(values: Record<string, string>, readonly = false) {
    const read = (name: string) => Object.hasOwn(values, name) ? values[name] : undefined;
    const write = (name: string, value: unknown) => {
        if (!name) throw new Error("酒馆变量名不能为空");
        Object.defineProperty(values, name, {value: String(value), enumerable: true, configurable: true, writable: true});
    };
    const get = (name: string, args: {index?: string} = {}): string | number => {
        let value: unknown = read(name);
        if (args.index !== undefined) {
            try {
                const parsed: unknown = JSON.parse(String(value));
                const key = Number.isNaN(Number(args.index)) ? args.index : String(Number(args.index));
                value = parsed !== null && typeof parsed === "object" && Object.hasOwn(parsed, key) ? Reflect.get(parsed, key) : undefined;
                if (typeof value === "object") value = JSON.stringify(value);
            } catch { /* ST leaves a non-JSON value unchanged when indexed access fails. */ }
        }
        return (typeof value === "string" && value.trim() === "") || Number.isNaN(Number(value)) ? String(value || "") : Number(value);
    };
    const set = (name: string, value: string | number, args: {index?: string} = {}) => {
        if (!name) throw new Error("酒馆变量名不能为空");
        if (readonly) return get(name, args);
        if (args.index === undefined) write(name, value);
        else {
            try {
                const numeric = Number(args.index);
                const parsed: unknown = JSON.parse(read(name) ?? "null");
                const target: unknown = parsed ?? (Number.isNaN(numeric) ? {} : []);
                if (target && typeof target === "object") {
                    const key = Number.isNaN(numeric) ? args.index : String(numeric);
                    // Keep own keys such as __proto__ as data rather than invoking prototype setters.
                    Object.defineProperty(target, key, {value, enumerable: true, configurable: true, writable: true});
                    write(name, JSON.stringify(target));
                }
            } catch { /* Upstream ignores invalid indexed assignments. */ }
        }
        return value;
    };
    const add = (name: string, value: string | number): string | number | unknown[] => {
        if (readonly) return get(name);
        const current = get(name) || 0;
        try {
            const parsed: unknown = JSON.parse(String(current));
            if (Array.isArray(parsed)) {parsed.push(value); write(name, JSON.stringify(parsed)); return parsed;}
        } catch { /* Numeric addition or string append is the upstream fallback. */ }
        const increment = Number(value);
        const result = Number.isNaN(increment) || Number.isNaN(Number(current)) ? String(current || "") + value : Number(current) + increment;
        if (typeof result === "number" && Number.isNaN(result)) return "";
        write(name, result);
        return result;
    };
    return {get, set, add, inc: (name: string) => add(name, 1), dec: (name: string) => add(name, -1),
        has: (name: string) => Object.hasOwn(values, name), del: (name: string) => {if (!readonly) delete values[name];}};
}
