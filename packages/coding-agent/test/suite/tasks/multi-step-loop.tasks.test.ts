/**
 * Tasks that need more than one step to finish.
 *
 * The agent loop only continues when a turn leaves something behind for the next one: a tool call,
 * a steering message, a tool-result hook that patches the transcript. A prompt change that teaches
 * the model to answer instead of acting, or a loop change that drops a tool call, shows up as a
 * task that ends one turn early rather than as an obviously broken assertion.
 */

import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@nanopi/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ModuleApi } from "../../../src/core/modules/types.ts";
import { createHarness, type Harness } from "../harness.ts";
import {
	createTaskHarness,
	failedCalls,
	readWorkspaceFile,
	recordRequests,
	seedFile,
	type TaskRecord,
	toolCallsOf,
} from "./task-network.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

describe("task network: multi-step loops", () => {
	it("creates a file with write and does not touch the ones around it", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		seedFile(harness, "src/a.txt", "keep me\n");
		const record: TaskRecord = { requests: [], toolCalls: [] };
		harness.setResponses(
			recordRequests(record, [
				fauxAssistantMessage([fauxToolCall("write", { path: "src/nested/b.txt", content: "new file\n" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage([fauxToolCall("read", { path: "src/nested/b.txt" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("Created src/nested/b.txt."),
			]),
		);
		await harness.session.prompt("Create src/nested/b.txt containing 'new file', and nothing else.");

		expect(readWorkspaceFile(harness, "src/nested/b.txt")).toBe("new file\n");
		expect(readWorkspaceFile(harness, "src/a.txt")).toBe("keep me\n");
		expect(failedCalls(record)).toEqual([]);
	});

	it("applies two disjoint edits in one call as one replacement each", async () => {
		const { harness, record } = await createTaskHarness();
		harnesses.push(harness);
		const source = ["const width = 1;", "const label = 'a';", "export { width, label };", ""].join("\n");
		seedFile(harness, "src/settings.ts", source);
		harness.setResponses(
			recordRequests(record, [
				fauxAssistantMessage([fauxToolCall("read", { path: "src/settings.ts" })], { stopReason: "toolUse" }),
				fauxAssistantMessage(
					[
						fauxToolCall("edit", {
							path: "src/settings.ts",
							edits: [
								{ oldText: "const width = 1;", newText: "const width = 2;" },
								{ oldText: "const label = 'a';", newText: "const label = 'b';" },
							],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Both values updated."),
			]),
		);
		await harness.session.prompt("Set width to 2 and label to 'b' in src/settings.ts.");

		expect(readWorkspaceFile(harness, "src/settings.ts")).toBe(
			["const width = 2;", "const label = 'b';", "export { width, label };", ""].join("\n"),
		);
		expect(toolCallsOf(record, "edit")[0]?.text).toContain("Successfully replaced 2 block(s)");
	});

	it("lets a tool_result hook rewrite the result the next turn sees", async () => {
		const redact = (nanopi: ModuleApi): void => {
			nanopi.on("tool_result", (event) => {
				if (event.toolName !== "read") return undefined;
				return {
					content: [{ type: "text", text: "[redacted]" }],
				};
			});
		};
		const harness = await createHarness({ modules: [{ name: "redact", factory: redact }] });
		harnesses.push(harness);
		seedFile(harness, "secret.txt", "token=abc123\n");
		const record: TaskRecord = { requests: [], toolCalls: [] };
		harness.setResponses(
			recordRequests(record, [
				fauxAssistantMessage([fauxToolCall("read", { path: "secret.txt" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("Read it."),
			]),
		);
		await harness.session.prompt("Read secret.txt.");

		const patched = harness.session.messages.find((message) => message.role === "toolResult");
		if (patched?.role !== "toolResult") throw new Error("expected a tool result");
		expect(JSON.stringify(patched.content)).toBe('[{"type":"text","text":"[redacted]"}]');
		// The next request must carry the patched text, not the raw file.
		expect(JSON.stringify(record.requests[1])).not.toContain("token=abc123");
	});

	it("ends the run after the model stops calling tools", async () => {
		const { harness, record } = await createTaskHarness();
		harnesses.push(harness);
		seedFile(harness, "notes.md", "# notes\n");
		harness.setResponses(
			recordRequests(record, [
				fauxAssistantMessage([fauxToolCall("read", { path: "notes.md" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("The file has one heading."),
			]),
		);
		await harness.session.prompt("What is in notes.md?");

		expect(record.requests).toHaveLength(2);
		expect(record.toolCalls).toHaveLength(1);
		expect(harness.session.isIdle).toBe(true);
		expect(harness.session.messages.at(-1)?.role).toBe("assistant");
	});
});

describe("task network: workspace isolation", () => {
	it("runs tools against the session cwd rather than the process cwd", async () => {
		const { harness, record } = await createTaskHarness();
		harnesses.push(harness);
		seedFile(harness, "inside.txt", "inside\n");
		harness.setResponses(
			recordRequests(record, [
				fauxAssistantMessage([fauxToolCall("read", { path: "inside.txt" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("read it"),
			]),
		);
		await harness.session.prompt("Read inside.txt.");

		expect(record.toolCalls[0]?.isError).toBe(false);
		expect(record.toolCalls[0]?.text).toContain("inside");
		// The temp workspace is the cwd the prompt advertises, and it is not the repo root.
		expect(harness.session.systemPrompt).toContain(join(harness.tempDir).replace(/\\/g, "/"));
	});
});
