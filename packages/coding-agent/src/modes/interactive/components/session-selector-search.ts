import { fuzzyMatch } from "@nanopi/pi-tui";
import type { SessionInfo } from "../../../core/session-manager.ts";

export type SortMode = "threaded" | "recent" | "relevance";

export type NameFilter = "all" | "named";

export interface ParsedSearchQuery {
	mode: "tokens" | "regex";
	tokens: { kind: "fuzzy" | "phrase"; value: string }[];
	regex: RegExp | null;
	/** If set, parsing failed and we should treat query as non-matching. */
	error?: string;
}

export interface MatchResult {
	matches: boolean;
	/** Lower is better; only meaningful when matches === true */
	score: number;
}

/** Characters that keep a bare word a plausible session id fragment. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Score offset that ranks session-id hits above fuzzy matches. The offset has to beat the
 * best fuzzy score: fuzzyMatch pays up to -10 per word-boundary character.
 */
const SESSION_ID_MATCH_BONUS = 100;

function getSessionSearchText(session: SessionInfo): string {
	return `${session.name ?? ""} ${session.allMessagesText} ${session.cwd}`;
}

export function hasSessionName(session: SessionInfo): boolean {
	return Boolean(session.name?.trim());
}

function matchesNameFilter(session: SessionInfo, filter: NameFilter): boolean {
	if (filter === "all") return true;
	return hasSessionName(session);
}

export function parseSearchQuery(query: string): ParsedSearchQuery {
	const trimmed = query.trim();
	if (!trimmed) {
		return { mode: "tokens", tokens: [], regex: null };
	}

	// Regex mode: re:<pattern>
	if (trimmed.startsWith("re:")) {
		const pattern = trimmed.slice(3).trim();
		if (!pattern) {
			return { mode: "regex", tokens: [], regex: null, error: "Empty regex" };
		}
		try {
			return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i") };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { mode: "regex", tokens: [], regex: null, error: msg };
		}
	}

	// Token mode with quote support.
	// Example: foo "node cve" bar
	const tokens: { kind: "fuzzy" | "phrase"; value: string }[] = [];
	let buf = "";
	let inQuote = false;
	let hadUnclosedQuote = false;

	const flush = (kind: "fuzzy" | "phrase"): void => {
		const v = buf.trim();
		buf = "";
		if (!v) return;
		tokens.push({ kind, value: v });
	};

	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i]!;
		if (ch === '"') {
			if (inQuote) {
				flush("phrase");
				inQuote = false;
			} else {
				flush("fuzzy");
				inQuote = true;
			}
			continue;
		}

		if (!inQuote && /\s/.test(ch)) {
			flush("fuzzy");
			continue;
		}

		buf += ch;
	}

	if (inQuote) {
		hadUnclosedQuote = true;
	}

	// If quotes were unbalanced, fall back to plain whitespace tokenization.
	if (hadUnclosedQuote) {
		return {
			mode: "tokens",
			tokens: trimmed
				.split(/\s+/)
				.map((t) => t.trim())
				.filter((t) => t.length > 0)
				.map((t) => ({ kind: "fuzzy" as const, value: t })),
			regex: null,
		};
	}

	flush(inQuote ? "phrase" : "fuzzy");

	return { mode: "tokens", tokens, regex: null };
}

function normalizeMatchText(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Returns the literal-match score, or null when the query is not a session-id hit. */
function matchSessionId(id: string, query: string): number | null {
	if (!query || !SESSION_ID_PATTERN.test(query)) return null;
	const idx = id.toLowerCase().indexOf(query);
	if (idx < 0) return null;
	return idx * 0.1 - SESSION_ID_MATCH_BONUS;
}

export function matchSession(session: SessionInfo, parsed: ParsedSearchQuery): MatchResult {
	const text = getSessionSearchText(session);

	if (parsed.mode === "regex") {
		if (!parsed.regex) {
			return { matches: false, score: 0 };
		}
		const idx = `${session.id} ${text}`.search(parsed.regex);
		if (idx < 0) return { matches: false, score: 0 };
		return { matches: true, score: idx * 0.1 };
	}

	if (parsed.tokens.length === 0) {
		return { matches: true, score: 0 };
	}

	let totalScore = 0;
	let normalizedText: string | null = null;

	for (const token of parsed.tokens) {
		// Session ids are matched literally, in both modes: fuzzy matching lets a short
		// number such as `1024` hit digits scattered through an 8 character id.
		const query = token.kind === "phrase" ? normalizeMatchText(token.value) : token.value;
		const idScore = matchSessionId(session.id, query);
		if (idScore !== null) {
			totalScore += idScore;
			continue;
		}

		if (token.kind === "phrase") {
			if (normalizedText === null) {
				normalizedText = normalizeMatchText(text);
			}
			if (!query) continue;
			const idx = normalizedText.indexOf(query);
			if (idx < 0) return { matches: false, score: 0 };
			totalScore += idx * 0.1;
			continue;
		}

		// The session ID is an opaque token, so it matches as a plain substring: fuzzy matching
		// let "1024" match letters scattered through a UUID. It is kept out of the search text
		// for the same reason, so only this branch can match it.
		const needle = token.value.toLowerCase();
		const idIndex = session.id.toLowerCase().indexOf(needle);
		if (idIndex >= 0) {
			totalScore += idIndex * 0.1 - 5;
			continue;
		}

		// An exact substring in the body is still a better hit than letters scattered over it.
		if (normalizedText === null) {
			normalizedText = normalizeMatchText(text);
		}
		const textIndex = normalizedText.indexOf(normalizeMatchText(token.value));
		if (textIndex >= 0) {
			totalScore += textIndex * 0.1;
			continue;
		}

		const m = fuzzyMatch(token.value, text);
		if (!m.matches) return { matches: false, score: 0 };
		totalScore += m.score;
	}

	return { matches: true, score: totalScore };
}

export function filterAndSortSessions(
	sessions: SessionInfo[],
	query: string,
	sortMode: SortMode,
	nameFilter: NameFilter = "all",
): SessionInfo[] {
	const nameFiltered =
		nameFilter === "all" ? sessions : sessions.filter((session) => matchesNameFilter(session, nameFilter));
	const trimmed = query.trim();
	if (!trimmed) return nameFiltered;

	const parsed = parseSearchQuery(query);
	if (parsed.error) return [];

	// Recent mode: filter only, keep incoming order.
	if (sortMode === "recent") {
		const filtered: SessionInfo[] = [];
		for (const s of nameFiltered) {
			const res = matchSession(s, parsed);
			if (res.matches) filtered.push(s);
		}
		return filtered;
	}

	// Relevance mode: sort by score, tie-break by modified desc.
	const scored: { session: SessionInfo; score: number }[] = [];
	for (const s of nameFiltered) {
		const res = matchSession(s, parsed);
		if (!res.matches) continue;
		scored.push({ session: s, score: res.score });
	}

	scored.sort((a, b) => {
		if (a.score !== b.score) return a.score - b.score;
		return b.session.modified.getTime() - a.session.modified.getTime();
	});

	return scored.map((r) => r.session);
}
