import type { AssistantMessage } from "@nanopi/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@nanopi/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import codexCompaction from "../../src/modules/codex-compaction/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

/** The module ships in every build; the harness only loads what a test names. */
const MODULES = [{ name: "codex-compaction", factory: codexCompaction }];

/** The checkpoint the session starts from. `CITED` is replaced with the real entry id. */
const SUMMARY = `## Progress
- the failing assertion was \`expected 2 to be 3\` [r1]

<refs>
- [r1] CITED
</refs>`;

function createUsage(totalTokens: number): AssistantMessage["usage"] {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(harness: Harness, text: string, totalTokens: number): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage(text, { stopReason: "stop" }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(totalTokens),
	};
}

/**
 * A session whose branch holds a compaction, with the cited entry before the kept boundary.
 * `keepId` is the entry the checkpoint keeps, so everything before it leaves the context.
 */
function seedCompactedSession(harness: Harness): string {
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "run the tests" }],
		timestamp: now - 4000,
	} as never);
	// The entry the summary cites. Its text is the only place the assertion exists.
	const cited = harness.sessionManager.appendMessage({
		...createAssistant(harness, "AssertionError: expected 2 to be 3", now - 3000),
		timestamp: now - 3000,
	} as never);
	const keep = harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "ok, keep going" }],
		timestamp: now - 1000,
	} as never);
	harness.sessionManager.appendCompaction(SUMMARY.replace("CITED", cited), keep, 5000, {
		readFiles: [],
		modifiedFiles: [],
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return cited;
}

function requestsOf(harness: Harness): string {
	return harness.session.messages.map((message) => getMessageText(message)).join("\n");
}

describe("recall_context", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("puts the cited entry back into the conversation", async () => {
		const harness = await createHarness({ modules: MODULES });
		harnesses.push(harness);
		seedCompactedSession(harness);

		// After the checkpoint alone, the assertion is gone from the conversation.
		expect(requestsOf(harness)).not.toContain("expected 2 to be 3");

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("recall_context", { ref: "r1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("got it"),
		]);
		await harness.session.prompt("what was the assertion?");

		const entries = harness.sessionManager.getBranch();
		const recall = entries.find((entry) => entry.type === "context_recall");
		expect(recall).toBeDefined();
		expect(recall?.type === "context_recall" ? recall.refs : []).toEqual([1]);
		// The recalled text is context, not a tool result: it projects back into the messages.
		const projected = harness.sessionManager.buildSessionProjection().messages;
		const recalled = projected.filter((message) => message.role === "recalledContext");
		expect(recalled).toHaveLength(1);
		expect(getMessageText(recalled[0])).toContain("expected 2 to be 3");
	});

	it("rejects a tag the summary never defined", async () => {
		const harness = await createHarness({ modules: MODULES });
		harnesses.push(harness);
		seedCompactedSession(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("recall_context", { ref: "r9" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("ok"),
		]);
		await harness.session.prompt("recall r9");

		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "context_recall")).toBe(false);
		const result = harness.session.messages.findLast(
			(message) => message.role === "toolResult" && message.toolName === "recall_context",
		);
		expect(getMessageText(result)).toContain("[r1]");
	});

	it("has nothing to recall before a compaction", async () => {
		const harness = await createHarness({ modules: MODULES });
		harnesses.push(harness);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: Date.now(),
		} as never);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("recall_context", { ref: "r1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("ok"),
		]);
		await harness.session.prompt("recall something");

		const result = harness.session.messages.findLast(
			(message) => message.role === "toolResult" && message.toolName === "recall_context",
		);
		expect(getMessageText(result)).toContain("No compaction summary");
	});
});
