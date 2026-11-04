/**
 * One registry per session, shared by every consumer that has to understand a
 * message: `convertToLlm`, compaction's token estimate, and the interactive
 * transcript.
 *
 * `kinds` maps a message kind (its `role`) to a codec. `customTypes` narrows the
 * single `custom` kind per `customType`: a `custom` message whose type is not there
 * falls back to the generic projection in `custom-message.ts`.
 */

import type { AgentMessage } from "@nanopi/pi-agent-core";
import { createBuiltinMessageCodecs } from "./builtin-codecs.ts";
import { type MessageTypeCodec, type MessageTypeCodecMap, messageKind } from "./codec.ts";
import { type CustomMessageRenderer, customMessageCodecMap, genericCustomMessageCodec } from "./custom-message.ts";

const BUILTIN_KINDS = new Set(createBuiltinMessageCodecs().keys());

export class MessageTypeRegistry {
	readonly kinds: MessageTypeCodecMap;
	readonly customTypes: MessageTypeCodecMap = new Map();

	constructor() {
		this.kinds = createBuiltinMessageCodecs();
	}

	/**
	 * Register a codec. `customType` narrows the single `custom` kind for one custom
	 * message type instead of replacing the projection every custom message shares.
	 */
	register(codec: MessageTypeCodec, customType?: string): void {
		if (customType) {
			this.customTypes.set(customType, codec);
			return;
		}
		this.kinds.set(codec.kind, codec);
	}

	/** Drop a codec. Built-in kinds cannot be dropped: the app writes those messages itself. */
	unregister(kind: string): boolean {
		if (BUILTIN_KINDS.has(kind)) return false;
		return this.kinds.delete(kind);
	}

	/** Narrow the `custom` kind for one `customType`. */
	registerCustomType(customType: string, renderer?: CustomMessageRenderer): void {
		const codecs = customMessageCodecMap(new Map(renderer ? [[customType, renderer]] : []));
		this.customTypes.set(customType, codecs.get(customType) ?? genericCustomMessageCodec);
	}

	/** Codec for a message, resolving `custom` messages by their `customType`. */
	codecFor(message: AgentMessage): MessageTypeCodec<AgentMessage> | undefined {
		const kind = messageKind(message);
		if (kind === undefined) return undefined;
		if (kind === "custom") {
			const customType = (message as { customType?: unknown }).customType;
			const specific = typeof customType === "string" ? this.customTypes.get(customType) : undefined;
			if (specific) return specific as MessageTypeCodec<AgentMessage>;
		}
		return this.kinds.get(kind) as MessageTypeCodec<AgentMessage> | undefined;
	}

	/**
	 * Flat `kind -> codec` table for consumers that only need the projection, with the
	 * generic `custom` codec under `custom` and one entry per registered custom type.
	 */
	table(): MessageTypeCodecMap {
		const table: MessageTypeCodecMap = new Map(this.kinds);
		table.set("custom", genericCustomMessageCodec as MessageTypeCodec);
		for (const [customType, codec] of this.customTypes) table.set(customType, codec);
		return table;
	}

	/** Codec for a kind, for callers that dispatch on the role themselves. */
	codecForKind(kind: string): MessageTypeCodec<AgentMessage> | undefined {
		if (kind === "custom") return genericCustomMessageCodec as MessageTypeCodec<AgentMessage>;
		return this.kinds.get(kind) as MessageTypeCodec<AgentMessage> | undefined;
	}
}
