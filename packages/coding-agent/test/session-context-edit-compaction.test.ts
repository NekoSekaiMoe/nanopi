import type { AssistantMessage } from "@nanopi/pi-ai";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "../src/core/compaction/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function assistant(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 10,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 11,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

describe("context edits inside a compaction range", () => {
	it("keeps an omitted attempt out of every compaction range", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "FIRST", timestamp: Date.now() });
		session.appendMessage(assistant("FIRST-ANSWER"));
		session.appendMessage({ role: "user", content: "SECOND", timestamp: Date.now() });
		session.appendMessage(assistant("SECOND-ANSWER"));
		session.appendMessage({ role: "user", content: `LATER ${"y".repeat(1500)}`, timestamp: Date.now() });
		session.appendMessage(assistant(`LATER-ANSWER ${"y".repeat(1500)}`));
		// The recovery turn starts at a previous compaction boundary: keeping the boundary also keeps
		// the message entry of the retracted attempt, while its omission edit lands in the turn prefix.
		session.appendCompaction("FIRST SUMMARY", session.getBranch()[4].id, 1000);
		session.appendMessage({ role: "user", content: `RETRY ${"r".repeat(1200)}`, timestamp: Date.now() });
		const retracted = session.appendMessage(assistant(`RETRACTED ${"e".repeat(1200)}`, "error"));
		session.appendContextEdit(retracted, null);
		session.appendMessage({ role: "user", content: `TAIL ${"t".repeat(1200)}`, timestamp: Date.now() });
		session.appendMessage(assistant(`TAIL-ANSWER ${"t".repeat(1200)}`));

		for (const keepRecentTokens of [1, 200, 400, 600, 800, 1000]) {
			const preparation = prepareCompaction(session.getBranch(), {
				...DEFAULT_COMPACTION_SETTINGS,
				keepRecentTokens,
			});
			if (!preparation) continue;
			const range = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
			expect(range.filter((message) => JSON.stringify(message).includes("RETRACTED"))).toHaveLength(0);
		}
	});

	it("does not read an edited entry back from its raw messages", () => {
		const session = SessionManager.inMemory();
		const target = session.appendMessage({ role: "user", content: "ORIGINAL", timestamp: Date.now() });
		session.appendMessage(assistant(`ANSWER ${"a".repeat(2000)}`));
		session.appendMessage({ role: "user", content: `MID ${"m".repeat(2000)}`, timestamp: Date.now() });
		session.appendMessage(assistant(`MID-ANSWER ${"m".repeat(2000)}`));
		session.appendMessage({ role: "user", content: "TAIL", timestamp: Date.now() });
		session.appendContextEdit(target, { content: `REPLACEMENT ${"r".repeat(1500)}` });

		// The edit sits on the leaf, so the projection of the target is already empty when the
		// range under consideration ends before it. Only a raw read-back can resurface the text.
		for (const keepRecentTokens of [1, 100, 300, 500, 700, 900]) {
			const preparation = prepareCompaction(session.getBranch(), {
				...DEFAULT_COMPACTION_SETTINGS,
				keepRecentTokens,
			});
			if (!preparation) continue;
			const range = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
			expect(range.filter((message) => JSON.stringify(message).includes("REPLACEMENT"))).toHaveLength(0);
		}
	});
});

describe("tool call pairing in a compaction range", () => {
	it("never splits a tool call from its result", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: `SEARCH ${"s".repeat(200)}`, timestamp: Date.now() });
		session.appendMessage({
			...assistant("CALLING"),
			content: [
				{ type: "text", text: "CALLING" },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } },
				{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "b.txt" } },
			],
			stopReason: "toolUse",
		});
		for (const id of ["call-1", "call-2"]) {
			session.appendMessage({
				role: "toolResult",
				toolCallId: id,
				toolName: "read",
				content: [{ type: "text", text: "OUTPUT ".repeat(400) }],
				isError: false,
				timestamp: Date.now(),
			});
		}
		session.appendMessage(assistant(`DONE ${"d".repeat(400)}`));
		session.appendMessage({ role: "user", content: `NEXT ${"n".repeat(400)}`, timestamp: Date.now() });
		session.appendMessage(assistant(`NEXT-ANSWER ${"n".repeat(400)}`));

		for (let keepRecentTokens = 1; keepRecentTokens <= 2000; keepRecentTokens += 41) {
			const preparation = prepareCompaction(session.getBranch(), {
				...DEFAULT_COMPACTION_SETTINGS,
				keepRecentTokens,
			});
			if (!preparation) continue;
			const calls = preparation.messagesToSummarize
				.filter((message) => message.role === "assistant")
				.flatMap((message) =>
					message.content.filter((block) => block.type === "toolCall").map((block) => block.id),
				);
			const results = preparation.messagesToSummarize
				.filter((message) => message.role === "toolResult")
				.map((message) => message.toolCallId);
			expect([...calls].sort()).toEqual([...results].sort());
		}
	});
});
