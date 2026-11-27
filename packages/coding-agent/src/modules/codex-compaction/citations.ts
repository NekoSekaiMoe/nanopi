/**
 * Turning a `[rN]` citation into the entry behind it.
 *
 * A summary cites tags, not ids: `[r2]` means "the second thing I cited", and the summary's
 * `<refs>` block is what says which session entry that was. Resolution therefore needs both
 * halves, and it has to fail loudly rather than substitute a neighbouring entry: a recalled
 * block that answers a different question than the citation is worse than none.
 */

/**
 * The writer is the compaction prompt (`SUMMARY_REF_INSTRUCTIONS` in the compaction package);
 * the reader lives here so that package's entry graph does not grow for a parser only this
 * module calls.
 */

/** `[r1]`, the tag written after a line that points at a recoverable session entry. */
const REF_PATTERN = /\[r(\d+)\]/g;

/** The `<refs>` block, which defines what each tag index stands for. */
const REFS_BLOCK = /<refs>([\s\S]*?)<\/refs>/;

/** Tag index to the entry ids it cites. */
export type SummaryRefs = Map<number, string[]>;

/**
 * Read the `<refs>` block: one bullet per tag index, listing the entry ids it stands for.
 * A tag the block never defines resolves to no entries, which the caller reports as unusable
 * instead of guessing.
 */
export function parseSummaryRefs(summary: string): SummaryRefs {
	const byIndex: SummaryRefs = new Map();
	const block = REFS_BLOCK.exec(summary);
	if (!block) return byIndex;

	for (const line of block[1].split("\n")) {
		const bullet = /^\s*[-*]\s*\[r(\d+)\]\s*(.*)$/.exec(line);
		if (!bullet) continue;
		const index = Number.parseInt(bullet[1], 10);
		if (!Number.isSafeInteger(index)) continue;
		const entryIds = bullet[2]
			.split(/[\s,]+/)
			.map((token) => token.trim().replace(/^[`"'([{]+|[`"'\])}.,;:]+$/g, ""))
			.filter((token) => token.length > 0);
		byIndex.set(index, entryIds);
	}
	return byIndex;
}

/** Tag indexes a summary cites in its body, ignoring the `<refs>` block that defines them. */
export function citedRefIndexes(summary: string): number[] {
	const body = summary.replace(REFS_BLOCK, "");
	const seen = new Set<number>();
	const indexes: number[] = [];
	for (const match of body.matchAll(REF_PATTERN)) {
		const index = Number.parseInt(match[1], 10);
		if (!Number.isSafeInteger(index) || seen.has(index)) continue;
		seen.add(index);
		indexes.push(index);
	}
	return indexes;
}

import type { AgentMessage } from "@nanopi/pi-agent-core";
import { convertToLlm, createCustomMessage } from "../../core/messages.ts";
import type { ReadonlySessionManager } from "../../core/session-manager.ts";
import { sessionEntryToContextMessages } from "../../core/session-projection.ts";
import type { SessionEntry } from "../../core/session-store.ts";

/** One recalled entry, rendered as text. */
export interface RecalledEntry {
	entryId: string;
	text: string;
}

/** Outcome of resolving tags against the newest summary in the session. */
export type ResolveResult = { ok: true; entries: RecalledEntry[]; refs: number[] } | { ok: false; reason: string };

/** Whether the active branch holds a compaction summary, i.e. whether a `[rN]` can exist. */
export function hasCompactionSummary(session: ReadonlySessionManager): boolean {
	return latestSummary(session) !== undefined;
}

/** The newest compaction summary the session still holds, if any. */
function latestSummary(session: ReadonlySessionManager): { summary: string; entryId: string } | undefined {
	const branch = session.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "compaction" && entry.summary) return { summary: entry.summary, entryId: entry.id };
	}
	return undefined;
}

/** Text of one entry, as the model would have read it before compaction. */
function renderEntry(entry: SessionEntry): string {
	const messages = sessionEntryToContextMessages(entry);
	const parts: string[] = [];
	for (const message of messages) parts.push(renderMessage(message));
	return parts.join("\n\n").trim();
}

/** One message as plain text. Providers see the projection, not the message's own kind. */
function renderMessage(message: AgentMessage): string {
	if (message.role === "custom") {
		const text = createCustomMessage(
			message.customType,
			message.content,
			message.display,
			message.details,
			new Date(message.timestamp).toISOString(),
		);
		return convertToLlm([text])
			.map((projected) => (typeof projected.content === "string" ? projected.content : ""))
			.join("\n")
			.trim();
	}
	if (message.role === "branchSummary" || message.role === "compactionSummary") return message.summary;
	return convertToLlm([message])
		.map((projected) => {
			if (typeof projected.content === "string") return projected.content;
			return projected.content.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");
		})
		.join("\n")
		.trim();
}

/**
 * Resolve `refs` against the newest summary, dropping entries that are still in the kept
 * region: recalling what the model can already read spends context on a duplicate.
 */
export function resolveRecalledEntries(session: ReadonlySessionManager, refs: number[]): ResolveResult {
	const summary = latestSummary(session);
	if (!summary) return { ok: false, reason: "No compaction summary in this session, so there is no [rN] to recall." };

	const parsed = parseSummaryRefs(summary.summary);
	if (parsed.size === 0) {
		return { ok: false, reason: "The newest compaction summary has no <refs> block, so no [rN] can be resolved." };
	}
	const cited = new Set(citedRefIndexes(summary.summary));
	const usable = refs.filter((ref) => cited.has(ref));
	if (usable.length === 0) {
		const known = [...cited]
			.sort((left, right) => left - right)
			.map((ref) => `[r${ref}]`)
			.join(", ");
		return {
			ok: false,
			reason: known
				? `The summary cites ${known}; none of ${refs.map((ref) => `[r${ref}]`).join(", ")} is one of them.`
				: "The summary cites no [rN] tags.",
		};
	}

	// Entries the model still sees after the checkpoint: recalling one of those is a copy.
	const visible = new Set(session.buildContextEntries().map((entry) => entry.id));
	const entries: RecalledEntry[] = [];
	const missing: number[] = [];
	for (const ref of [...new Set(usable)].sort((left, right) => left - right)) {
		const entryIds = parsed.get(ref) ?? [];
		if (entryIds.length === 0) {
			missing.push(ref);
			continue;
		}
		for (const entryId of entryIds) {
			if (visible.has(entryId)) continue;
			const entry = session.getEntry(entryId);
			if (!entry) {
				missing.push(ref);
				continue;
			}
			const text = renderEntry(entry);
			if (text) entries.push({ entryId, text });
		}
	}

	if (entries.length === 0) {
		if (missing.length > 0) {
			return {
				ok: false,
				reason: `The summary cites ${missing.map((ref) => `[r${ref}]`).join(", ")} but no entry in this session still has that content (the session may have been forked).`,
			};
		}
		return { ok: false, reason: "Those entries are still in the kept part of the context; nothing to recall." };
	}
	return { ok: true, entries, refs: usable };
}
