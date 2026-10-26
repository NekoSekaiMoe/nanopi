/**
 * pi-memory — `/remember` and the end-of-session memory prompt.
 *
 * A naive memory feature writes every plausible fact into AGENTS.md and makes
 * the context worse every session. This one is built around refusing: entries
 * are validated against the file's own content, the extraction prompt names
 * what AGENTS.md already says, and nothing is ever written without the user
 * saying yes.
 *
 *   /remember             Ask the model for candidates, then confirm what to write
 *   /remember <text>      Write that one line directly (still validated)
 *   /remember --list      Show what the file holds, with ages
 *   /remember --prune     Offer the entries that look out of date for deletion
 *   /forget               Delete entries, by number or by section
 *
 * The write goes into the project's context file (AGENTS.md and its siblings),
 * so the loader that already reads those files puts it in front of the next
 * session: no new format, no extra plumbing.
 *
 * Refusing to write is only half of it. A list that never shrinks is a list
 * whose every line is read forever, so each entry carries the day it was last
 * confirmed, `/remember --prune` surfaces the ones that stopped being true, and
 * `/forget` exists so that acting on that is one command.
 */

import type { AgentMessage } from "@nanopi/pi-agent-core";
import type { ModuleApi, ModuleCommandContext, ModuleContext } from "../../../core/modules/types.ts";
import { blameDays, SOFT_LIMIT, type StaleCandidate, STALE_DAYS, staleCandidates } from "./freshness.ts";
import { ageInDays, type MemoryEntry, stripStamp } from "./parse.ts";
import { isDuplicate, listEntries, validateEntry } from "./parse.ts";
import { buildExtractionPrompt, type Candidate, MAX_CANDIDATES, parseCandidates } from "./prompt.ts";
import {
	applyEntry,
	type MemoryFileEntry,
	otherContextFiles,
	readEntries,
	readText,
	removeEntries,
	resolveTarget,
	touchSections,
} from "./store.ts";

const COMMAND = "remember";
const FORGET = "forget";
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

/** One line, never the stamp: the stamp is bookkeeping, not the rule. */
function oneLine(entry: MemoryEntry): string {
	return stripStamp(entry).replace(/\s*\n\s*/g, " ").replace(/^[-*]\s+/, "").trim();
}

function ageLabel(entry: MemoryEntry, now: Date): string {
	return entry.kept ? `${ageInDays(entry.kept, now)}d` : "no stamp";
}

async function readStale(cwd: string, file: string): Promise<StaleCandidate[]> {
	const entries = readEntries(file);
	const unstamped = entries.filter((entry) => entry.kept === undefined);
	const ages = unstamped.length > 0 ? await blameDays(file, unstamped, cwd) : new Map<string, string>();
	return staleCandidates({ cwd, entries, now: new Date(), blameDays: ages });
}

async function extract(
	ctx: ModuleContext,
	session: PendingSession,
): Promise<{ candidates: Candidate[]; stale: Candidate[]; target: string; exists: boolean } | string> {
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
		stale: existing.length > 0 ? await readStale(session.cwd, target.path) : [],
	});
	if (!prompt) return "This session is too short to have reached a conclusion worth keeping.";

	const response = await ctx.modelRegistry.complete(model, {
		systemPrompt: prompt.systemPrompt,
		messages: [{ role: "user", content: [{ type: "text", text: prompt.prompt }], timestamp: Date.now() }],
	});
	if (response.stopReason === "error") {
		return `Memory extraction failed: ${response.errorMessage ?? "unknown error"}`;
	}
	const parsed = parseCandidates(textOf(response as unknown as AgentMessage));
	if (!parsed) return "Memory extraction returned nothing readable.";
	// The model sees the existing entries, but it sees a lot else too: re-check locally.
	const fresh = parsed.candidates.filter((candidate) => {
		if (validateEntry(candidate.text) !== undefined) return false;
		return !isDuplicate(candidate.text, existing);
	});
	// "Stale" is only a proposal: it has to name a bullet that is really there.
	const stale = parsed.stale.filter((candidate) => existing.some((entry) => sameEntry(entry, candidate.text)));
	return { candidates: fresh, stale, target: target.path, exists: target.exists };
}

/** Loose identity for matching the model's quote back to a bullet in the file. */
function sameEntry(entry: MemoryEntry, quote: string): boolean {
	const wanted = quote.trim().replace(/^[-*]\s+/, "").toLowerCase();
	if (!wanted) return false;
	const body = stripStamp(entry).replace(/^[-*]\s+/, "").toLowerCase();
	return body === wanted || body.startsWith(wanted) || wanted.startsWith(body);
}

