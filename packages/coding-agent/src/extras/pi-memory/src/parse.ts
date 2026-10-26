/**
 * Pure text logic for `/remember`: validation, dedupe, age stamps, and the
 * section-boundary detection used to retire an entry that a later one
 * contradicts.
 *
 * Nothing here touches disk, the model, or git, so the rules that decide what
 * reaches AGENTS.md are testable without a session.
 */

/** An entry is one `- ` bullet, optionally continued by indented lines. */
export interface MemoryEntry {
	text: string;
	/** Text without the trailing `(kept <date>)` stamp. */
	body: string;
	/** The day the stamp records, as `YYYY-MM-DD`, when the entry carries one. */
	kept: string | undefined;
	/** 0-based line index of the bullet, relative to the target file. */
	start: number;
	/** 0-based line index of the last line of the entry. */
	end: number;
}

const BULLET = /^[-*]\s+/;
const HEADING = /^#{1,6}\s+/;

/** Fenced code blocks are content, not structure: never edit inside one. */
interface Fence {
	open: number;
	close: number;
}

function fencesOf(lines: readonly string[]): Fence[] {
	const fences: Fence[] = [];
	let openAt = -1;
	let marker = "";
	for (let index = 0; index < lines.length; index++) {
		const match = /^\s*(```+|~~~+)/.exec(lines[index]);
		if (!match) continue;
		if (openAt === -1) {
			openAt = index;
			marker = match[1][0];
			continue;
		}
		if (match[1][0] !== marker) continue;
		fences.push({ open: openAt, close: index });
		openAt = -1;
	}
	// An unclosed fence swallows the rest of the file.
	if (openAt !== -1) fences.push({ open: openAt, close: lines.length - 1 });
	return fences;
}

function inFence(fences: Fence[], index: number): boolean {
	return fences.some((fence) => index >= fence.open && index <= fence.close);
}

/**
 * The `(kept YYYY-MM-DD)` stamp pi-memory appends to what it writes.
 *
 * The stamp is the only thing that makes an entry's age knowable: git blame
 * answers "when was this line last touched", not "when was it last true", and a
 * repository without history answers nothing at all. It stays inside the line
 * and in parentheses because a reader that is not pi-memory then still sees a
 * sentence, and because a bullet's own text must not change when a later write
 * restamps its neighbours.
 */
const STAMP = /[ \t]*\(kept (\d{4}-\d{2}-\d{2})\)[ \t]*$/;
const STAMP_LIKE = /\(kept [^)]*\)\s*$/;

interface Stamp {
	day: string;
	/** Offset of the stamp in the entry text. */
	at: number;
}

function stampOf(text: string): Stamp | undefined {
	const match = STAMP.exec(text);
	if (!match) return undefined;
	const day = match[1];
	if (Number.isNaN(Date.parse(day))) return undefined;
	return { day, at: match.index };
}

function stampLine(line: string): Stamp | undefined {
	const match = STAMP.exec(line);
	if (!match || Number.isNaN(Date.parse(match[1]))) return undefined;
	return { day: match[1], at: match.index };
}

/** The `YYYY-MM-DD` day at the middle of `date`'s local timezone. */
export function dayOf(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Whether a stamp-like suffix carries the shape this module writes. */
export function hasStamp(text: string): boolean {
	return STAMP.test(text);
}

/** Whole days between a `YYYY-MM-DD` stamp and now, never negative. */
export function ageInDays(day: string, now: Date): number {
	const kept = Date.parse(day);
	if (Number.isNaN(kept)) return 0;
	return Math.max(0, Math.floor((now.getTime() - kept) / 86_400_000));
}

/** A bullet without its stamp, for messages that show what the user would delete. */
export function stripStamp(entry: MemoryEntry): string {
	return entry.body;
}

/** Every `- ` bullet with its continuation lines, skipping fenced blocks. */
export function listEntries(lines: readonly string[]): MemoryEntry[] {
	return listRawEntries(lines).map((entry) => {
		const stamp = stampOf(entry.text);
		return { ...entry, body: stamp ? entry.text.slice(0, stamp.at).replace(/\s+$/, "") : entry.text, kept: stamp?.day };
	});
}

function listRawEntries(lines: readonly string[]): MemoryEntry[] {
	const fences = fencesOf(lines);
	const entries: MemoryEntry[] = [];
	for (let index = 0; index < lines.length; index++) {
		if (inFence(fences, index) || !BULLET.test(lines[index])) continue;
		let end = index;
		while (end + 1 < lines.length) {
			const next = lines[end + 1];
			const continues = /^\s+\S/.test(next) && !BULLET.test(next) && !HEADING.test(next);
			if (!continues || inFence(fences, end + 1)) break;
			end++;
		}
		const text = lines.slice(index, end + 1).join("\n");
		entries.push({ text, body: text, kept: undefined, start: index, end });
		index = end;
	}
	return entries;
}

const SUMMARY_SECTION = /^#{1,6}\s+summary\b/i;

/**
 * The heading line that owns `lineIndex`, or undefined at file level. An entry
 * that contradicts itself usually lives under a `## <topic>` heading, and that
 * heading is the granularity at which a stale note is retired.
 */
export function sectionOf(lines: readonly string[], lineIndex: number): { title: string; line: number } | undefined {
	const fences = fencesOf(lines);
	for (let index = Math.min(lineIndex, lines.length - 1); index >= 0; index--) {
		if (inFence(fences, index) || !HEADING.test(lines[index])) continue;
		return { title: lines[index].replace(/^#+\s*/, "").trim(), line: index };
	}
	return undefined;
}

/** Whether a heading names a section whose content later entries supersede. */
export function isSummarySection(title: string): boolean {
	return SUMMARY_SECTION.test(`## ${title}`);
}

/** Normalized form used for duplicate detection: case, stamp, punctuation, and whitespace ignored. */
function normalize(text: string): string {
	return text
		.toLowerCase()
		.replace(STAMP_LIKE, "")
		.replace(BULLET, "")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Words too common to tell two bullets apart; only the rest decide similarity. */
const STOP_WORDS = new Set([
	"a", "an", "and", "any", "are", "as", "at", "be", "before", "by", "do", "for", "from", "has", "in", "is", "it",
	"its", "not", "now", "of", "on", "or", "so", "stale", "still", "that", "the", "then", "this", "to", "use", "used",
	"uses", "was", "when", "with",
]);

function contentWords(text: string): Set<string> {
	return new Set(
		normalize(text)
			.split(" ")
			.filter((token) => token.length > 0 && !STOP_WORDS.has(token)),
	);
}

/**
 * True when `candidate` says what an existing entry already says.
 *
 * Two bullets about the same subject keep the subject's words and lose the
 * filler, so similarity is measured over content words only, and an entry with
 * a single content word ("the build uses X") counts as a restatement once that
 * word appears in the candidate. Two different rules keep distinct nouns.
 */
export function isDuplicate(candidate: string, entries: readonly MemoryEntry[]): boolean {
	const target = normalize(candidate);
	if (!target) return true;
	const candidateWords = contentWords(candidate);
	for (const entry of entries) {
		const existing = normalize(entry.text);
		if (existing === target) return true;
		const entryWords = contentWords(entry.text);
		if (entryWords.size === 0 || candidateWords.size === 0) continue;
		const shared = [...candidateWords].filter((token) => entryWords.has(token)).length;
		if (entryWords.size <= 2) {
			if (shared > 0) return true;
			continue;
		}
		const union = new Set([...candidateWords, ...entryWords]).size;
		if (shared / union >= 0.6) return true;
	}
	return false;
}

export interface RejectReason {
	reason: string;
}

/**
 * Why a proposed entry cannot be written as a bullet, or undefined when it can.
 *
 * The bar is deliberately narrow: a bullet in AGENTS.md is read by every later
 * session, so it has to read as a rule, not as a retelling of one conversation.
 */
export function validateEntry(text: string): string | undefined {
	const trimmed = text.trim();
	const bullet = trimmed.replace(BULLET, "").trim();
	if (!bullet) return "the entry is empty";
	if (BULLET.test(trimmed) && trimmed.split("\n").length > 4) return "the entry is longer than four lines";
	if (bullet.length > 240) return `the entry is ${bullet.length} characters; keep a bullet under 240`;
	if (/^(the |i |we |you )?\w+ (asked|wanted|said|requested)\b/i.test(bullet)) {
		return "the entry narrates one conversation; state the rule it implies instead";
	}
	if (/\bthis (session|conversation|turn)\b/i.test(bullet)) {
		return "the entry refers to the current session; write what holds for future ones too";
	}
	if (STAMP_LIKE.test(bullet) && !STAMP.test(bullet)) {
		return "the age stamp is malformed; write `(kept YYYY-MM-DD)` or leave it out";
	}
	return undefined;
}

const SINGLE_LINE_STAMP = /\s*\(kept \d{4}-\d{2}-\d{2}\)\s*$/;

/**
 * Render a validated entry as a bullet, keeping multi-line continuations
 * indented. The stamp is not part of the text: `renderEntry` owns it.
 */
export function toBullet(text: string): string {
	const [first, ...rest] = text.trim().replace(BULLET, "").split("\n");
	if (rest.length === 0) return `- ${first.trim().replace(SINGLE_LINE_STAMP, "")}`;
	return [
		`- ${first.trim().replace(SINGLE_LINE_STAMP, "")}`,
		...rest.map((line, index) =>
			index === rest.length - 1 ? `  ${line.trim().replace(SINGLE_LINE_STAMP, "")}` : `  ${line.trim()}`,
		),
	].join("\n");
}

/**
 * A bullet with its age stamp, re-stamped to `day`.
 *
 * Every line pi-memory owns goes through here on every write, so an entry
 * written before stamps existed gains one the first time anything else in the
 * file is written. That is also why the stamp goes inside the line: a bullet
 * without one is an old bullet, and old bullets have to look different from new
 * ones without a migration step.
 */
export function renderEntry(text: string, day: string): string {
	const bullet = toBullet(text);
	const parts = bullet.split("\n");
	const last = parts.length - 1;
	parts[last] = `${parts[last].trimEnd()} (kept ${day})`;
	return parts.join("\n");
}

/**
 * Re-stamp a bullet that is already in the file. Comment lines a human wrote
 * after the bullet are carried over untouched.
 */
export function restamp(entry: MemoryEntry, day: string): string {
	const body = stripStampLike(entry.text).split("\n");
	const next = body.length - 1;
	body[next] = `${body[next].trimEnd()} (kept ${day})`;
	return body.join("\n");
}

/** Drop a trailing stamp, valid or malformed: a rewrite replaces it either way. */
function stripStampLike(text: string): string {
	return text.replace(STAMP_LIKE, "").replace(/\s+$/, "");
}

/** First and last line a section owns, or undefined when the heading is absent. */
export function sectionRange(lines: readonly string[], title: string): { start: number; end: number } | undefined {
	const wanted = title.trim().toLowerCase();
	const fences = fencesOf(lines);
	for (let index = 0; index < lines.length; index++) {
		if (inFence(fences, index) || !HEADING.test(lines[index])) continue;
		if (lines[index].replace(/^#+\s*/, "").trim().toLowerCase() !== wanted) continue;
		let end = index + 1;
		while (end < lines.length && (!HEADING.test(lines[end]) || inFence(fences, end))) end++;
		return { start: index, end };
	}
	return undefined;
}
