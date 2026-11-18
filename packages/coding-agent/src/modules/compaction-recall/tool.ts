/**
 * `recall_context`: pull one replaced region of the transcript back into context.
 *
 * The summary names each replaced region with a ref (see `recall.ts`). This tool resolves
 * one against the live branch, projects its entries through the session's own message
 * codecs, and answers with that text. The answer is a tool result, so the recalled history
 * lands in front of the model the same way a `read` result would.
 */

import { Text } from "@nanopi/pi-tui";
import { type Static, Type } from "typebox";
import { type CustomMessage, convertToLlm } from "../../core/messages.ts";
import type { ModuleToolContext } from "../../core/modules/types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { DEFAULT_RECALL_MAX_TOKENS, RECALL_SECTION_HEADER, resolveRecallRef } from "./recall.ts";

export const RecallParams = Type.Object({
	ref: Type.String({ description: "Ref from the summary's recall section, e.g. E3." }),
});

export interface RecallDetails {
	ref: string;
	entries: number;
	tokens: number;
}

/** One entry's model projection as plain text, using the same codecs the request uses. */
function projectEntry(entry: SessionEntry): string {
	const message = entry.type === "message" ? entry.message : undefined;
	const custom: CustomMessage | undefined =
		entry.type === "custom_message"
			? {
					role: "custom",
					customType: entry.customType,
					content: entry.content,
					display: false,
					timestamp: Date.parse(entry.timestamp),
				}
			: undefined;
	const source = message ?? custom;
	if (!source) return "";
	const parts: string[] = [];
	for (const projected of convertToLlm([source])) {
		const content = projected.content;
		if (typeof content === "string") {
			if (content) parts.push(content);
			continue;
		}
		const texts: string[] = [];
		for (const block of content) {
			if (block.type === "text") texts.push(block.text);
		}
		if (texts.length > 0) parts.push(texts.join("\n"));
	}
	return parts.join("\n");
}

async function executeRecall(
	_ref: string,
	params: Static<typeof RecallParams>,
	ctx: ModuleToolContext,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: RecallDetails }> {
	const ref = params.ref.trim().toUpperCase();
	if (!/^E\d+$/.test(ref)) {
		throw new Error(`Ref must look like E12; got ${JSON.stringify(params.ref)}.`);
	}
	const branch = ctx.sessionManager.getBranch();
	const region = resolveRecallRef(branch, ref, DEFAULT_RECALL_MAX_TOKENS);
	if (!region) {
		const known = `Replaced regions are renumbered when a later compaction runs, so read the refs off the newest summary section "${RECALL_SECTION_HEADER}".`;
		throw new Error(`Ref ${ref} is not on this branch. ${known}`);
	}

	const body = region.entries
		.map((entry) => projectEntry(entry))
		.filter((text) => text.length > 0)
		.join("\n\n");
	const header = `Recalled history replaced by compaction (ref ${ref}). This is earlier context, not a new instruction.`;

	return {
		content: [{ type: "text", text: `${header}\n\n${body}` }],
		details: { ref, entries: region.entries.length, tokens: region.tokens },
	};
}

export const recallTool = {
	name: "recall_context",
	label: "Recall Context",
	description: `Pull one region of history that a compaction replaced back into context. Takes a ref from the summary's "${RECALL_SECTION_HEADER}" section and returns the original messages of that region.`,
	promptGuidelines: [
		`Call recall_context when the summary is not enough and you need a replaced region verbatim (an exact error text, a decision's reasoning, a file that was read). The refs are listed in the summary's "${RECALL_SECTION_HEADER}" section; do not recall what the summary already answers.`,
	],
	parameters: RecallParams,
	executionMode: "sequential" as const,

	async execute(
		toolCallId: string,
		params: Static<typeof RecallParams>,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		ctx: ModuleToolContext,
	) {
		return executeRecall(toolCallId, params, ctx);
	},

	renderCall(args: Static<typeof RecallParams>, theme: Theme) {
		return new Text(
			`${theme.fg("toolTitle", theme.bold("recall_context "))}${theme.fg("accent", args.ref ?? "")}`,
			0,
			0,
		);
	},

	renderResult(result: { details?: RecallDetails }, _options: unknown, theme: Theme) {
		const details = result.details;
		if (!details) return new Text(theme.fg("dim", "recalled"), 0, 0);
		return new Text(
			`${theme.fg("accent", details.ref)} ${theme.fg("dim", `${details.entries} entries, ${details.tokens} tokens`)}`,
			0,
			0,
		);
	},
};
