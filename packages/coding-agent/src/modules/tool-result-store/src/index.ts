/**
 * Recall for tool output that was too large to keep in the model context.
 *
 * `read`, `grep`, `find` and `ls` store the full text when they truncate. The
 * model gets a short notice with a ref; this tool reads that text back in
 * bounded pages, so recalling one result cannot spend the whole context again.
 */

import { Text } from "@nanopi/pi-tui";
import type { ModuleApi, ModuleToolsSurface } from "../../../core/modules/types.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { readToolResult } from "../../../utils/tool-result-store.ts";
import { type Static, Type } from "typebox";

const MAX_RECALL_BYTES = 50 * 1024;

const recallParams = Type.Object({
	ref: Type.String({ description: "Tool result ref from a truncation notice, e.g. grep-0123456789abcdef" }),
	offset: Type.Optional(Type.Number({ description: "Byte offset in the stored result (default: 0)" })),
});

type RecallParams = Static<typeof recallParams>;

export function registerToolResultStoreTools(pi: ModuleToolsSurface): void {
	pi.registerTool({
		name: "recall_tool_result",
		label: "Recall tool result",
		description:
			"Read a page of a truncated read/grep/find/ls result by its ref. Each call returns at most 50KB; use offset from the previous reply to continue.",
		promptSnippet: "Recall truncated tool output",
		promptGuidelines: [
			"When a tool result says it was saved with a ref, call recall_tool_result for the part you need instead of re-running the whole search.",
		],
		annotations: { readOnlyHint: true },
		parameters: recallParams,
		async execute(_toolCallId, params: RecallParams, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const page = await readToolResult(ctx.getAgentDir(), params.ref, params.offset ?? 0, MAX_RECALL_BYTES);
			const lines = [
				`[tool result ${params.ref}: bytes ${page.startByte}-${page.endByte} of ${page.totalBytes}${page.truncated ? ", more available" : ", end of result"}]`,
				page.text,
			];
			if (page.truncated) lines.push(`[Use offset=${page.endByte} to continue.]`);
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: undefined };
		},
		renderCall(args: RecallParams, theme: Theme) {
			const offset = args.offset ? ` @${args.offset}` : "";
			return new Text(theme.fg("toolTitle", "recall_tool_result ") + theme.fg("muted", `${args.ref}${offset}`), 0, 0);
		},
	});
}

export default function toolResultStoreExtension(pi: ModuleApi): void {
	registerToolResultStoreTools(pi);
}
