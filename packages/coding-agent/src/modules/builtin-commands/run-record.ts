/**
 * Chat row for run records (`custom` entries of type `run`). Records carry no model content, so
 * something has to say that the last run failed and `/retry` can replay it.
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
	if (!data || data.outcome !== "failed") return undefined;
	const attempts = data.attempts > 0 ? ` after ${data.attempts} attempt${data.attempts === 1 ? "" : "s"}` : "";
	const reason = data.errorMessage ? `: ${data.errorMessage}` : "";
	return new Text(theme.fg("dim", `Run failed${attempts}${reason}. /retry replays it.`), 0, 0);
}

export function registerRunRecord(pi: ModuleApi): void {
	pi.registerEntryRenderer<RunRecordData>(RUN_RECORD_CUSTOM_TYPE, renderRunRecord);
}
