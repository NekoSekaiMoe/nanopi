/**
 * pi-memory — `/remember` and the end-of-session memory prompt.
 *
 * A naive memory feature writes every plausible fact into AGENTS.md and makes
 * the context worse every session. This one is built around refusing: entries
 * are validated against the file's own content, the extraction prompt names
 * what AGENTS.md already says, and nothing is ever written without the user
 * saying yes.
 *
 *   /remember           Ask the model for candidates, then confirm what to write
 *   /remember <text>    Write that one line directly (still validated)
 *
 * The write goes into the project's context file (AGENTS.md and its siblings),
 * so the loader that already reads those files puts it in front of the next
 * session: no new format, no extra plumbing.
 */

import type { AgentMessage } from "@nanopi/pi-agent-core";
import type { ModuleApi, ModuleCommandContext, ModuleContext } from "../../../core/modules/types.ts";
import { buildExtractionPrompt, type Candidate, MAX_CANDIDATES, parseCandidates } from "./prompt.ts";
import { isDuplicate, listEntries, validateEntry } from "./parse.ts";
import { applyEntry, otherContextFiles, readText, resolveTarget } from "./store.ts";

const COMMAND = "remember";
/** One nudge per session, and only for a session that went somewhere. */
const MIN_USER_TURNS_FOR_PROMPT = 4;

interface PendingSession {
	cwd: string;
	userTurns: string[];
	assistantTurns: string[];
	/** Candidates the user declined, fed back into the next extraction. */
	declined: string[];
}

function textOf(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

/** User prompts and assistant closing text, in order. Tool traffic is left out on purpose. */
function collectTurns(messages: readonly AgentMessage[]): { userTurns: string[]; assistantTurns: string[] } {
	const userTurns: string[] = [];
	const assistantTurns: string[] = [];
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = textOf(message).trim();
		if (!text) continue;
		if (message.role === "user") userTurns.push(text);
		else assistantTurns.push(text);
	}
	return { userTurns, assistantTurns };
}