/** Entries quoted by the model, resolved to what is actually in the file. */
function resolveQuotes(entries: readonly MemoryFileEntry[], quotes: readonly Candidate[]): MemoryFileEntry[] {
	const found: MemoryFileEntry[] = [];
	for (const quote of quotes) {
		const match = entries.find((entry) => sameEntry(entry, quote.text));
		if (match && !found.includes(match)) found.push(match);
	}
	return found;
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
	const listed = result.candidates.map((candidate, index) => {
		const reason = candidate.reason ? `\n   ${candidate.reason}` : "";
		return `${index + 1}. ${candidate.text.trim().replace(/^[-*]\s+/, "")}${reason}`;
	});
	if (listed.length === 0) {
		ctx.ui.notify(`Nothing to keep: ${where} already covers this session.`, "info");
	} else {
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
		await confirmStale(ctx, session, result.target, result.stale);

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
		const total = readEntries(result.target).length;
		if (total > SOFT_LIMIT) {
			notes.push(`${total} entries now; run \`/${COMMAND} --prune\` to clear out the old ones.`);
		}
		ctx.ui.notify(notes.join("\n"), written > 0 ? "info" : "warning");
	}
	await confirmStale(ctx, session, result.target, result.stale);
}

async function confirmStale(
	ctx: ModuleCommandContext,
	session: PendingSession,
	file: string,
	quotes: readonly Candidate[],
): Promise<void> {
	if (quotes.length === 0) return;
	const entries = readEntries(file);
	const targets = resolveQuotes(entries, quotes);
	if (targets.length === 0) return;
	const listed = targets.map((entry, index) => {
		const reason = quotes.find((quote) => sameEntry(entry, quote.text))?.reason;
		return `${index + 1}. ${oneLine(entry)}${reason ? `\n   ${reason}` : ""}`;
	});
	const accepted = await ctx.ui.input(
		`These entries in ${relative(session.cwd, file)} look out of date. List the numbers to delete, or leave blank to keep them.\n\n${listed.join("\n")}`,
		"",
	);
	if (accepted === undefined || accepted.trim() === "") return;
	const drop = new Set(
		accepted
			.split(/[,\s]+/)
			.map((part) => Number.parseInt(part, 10))
			.filter((index) => Number.isInteger(index) && index >= 1 && index <= targets.length),
	);
	if (drop.size === 0) return;
	const chosen = targets.filter((_entry, index) => drop.has(index + 1));
	const outcome = removeEntries(file, (entry) => chosen.some((item) => item.start === entry.start));
	const sections = [...new Set(chosen.map((entry) => entry.section).filter((title) => title !== undefined))];
	touchSections(file, sections);
	ctx.ui.notify(
		`Deleted ${outcome.removed.length} entr${outcome.removed.length === 1 ? "y" : "ies"} from ${relative(session.cwd, file)}.`,
		"info",
	);
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
		const total = readEntries(target.path).length;
		const pressure = total > SOFT_LIMIT ? ` ${total} entries; \`/${COMMAND} --prune\` clears the old ones.` : "";
		ctx.ui.notify(
			`Written to ${relative(session.cwd, outcome.file)} under "## ${outcome.section}"${replaced}.${pressure}`,
			"info",
		);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
	}
}

function listMemory(ctx: ModuleCommandContext, session: PendingSession): void {
	const target = resolveTarget(session.cwd);
	const entries = readEntries(target.path);
	if (entries.length === 0) {
		ctx.ui.notify(`${relative(session.cwd, target.path)} holds no entries yet.`, "info");
		return;
	}
	const now = new Date();
	const lines = entries.map((entry, index) => {
		const section = entry.section ? `${entry.section}: ` : "";
		return `${index + 1}. ${ageLabel(entry, now)}  ${section}${oneLine(entry)}`;
	});
	const note =
		entries.length > SOFT_LIMIT
			? `\n${entries.length} entries is past the soft limit of ${SOFT_LIMIT}.`
			: `\n${entries.length} entr${entries.length === 1 ? "y" : "ies"}; \`/${FORGET} <numbers>\` deletes.`;
	ctx.ui.notify(`${relative(session.cwd, target.path)}\n\n${lines.join("\n")}${note}`, "info");
}

