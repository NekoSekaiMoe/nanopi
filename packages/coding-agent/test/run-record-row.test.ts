import type { AssistantMessage } from "@nanopi/pi-ai";
import { describe, expect, test } from "vitest";
import type { EntryRenderer, EntryRenderOptions, ModuleApi } from "../src/core/modules/types.ts";
import { RUN_RECORD_CUSTOM_TYPE, type RunRecordData } from "../src/core/run-record.ts";
import type { CustomEntry } from "../src/core/session-manager.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { registerRunRecord } from "../src/modules/builtin-commands/run-record.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function renderRow(data: RunRecordData): string | undefined {
	let renderer: EntryRenderer<RunRecordData> | undefined;
	const api = {
		registerEntryRenderer: (_type: string, render: EntryRenderer<RunRecordData>) => {
			renderer = render;
		},
	} as unknown as ModuleApi;
	registerRunRecord(api);
	if (!renderer) throw new Error("run record renderer was not registered");

	const entry: CustomEntry<RunRecordData> = {
		id: "entry-1",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		type: "custom",
		customType: RUN_RECORD_CUSTOM_TYPE,
		data,
	};
	const options: EntryRenderOptions = { expanded: false };
	const row = renderer(entry, options, theme);
	return row ? stripAnsi(row.render(100).join("\n")).trimEnd() : undefined;
}

function record(overrides: Partial<RunRecordData> = {}): RunRecordData {
	return {
		lastEntryId: "entry-0",
		stopReason: "error" satisfies AssistantMessage["stopReason"],
		turns: 1,
		outcome: "failed",
		attempts: 0,
		...overrides,
	};
}

describe("run record chat row", () => {
	initTheme();

	test("says the run failed without repeating the provider error", () => {
		const rendered = renderRow(record({ errorMessage: '402 "You have no remaining credits."' }));

		expect(rendered).toBe("Run failed. /retry replays it.");
	});

	test("keeps the attempt count", () => {
		expect(renderRow(record({ attempts: 1, errorMessage: "overloaded_error" }))).toBe(
			"Run failed after 1 attempt. /retry replays it.",
		);
		expect(renderRow(record({ attempts: 3, errorMessage: "overloaded_error" }))).toBe(
			"Run failed after 3 attempts. /retry replays it.",
		);
	});

	test("does not call an aborted run a failure", () => {
		expect(renderRow(record({ stopReason: "aborted", errorMessage: "Request was aborted" }))).toBe(
			"Run was aborted. /retry replays it.",
		);
	});

	test("renders nothing for a completed run", () => {
		expect(renderRow(record({ outcome: "completed", stopReason: "stop" }))).toBeUndefined();
	});
});
