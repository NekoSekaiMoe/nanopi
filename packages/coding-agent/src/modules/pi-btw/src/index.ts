/**
 * pi-btw — `/btw <question>`: ask something beside the session instead of in it.
 *
 * The session transcript is the wrong place for a question that is about the
 * work rather than part of it ("why did we pick the git-ref snapshot?", "what
 * does this regex actually match?"). Answering it as a normal turn costs three
 * things at once: the question and the answer stay in the context forever, the
 * model may answer by running tools instead of by reading, and the next turn
 * inherits a detour it never asked for.
 *
 * So `/btw`:
 *
 * - reads the conversation once (user and assistant text; tool traffic is left
 *   out, since the side question is about the discussion, not the bytes),
 * - asks the model directly, with no tools and no follow-up turn,
 * - appends the answer as a `btw` custom message whose codec projects to
 *   nothing, so the transcript shows it and the next request does not carry it,
 * - keeps the side thread in memory, so a second `/btw` continues the first
 *   without any of it reaching the main context.
 *
 * The distinction that makes this worth a module: `subagent` isolates *work*
 * (a child session, its own tool loop, a report on disk). `/btw` isolates a
 * *question* — cheaper than a spawn, and unusable for anything that has to
 * change the tree, which is the point.
 */

import type { AgentMessage } from "@nanopi/pi-agent-core";
import { Markdown } from "@nanopi/pi-tui";
import type { ModuleApi, ModuleCommandContext } from "../../../core/modules/types.ts";
import { getMarkdownTheme } from "../../../modes/interactive/theme/theme.ts";

const COMMAND = "btw";
const MESSAGE_TYPE = "btw";
/** How much of the conversation travels with the question, in characters. */
const MAX_CONTEXT_CHARS = 24_000;
/** Cap per message so one long assistant turn cannot eat the whole budget. */
const MAX_MESSAGE_CHARS = 6_000;
/** A side thread is a few exchanges, not a second conversation. */
const MAX_SIDE_TURNS = 8;

const SYSTEM_PROMPT = `You answer a side question about the coding session shown below.

Rules:
- Answer from the conversation; you cannot run tools, read files, or change anything.
- Be brief and concrete. The user asked beside the main work, not instead of it.
- If the conversation does not say, say so in one line instead of guessing.
- Earlier questions in this side thread are yours to continue; they are not part of the session.`;

interface SideTurn {
	question: string;
	answer: string;
}

/** Text blocks of one message, joined; "" for a message carrying no text. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

/**
 * The conversation tail as plain text, newest kept when the budget runs out.
 *
 * Tool calls and their results are dropped rather than summarized: they are the
 * bulk of a transcript and the least of what a side question is about, and a
 * truncated tool payload reads as a fact the model would then reason from.
 */
export function transcriptExcerpt(messages: readonly AgentMessage[], budget = MAX_CONTEXT_CHARS): string {
	const lines: string[] = [];
	let used = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = textOf(message.content);
		if (!text) continue;
		const clipped = text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}\n…(truncated)` : text;
		if (used + clipped.length > budget) break;
		used += clipped.length;
		lines.unshift(`${message.role === "user" ? "User" : "Assistant"}: ${clipped}`);
	}
	return lines.join("\n\n");
}

/** What the model sees: the session tail, then the side thread it is continuing. */
export function buildContext(excerpt: string, thread: readonly SideTurn[]): string {
	const sections: string[] = [];
	if (excerpt) sections.push("## Session so far", excerpt);
	if (thread.length > 0) {
		sections.push(
			"## This side thread",
			thread
				.map(
					(turn, index) =>
						`### Question ${index + 1}\n${turn.question}\n\n### Answer ${index + 1}\n${turn.answer}`,
				)
				.join("\n\n"),
		);
	}
	return sections.join("\n\n");
}

export default function piBtw(pi: ModuleApi): void {
	/** The side thread of the current session; a new session starts a new one. */
	let thread: SideTurn[] = [];

	pi.on("session_start", () => {
		thread = [];
	});

	// `display: true` with a codec that projects to nothing: the answer is in the
	// transcript and in the session file, and out of every future request.
	pi.registerMessageType({ kind: "custom", customType: MESSAGE_TYPE, toLlm: () => [] });

	pi.registerMessageRenderer<{ question?: unknown }>(MESSAGE_TYPE, (message, _options, theme) => {
		const question = typeof message.details?.question === "string" ? message.details.question : "";
		const body = textOf(message.content);
		if (!body) return undefined;
		const heading = question ? `**btw · ${question}**\n\n` : "**btw**\n\n";
		return new Markdown(heading + body, 0, 0, getMarkdownTheme(), {
			color: (text: string) => theme.fg("customMessageText", text),
		});
	});

	pi.registerCommand(COMMAND, {
		description: "Ask a side question about this session without adding it to the conversation",
		handler: async (args, ctx) => {
			await ask(args, ctx, thread, (question, answer) => {
				pi.sendMessage({ customType: MESSAGE_TYPE, content: answer, display: true, details: { question } });
			});
		},
	});
}

async function ask(
	args: string,
	ctx: ModuleCommandContext,
	thread: SideTurn[],
	show: (question: string, answer: string) => void,
): Promise<void> {
	const question = args.trim();
	if (!question) {
		ctx.ui.notify(`Ask a side question: /${COMMAND} <question>`, "info");
		return;
	}
	const model = ctx.model;
	if (!model) {
		ctx.ui.notify(`No model selected, so /${COMMAND} has nothing to ask.`, "warning");
		return;
	}
	const excerpt = transcriptExcerpt(ctx.sessionManager.buildSessionProjection().messages);
	const context = buildContext(excerpt, thread);
	ctx.ui.setWorkingMessage(`btw: ${question.length > 60 ? `${question.slice(0, 57)}…` : question}`);
	try {
		const response = await ctx.modelRegistry.complete(model, {
			systemPrompt: SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: `${context}\n\n## Question\n${question}` }],
					timestamp: Date.now(),
				},
			],
		});
		if (response.stopReason === "error") {
			ctx.ui.notify(`btw failed: ${response.errorMessage ?? "unknown error"}`, "warning");
			return;
		}
		const answer = textOf(response.content);
		if (!answer) {
			ctx.ui.notify("btw returned nothing readable.", "warning");
			return;
		}
		thread.push({ question, answer });
		while (thread.length > MAX_SIDE_TURNS) thread.shift();
		show(question, answer);
	} catch (error) {
		ctx.ui.notify(`btw failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
	} finally {
		ctx.ui.setWorkingMessage();
	}
}
