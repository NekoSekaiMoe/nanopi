/**
 * Built-in Codex-style compaction (default for every session).
 *
 * 1. `session_before_compact` — take over every compaction (manual `/compact`,
 *    threshold, overflow) and produce a Codex-style result: a handoff-framed
 *    summary plus verbatim retention of recent user messages across the cut
 *    point. See `compact.ts` for the mechanics and failure policy.
 *
 * 2. `session_compact` — append Codex's post-compaction warning as a TUI-only
 *    transcript row (never sent to the LLM). Codex emits the same warning after
 *    every compaction: long threads with multiple compactions degrade accuracy,
 *    so starting a new thread is the better fix when possible.
 *
 * 3. `recall_context` — restores the original messages behind a Key Facts ref.
 *    The ref-to-entry-id mapping lives in the stored summary, so it survives
 *    session resume; no in-memory ledger is needed.
 */

import { Text } from "@nanopi/pi-tui";
import type { Static } from "typebox";
import { Type } from "typebox";
import type {
	ModuleActionsSurface,
	ModuleEventsSurface,
	ModuleRenderingSurface,
	ModuleToolContext,
	ModuleToolsSurface,
} from "../../core/modules/types.ts";
import { sessionEntryToContextMessages } from "../../core/session-manager.ts";
import { DEFAULT_USER_RETAIN_TOKENS, runCodexCompaction } from "./compact.ts";

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

const RecallParams = Type.Object({
	ref: Type.String({ description: "Fact ref from a compaction summary's Key Facts block, for example c0r2" }),
});

/**
 * Resolve a ref by reading the Key Facts rows in every compaction summary on the
 * active branch. The row format is `- <ref>: <label> (entry <id>)`, written by
 * `formatKeyFacts()`. Reading it back keeps the contract to one line of text:
 * no separate sidecar file or custom entry type that could go missing.
 */
export function findEntryIdForRef(summaryText: string, ref: string): string | undefined {
	const pattern = new RegExp(`^-\\s+${escapeRegExp(ref)}:.*\\(entry ([^)]+)\\)$`, "m");
	return pattern.exec(summaryText)?.[1];
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default function codexCompactionExtension(
	pi: ModuleEventsSurface & ModuleActionsSurface & ModuleRenderingSurface & ModuleToolsSurface,
): void {
	const config = { userRetainTokens: DEFAULT_USER_RETAIN_TOKENS, compactionIndex: 0 };

	pi.registerTool({
		name: "recall_context",
		label: "Recall Context",
		description:
			"Restore the original messages behind one Key Facts ref in a compaction summary. Use it only when a summary is too compressed to continue safely.",
		promptSnippet: "Recall the verbatim messages behind a compaction summary fact ref",
		parameters: RecallParams,
		async execute(_toolCallId, params: Static<typeof RecallParams>, _signal, _onUpdate, ctx: ModuleToolContext) {
			const branch = ctx.sessionManager.getBranch();
			let entryId: string | undefined;
			for (let i = branch.length - 1; i >= 0 && !entryId; i--) {
				const entry = branch[i];
				if (entry.type !== "compaction") continue;
				entryId = findEntryIdForRef(entry.summary, params.ref);
			}
			if (!entryId) {
				return { content: [{ type: "text" as const, text: `Unknown context ref "${params.ref}"` }], details: {} };
			}
			const entry = ctx.sessionManager.getEntry(entryId);
			if (!entry) {
				return {
					content: [
						{ type: "text" as const, text: `Context ref "${params.ref}" is no longer stored in this session` },
					],
					details: {},
				};
			}
			const messages = sessionEntryToContextMessages(entry).map((message) => {
				const content = "content" in message ? message.content : "";
				const text =
					typeof content === "string"
						? content
						: content.map((block: { text?: string }) => block.text ?? "").join("\n");
				return `[${message.role}]: ${text}`;
			});
			return {
				content: [{ type: "text" as const, text: messages.join("\n\n") || "(no messages)" }],
				details: { ref: params.ref, entryId },
			};
		},
	});

	pi.on("session_before_compact", async (event, ctx) => {
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
	});

	pi.on("session_compact", () => {
		pi.appendEntry(WARNING_ENTRY);
	});

	pi.registerEntryRenderer(WARNING_ENTRY, (_entry, _options, theme) => {
		const icon = theme.fg("warning", "⚠");
		return new Text(`${icon} ${theme.fg("dim", COMPACTION_WARNING)}`, 0, 0);
	});
}