async function pruneMemory(ctx: ModuleCommandContext, session: PendingSession): Promise<void> {
	const target = resolveTarget(session.cwd);
	if (!target.exists) {
		ctx.ui.notify(`No ${relative(session.cwd, target.path)} to prune.`, "info");
		return;
	}
	const stale = await readStale(session.cwd, target.path);
	if (stale.length === 0) {
		ctx.ui.notify(`Nothing looks out of date: no entry names a missing path or is over ${STALE_DAYS} days old.`, "info");
		return;
	}
	const now = new Date();
	const listed = stale.map((item, index) => {
		const why =
			item.reason === "missing"
				? `names ${item.paths.join(", ")}, which no longer exist`
				: `kept ${item.days} days ago`;
		return `${index + 1}. ${oneLine(item.entry)}\n   ${why}`;
	});
	const accepted = await ctx.ui.input(
		`${stale.length} entr${stale.length === 1 ? "y" : "ies"} in ${relative(session.cwd, target.path)} may be out of date. List the numbers to delete, comma separated, or leave blank to keep them.\n\n${listed.join("\n")}`,
		"",
	);
	if (accepted === undefined || accepted.trim() === "") return;
	const drop = new Set(
		accepted
			.split(/[,\s]+/)
			.map((part) => Number.parseInt(part, 10))
			.filter((index) => Number.isInteger(index) && index >= 1 && index <= stale.length),
	);
	if (drop.size === 0) return;
	const chosen = stale.filter((_item, index) => drop.has(index + 1)).map((item) => item.entry);
	const sections = readEntries(target.path)
		.filter((entry) => chosen.some((item) => item.start === entry.start))
		.map((entry) => entry.section)
		.filter((title) => title !== undefined);
	const outcome = removeEntries(target.path, (entry) => chosen.some((item) => item.start === entry.start));
	touchSections(target.path, sections);
	const kept = stale.length - outcome.removed.length;
	const rest = kept > 0 ? `, ${kept} kept and restamped` : "";
	ctx.ui.notify(
		`Deleted ${outcome.removed.length} entr${outcome.removed.length === 1 ? "y" : "ies"} from ${relative(session.cwd, target.path)}${rest}.`,
		"info",
	);
}

async function forgetMemory(ctx: ModuleCommandContext, session: PendingSession, arg: string): Promise<void> {
	const target = resolveTarget(session.cwd);
	const entries = readEntries(target.path);
	if (entries.length === 0) {
		ctx.ui.notify(`${relative(session.cwd, target.path)} holds no entries.`, "info");
		return;
	}
	const numbers = arg
		.split(/[,\s]+/)
		.map((part) => Number.parseInt(part, 10))
		.filter((index) => Number.isInteger(index) && index >= 1 && index <= entries.length);
	if (numbers.length === 0) {
		ctx.ui.notify(`Usage: \`/${FORGET} <numbers from \`/${COMMAND} --list\`>`, "warning");
		return;
	}
	const chosen = [...new Set(numbers)].map((index) => entries[index - 1]);
	const outcome = removeEntries(target.path, (entry) => chosen.some((item) => item.start === entry.start));
	const sections = [...new Set(chosen.map((entry) => entry.section).filter((title) => title !== undefined))];
	touchSections(target.path, sections);
	const emptied = outcome.section ? ` "## ${outcome.section.title}" is gone with its last entry.` : "";
	ctx.ui.notify(
		`Deleted ${outcome.removed.length} entr${outcome.removed.length === 1 ? "y" : "ies"} from ${relative(session.cwd, target.path)}.${emptied}`,
		"info",
	);
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
		description: "Distill this session into AGENTS.md entries (validated, deduped, confirmed); --list, --prune",
		getArgumentCompletions: (prefix) =>
			["--list", "--prune"]
				.filter((flag) => flag.startsWith(prefix))
				.map((flag) => ({
					value: flag,
					label: flag,
					description: flag === "--list" ? "show entries with their ages" : "delete entries that look out of date",
				})),
		handler: async (args, ctx) => {
			const session = current(ctx.cwd);
			const text = args.trim();
			if (text === "--list") listMemory(ctx, session);
			else if (text === "--prune") await pruneMemory(ctx, session);
			else if (text.length > 0) rememberDirect(ctx, session, text);
			else await rememberFromSession(ctx, session);
		},
	});

	pi.registerCommand(FORGET, {
		description: `Delete AGENTS.md memory entries by number (see /${COMMAND} --list)`,
		handler: async (args, ctx) => {
			await forgetMemory(ctx, current(ctx.cwd), args.trim());
		},
	});
}

export { MAX_CANDIDATES };
