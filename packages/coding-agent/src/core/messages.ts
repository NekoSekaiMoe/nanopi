/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import type { AgentMessage } from "@nanopi/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@nanopi/pi-ai";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for extension-injected messages via sendMessage().
 * These are custom messages that extensions can inject into the conversation.
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string | null;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
declare module "@nanopi/pi-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary: summary,
		tokensBefore,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

// ============================================================================
// Message codec registry
// ============================================================================

/**
 * What a message role contributes to the rest of the host: how it becomes LLM
 * context, how many tokens it costs, and where it can be cut.
 *
 * The role table used to be three hardcoded `switch (message.role)` statements
 * in three files. Adding a role meant finding all three, and a module that
 * invented its own role could not reach any of them. The codec registers one
 * place per role instead; `convertToLlm`, `estimateTokens`, and the compaction
 * cut points read this table.
 */
export interface MessageCodec<TMessage extends AgentMessage = AgentMessage> {
	/** Role this codec owns. One codec per role; registering again replaces. */
	readonly role: string;
	/** Whether the message enters LLM context. Absent leaves it in; false drops it. */
	include?(message: TMessage): boolean;
	/** LLM context form, or undefined when the message does not belong in a request. */
	toLlm?(message: TMessage): Message | undefined;
	/** Token estimate. Defaults to `estimateMessageTextChars(message) / 4`. */
	estimateTokens?(message: TMessage): number;
	/** Whether a compaction cut may start before this message. Defaults to the core rule for its role. */
	isCutPoint?(message: TMessage): boolean;
	/** Whether a compaction cut may start at this message as a turn boundary. */
	isTurnStart?(message: TMessage): boolean;
}

const codecs = new Map<string, MessageCodec>();

/** Register a message codec, replacing any codec already registered for that role. */
export function registerMessageCodec(codec: MessageCodec): void {
	codecs.set(codec.role, codec);
}

/** Remove the codec for a role. Built-in codecs can be replaced with `registerMessageCodec()`. */
export function unregisterMessageCodec(role: string): void {
	codecs.delete(role);
}

/** The codec for a role, or undefined when the role only has the core message shape. */
export function getMessageCodec(role: string): MessageCodec | undefined {
	return codecs.get(role);
}

/** Roles that have a codec, in registration order. */
export function getMessageCodecRoles(): string[] {
	return [...codecs.keys()];
}

/**
 * Rough character count of a message, used when a codec does not supply its own
 * estimate. Reads the optional `content`, `summary`, `command`, and `output`
 * fields loosely so that a module's message shape can still ride the default.
 */
const ESTIMATED_IMAGE_CHARS = 4800;

export function estimateMessageTextChars(message: AgentMessage): number {
	const shaped = message as { content?: unknown; summary?: unknown; command?: unknown; output?: unknown };
	let chars = 0;
	const content = shaped.content;
	if (typeof content === "string") {
		chars += content.length;
	} else if (Array.isArray(content)) {
		for (const block of content) {
			if (typeof block !== "object" || block === null) continue;
			const typed = block as { type?: string; text?: string; thinking?: string };
			if (typed.type === "text" && typeof typed.text === "string") chars += typed.text.length;
			else if (typed.type === "image") chars += ESTIMATED_IMAGE_CHARS;
			else if (typed.type === "thinking" && typeof typed.thinking === "string") chars += typed.thinking.length;
		}
	}
	if (typeof shaped.summary === "string") chars += shaped.summary.length;
	if (typeof shaped.command === "string") chars += shaped.command.length;
	if (typeof shaped.output === "string") chars += shaped.output.length;
	return chars;
}

/**
 * Token estimate for one message: the codec's own, or `fallback` for roles the
 * codec table does not own (`system`, `user`, `assistant`, `toolResult`).
 */
export function estimateMessageTokens(message: AgentMessage, fallback?: (message: AgentMessage) => number): number {
	const codec = codecs.get(message.role);
	if (codec?.estimateTokens) return codec.estimateTokens(message);
	if (fallback) return fallback(message);
	return Math.ceil(estimateMessageTextChars(message) / 4);
}

/** Whether a compaction cut may start before this message. Unknown roles cannot be cut. */
export function isCutPointMessageRole(
	message: AgentMessage,
	fallback: (message: AgentMessage) => boolean = () => false,
): boolean {
	const codec = codecs.get(message.role);
	if (codec?.isCutPoint) return codec.isCutPoint(message);
	return fallback(message);
}

/** Whether a compaction cut may start at this message as a turn boundary. */
export function isTurnStartMessageRole(
	message: AgentMessage,
	fallback: (message: AgentMessage) => boolean = () => false,
): boolean {
	const codec = codecs.get(message.role);
	if (codec?.isTurnStart) return codec.isTurnStart(message);
	return fallback(message);
}

/** Wrap text as a user message, the shape most custom roles convert to. */
export function toUserTextMessage(text: string, timestamp: number): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

const BUILTIN_CODECS: MessageCodec[] = [
	{
		role: "bashExecution",
		include: (message) => !(message as BashExecutionMessage).excludeFromContext,
		toLlm: (message) => {
			const bash = message as BashExecutionMessage;
			return toUserTextMessage(bashExecutionToText(bash), bash.timestamp);
		},
		estimateTokens: (message) => {
			const bash = message as BashExecutionMessage;
			return Math.ceil((bash.command.length + bash.output.length) / 4);
		},
		isCutPoint: () => true,
		isTurnStart: () => true,
	},
	{
		role: "custom",
		toLlm: (message) => {
			const custom = message as CustomMessage;
			const content =
				typeof custom.content === "string" ? [{ type: "text" as const, text: custom.content }] : custom.content;
			return { role: "user", content, timestamp: custom.timestamp };
		},
		estimateTokens: (message) =>
			Math.ceil(
				estimateMessageTextChars({ role: "custom", content: (message as CustomMessage).content } as AgentMessage) /
					4,
			),
		isCutPoint: () => true,
		isTurnStart: () => true,
	},
	{
		role: "branchSummary",
		toLlm: (message) => {
			const branch = message as BranchSummaryMessage;
			return toUserTextMessage(BRANCH_SUMMARY_PREFIX + branch.summary + BRANCH_SUMMARY_SUFFIX, branch.timestamp);
		},
		estimateTokens: (message) => Math.ceil((message as BranchSummaryMessage).summary.length / 4),
		isCutPoint: () => true,
		isTurnStart: () => true,
	},
	{
		role: "compactionSummary",
		toLlm: (message) => {
			const compaction = message as CompactionSummaryMessage;
			return toUserTextMessage(
				COMPACTION_SUMMARY_PREFIX + compaction.summary + COMPACTION_SUMMARY_SUFFIX,
				compaction.timestamp,
			);
		},
		estimateTokens: (message) => Math.ceil((message as CompactionSummaryMessage).summary.length / 4),
		isCutPoint: () => true,
		isTurnStart: () => true,
	},
];

for (const codec of BUILTIN_CODECS) registerMessageCodec(codec);

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 *
 * A role without a codec passes through unchanged: `system`, `user`,
 * `assistant`, and `toolResult` are already LLM messages, and an unknown role
 * is the host's business, not ours.
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	const converted: Message[] = [];
	for (const message of messages) {
		const codec = codecs.get(message.role);
		if (!codec) {
			converted.push(message as Message);
			continue;
		}
		if (codec.include && !codec.include(message)) continue;
		if (!codec.toLlm) {
			converted.push(message as Message);
			continue;
		}
		const llmMessage = codec.toLlm(message);
		if (llmMessage !== undefined) converted.push(llmMessage);
	}
	return converted;
}
