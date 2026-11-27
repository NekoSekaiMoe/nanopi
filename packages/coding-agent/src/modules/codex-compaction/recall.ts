/**
 * Recallable compaction refs.
 *
 * The summary a compaction writes replaces the transcript, and the raw entries under it
 * stay in the session file but never reach the model again. `recall_context` is the way
 * back: the summary lists the regions that were replaced, each with a ref, and the tool
 * re-injects one of them on demand.
 *
 * Ref format: `E<ordinal>`, where the ordinal counts the model-visible entries the
 * summary replaced (1 = first line of the transcript). Ordinals are a property of the
 * branch, not of the message, so nothing has to be stored for a ref to resolve: the
 * region is recomputed from the branch and the newest compaction's cut point.
 */

import type { SessionEntry } from "../../core/session-manager.ts";
import { sessionEntryToContextMessages } from "../../core/session-manager.ts";

/** Appended to the summary so the model knows the refs are callable. */
export const RECALL_SECTION_HEADER = "## Replaced Context (recallable)";

/** Shown in the appendix when a compaction replaced nothing addressable. */
export const NO_RECALL_NOTE =
	"- (none: the summary replaced nothing that can be recalled; the kept messages are still in context)";

/** Prefix of the `details` field, so a ref block on a session entry names the tool that reads it. */
export const RECALL_DETAILS_KEY = "compaction-recall";

/** One contiguous run of model-visible entries a summary replaced. */
export interface RecallRegion {
	ref: string;
	startEntryId: string;
	endEntryId: string;
	/** Entries in the run, as the ordinal range it spans. */
	from: number;
	to: number;
	/** First line of the run, shortened for the appendix. */
	preview: string;
	tokens: number;
}

/** The region one ref resolves to. */
export interface RecalledRegion extends RecallRegion {
	/** Entries bound to the region. A region can span an entry that projects no messages. */
	entries: SessionEntry[];
}

/** Longest preview kept in the appendix: a one-line clue, not a copy of the message. */
const PREVIEW_MAX_CHARS = 140;

/** Refuse a region larger than this; the point of the summary is to keep context small. */
export const DEFAULT_RECALL_MAX_TOKENS = 8_000;

/** Whether an entry can contribute to the model context at all. */
function isModelVisibleEntry(entry: SessionEntry): boolean {
	if (entry.type === "compaction") return false;
	return sessionEntryToContextMessages(entry).length > 0;
}

/** The newest compaction on the branch. Insertion order, then path order. */
export function latestCompactionEntry(entries: SessionEntry[]): SessionEntry | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") return entries[i];
	}
	return undefined;
}

/**
 * Where the newest compaction took over, as an index into `branchEntries`.
 *
 * Its cut point (`firstKeptEntryId`) is the oldest entry the transcript still shows, so
 * everything before it on the path was replaced. A `firstKeptEntryId` that names no entry
 * means the summary kept nothing and replaced the whole preceding path.
 */
export function replacedRangeEnd(branchEntries: SessionEntry[]): number {
	const compaction = latestCompactionEntry(branchEntries);
	if (compaction?.type !== "compaction") return 0;
	const cutIndex = branchEntries.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
	if (cutIndex >= 0) return cutIndex;
	const compactionIndex = branchEntries.indexOf(compaction);
	return compactionIndex >= 0 ? compactionIndex : branchEntries.length;
}

/** Ordinal of the first model-visible entry, matching the numbering a ref uses. */
export function firstRecallOrdinal(): number {
	return 1;
}

/** Compact one line of an entry into a preview the appendix can hold. */
function previewOf(entry: SessionEntry): string {
	const message = sessionEntryToContextMessages(entry)[0];
	if (!message) return entry.type;
	let text = "";
	if (message.role === "user") {
		text = textOf(message.content);
	} else if (message.role === "assistant") {
		const blocks = Array.isArray(message.content) ? message.content : [];
		for (const block of blocks) {
			if (block.type === "text" && !text) text = block.text;
			else if (block.type === "toolCall" && !text) text = `${block.name}(${argumentSummary(block.arguments)})`;
		}
	} else if (message.role === "toolResult") {
		text = textOf(message.content);
		if (!text) text = `${message.toolName} result`;
	} else if (message.role === "custom") {
		text = typeof message.content === "string" ? message.content : textOf(message.content);
	} else if (message.role === "bashExecution") {
		text = `$ ${message.command}`;
	} else if (message.role === "compactionSummary" || message.role === "branchSummary") {
		text = message.summary;
	}
	return clip(text.replace(/\s+/g, " ").trim());
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) {
		if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
			text += String(block.text);
		}
	}
	return text;
}

function argumentSummary(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const path = (args as { path?: unknown }).path;
	if (typeof path === "string") return path;
	return Object.keys(args as Record<string, unknown>)
		.slice(0, 3)
		.join(", ");
}

