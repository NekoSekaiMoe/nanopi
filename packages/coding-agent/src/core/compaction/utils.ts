/**
 * Shared utilities for compaction and branch summarization.
 */

import type { AgentMessage } from "@nanopi/pi-agent-core";
import type { Message } from "@nanopi/pi-ai";
import { contentText } from "@nanopi/pi-ai/module-surface";

// ============================================================================
// File Operation Tracking
// ============================================================================

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/**
 * Extract file operations from tool calls in an assistant message, or from the nested calls
 * recorded on a tool result.
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role === "toolResult") {
		// Calls made from codemode scripts are recorded on the script's result.
		for (const call of message.nestedCalls?.calls ?? []) addFileOp(call.name, call.arguments, fileOps);
		return;
	}
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;
		addFileOp(block.name, block.arguments as Record<string, unknown> | undefined, fileOps);
	}
}

function addFileOp(toolName: string, args: Record<string, unknown> | undefined, fileOps: FileOperations): void {
	const path = typeof args?.path === "string" ? args.path : undefined;
	if (!path) return;
	switch (toolName) {
		case "read":
			fileOps.read.add(path);
			break;
		case "write":
			fileOps.written.add(path);
			break;
		case "edit":
			fileOps.edited.add(path);
			break;
	}
}

/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/**
 * Format file operations as XML tags for summary.
 */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

// ============================================================================
// Message Serialization
// ============================================================================

/** Maximum characters for a tool result in serialized summaries. */
const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * Truncate text to a maximum character length for summarization.
 * Keeps the beginning and appends a truncation marker.
 *
 * The cut is a UTF-16 index, so it can land inside a surrogate pair and leave
 * half a character; the summary is JSON-encoded, and a strict encoder rejects
 * a lone surrogate outright (#634).
 */
function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const truncatedChars = text.length - maxChars;
	return `${sliceWithoutLoneSurrogate(text, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

/**
 * `text` up to `maxChars`, minus a half surrogate pair at the cut.
 *
 * Inlined rather than imported from `@nanopi/pi-ai/utils/sanitize-unicode`: that
 * import is one more file on the `core/compaction/index.ts` entry graph, which
 * has an entry-point budget (`scripts/check-entry-graphs.mjs`).
 */
function sliceWithoutLoneSurrogate(text: string, maxChars: number): string {
	const cut = text.charCodeAt(maxChars - 1);
	const next = text.charCodeAt(maxChars);
	const splitsPair = cut >= 0xd800 && cut <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
	return text.slice(0, splitsPair ? maxChars - 1 : maxChars);
}

/**
 * Serialize LLM messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 * Call convertToLlm() first to handle custom message types.
 *
 * Tool results are truncated to keep the summarization request within
 * reasonable token budgets. Full content is not needed for summarization.
 *
 * Thinking is omitted. Providers return summaries of the real reasoning, and
 * replayed thinking is often not part of the model's live context: for example,
 * a block that does not match its request is dropped. Including it can make the
 * summarization request larger than the context it summarizes. Visible text,
 * tool calls, and tool results record what happened.
 */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			const content = contentText(msg.content, "");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				if (block.type === "toolCall") {
					const args = block.arguments as Record<string, unknown>;
					const argsStr = Object.entries(args)
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}

			if (msg.content.some((block) => block.type === "text")) {
				parts.push(`[Assistant]: ${contentText(msg.content)}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			const content = contentText(msg.content, "");
			if (content) {
				parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
			}
		}
	}

	return parts.join("\n\n");
}

// ============================================================================
// Summarization System Prompt
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Read a conversation between a user and an AI assistant and produce the structured summary the user prompt asks for.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.

Use these rules when choosing what the next model needs:

KEEP
- Exact file paths, line numbers, function and type signatures, commands, and error text.
- Decisions with their rationale, constraints, user preferences, and the user's original goal.
- Open tasks, blockers, and the next action, including unfinished work visible in tool calls.
- Every open objective in the summarized range: a user request that is unfinished and not superseded must keep its own line, even when this range made no progress on it. Do not drop a goal because this turn did not touch it.

DROP
- Logs whose conclusion is already recorded, repeated file reads or status checks, and tool results whose useful content is captured elsewhere.
- Back-and-forth discussion that ended in a decision already listed.
- Prompts, instructions, and boilerplate repeated across turns.

PRIORITY
- Prefer precise, current facts over broad narration. When two entries conflict, keep the later one and note the change.
- Keep enough detail to resume without re-reading the dropped material. Never invent facts that are not in the conversation.
- Reproduce user requests, decisions, and constraints verbatim. If you shorten or rephrase one, mark it as a paraphrase; never present a reconstructed phrase as the original wording.`;

// ============================================================================
// Recoverable references
// ============================================================================

/** Appended to every compaction summary prompt. */
export const SUMMARY_REF_INSTRUCTIONS = `## Recoverable references

The conversation above is serialized. Those entries are also stored in the session file, so the summary can point back at one instead of paraphrasing it away.

- After a line that records a fact a later model may need exactly (an error, a path plus line number, a decision and its why, a constraint, an unfinished item), add the entry tag it came from: \`[r1]\` or \`[r1][r2]\`.
- Number tags from \`[r1]\` in order of first appearance, from scratch. A previous summary's tags do not carry over.
- Directly below the summary, list what each tag holds:

<refs>
- [r1] <one line: what the entry contains and when to read it again>
</refs>

- When you cited nothing, write \`<refs>\` then \`(none)\` then \`</refs>\`. Never invent a tag.`;