function relative(cwd: string, path: string): string {
	return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

async function extract(
	ctx: ModuleContext,
	session: PendingSession,
): Promise<{ candidates: Candidate[]; target: string; exists: boolean } | string> {
	const model = ctx.model;
	if (!model) return "No model selected.";
	const target = resolveTarget(session.cwd);
	const existing = listEntries(readText(target.path).split("\n"));
	const prompt = buildExtractionPrompt({
		userTurns: session.userTurns,
		assistantTurns: session.assistantTurns,
		existing,
		otherFiles: otherContextFiles(session.cwd, target.path).map((path) => relative(session.cwd, path)),
		rejected: session.declined,
	});
	if (!prompt) return "This session is too short to have reached a conclusion worth keeping.";

	const response = await ctx.modelRegistry.complete(model, {
		systemPrompt: prompt.systemPrompt,
		messages: [{ role: "user", content: [{ type: "text", text: prompt.prompt }], timestamp: Date.now() }],
	});
	if (response.stopReason === "error") {
		return `Memory extraction failed: ${response.errorMessage ?? "unknown error"}`;
	}
	const candidates = parseCandidates(textOf(response as unknown as AgentMessage));
	if (!candidates) return "Memory extraction returned nothing readable.";
	// The model sees the existing entries, but it sees a lot else too: re-check locally.
	const fresh = candidates.filter((candidate) => {
		if (validateEntry(candidate.text) !== undefined) return false;
		return !isDuplicate(candidate.text, existing);
	});
	return { candidates: fresh, target: target.path, exists: target.exists };
}

async function rememberFromSession(ctx: ModuleCommandContext, session: PendingSession): Promise<void> {
	let result: Awaited<ReturnType<typeof extract>>;
	try {
		result = await extract(ctx, session);
	} catch (error) {
		ctx.ui.notify(`Memory extraction failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		return;
	}
	if (typeof result === "string") {
		ctx.ui.notify(result, "info");
		return;
	}
	const where = result.exists ? relative(session.cwd, result.target) : `${relative(session.cwd, result.target)} (new)`;
	if (result.candidates.length === 0) {
		ctx.ui.notify(`Nothing to keep: ${where} already covers this session.`, "info");
		return;
	}

	const listed = result.candidates.map((candidate, index) => {
		const reason = candidate.reason ? `\n   ${candidate.reason}` : "";
		return `${index + 1}. ${candidate.text.trim().replace(/^[-*]\s+/, "")}${reason}`;
	});
	const accepted = await ctx.ui.input(
		`Write to ${where}: list the numbers to keep, comma separated, or leave blank to skip.\n\n${listed.join("\n")}`,
		result.candidates.map((_candidate, index) => String(index + 1)).join(","),
	);
	if (accepted === undefined) return;
	const keep = new Set(
		accepted
			.split(/[,\s]+/)
			.map((part) => Number.parseInt(part, 10))
			.filter((index) => Number.isInteger(index) && index >= 1 && index <= result.candidates.length),
	);
	// Declining is a signal, not a no-op: the next run must not re-propose it.
	for (const [index, candidate] of result.candidates.entries()) {
		if (!keep.has(index + 1)) session.declined.push(candidate.text);
	}
	if (keep.size === 0) {
		ctx.ui.notify("No entries written.", "info");
		return;
	}

	let written = 0;
	const notes: string[] = [];
	for (const [index, candidate] of result.candidates.entries()) {
		if (!keep.has(index + 1)) continue;
		try {
			const outcome = applyEntry(result.target, candidate.text, candidate.section);
			if (outcome.status === "added") written++;
			else notes.push(`already there: ${candidate.text.trim()}`);
		} catch (error) {
			notes.push(error instanceof Error ? error.message : String(error));
		}
	}
	notes.unshift(`${written} entr${written === 1 ? "y" : "ies"} written to ${relative(session.cwd, result.target)}`);
	ctx.ui.notify(notes.join("\n"), written > 0 ? "info" : "warning");
}

function rememberDirect(ctx: ModuleCommandContext, session: PendingSession, text: string): void {
	const target = resolveTarget(session.cwd);
	const invalid = validateEntry(text);
	if (invalid) {
		ctx.ui.notify(`${invalid}: ${text.trim()}`, "warning");
		return;
	}
	try {
		const outcome = applyEntry(target.path, text);
		if (outcome.status === "duplicate") {
			ctx.ui.notify(`${relative(session.cwd, outcome.file)} already says this.`, "info");
			return;
		}
		const replaced = outcome.replaced.length > 0 ? `, replacing ${outcome.replaced.length} stale` : "";
		ctx.ui.notify(`Written to ${relative(session.cwd, outcome.file)} under "## ${outcome.section}"${replaced}.`, "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
	}
}

export default function memory(pi: ModuleApi): void {
	const sessions = new Map<string, PendingSession>();
	const nudged = new Set<string>();

	const current = (cwd: string): PendingSession => {
		let session = sessions.get(cwd);
		if (!session) {
			session = { cwd, userTurns: [], assistantTurns: [], declined: [] };
			sessions.set(cwd, session);
		}
		return session;
	};

	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "new") {
			sessions.delete(ctx.cwd);
			nudged.delete(ctx.cwd);
		}
		current(ctx.cwd);
	});

	pi.on("turn_end", async (_event, ctx) => {
		const session = current(ctx.cwd);
		const turns = collectTurns(ctx.sessionManager.buildSessionProjection().messages);
		session.userTurns = turns.userTurns;
		session.assistantTurns = turns.assistantTurns;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const session = current(ctx.cwd);
		if (nudged.has(session.cwd)) return;
		if (session.userTurns.length < MIN_USER_TURNS_FOR_PROMPT) return;
		nudged.add(session.cwd);
		const target = resolveTarget(session.cwd);
		ctx.ui.setStatus(
			COMMAND,
			`/${COMMAND}: write this session's durable conclusions to ${relative(session.cwd, target.path)}`,
		);
	});

	pi.registerCommand(COMMAND, {
		description: "Distill this session into AGENTS.md entries (validated, deduped, confirmed)",
		handler: async (args, ctx) => {
			const session = current(ctx.cwd);
			const text = args.trim();
			if (text.length > 0) rememberDirect(ctx, session, text);
			else await rememberFromSession(ctx, session);
		},
	});
}

export { MAX_CANDIDATES };
