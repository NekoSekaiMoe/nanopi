/**
 * Session export to Markdown.
 *
 * The HTML export renders the session in the browser from the template's data
 * payload; a Markdown file has to be rendered up front, so this module keeps
 * its own reading of the entry list. It walks the branch the session points at
 * (not the whole tree, which is what the HTML sidebar is for) and writes one
 * section per entry, in order.
 *
 * Tool calls and results are kept: a transcript without the tool output hides
 * the half of the conversation that did the work.
 */

import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { APP_NAME } from "../../config.ts";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import type { ReadonlySessionManager, SessionEntry } from "../session-manager.ts";

export interface MarkdownExportOptions {
	outputPath?: string;
	/** Title of the exported document; defaults to the session id. */
	title?: string;
}

type ContentBlock = {
	type: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: unknown;
	data?: string;
	mimeType?: string;
};

/** A message as the session stores it, with the fields the exporter reads. */
type EntryMessage = ContentBlock & {
	role?: string;
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
	toolName?: string;
	isError?: boolean;
	command?: string;
	output?: string;
	exitCode?: number | undefined;
	cancelled?: boolean;
	display?: boolean;
	customType?: string;
	summary?: string;
};

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is ContentBlock => typeof block === "object" && block !== null && block.type === "text")
		.map((block) => block.text ?? "")
		.filter((text) => text.length > 0)
		.join("");
}

function imagesOf(content: unknown): ContentBlock[] {
	if (!Array.isArray(content)) return [];
	return content.filter(
		(block): block is ContentBlock =>
			typeof block === "object" && block !== null && block.type === "image" && typeof block.data === "string",
	);
}

/** A fenced block, with a fence long enough that the content cannot close it. */
function fenced(content: string, language = ""): string {
	let fence = "```";
	while (content.includes(fence)) fence += "`";
	return `${fence}${language}\n${content.replace(/\n+$/, "")}\n${fence}`;
}

function heading(level: number, text: string): string {
	return `${"#".repeat(level)} ${text}`;
}

function formatArguments(args: unknown): string {
	try {
		return JSON.stringify(args, null, 2) ?? "";
	} catch {
		return String(args);
	}
}

function timestampOf(entry: SessionEntry): string {
	const date = new Date(entry.timestamp);
	if (Number.isNaN(date.getTime())) return "";
	return date.toISOString();
}

function renderMessage(entry: SessionEntry & { type: "message" }): string[] {
	const message = entry.message as unknown as EntryMessage;
	const parts: string[] = [];
	switch (message.role) {
		case "user": {
			const text = textOf(message.content).trim();
			const images = imagesOf(message.content);
			const body: string[] = [];
			if (text) body.push(text);
			if (images.length > 0) {
				body.push(
					`_${images.length} image attachment${images.length === 1 ? "" : "s"} not included in Markdown export._`,
				);
			}
			if (body.length > 0) parts.push(heading(2, "User"), body.join("\n\n"));
			break;
		}
		case "assistant": {
			const blocks = Array.isArray(message.content) ? (message.content as ContentBlock[]) : [];
			const text = blocks
				.filter((block) => block.type === "text")
				.map((block) => block.text ?? "")
				.filter((value) => value.trim().length > 0)
				.join("\n\n");
			const thinking = blocks
				.filter((block) => block.type === "thinking")
				.map((block) => block.thinking ?? "")
				.filter((value) => value.trim().length > 0)
				.join("\n\n");
			const toolCalls = blocks.filter((block) => block.type === "toolCall");
			const body: string[] = [];
			if (thinking) body.push(fenced(thinking, "text"));
			if (text) body.push(text);
			for (const call of toolCalls) {
				body.push(
					`${heading(3, `Tool call: ${call.name ?? "unknown"}`)}\n\n${fenced(formatArguments(call.arguments), "json")}`,
				);
			}
			if (message.stopReason === "aborted") body.push("_Aborted._");
			else if (message.errorMessage) body.push(`_Error: ${String(message.errorMessage)}_`);
			if (body.length > 0) parts.push(heading(2, "Assistant"), body.join("\n\n"));
			break;
		}
		case "toolResult": {
			const text = textOf(message.content).trim();
			const failed = message.isError === true;
			const body: string[] = [];
			if (text) body.push(fenced(text));
			if (imagesOf(message.content).length > 0) body.push("_Image result not included in Markdown export._");
			if (body.length === 0) return [];
			parts.push(
				heading(3, `Tool result: ${String(message.toolName ?? "tool")}${failed ? " (error)" : ""}`),
				body.join("\n\n"),
			);
			break;
		}
		case "bashExecution": {
			const lines = [`$ ${String(message.command ?? "")}`];
			const output = String(message.output ?? "").replace(/\n+$/, "");
			if (output) lines.push(output);
			if (message.cancelled) lines.push("(cancelled)");
			else if (typeof message.exitCode === "number" && message.exitCode !== 0)
				lines.push(`(exit ${message.exitCode})`);
			parts.push(heading(2, "Bash"), fenced(lines.join("\n"), "sh"));
			break;
		}
		case "branchSummary": {
			const summary = String(message.summary ?? "").trim();
			if (summary) parts.push(heading(2, "Branch summary"), summary);
			break;
		}
		case "custom": {
			const text = textOf(message.content).trim();
			if (message.display !== false && text) parts.push(heading(2, String(message.customType ?? "message")), text);
			break;
		}
		default:
			return [];
	}
	if (parts.length === 0) return [];
	const stamp = timestampOf(entry);
	return stamp ? [...parts, `_${stamp}_`] : parts;
}

