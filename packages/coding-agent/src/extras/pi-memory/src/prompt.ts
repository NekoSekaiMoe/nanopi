/**
 * The extraction request.
 *
 * Everything that makes the result "smart" lives here rather than in a skill:
 * the model sees the candidates it proposed, the entries AGENTS.md already
 * has, and the rules that reject both. Deciding what not to record is the hard
 * part, and it is cheaper to state it once in the prompt than to re-litigate
 * every candidate afterwards.
 */

import type { MemoryEntry } from "./parse.ts";

/** Per-session cap: a note that needs more than this is a document, not a memory. */
const MAX_CANDIDATES = 3;
/** A session earns notes by lasting long enough to reach a conclusion. */
const MIN_USER_TURNS = 2;
const MAX_TRANSCRIPT_CHARS = 24_000;

const EXTRACTION_SYSTEM_PROMPT = `You extract durable project memory from a coding session for a project's AGENTS.md.

AGENTS.md is read into the system prompt of every future session in this repository. Every line you accept costs tokens forever, and a wrong line is worse than a missing one. When in doubt, propose nothing.`;

const RULES = `Rules for a candidate:
- It must be a rule or fact that stays true after this session: a build convention, a constraint that was not obvious from the code, a decision with its reason, a command that differs from the usual one, a trap that cost real time.
- It must be new. If the existing entries already say it, or the code states it, drop it.
- It must be actionable by a future agent that has never seen this conversation. No "we", no "this session", no retelling of what happened.
- One line, at most 240 characters. State the constraint, not the story behind it.
- Never record secrets, credentials, personal data, or anything the user asked to keep out of the repository.
- Never record what the diff already says: "changed foo.ts to fix a bug" is not memory.

Good: \`- Run \`pnpm run check\` after code changes; it also type-checks the generated model shards.\`
Good: \`- The webui build reads packages/webui/dist; rebuild it before testing a frontend change.\`
Bad: \`- The user asked me to fix the retry logic.\` (narrates one session)
Bad: \`- src/retry.ts has 42 lines.\` (the code already says it)`;

const OUTPUT_FORMAT = `Reply with one fenced json block and nothing else:
\`\`\`json
{ "candidates": [ { "text": "- ...", "reason": "why it survives without this session", "section": "Build" } ] }
\`\`\`
Use an empty "candidates" array when nothing qualifies. "section" names the AGENTS.md heading the entry belongs under, or "Project Notes" for a new one.`;

export interface ExtractionInput {
	/** The user's prompts, in order, as the only record of intent. */
	userTurns: string[];
	/** Assistant conclusions, in order. */
	assistantTurns: string[];
	/** Entries already present in the target file. */
	existing: readonly MemoryEntry[];
	/** The other context files the loader reads, by name, so the model can see what is already claimed. */
	otherFiles: readonly string[];
	/** Turns the model already proposed and the user declined, so it stops re-proposing them. */
	rejected: readonly string[];
}

/** Build the extraction request, or undefined when the session has nothing worth reading. */
export function buildExtractionPrompt(input: ExtractionInput): { systemPrompt: string; prompt: string } | undefined {
	if (input.userTurns.length < MIN_USER_TURNS) return undefined;
	const transcript = serializeTranscript(input);
	if (transcript.trim().length === 0) return undefined;

	const existing =
		input.existing.length > 0
			? input.existing.map((entry) => entry.text).join("\n")
			: "(none: the file has no bullets yet)";
	const sections: string[] = [];
	const body = [
		`<existing-entries>\n${existing}\n</existing-entries>`,
		input.otherFiles.length > 0
			? `<other-context-files>\nAlso loaded by every session: ${input.otherFiles.join(", ")}\n</other-context-files>`
			: "",
		input.rejected.length > 0
			? `<declined>\nThe user already declined these; do not propose them again:\n${input.rejected.map((item) => `- ${item}`).join("\n")}\n</declined>`
			: "",
		`<session>\n${transcript}\n</session>`,
		RULES,
		OUTPUT_FORMAT,
	]
		.filter((part) => part.length > 0)
		.join("\n\n");
	sections.push(body);
	return { systemPrompt: EXTRACTION_SYSTEM_PROMPT, prompt: sections.join("\n\n") };
}

/**
 * User prompts plus the assistant's closing text for each turn.
 *
 * Tool calls and results are deliberately absent: a file path that appears in a
 * diff is not memory, and including them invites the model to summarize the
 * diff instead of the conclusion.
 */
function serializeTranscript(input: ExtractionInput): string {
	const parts: string[] = [];
	const turns = Math.max(input.userTurns.length, input.assistantTurns.length);
	for (let index = 0; index < turns; index++) {
		const user = input.userTurns[index]?.trim();
		const assistant = input.assistantTurns[index]?.trim();
		if (user) parts.push(`[user] ${user}`);
		if (assistant) parts.push(`[assistant] ${assistant}`);
	}
	const text = parts.join("\n\n");
	return text.length > MAX_TRANSCRIPT_CHARS ? `${text.slice(-MAX_TRANSCRIPT_CHARS)}` : text;
}

export interface Candidate {
	text: string;
	reason?: string;
	section?: string;
}

/** Parse the model's reply. Returns undefined when no json block can be read. */
export function parseCandidates(reply: string): Candidate[] | undefined {
	const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(reply);
	const body = fenced ? fenced[1] : reply;
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	if (start === -1 || end <= start) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body.slice(start, end + 1));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || !("candidates" in parsed)) return undefined;
	const raw = (parsed as { candidates: unknown }).candidates;
	if (!Array.isArray(raw)) return undefined;
	const candidates: Candidate[] = [];
	for (const item of raw) {
		if (typeof item === "string") {
			candidates.push({ text: item });
			continue;
		}
		if (typeof item !== "object" || item === null || !("text" in item)) continue;
		const text = (item as { text: unknown }).text;
		if (typeof text !== "string") continue;
		const reason = (item as { reason?: unknown }).reason;
		const section = (item as { section?: unknown }).section;
		candidates.push({
			text,
			reason: typeof reason === "string" ? reason : undefined,
			section: typeof section === "string" ? section : undefined,
		});
	}
	return candidates.slice(0, MAX_CANDIDATES);
}

export { MAX_CANDIDATES, MIN_USER_TURNS };
