import type {Message} from "@earendil-works/pi-ai";
import {createUserMessage, EMPTY_USAGE} from "nbook/server/agent/messages/message-utils";
import type {ManagedPromptMessages} from "nbook/shared/dto/prompt-management.dto";

/** Preloaded assistant examples carry no generated tokens and never count as real model usage. */
export function managedProviderMessages(messages: readonly ManagedPromptMessages["messages"][number][]): Message[] {
    return messages.map(message => message.role === "user" ? createUserMessage({text: message.content}, 0) : {
        role: "assistant", content: [{type: "text", text: message.content}],
        api: "openai-completions", provider: "prompt-preset", model: "preloaded-example",
        usage: EMPTY_USAGE, stopReason: "stop", timestamp: 0,
    });
}
