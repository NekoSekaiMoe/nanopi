/**
 * Runtime registry for agent message types.
 *
 * `AgentMessage` is a compile-time union (see `CustomAgentMessages`), so a message type
 * added by a module cannot appear in it. The registry is the runtime counterpart: a
 * `kind` maps to the three functions the rest of the app needs from a message type —
 * project it for the LLM, measure it, draw it — and every consumer dispatches through
 * the same table instead of matching `role` on its own.
 *
 * `kind` is the message's `role` string. The built-in kinds are registered here; a module
 * adds its own through `registerMessageType()`.
 */

import type { AgentMessage } from "@nanopi/pi-agent-core";
import type { Message } from "@nanopi/pi-ai";
import type { Component } from "@nanopi/pi-tui";
import type { MessageRenderOptions } from "../modules/types.ts";

/** What a renderer gets besides the message. */
export interface MessageRunRenderOptions extends MessageRenderOptions {
	turn: number;
	/** Width available to the transcript, when the caller knows it. */
	availableWidth?: number;
}

export interface MessageTypeCodec<T = any> {
	/** Message `role` this codec handles, e.g. "bashExecution". */
	kind: string;
	/**
	 * Project one message into the LLM context. Return an empty array to keep it out
	 * of the request (UI-only messages), or one or more messages for the provider.
	 *
	 * Messages of this kind that reach the LLM are evaluated on every request, so this
	 * must be cheap and side-effect free.
	 */
	toLlm(message: T): Message[];

	/**
	 * Rough token estimate, used for compaction. Chars/4 is the convention; a codec that
	 * omits it is measured as 0, which keeps a cheap message from inflating the budget.
	 */
	estimateTokens?(message: T): number;

	/** Draw the message in the interactive transcript. Undefined falls back to `[kind]`. */
	renderRun?(message: T, options: MessageRunRenderOptions): Component | undefined;
}

export type MessageTypeCodecMap = Map<string, MessageTypeCodec>;

/** The role string of a runtime message, which is also its codec kind. */
export function messageKind(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const role = (message as { role?: unknown }).role;
	return typeof role === "string" ? role : undefined;
}

/**
 * Look up the codec for a message. Unknown kinds stay out of the LLM context: a message
 * type nobody registered has no defined projection, and guessing one would put arbitrary
 * module payloads in front of the model.
 */
/**
 * Resolve a message against a flat `kind -> codec` table. A `custom` message looks up its
 * `customType` first, so a table built by `MessageTypeRegistry.table()` picks the narrowed
 * codec and falls back to the generic `custom` entry.
 */
export function resolveMessageCodec(
	codecs: MessageTypeCodecMap,
	message: AgentMessage,
): MessageTypeCodec<AgentMessage> | undefined {
	const kind = messageKind(message);
	if (kind === undefined) return undefined;
	if (kind === "custom") {
		const customType = (message as { customType?: unknown }).customType;
		const specific = typeof customType === "string" ? codecs.get(customType) : undefined;
		if (specific) return specific as MessageTypeCodec<AgentMessage>;
	}
	return codecs.get(kind) as MessageTypeCodec<AgentMessage> | undefined;
}
