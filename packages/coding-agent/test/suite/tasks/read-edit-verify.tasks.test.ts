/**
 * Task: read a file, make a targeted edit, then verify the result.
 *
 * This is the base workload every prompt change has to keep working. It breaks if `read` stops
 * returning file text, if `edit` stops accepting one disjoint replacement, or if the prompt stops
 * telling the model to check the file after changing it.
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

// A template literal the task rewrites; kept out of the fixture so the escape stays readable.
const DOLLAR = String.fromCharCode(36);
const TEMPLATE_LINE = `  return \`hello ${DOLLAR}{name}\`;`;

const SOURCE = ["export function greet(name) {", TEMPLATE_LINE, "}", "", "export const version = 1;", ""].join("\n");

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

async function runGreetingTask(): Promise<{ harness: Harness; record: TaskRecord }> {
	const { harness, record } = await createTaskHarness();
	harnesses.push(harness);
	seedFile(harness, "src/greet.ts", SOURCE);
	harness.setResponses(
		recordRequests(record, [
			fauxAssistantMessage([fauxToolCall("read", { path: "src/greet.ts" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						path: "src/greet.ts",
						edits: [{ oldText: TEMPLATE_LINE.trim(), newText: TEMPLATE_LINE.replace("hello", "hi").trim() }],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("read", { path: "src/greet.ts" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Changed the greeting to `hi`."),
		]),
	);
	await harness.session.prompt(
		"Change the greeting in src/greet.ts from hello to hi, then re-read the file to confirm.",
	);
	return { harness, record };
}

describe("task network: read, edit, verify", () => {
	it("lands the edit and leaves no failed tool call behind", async () => {
		const { harness, record } = await runGreetingTask();

		expect(failedCalls(record)).toEqual([]);
		expect(record.toolCalls.map((call) => call.toolName)).toEqual(["read", "edit", "read"]);
		expect(readWorkspaceFile(harness, "src/greet.ts")).toBe(SOURCE.replace("hello", "hi"));
	});

	it("shows the model the file text it asked for", async () => {
		const { record } = await runGreetingTask();

		const firstRead = record.toolCalls[0];
		expect(firstRead?.text).toContain("export function greet(name) {");
		expect(firstRead?.text).toContain(TEMPLATE_LINE.trim());
	});

	it("reports the edit as a replacement, not a rewrite", async () => {
		const { record } = await runGreetingTask();

		const edit = record.toolCalls[1];
		expect(edit?.text).toContain("Successfully replaced 1 block(s)");
		expect(edit?.args).toMatchObject({ path: "src/greet.ts" });
	});

	it("sends the whole file back after the edit", async () => {
		const { record } = await runGreetingTask();

		const secondRead = record.toolCalls[2];
		expect(secondRead?.text).toBe(SOURCE.replace("hello", "hi"));
	});

	it("keeps the request transcript replayable across turns", async () => {
		const { harness, record } = await runGreetingTask();

		expect(record.requests).toHaveLength(4);
		// The system message is declared once; later requests reuse it instead of restating it.
		const systemCounts = record.requests.map(
			(request) => request.messages.filter((message) => message.role === "system").length,
		);
		expect(systemCounts).toEqual([1, 1, 1, 1]);
		expect(harness.session.messages.at(-1)?.role).toBe("assistant");
	});
});
