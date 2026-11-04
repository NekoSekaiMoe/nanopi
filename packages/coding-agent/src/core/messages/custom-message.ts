/**
 * The `custom` message kind, which every module-owned message type shares.
 *
 * A module can narrow this by registering a codec for its own `customType`
 * (`registerMessageType({ kind: "custom", customType: "my-type", ... })`); the generic
 * projection below is the fallback so an unregistered custom type still reaches the
 * model as a user message instead of vanishing.
 */

import type { ImageContent, TextContent } from "@nanopi/pi-ai";
import type { Component } from "@nanopi/pi-tui";
import { CustomMessageComponent } from "../../modes/interactive/components/custom-message.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import type { MessageTypeCodec, MessageTypeCodecMap } from "./codec.ts";

/** Shape shared by every `custom` message, whatever its `customType`. */
export interface CustomMessageShape {
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: unknown;
	timestamp: number;
}

/** Signature of the per-`customType` renderer a module registers with `registerMessageRenderer`. */
export type CustomMessageRenderer<T = unknown> = (
	message: CustomMessageShape & { details?: T },
	options: { expanded: boolean; outputPad: number },
	theme: Theme,
) => Component | undefined;

export const genericCustomMessageCodec: MessageTypeCodec<CustomMessageShape> = {
	kind: "custom",
	toLlm(message) {
		const content: (TextContent | ImageContent)[] =
			typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
		return [{ role: "user", content, timestamp: message.timestamp }];
	},
	estimateTokens(message) {
		if (typeof message.content === "string") return Math.ceil(message.content.length / 4);
		let chars = 0;
		for (const block of message.content) {
			if (block.type === "text") chars += (block.text ?? "").length;
		}
		return Math.ceil(chars / 4);
	},
};

/**
 * Codec for one custom type. `renderer` is the per-type draw override a module
 * registered; without it the message draws through the generic custom-message frame.
 */
export function createCustomMessageCodecs(renderer?: CustomMessageRenderer): MessageTypeCodec<CustomMessageShape> {
	if (!renderer) return genericCustomMessageCodec;
	return {
		...genericCustomMessageCodec,
		renderRun: (message, options) => {
			const component = new CustomMessageComponent(
				message as never,
				renderer as never,
				getMarkdownTheme(),
				options.outputPad,
			);
			component.setExpanded(options.expanded);
			return component;
		},
	};
}

/** Every registered custom type plus the generic fallback. */
export function customMessageCodecMap(customTypes: Map<string, CustomMessageRenderer>): MessageTypeCodecMap {
	const codecs: MessageTypeCodecMap = new Map();
	for (const [customType, renderer] of customTypes) {
		codecs.set(customType, createCustomMessageCodecs(renderer) as MessageTypeCodec);
	}
	return codecs;
}
