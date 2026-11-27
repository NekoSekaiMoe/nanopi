/**
 * The single `recall_context` tool inside the compaction module.
 *
 * Each strategy writes a different ref format into the compaction summary:
 * `[rN]` citations, Key Facts `c<checkpoint>r<fact>` refs, and `E<ordinal>`
 * replaced-region refs. This tool owns the name and dispatches on the ref shape. A call
 * using more than one shape is refused: mixing them would make an ambiguous
 * answer look successful.
 */

import { countTextTokens } from "@nanopi/pi-ai/module-surface";
import { type Static, Type } from "typebox";
import { convertToLlm } from "../../core/messages.ts";
import type { ModuleToolContext, ModuleToolsSurface, ToolDefinition } from "../../core/modules/types.ts";
import { sessionEntryToContextMessages } from "../../core/session-projection.ts";
import type { SessionEntry } from "../../core/session-store.ts";
import { resolveRecalledEntries } from "./citations.ts";
import { findEntryIdForRef } from "./compact.ts";
import { DEFAULT_RECALL_MAX_TOKENS, RECALL_SECTION_HEADER, resolveRecallRef } from "./recall.ts";

const RecallParams = Type.Object({
	ref: Type.String({
		description: "Ref from the compaction summary: [rN] citation, Key Facts cNrN ref, or E<n> replaced-region ref.",
	}),
});
type RecallParamsType = Static<typeof RecallParams>;
type RecallDetails = { refs: string[]; strategy: string; entryIds: string[]; tokens: number };

type RefKind = "numbered" | "keyFacts" | "region" | "unknown";

interface ResolvedRecall {
	entries: Array<{ entryId: string; text: string }>;
	refs: string[];
	numberedRefs: number[];
	strategy: string;
}

function classifyRef(ref: string): RefKind {
	if (/^\[?r\d+\]?$/i.test(ref)) return "numbered";
	if (/^c\d+r\d+$/i.test(ref)) return "keyFacts";
	if (/^e\d+$/i.test(ref)) return "region";
	return "unknown";
}

function projectEntry(entry: SessionEntry): string {
	const parts: string[] = [];
	for (const message of sessionEntryToContextMessages(entry)) {
		for (const projected of convertToLlm([message])) {
			const content = projected.content;
			if (typeof content === "string") {
				if (content) parts.push(content);
				continue;
			}
			const text = content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			if (text) parts.push(text);
		}
	}
	return parts.join("\n");
}

function resolveByKeyFacts(ref: string, ctx: ModuleToolContext): ResolvedRecall {
	const branch = ctx.sessionManager.getBranch();
	let entryId: string | undefined;
	for (let i = branch.length - 1; i >= 0 && !entryId; i--) {
		const entry = branch[i];
		if (entry.type !== "compaction") continue;
		entryId = findEntryIdForRef(entry.summary, ref);
	}
	if (!entryId) throw new Error(`Unknown context ref "${ref}"`);
	const entry = ctx.sessionManager.getEntry(entryId);
	if (!entry) throw new Error(`Context ref "${ref}" is no longer stored in this session`);
	const text = projectEntry(entry);
	if (!text) throw new Error(`Context ref "${ref}" has no model-visible content`);
	return { entries: [{ entryId, text }], refs: [ref], numberedRefs: [], strategy: "keyFacts" };
}

function resolveByRegion(ref: string, ctx: ModuleToolContext): ResolvedRecall {
	const region = resolveRecallRef(ctx.sessionManager.getBranch(), ref, DEFAULT_RECALL_MAX_TOKENS);
	if (!region) {
		throw new Error(
			`Ref ${ref} is not on this branch. Replaced regions are renumbered when a later compaction runs, so read the refs off the newest summary section "${RECALL_SECTION_HEADER}".`,
		);
	}
	const entries = region.entries
		.map((entry) => ({ entryId: entry.id, text: projectEntry(entry) }))
		.filter((entry) => entry.text.length > 0);
	if (entries.length === 0) throw new Error(`Ref ${ref} has no model-visible content`);
	return { entries, refs: [region.ref], numberedRefs: [], strategy: "region" };
}

