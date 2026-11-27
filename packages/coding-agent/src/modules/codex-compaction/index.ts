/**
 * Built-in compaction module (default for every session).
 *
 * `compact.ts` takes over every compaction (manual `/compact`, threshold,
 * overflow) with a Codex-style handoff summary plus verbatim retention of
 * recent user messages across the cut. `session_compact` appends Codex's
 * post-compaction warning, a TUI-only transcript row that is never sent to the
 * LLM.
 *
 * Recall lives in this module too. Key Facts are written by `compact.ts`;
 * `recall.ts` appends the `E<n>` region table; `citations.ts` resolves `[rN]`
 * tags. `recall-tool.ts` owns the single `recall_context` tool that reads all
 * three ref shapes.
 */

import { Text } from "@nanopi/pi-tui";
import type { CompactionResult } from "../../core/compaction/index.ts";
import type {
	ModuleActionsSurface,
	ModuleContext,
	ModuleEventsSurface,
	ModuleRenderingSurface,
	ModuleToolsSurface,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
} from "../../core/modules/types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { DEFAULT_USER_RETAIN_TOKENS, runCodexCompaction } from "./compact.ts";
import {
	DEFAULT_RECALL_MAX_TOKENS,
	describeRecallRegions,
	formatRecallAppendix,
	RECALL_DETAILS_KEY,
	type RecallRegion,
} from "./recall.ts";
import { registerRecallTool } from "./recall-tool.ts";

/** TUI-only entry type for the post-compaction warning. */
const WARNING_ENTRY = "codex-compaction:warning";

/** Drop null-valued provider headers; the summarization call wants plain strings. */
function normalizeHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (typeof value === "string") out[key] = value;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** Codex's post-compaction warning (`codex-rs/core/src/compact.rs`). */
const COMPACTION_WARNING =
	"Heads up: long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted.";

export default function codexCompactionExtension(
	pi: ModuleEventsSurface & ModuleActionsSurface & ModuleRenderingSurface & ModuleToolsSurface,
): void {
	const config = { userRetainTokens: DEFAULT_USER_RETAIN_TOKENS, compactionIndex: 0 };

	pi.on("session_before_compact", (event, ctx) => compactBefore(event, ctx, config));
	registerRecallTool(pi);
	pi.on("session_compact", () => pi.appendEntry(WARNING_ENTRY));
	pi.registerEntryRenderer(WARNING_ENTRY, (_entry, _options, theme) => {
		const icon = theme.fg("warning", "⚠");
		return new Text(`${icon} ${theme.fg("dim", COMPACTION_WARNING)}`, 0, 0);
	});
}

/** One compaction handler: summarize on pass one, append the region table on pass two. */
export async function compactBefore(
	event: SessionBeforeCompactEvent,
	ctx: ModuleContext,
	config: { userRetainTokens: number; compactionIndex: number },
): Promise<SessionBeforeCompactResult | undefined> {
	const regions = recallRegions(event);
	if (regions) {
		// The summarizer already produced the text. Only rewrite the appendix here,
		// whatever model (or none) produced it.
		return { compaction: appendRecallRegions({ summary: event.replacedSummary }, regions) };
	}
	const model = ctx.model;
	if (!model) return undefined;
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return undefined;
		const compaction = await runCodexCompaction(
			event,
			model,
			{ apiKey: auth.apiKey, headers: normalizeHeaders(auth.headers), env: auth.env },
			config,
			ctx.thinkingLevel,
			ctx.modelRegistry.streamFn,
		);
		if (compaction) {
			const details = compaction.details as { facts?: unknown[] } | undefined;
			if (details?.facts?.length) config.compactionIndex++;
			return { compaction };
		}
	} catch {
		// Fall through: the default compaction is the safety net.
	}
	return undefined;
}

/** Register only the recall tool, for callers that do not need the whole module. */
export { registerRecallTool as registerCompactionRecallTool };

/** The region table is derived from the branch, independent of the summarizer. */
function recallRegions(event: SessionBeforeCompactEvent): RecallRegion[] | undefined {
	// The dispatch calls this handler twice: once before any summary exists, then
	// again with the written text. Only the second pass can append the appendix.
	if (!event.replacedSummary) return undefined;
	const regions = describeRecallRegions(event.branchEntries, DEFAULT_RECALL_MAX_TOKENS);
	return formatRecallAppendix(regions) ? regions : undefined;
}

function appendRecallRegions(
	compaction: Partial<CompactionResult>,
	regions: RecallRegion[],
): Partial<CompactionResult> {
	return {
		...compaction,
		summary: `${compaction.summary ?? ""}${formatRecallAppendix(regions)}`,
		details: withRecallDetails(compaction.details, regions),
	};
}

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