function clip(text: string): string {
	return text.length <= PREVIEW_MAX_CHARS ? text : `${text.slice(0, PREVIEW_MAX_CHARS - 1)}…`;
}

/**
 * Group the replaced entries into regions the model can pull back one at a time.
 *
 * A region is a run of consecutive user turns, so a ref covers a stretch of work rather
 * than a single message: recalling one assistant reply without its prompt is rarely what
 * the reader wants. A run that would exceed `maxTokens` is split at a turn boundary.
 */
export function describeRecallRegions(branchEntries: SessionEntry[], maxTokens: number): RecallRegion[] {
	const regions: RecallRegion[] = [];
	const end = replacedRangeEnd(branchEntries);
	let ordinal = firstRecallOrdinal();
	let current:
		| { startId: string; endId: string; from: number; to: number; preview: string; tokens: number }
		| undefined;

	const flush = () => {
		if (!current) return;
		regions.push({
			ref: `E${current.from}`,
			startEntryId: current.startId,
			endEntryId: current.endId,
			from: current.from,
			to: current.to,
			preview: current.preview,
			tokens: current.tokens,
		});
		current = undefined;
	};

	for (let i = 0; i < end; i++) {
		const entry = branchEntries[i];
		if (!isModelVisibleEntry(entry)) continue;
		const tokens = estimateEntryTokens(entry);
		const startsTurn = sessionEntryToContextMessages(entry).some((message) => message.role === "user");
		if (current && (startsTurn || current.tokens + tokens > maxTokens)) flush();
		if (!current) {
			current = {
				startId: entry.id,
				endId: entry.id,
				from: ordinal,
				to: ordinal,
				preview: previewOf(entry),
				tokens,
			};
		} else {
			current.endId = entry.id;
			current.to = ordinal;
			current.tokens += tokens;
		}
		ordinal += 1;
	}
	flush();
	return regions;
}

/**
 * Resolve one ref to the entries it covers. The ref is re-derived here from the branch,
 * so a ref from an older summary answers with the region that numbered it then.
 */
export function resolveRecallRef(
	branchEntries: SessionEntry[],
	ref: string,
	maxTokens: number,
): RecalledRegion | undefined {
	const normalized = ref.trim().toUpperCase();
	const region = describeRecallRegions(branchEntries, maxTokens).find((candidate) => candidate.ref === normalized);
	if (!region) return undefined;
	const startIndex = branchEntries.findIndex((entry) => entry.id === region.startEntryId);
	if (startIndex < 0) return undefined;
	const entries: SessionEntry[] = [];
	let ordinal = region.from;
	for (let i = startIndex; ordinal <= region.to && i < branchEntries.length; i++) {
		const entry = branchEntries[i];
		if (!isModelVisibleEntry(entry)) continue;
		entries.push(entry);
		ordinal += 1;
	}
	return { ...region, entries };
}

/** Render the appendix a summary carries: one line per region, with its ref. */
export function formatRecallAppendix(regions: RecallRegion[]): string {
	if (regions.length === 0) return "";
	return `\n\n${RECALL_SECTION_HEADER}\n${regions.map(formatRecallLine).join("\n")}`;
}

/**
 * One appendix line: `- E3: 2026-11-17 11:02 | 4 messages, 812 tokens | user: "..."`.
 *
 * The ref is not the only label: a reader that wants a decision recorded at 11:02 can
 * pick the region by what the line says instead of recalling several to find it.
 */
export function formatRecallLine(region: RecallRegion): string {
	const count = region.to - region.from + 1;
	const tokens = region.tokens > 0 ? `${region.tokens} tokens` : "unknown size";
	return `- ${region.ref}: ${region.preview} | ${count} ${count === 1 ? "entry" : "entries"}, ${tokens}`;
}

/** Token estimate of one entry, over its model-visible projection. */
export function estimateEntryTokens(entry: SessionEntry): number {
	let tokens = 0;
	for (const message of sessionEntryToContextMessages(entry)) {
		tokens += estimateProjectedTokens(message);
	}
	return tokens;
}

/**
 * Cheap char/4 estimate. The exact counter lives in the compaction barrel, which the
 * appendix cannot import: this module runs on every summary write and only needs a
 * number good enough to group entries.
 */
function estimateProjectedTokens(message: unknown): number {
	const typed = message as { role?: string; content?: unknown };
	let chars = 0;
	if (typed.role === "assistant" && Array.isArray(typed.content)) {
		for (const block of typed.content) {
			if (!block || typeof block !== "object") continue;
			if ("text" in block && typeof block.text === "string") chars += block.text.length;
			if ("thinking" in block && typeof block.thinking === "string") chars += block.thinking.length;
			if ("arguments" in block) chars += JSON.stringify(block.arguments).length;
			if ("name" in block && typeof block.name === "string") chars += block.name.length;
		}
	} else {
		chars += textOf(typed.content).length;
	}
	return Math.ceil(chars / 4);
}
