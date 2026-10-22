/**
 * Tasks where the first attempt the model makes is wrong.
 *
 * These are the interesting prompt cases: the contract only pays off if the tool refuses the bad
 * edit with an actionable message and the model can recover on the next turn. A prompt change that
 * makes `edit` permissive (fuzzy duplicate matching, silent no-ops, picking the first occurrence)
 * turns these tasks green for the wrong reason, so each one asserts the refusal too.
 */

import { fauxAssistantMessage, fauxToolCall } from "@nanopi/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { Harness } from "../harness.ts";
import {
	createTaskHarness,
	failedCalls,
	readWorkspaceFile,
	recordRequests,
	seedFile,
	type TaskRecord,
} from "./task-network.ts";

const DUPLICATE_SOURCE = ["function a() {", "  return 1;", "}", "", "function b() {", "  return 1;", "}", ""].join(
	"\n",
);

const STALE_SOURCE = ["const flags = {", "  verbose: true,", "  color: false,", "};", ""].join("\n");

// Padded so the file exceeds the read tool's byte budget, not just its line budget.
const OVERSIZED_SOURCE = `${Array.from({ length: 80 }, (_, index) => `line ${index + 1} ${"x".repeat(1000)}`).join("\n")}\n`;

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

async function runTask(
	files: Record<string, string>,
	prompt: string,
	steps: Parameters<typeof recordRequests>[1],
): Promise<{ harness: Harness; record: TaskRecord }> {
	const { harness, record } = await createTaskHarness();
	harnesses.push(harness);
	for (const [path, content] of Object.entries(files)) seedFile(harness, path, content);
	harness.setResponses(recordRequests(record, steps));
	await harness.session.prompt(prompt);
	return { harness, record };
}

describe("task network: recovering from a refused edit", () => {
	it("rejects an ambiguous oldText and lands the retry that adds context", async () => {
		const { harness, record } = await runTask(
			{ "src/dup.ts": DUPLICATE_SOURCE },
			"Make function b return 2 instead of 1.",
			[
				fauxAssistantMessage([fauxToolCall("read", { path: "src/dup.ts" })], { stopReason: "toolUse" }),
				fauxAssistantMessage(
					[
						fauxToolCall("edit", {
							path: "src/dup.ts",
							edits: [{ oldText: "  return 1;", newText: "  return 2;" }],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[
						fauxToolCall("edit", {
							path: "src/dup.ts",
							edits: [{ oldText: "function b() {\n  return 1;", newText: "function b() {\n  return 2;" }],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Function b now returns 2."),
			],
		);

		expect(record.toolCalls.map((call) => call.isError)).toEqual([false, true, false]);
		// The refusal has to name the failure mode, otherwise the model cannot pick a fix.
		expect(record.toolCalls[1]?.text).toContain("must be unique");
		expect(readWorkspaceFile(harness, "src/dup.ts")).toBe(
			DUPLICATE_SOURCE.replace("function b() {\n  return 1;", "function b() {\n  return 2;"),
		);
	});

	it("rejects an oldText that is not in the file and lands the retry that is", async () => {
		const { harness, record } = await runTask({ "src/flags.ts": STALE_SOURCE }, "Turn color on.", [
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						path: "src/flags.ts",
						edits: [{ oldText: "  color: true,", newText: "  color: true," }],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("read", { path: "src/flags.ts" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						path: "src/flags.ts",
						edits: [{ oldText: "  color: false,", newText: "  color: true," }],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Enabled color."),
		]);

		expect(record.toolCalls.map((call) => call.isError)).toEqual([true, false, false]);
		expect(record.toolCalls[0]?.text).toContain("Could not find the exact text");
		// The retry follows the read, so the model could see the real text before editing again.
		expect(record.toolCalls[1]?.toolName).toBe("read");
		expect(readWorkspaceFile(harness, "src/flags.ts")).toBe(STALE_SOURCE.replace("color: false", "color: true"));
	});

	it("keeps the failed call in the transcript so the retry is not blind", async () => {
		const { record } = await runTask({ "src/flags.ts": STALE_SOURCE }, "Turn color on.", [
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						path: "src/flags.ts",
						edits: [{ oldText: "  color: true,", newText: "  color: true," }],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						path: "src/flags.ts",
						edits: [{ oldText: "  color: false,", newText: "  color: true," }],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Enabled color."),
		]);

		const secondRequest = record.requests[1];
		const failedResult = secondRequest?.messages.find(
			(message) => message.role === "toolResult" && message.isError === true,
		);
		expect(failedResult).toBeDefined();
		expect(failedCalls(record)).toHaveLength(1);
	});
});

describe("task network: reading a large file in pieces", () => {
	it("hands the model a usable offset and lands the edit on the tail", async () => {
		const { harness, record } = await runTask(
			{ "src/big.txt": OVERSIZED_SOURCE },
			"Change the last line of src/big.txt to 'done'.",
			[
				fauxAssistantMessage([fauxToolCall("read", { path: "src/big.txt" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("read", { path: "src/big.txt", offset: 79 })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(
					[
						fauxToolCall("edit", {
							path: "src/big.txt",
							edits: [{ oldText: "line 80 ", newText: "done " }],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Last line updated."),
			],
		);

		expect(failedCalls(record)).toEqual([]);
		const firstRead = record.toolCalls[0];
		// Truncation has to tell the model how to continue, otherwise the tail is unreachable.
		expect(firstRead?.text).toContain("Use offset=");
		expect(firstRead?.text).not.toContain("line 80 ");
		const tailRead = record.toolCalls[1];
		expect(tailRead?.text).toContain("line 80 ");
		expect(readWorkspaceFile(harness, "src/big.txt").trimEnd().split("\n").at(-1)).toBe(`done ${"x".repeat(1000)}`);
	});
});
