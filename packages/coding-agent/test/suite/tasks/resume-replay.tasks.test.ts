/**
 * Tasks resumed from a persisted transcript.
 *
 * The system prompt is declared once, in the transcript head, and later turns only carry diffs.
 * A resume replays that head instead of rebuilding the prompt, so whatever the first leg declared
 * is still what the model sees. These tasks resume a real session and check what the provider gets.
 */

import { fauxAssistantMessage, fauxToolCall } from "@nanopi/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";
import { createTaskHarness, recordRequests, seedFile, type TaskRecord } from "./task-network.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

async function runFirstLeg(): Promise<{ harness: Harness; record: TaskRecord }> {
	const { harness, record } = await createTaskHarness();
	harnesses.push(harness);
	seedFile(harness, "a.txt", "alpha\n");
	harness.setResponses(
		recordRequests(record, [
			fauxAssistantMessage([fauxToolCall("read", { path: "a.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Read a.txt."),
		]),
	);
	await harness.session.prompt("Read a.txt.");
	return { harness, record };
}

describe("task network: resuming a transcript", () => {
	it("replays the declared prompt and tools instead of rebuilding them", async () => {
		const first = await runFirstLeg();
		const head = first.harness.session.messages.find((message) => message.role === "system");
		if (head?.role !== "system") throw new Error("expected a system message");

		const resumed = await createHarness({ sessionManager: first.harness.sessionManager });
		harnesses.push(resumed);
		const record: TaskRecord = { requests: [], toolCalls: [] };
		resumed.setResponses(recordRequests(record, [fauxAssistantMessage("It said alpha.")]));
		await resumed.session.prompt("What did a.txt say?");

		const systemMessages = record.requests[0]?.messages.filter((message) => message.role === "system") ?? [];
		// The transcript head, then the requested-turn declaration for the pending user message.
		expect(systemMessages).toHaveLength(2);
		const replay = systemMessages[0];
		if (replay?.role !== "system") throw new Error("expected a replayed system message");
		// The head replays untouched: same prompt, same declared tools, no diff bolted onto it.
		expect(replay.content).toBe(head.content);
		expect(Object.keys(replay.sections ?? {})).toEqual(Object.keys(head.sections ?? {}));
		expect(replay.sections?.preamble).toBe(head.sections?.preamble);
		expect(replay.sections?.rules).toBe(head.sections?.rules);
		expect((replay.toolsAdded ?? []).map((tool) => tool.name)).toEqual(
			(head.toolsAdded ?? []).map((tool) => tool.name),
		);
		// The only thing that changed is the workspace path, because this harness made a new one.
		const declaration = systemMessages[1];
		if (declaration?.role !== "system") throw new Error("expected a requested-turn system message");
		expect(declaration.sections?.cwd).toBe(`<cwd>\n${resumed.tempDir.replace(/\\/g, "/")}\n</cwd>`);
		expect(resumed.session.systemPrompt).toContain(resumed.tempDir.replace(/\\/g, "/"));
	});

	it("keeps a tool the transcript deactivated out of the resumed loadout", async () => {
		const first = await runFirstLeg();
		first.harness.session.setActiveToolsByName(["read", "bash", "write"]);
		first.harness.setResponses([fauxAssistantMessage("edit is off")]);
		await first.harness.session.prompt("stop using edit");

		const resumed = await createHarness({ sessionManager: first.harness.sessionManager });
		harnesses.push(resumed);
		expect(resumed.session.getActiveToolNames()).toEqual(["read", "bash", "write"]);
		expect(resumed.session.systemPrompt).not.toContain("- edit:");

		const record: TaskRecord = { requests: [], toolCalls: [] };
		resumed.setResponses(recordRequests(record, [fauxAssistantMessage("still here")]));
		await resumed.session.prompt("continue");

		// The deactivation is a replayable delta: the resumed run replays it instead of re-adding `edit`.
		const systemMessages = record.requests[0]?.messages.filter((message) => message.role === "system") ?? [];
		expect(systemMessages).toHaveLength(3);
		expect(systemMessages[1]?.toolsRemoved).toEqual([{ name: "edit" }]);
		// The resumed harness is a fresh process, so it re-declares the tools the transcript kept.
		expect((systemMessages[2]?.toolsAdded ?? []).map((tool) => tool.name)).toEqual(["read", "bash", "write"]);
	});

	it("declares a prompt before the first request of a transcript that has none", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "earlier", timestamp: 1 });
		const harness = await createHarness({ sessionManager });
		harnesses.push(harness);
		const record: TaskRecord = { requests: [], toolCalls: [] };
		harness.setResponses(recordRequests(record, [fauxAssistantMessage("answered")]));
		await harness.session.prompt("now");

		// The declaration is inserted ahead of the pending user turn, not appended after it.
		const roles = record.requests[0]?.messages.map((message) => message.role);
		expect(roles).toEqual(["user", "system", "user"]);
		const head = record.requests[0]?.messages[1];
		if (head?.role !== "system") throw new Error("expected a declared system message");
		expect(head.sections?.preamble).toBeTruthy();
		expect((head.toolsAdded ?? []).length).toBeGreaterThan(0);
		expect(harness.session.messages.filter((message) => message.role === "system")).toHaveLength(1);
	});
});

describe("task network: request transcript shape", () => {
	it("keeps every tool result next to the call that produced it", async () => {
		const { harness, record } = await createTaskHarness();
		harnesses.push(harness);
		seedFile(harness, "one.txt", "first file\n");
		seedFile(harness, "two.txt", "second file\n");
		harness.setResponses(
			recordRequests(record, [
				fauxAssistantMessage(
					[fauxToolCall("read", { path: "one.txt" }), fauxToolCall("read", { path: "two.txt" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Both read."),
			]),
		);
		await harness.session.prompt("Read both files.");

		const roles = harness.session.messages.map((message) => message.role);
		expect(roles).toEqual(["system", "user", "assistant", "toolResult", "toolResult", "assistant"]);
		const call = harness.session.messages[2];
		if (call?.role !== "assistant") throw new Error("expected the tool call message");
		const callIds = call.content
			.filter((part) => part.type === "toolCall")
			.map((part) => (part as { id: string }).id);
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results.map((result) => (result as { toolCallId: string }).toolCallId)).toEqual(callIds);
		// The second request carries the same pair, so the model can match calls to results.
		expect(JSON.stringify(record.requests[1])).toContain("second file");
	});
});