function renderEntry(entry: SessionEntry): string[] {
	switch (entry.type) {
		case "message":
			return renderMessage(entry as SessionEntry & { type: "message" });
		case "compaction": {
			return [
				heading(2, "Compaction"),
				`Compacted from ${entry.tokensBefore.toLocaleString("en-US")} tokens.`,
				"",
				entry.summary,
			];
		}
		case "branch_summary":
			return [heading(2, "Branch summary"), entry.summary];
		case "model_change":
			return [`_Switched to model: ${entry.provider}/${entry.modelId}_`];
		case "thinking_level_change":
			return [`_Thinking level: ${entry.thinkingLevel}_`];
		case "custom_message": {
			const text = textOf(entry.content).trim();
			return text ? [heading(2, `[${entry.customType}]`), text] : [];
		}
		default:
			return [];
	}
}

/** Render every entry of the session branch as Markdown. */
export function renderSessionMarkdown(sessionManager: ReadonlySessionManager, title?: string): string {
	const header = sessionManager.getHeader();
	const name = title ?? sessionManager.getSessionName() ?? header?.id ?? "session";
	const branch = sessionManager.getBranch();
	const lines: string[] = [heading(1, name), ""];
	const meta = [
		header?.timestamp ? `- Started: ${header.timestamp}` : undefined,
		header?.cwd ? `- Working directory: \`${header.cwd}\`` : undefined,
		`- Entries: ${branch.length}`,
		`- Exported with ${APP_NAME}`,
	].filter((line): line is string => line !== undefined);
	lines.push(...meta, "");
	for (const entry of branch) {
		const section = renderEntry(entry);
		if (section.length === 0) continue;
		lines.push(...section, "");
	}
	return `${lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd()}\n`;
}

/**
 * Write the session branch as Markdown. Without an output path the file lands
 * in the working directory, named after the session.
 */
export function exportSessionToMarkdown(
	sessionManager: ReadonlySessionManager,
	options?: MarkdownExportOptions | string,
): string {
	const opts: MarkdownExportOptions = typeof options === "string" ? { outputPath: options } : (options ?? {});
	const sessionFile = sessionManager.getSessionFile();
	const defaultName = sessionFile
		? `${APP_NAME}-session-${basename(sessionFile, ".jsonl")}.md`
		: `${APP_NAME}-session-${sessionManager.getSessionId()}.md`;
	const outputPath = opts.outputPath
		? normalizePath(resolvePath(opts.outputPath))
		: normalizePath(resolvePath(defaultName));
	if (sessionManager.getBranch().length === 0) {
		throw new Error("Nothing to export yet - start a conversation first");
	}
	writeFileSync(outputPath, renderSessionMarkdown(sessionManager, opts.title), "utf8");
	return outputPath;
}
