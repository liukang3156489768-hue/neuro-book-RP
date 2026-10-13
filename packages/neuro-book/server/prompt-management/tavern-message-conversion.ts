import type {TavernBindings, TavernMessage} from "nbook/shared/dto/tavern-preset.dto";

export type TavernPostProcessing = "none" | "" | "claude" | "merge" | "merge_tools" | "semi" | "semi_tools" | "strict" | "strict_tools" | "single";

function merge(messages: TavernMessage[]): TavernMessage[] {
    return messages.reduce<TavernMessage[]>((result, message) => {
        const previous = result.at(-1);
        if (previous?.role === message.role && message.content) previous.content += `\n\n${message.content}`;
        else result.push({...message});
        return result;
    }, []);
}

/** The tools variants are equivalent for this text-only contract; tool and media messages are rejected at the DTO boundary. */
export function postProcessTavernMessages(input: readonly TavernMessage[], identity: Pick<TavernBindings, "user" | "char">,
    mode: TavernPostProcessing): TavernMessage[] {
    if (mode === "none" || mode === "") return input.map(message => ({...message}));
    const single = mode === "single";
    const strict = single || mode === "semi" || mode === "semi_tools" || mode === "strict" || mode === "strict_tools";
    const placeholders = mode === "strict" || mode === "strict_tools";
    const named = input.map(message => {
        let content = message.content;
        const name = message.role === "system" ? message.name === "example_user" ? identity.user : message.name === "example_assistant" ? identity.char : "" : message.name;
        if (name && !content.startsWith(`${name}: `)) content = `${name}: ${content}`;
        if (single && message.role !== "system") {
            const speaker = message.role === "user" ? identity.user : identity.char;
            if (speaker && !content.startsWith(`${speaker}: `)) content = `${speaker}: ${content}`;
        }
        return {role: single ? "user" as const : message.role, content};
    });
    const merged = merge(named);
    const placeholder: TavernMessage = {role: "user", content: "Let's get started."};
    if (!merged.length) merged.push(placeholder);
    if (!strict) return merged;
    for (let index = 1; index < merged.length; index++) if (merged[index]!.role === "system") merged[index]!.role = "user";
    if (placeholders) {
        if (merged[0]!.role === "system" && merged[1]?.role !== "user") merged.splice(1, 0, placeholder);
        else if (merged[0]!.role !== "system" && merged[0]!.role !== "user") merged.unshift(placeholder);
    }
    return merge(merged);
}

export function strictTavernMessages(input: readonly TavernMessage[], identity: Pick<TavernBindings, "user" | "char">): TavernMessage[] {
    return postProcessTavernMessages(input, identity, "strict");
}

type IdentifiedMessage = {identifier: string; message: TavernMessage};
const SQUASH_EXCLUSIONS = new Set(["newMainChat", "newChat", "groupNudge"]);

/** ST's client squash runs before request post-processing and keeps chat boundary markers and named examples separate. */
export function squashTavernSystemMessages(input: readonly IdentifiedMessage[]): IdentifiedMessage[] {
    const output: IdentifiedMessage[] = [];
    const eligible = (entry: IdentifiedMessage) => entry.message.role === "system" && !entry.message.name && !SQUASH_EXCLUSIONS.has(entry.identifier);
    for (const entry of input) {
        if (entry.message.role === "system" && !entry.message.content) continue;
        const previous = output.at(-1);
        if (previous && eligible(previous) && eligible(entry)) previous.message.content += `\n${entry.message.content}`;
        else output.push({identifier: entry.identifier, message: {...entry.message}});
    }
    return output;
}
