/**
 * The `recall_context` tool: puts session content a compaction summary cited back in front of
 * the model.
 *
 * The tool does not answer with the recalled text in its result. A tool result is context the
 * model reads once and the next compaction summarizes away again; the point of a citation is
 * that the text stays readable, so the tool appends a `context_recall` entry and the projection
 * replays it. The result only says which entries came back and how much they cost.
 */

import { countTextTokens } from "@nanopi/pi-ai/module-surface";
import { Type } from "typebox";
import type { ModuleToolContext, ModuleToolsSurface, ToolDefinition } from "../../core/modules/types.ts";
import { resolveRecalledEntries } from "./resolve.ts";

const RecallParams = Type.Object({
	refs: Type.Array(Type.Integer({ minimum: 1 }), {
		minItems: 1,
		description: "The [rN] tag numbers to recall, without brackets. Example: [1, 3] recalls [r1] and [r3].",
	}),
});

type RecallTool = ToolDefinition<typeof RecallParams>;

function buildRecalledText(entries: { text: string }[]): string {
	return entries.map((entry) => entry.text).join("\n\n---\n\n");
}

export function registerRecallTool(pi: ModuleToolsSurface): void {
	const tool: RecallTool = {
		name: "recall_context",
		label: "Recall context",
		description:
			"Read back conversation that a compaction summary cites as [rN]. Use it when the summary names a tag whose detail you need exactly (an error, a path, a decision). The recalled text is added to the conversation and stays readable.",
		promptSnippet: "Read back history a compaction summary cited as [rN].",
		parameters: RecallParams,
		annotations: { readOnlyHint: true },
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx: ModuleToolContext) {
			if (signal?.aborted) throw new Error("Recall aborted.");
			const refs = [...new Set(params.refs)];
			const resolved = resolveRecalledEntries(ctx.sessionManager, refs);
			if (!resolved.ok) throw new Error(resolved.reason);

			const text = buildRecalledText(resolved.entries);
			const tokens = countTextTokens(text);
			const usage = ctx.getContextUsage();
			if (usage?.contextWindow && tokens > usage.contextWindow * 0.25) {
				throw new Error(
					`Recalling ${resolved.refs.map((ref) => `[r${ref}]`).join(", ")} would add about ${tokens} tokens, over a quarter of the ${usage.contextWindow} token window. Recall fewer tags.`,
				);
			}

			ctx.sessionManager.appendContextRecall(
				resolved.refs,
				resolved.entries.map((entry) => entry.entryId),
				text,
				"recall_context",
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Recalled ${resolved.refs.map((ref) => `[r${ref}]`).join(", ")} (${resolved.entries.length} entries, about ${tokens} tokens). The content follows this message in the conversation.`,
					},
				],
				details: { refs: resolved.refs, entryIds: resolved.entries.map((entry) => entry.entryId), tokens },
			};
		},
	};
	pi.registerTool(tool);
}
