/**
 * Compaction recall: the summary says what it replaced, and the model can ask for one
 * replaced region back.
 *
 * 1. `session_before_compact` appends a "Replaced Context (recallable)" section to the
 *    summary the compaction is about to write. The handler may run twice: once before any
 *    summary exists (and answers nothing), then again with the written text in
 *    `replacedSummary`. The region table also goes into `details`, so a reader resolves
 *    a ref without parsing the summary.
 * 2. The refs it writes are resolved by the `recall_context` tool in the
 *    `context-recall-coordinator` module.
 *
 * The session format does not change: a ref is an ordinal over the branch, so `E3` names
 * the same region after a reload. A later compaction renumbers the regions, which is why
 * the appendix is rewritten on each compaction rather than accumulated.
 */

import type {
	ModuleEventsSurface,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
} from "../../core/modules/types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import {
	DEFAULT_RECALL_MAX_TOKENS,
	describeRecallRegions,
	formatRecallAppendix,
	RECALL_DETAILS_KEY,
	type RecallRegion,
} from "./recall.ts";

export default function compactionRecallExtension(pi: ModuleEventsSurface): void {
	pi.on("session_before_compact", (event: SessionBeforeCompactEvent): SessionBeforeCompactResult | undefined => {
		const summary = event.replacedSummary;
		// Nothing written yet: this pass runs before the summary exists. The dispatch calls
		// the handler again with the text, which is the pass that appends the appendix.
		if (!summary) return undefined;
		const regions = describeRecallRegions(event.branchEntries, DEFAULT_RECALL_MAX_TOKENS);
		const appendix = formatRecallAppendix(regions);
		if (!appendix) return undefined;
		return {
			// Only the text and the ref table change; the cut point, token count and usage
			// stay those of the summary being rewritten.
			compaction: {
				summary: `${summary}${appendix}`,
				details: withRecallDetails(undefined, regions),
			},
		};
	});
}

/** Keep whatever `details` the summarizer wrote; add the ref table under its own key. */
function withRecallDetails(details: unknown, regions: RecallRegion[]): unknown {
	const base = details && typeof details === "object" ? (details as Record<string, unknown>) : {};
	return { ...base, [RECALL_DETAILS_KEY]: regions.map(toDetailsRegion) };
}

function toDetailsRegion(region: RecallRegion): Record<string, unknown> {
	return {
		ref: region.ref,
		from: region.from,
		to: region.to,
		firstEntryId: region.startEntryId,
		lastEntryId: region.endEntryId,
		tokens: region.tokens,
	};
}

/** Exported for tests: the regions a summary would list for this branch. */
export function regionsForBranch(branchEntries: SessionEntry[], maxTokens = DEFAULT_RECALL_MAX_TOKENS) {
	return describeRecallRegions(branchEntries, maxTokens);
}