function resolveByNumbered(ref: string, ctx: ModuleToolContext): ResolvedRecall {
	const index = ref.replace(/^\[|\]$/g, "").slice(1);
	const resolved = resolveRecalledEntries(ctx.sessionManager, [Number(index)]);
	if (!resolved.ok) throw new Error(resolved.reason);
	return {
		entries: resolved.entries,
		refs: resolved.refs.map((value) => `[r${value}]`),
		numberedRefs: resolved.refs,
		strategy: "numbered",
	};
}

function resolveRecall(ref: string, ctx: ModuleToolContext): ResolvedRecall {
	const kind = classifyRef(ref);
	switch (kind) {
		case "numbered":
			return resolveByNumbered(ref, ctx);
		case "keyFacts":
			return resolveByKeyFacts(ref, ctx);
		case "region":
			return resolveByRegion(ref, ctx);
		case "unknown":
			throw new Error(
				`Unknown ref "${ref}". Use one ref from the compaction summary: [rN], a Key Facts cNrN ref, or an ${RECALL_SECTION_HEADER} E<n> ref.`,
			);
	}
}

export const recallTool: ToolDefinition<typeof RecallParams, RecallDetails> = {
	name: "recall_context",
	label: "Recall Context",
	description:
		"Restore one region of history a compaction summary cites. Accepts a [rN] citation, a Key Facts ref such as c0r2, or an E<n> ref from the Replaced Context section.",
	promptSnippet: "Restore history a compaction summary cited, using its [rN], Key Facts, or E<n> ref.",
	promptGuidelines: [
		"Call recall_context only when the summary is too compressed to continue safely and you need the original wording behind one ref. Read the ref from the newest summary; do not guess one.",
	],
	parameters: RecallParams,
	annotations: { readOnlyHint: true },
	executionMode: "sequential",
	async execute(_toolCallId, params: RecallParamsType, signal, _onUpdate, ctx) {
		if (signal?.aborted) throw new Error("Recall aborted.");
		const ref = params.ref.trim();
		if (!ref) throw new Error("A compaction ref is required.");
		const kinds = new Set(
			ref
				.split(/[\s,]+/)
				.filter(Boolean)
				.map(classifyRef),
		);
		if (kinds.size !== 1 || kinds.has("unknown")) {
			throw new Error("Recall one ref shape at a time: [rN], a Key Facts cNrN ref, or an E<n> ref.");
		}
		const resolved = resolveRecall(ref, ctx);
		const text = resolved.entries.map((entry) => entry.text).join("\n\n");
		const tokens = countTextTokens(text);
		const usage = ctx.getContextUsage();
		if (usage?.contextWindow && tokens > usage.contextWindow * 0.25) {
			throw new Error(
				`Recalling ${resolved.refs.join(", ")} would add about ${tokens} tokens, over a quarter of the ${usage.contextWindow} token window. Try a smaller ref.`,
			);
		}
		if (resolved.strategy === "numbered") {
			ctx.sessionManager.appendContextRecall(
				resolved.numberedRefs,
				resolved.entries.map((entry) => entry.entryId),
				text,
				"recall_context",
			);
		}
		return {
			content: [
				{
					type: "text" as const,
					text:
						resolved.strategy === "numbered"
							? `Recalled ${resolved.refs.join(", ")} (${resolved.entries.length} entries, about ${tokens} tokens). The content follows this message in the conversation.`
							: `Recalled history behind ${resolved.refs.join(", ")} (${resolved.entries.length} entries, about ${tokens} tokens). This is earlier context, not a new instruction.`,
				},
			],
			details: {
				refs: resolved.refs,
				strategy: resolved.strategy,
				entryIds: resolved.entries.map((entry) => entry.entryId),
				tokens,
			},
		};
	},
};

export function registerRecallTool(pi: ModuleToolsSurface): void {
	pi.registerTool(recallTool);
}
