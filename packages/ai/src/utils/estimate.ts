import type { AssistantMessage, ImageContent, Message, TextContent, TranscriptContext, Usage } from "../types.ts";
import { countTextTokens, countTokenFragments, getSystemMessageText } from "./text.ts";

export interface ContextUsageEstimate {
	/** Estimated total context tokens. */
	tokens: number;
	/** Tokens reported by the most recent applicable assistant usage block. */
	usageTokens: number;
	/** Estimated tokens after the most recent applicable assistant usage block. */
	trailingTokens: number;
	/** Index of the applicable message that provided usage, or null when none exists. */
	lastUsageIndex: number | null;
}

/** Images have no local tokenizer; keep the historical fixed charge. */
const ESTIMATED_IMAGE_TOKENS = 1200;

/**
 * Safety margin for sizing a request against the context window.
 *
 * o200k_base counts every provider's text closely, but providers may charge
 * framing tokens (role markers, tool schemas, reasoning replay) that a local
 * count of message bodies does not see. The margin absorbs that framing. It is
 * no longer compensating for a chars/constant underestimate.
 */
const INPUT_HEADROOM = 1.15;

export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

/** Count text blocks plus a fixed charge for image blocks. */
export function estimateTextAndImageContentTokens(content: string | Array<TextContent | ImageContent>): number {
	if (typeof content === "string") return countTextTokens(content);
	let tokens = 0;
	const texts: string[] = [];
	for (const block of content) {
		if (block.type === "text") texts.push(block.text);
		else tokens += ESTIMATED_IMAGE_TOKENS;
	}
	return tokens + countTokenFragments(texts);
}

export function estimateTextTokens(text: string): number {
	return countTextTokens(text);
}

export function estimateMessageTokens(message: Message): number {
	if (message.role === "system") {
		return (
			estimateTextTokens(getSystemMessageText(message)) +
			estimateToolsTokens(message.toolsAdded) +
			estimateToolsTokens(message.toolsRemoved)
		);
	}
	if (message.role === "user") return estimateTextAndImageContentTokens(message.content);
	if (message.role === "toolResult") return estimateTextAndImageContentTokens(message.content);

	const fragments: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			fragments.push(block.text);
		} else if (block.type === "thinking") {
			fragments.push(block.thinking);
			// thinkingSignature / redactedThinking are opaque provider payloads. The
			// request strips another model's signatures before replay, so counting
			// their local bytes would charge the reader for text it never sees.
		} else {
			fragments.push(block.name);
			fragments.push(safeJsonStringify(block.arguments));
		}
	}
	return countTokenFragments(fragments);
}

function getLastAssistantUsageInfo(messages: readonly Message[]): { usage: Usage; index: number } | undefined {
	let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
	let usageInfo: { usage: Usage; index: number } | undefined;

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "assistant") {
			const assistant = message as AssistantMessage;
			// A newer prefix message was inserted after this response (for example, a
			// compaction summary), so its usage cannot describe the current prefix.
			const usageAppliesToPrefix = assistant.timestamp >= latestPrefixTimestamp;
			if (
				usageAppliesToPrefix &&
				assistant.stopReason !== "aborted" &&
				assistant.stopReason !== "error" &&
				calculateContextTokens(assistant.usage) > 0
			) {
				usageInfo = { usage: assistant.usage, index: i };
			}
		}
		latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
	}

	return usageInfo;
}

/**
 * The estimate multiplied by {@link INPUT_HEADROOM}, for sizing a request against the
 * context window. Reporting callers keep the raw figure.
 */
export function estimateContextTokensForRequest(context: TranscriptContext | readonly Message[]): number {
	return Math.ceil(estimateContextTokens(context).tokens * INPUT_HEADROOM);
}

export function estimateContextTokens(context: TranscriptContext | readonly Message[]): ContextUsageEstimate {
	const messages = "messages" in context ? context.messages : context;
	const usageInfo = getLastAssistantUsageInfo(messages);
	if (usageInfo) {
		const usageTokens = calculateContextTokens(usageInfo.usage);
		let trailingTokens = 0;
		for (let i = usageInfo.index + 1; i < messages.length; i++) {
			trailingTokens += estimateMessageTokens(messages[i]);
		}
		return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: usageInfo.index };
	}

	let tokens = 0;
	for (const message of messages) tokens += estimateMessageTokens(message);
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

function estimateToolsTokens(tools: readonly unknown[] | undefined): number {
	if (!tools || tools.length === 0) return 0;
	return estimateTextTokens(safeJsonStringify(tools));
}
