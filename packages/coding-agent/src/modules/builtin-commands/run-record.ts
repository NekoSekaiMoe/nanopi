/**
 * Chat row for run records (`custom` entries of type `run`). Records carry no model content, so
 * something has to say that the last run failed and `/retry` can replay it.
 *
 * The row carries no reason: the failed assistant message ends with the same text, and a tool call
 * records its own error, so repeating it here only echoed a multi-line provider error twice.
 */

import { Text } from "@nanopi/pi-tui";
import type { EntryRenderOptions, ModuleApi } from "../../core/modules/types.ts";
import { getRunRecordData, RUN_RECORD_CUSTOM_TYPE, type RunRecordData } from "../../core/run-record.ts";
import type { CustomEntry } from "../../core/session-manager.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";

function renderRunRecord(
	entry: CustomEntry<RunRecordData>,
	_options: EntryRenderOptions,
	theme: Theme,
): Text | undefined {
	const data = getRunRecordData(entry);
	if (data?.outcome !== "failed") return undefined;
	const reason = data.stopReason === "aborted" || !data.errorMessage ? "Run was aborted" : "Run failed";
	const attempts = data.attempts > 0 ? ` after ${data.attempts} attempt${data.attempts === 1 ? "" : "s"}` : "";
	return new Text(theme.fg("dim", `${reason}${attempts}. /retry replays it.`), 0, 0);
}

export function registerRunRecord(pi: ModuleApi): void {
	pi.registerEntryRenderer<RunRecordData>(RUN_RECORD_CUSTOM_TYPE, renderRunRecord);
}
