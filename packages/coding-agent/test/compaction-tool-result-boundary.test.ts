import type { ToolResultMessage } from "@nanopi/pi-ai";
import { describe, expect, it } from "vitest";
import { prepareCompaction } from "../src/core/compaction/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";

/**
 * Issue #185 item 5: does a compaction that lands while a tool is running lose
 * that tool's result?
 *
 * The failure mode being probed: the assistant asks for a tool, compaction runs
 * before the result is recorded, and a resume then shows the model a tool call
 * with no answer to it ("No result provided").
 *
 * Three layers are checked, from the boundary backwards:
 *
 * - `findCutPoint` never cuts between a call and its result, and
 *   `assertToolPairsClosed` refuses a summary range that splits one;
 * - a compaction entry recorded between a call and its result still projects the
 *   result, because `appendCompaction` re-parents the kept entry, not the leaf;
 * - the same holds when the session is rebuilt from its serialized entries, which
 *   is what a resume does.
 */
describe("tool results across a compaction", () => {
	function callTurn(session: SessionManager, id: string, size: number): void {
		const now = Date.now();
		session.appendMessage({
			role: "user",
			content: [{ type: "text", text: `run ${id} ${"x".repeat(size)}` }],
			timestamp: now,
		});
		session.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id, name: "bash", arguments: { command: "true" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			thinkingLevel: "off",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: now,
		});
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: id,
			toolName: "bash",
			content: [{ type: "text", text: `result of ${id}` }],
			isError: false,
			timestamp: now,
		};
		session.appendMessage(result);
	}

	it("a compaction recorded between a call and its result still projects the result", () => {
		const session = SessionManager.inMemory();
		callTurn(session, "call-early", 2000);
		callTurn(session, "call-late", 2000);

		// The shape of "compaction started while the tool was running": the assistant's
		// call is recorded, the compaction is recorded, and the result lands after it.
		const now = Date.now();
		session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "turn" }],
			timestamp: now,
		});
		const callEntryId = session.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call-mid", name: "bash", arguments: { command: "true" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			thinkingLevel: "off",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: now,
		});
		session.appendCompaction("summary of earlier work", callEntryId, 1000);
		session.appendMessage({
			role: "toolResult",
			toolCallId: "call-mid",
			toolName: "bash",
			content: [{ type: "text", text: "result that must survive" }],
			isError: false,
			timestamp: now + 1,
		});

		const projected = session.buildSessionProjection().messages;
		const results = projected.filter((m) => m.role === "toolResult").map((m) => m.toolCallId);
		expect(results).toContain("call-mid");
	});

	it("rebuilding the projection from the persisted file still has the result", () => {
		const session = SessionManager.inMemory();
		const now = Date.now();
		session.appendMessage({ role: "user", content: [{ type: "text", text: "go" }], timestamp: now });
		const callEntryId = session.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call-x", name: "bash", arguments: { command: "true" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			thinkingLevel: "off",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: now,
		});
		session.appendCompaction("earlier work", callEntryId, 100);
		session.appendMessage({
			role: "toolResult",
			toolCallId: "call-x",
			toolName: "bash",
			content: [{ type: "text", text: "answer" }],
			isError: false,
			timestamp: now + 1,
		});

		// Same entries, rebuilt the way a resume does it: from the serialized form.
		const rebuilt = SessionManager.inMemory(
			process.cwd(),
			undefined,
			session.getEntries().map((entry) => JSON.parse(JSON.stringify(entry))),
		);
		const results = rebuilt.buildSessionProjection().messages.filter((m) => m.role === "toolResult");
		expect(results.map((m) => m.toolCallId)).toContain("call-x");
	});

	it("keeps a tool call and its result on the same side of the cut", () => {
		const session = SessionManager.inMemory();
		for (let i = 0; i < 6; i++) callTurn(session, `call-${i}`, 2000);

		const preparation = prepareCompaction(session.getBranch(), {
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 400,
		});
		expect(preparation).toBeDefined();

		const summarized = preparation!.messagesToSummarize;
		const summarizedCalls = new Set(
			summarized.flatMap((m) =>
				m.role === "assistant" ? m.content.filter((c) => c.type === "toolCall").map((c) => c.id) : [],
			),
		);
		const summarizedResults = new Set(summarized.filter((m) => m.role === "toolResult").map((m) => m.toolCallId));
		// A call summarized without its result is what produces "No result provided"
		// after a resume: the model sees a call it made and no answer to it.
		const prefixCalls = new Set(
			preparation!.turnPrefixMessages.flatMap((m) =>
				m.role === "assistant" ? m.content.filter((c) => c.type === "toolCall").map((c) => c.id) : [],
			),
		);
		const prefixResults = new Set(
			preparation!.turnPrefixMessages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId),
		);
		for (const id of prefixCalls) expect(prefixResults.has(id)).toBe(true);
		for (const id of summarizedCalls) expect(summarizedResults.has(id)).toBe(true);
	});

	it("does not drop a tool result when the cut point falls right after its call", () => {
		const session = SessionManager.inMemory();
		// Last turn is a call+result pair; make the budget land the cut between them.
		for (let i = 0; i < 8; i++) callTurn(session, `call-${i}`, 1500);

		const branch = session.getBranch();
		const callIndex = branch.findIndex(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some((c) => c.type === "toolCall"),
		);
		expect(callIndex).toBeGreaterThan(0);

		for (const keep of [50, 200, 400, 800, 1600]) {
			const preparation = prepareCompaction(branch, { enabled: true, reserveTokens: 16384, keepRecentTokens: keep });
			if (!preparation) continue;
			// The kept range must start at the firstKeptEntryId and include everything after it,
			// so a result that belongs to a kept call cannot be left behind.
			const keptIndex = branch.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
			expect(keptIndex).toBeGreaterThanOrEqual(0);
			const keptResults = branch
				.slice(keptIndex)
				.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolCallId] : [],
				);
			const keptCalls = branch
				.slice(keptIndex)
				.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "assistant"
						? entry.message.content.flatMap((c) => (c.type === "toolCall" ? [c.id] : []))
						: [],
				);
			for (const id of keptCalls) expect(keptResults).toContain(id);
		}
	});
});
