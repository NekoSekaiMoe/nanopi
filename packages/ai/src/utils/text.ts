import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import type { ImageContent, SystemMessage, TextContent, ThinkingContent, ToolCall } from "../types.ts";

type Content = TextContent | ImageContent | ThinkingContent | ToolCall;

/** Extract and join text from message content. */
export function contentText(content: string | readonly Content[], separator = "\n"): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join(separator);
}

/** Render a system message as a complete prompt: its content followed by its sections. */
export function getSystemMessageText(message: SystemMessage): string {
	const parts = [contentText(message.content)];
	for (const text of Object.values(message.sections ?? {})) {
		if (text !== null) parts.push(text);
	}
	return parts.filter((part) => part.length > 0).join("\n\n");
}

/**
 * Render a later system message for APIs that accept system messages mid-conversation.
 * Section changes are framed by name so the model can relate them to the leading prompt.
 * This framing is request-time only and may change between versions.
 */
export function renderSystemMessageUpdate(message: SystemMessage): string {
	const parts: string[] = [];
	const text = contentText(message.content);
	if (text.length > 0) parts.push(text);
	for (const [name, value] of Object.entries(message.sections ?? {})) {
		parts.push(
			value === null
				? `Removed system prompt section "${name}".`
				: `Updated system prompt section "${name}":\n\n${value}`,
		);
	}
	return parts.join("\n\n");
}

/**
 * Local token counting for context sizing.
 *
 * A chars/constant heuristic undercounts code, JSON tool arguments and CJK text
 * by up to ~3x, so compaction fires late after switching to a denser tokenizer.
 * o200k_base counts every provider's text closely and is used only for sizing:
 * a provider's reported usage still wins for the settled prefix. The import is
 * top-level (not deferred) because every estimate path needs it.
 */
/** Above this length a text is counted without entering the cache. */
const MAX_CACHED_LENGTH = 16 * 1024;
/** Bounded so growing streamed text cannot evict the reusable short fragments. */
const MAX_CACHE_ENTRIES = 512;

const cache = new Map<string, number>();

/** Count tokens in one text with o200k_base, memoizing short repeated strings. */
export function countTextTokens(text: string): number {
	if (text.length === 0) return 0;
	if (text.length > MAX_CACHED_LENGTH) return countTokens(text);
	const cached = cache.get(text);
	if (cached !== undefined) return cached;
	const tokens = countTokens(text);
	if (cache.size >= MAX_CACHE_ENTRIES) {
		// Map iterates in insertion order; dropping the oldest entry keeps the
		// recently used fragments and bounds memory for session-long chats.
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(text, tokens);
	return tokens;
}

/** Sum of {@link countTextTokens} over fragments, counted independently. */
export function countTokenFragments(fragments: readonly string[]): number {
	let total = 0;
	for (const fragment of fragments) total += countTextTokens(fragment);
	return total;
}
