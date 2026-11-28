/**
 * Channels two extras agree on.
 *
 * `pi-subagent-mini` writes its running jobs and `pi-ui` draws them as rows of
 * one exploring block. Neither package imports the other, so the agreement
 * lives here instead of in a widget-key string duplicated at both ends.
 *
 * The view channel carries a read-only snapshot of every job the session has
 * seen. It is data, not a widget: the producer writes it, the viewer reads the
 * latest value when it opens. No component subscribes to it as a widget, so it
 * never competes with the live rows under the editor.
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

/** One job as shown in the read-only viewer. All fields are pre-formatted. */
export interface SubagentViewEntry {
	id: string;
	status: string;
	/** Seconds since the job started, formatted for display. */
	elapsed: string;
	scope: string;
	/** Status line: cwd, tools, attempts — shown while no report exists yet. */
	detail: string;
	report: string;
}

/** Snapshot of every job, consumed by the read-only viewer. */
export interface SubagentViewContent {
	label: "subagent views";
	kind: "view";
	jobs: readonly SubagentViewEntry[];
}

export const SUBAGENT_VIEW_CHANNEL: ModuleWidgetChannel<SubagentViewContent> = {
	name: "subagent-view",
	is(value): value is SubagentViewContent {
		if (!value || typeof value !== "object") return false;
		const record = value as Record<string, unknown>;
		if (record.label !== "subagent views" || record.kind !== "view" || !Array.isArray(record.jobs)) return false;
		return record.jobs.every(
			(job) =>
				job !== null &&
				typeof job === "object" &&
				["id", "status", "elapsed", "scope", "detail", "report"].every(
					(field) => typeof (job as Record<string, unknown>)[field] === "string",
				),
		);
	},
};
