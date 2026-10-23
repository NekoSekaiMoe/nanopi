/**
 * Channels two extras agree on.
 *
 * `pi-subagent-mini` writes its running jobs and `pi-ui` draws them as rows of
 * one exploring block. Neither package imports the other, so the agreement
 * lives here instead of in a widget-key string duplicated at both ends.
 */

import type { ModuleWidgetChannel } from "@nanopi/pi-coding-agent";

/** Rows of running subagent jobs, one job per row, already coloured. */
export interface SubagentRowsContent {
	label: "subagent jobs";
	kind: "rows";
	rows: readonly string[];
}

export const SUBAGENT_CHANNEL: ModuleWidgetChannel<SubagentRowsContent> = {
	name: "subagent",
	is(value): value is SubagentRowsContent {
		if (!value || typeof value !== "object") return false;
		const record = value as Record<string, unknown>;
		return (
			record.label === "subagent jobs" &&
			record.kind === "rows" &&
			Array.isArray(record.rows) &&
			record.rows.every((row) => typeof row === "string")
		);
	},
};
