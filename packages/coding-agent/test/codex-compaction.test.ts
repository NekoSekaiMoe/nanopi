import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "vitest";
import type { SessionEntry } from "../src/index.ts";
import {
	collectCheckpointFacts,
	DEFAULT_USER_RETAIN_TOKENS,
	factRef,
	formatKeyFacts,
	planUserRetention,
} from "../src/modules/codex-compaction/compact.ts";
import { findEntryIdForRef } from "../src/modules/codex-compaction/index.ts";
import {
	assembleCodexSummary,
	isCodexSummary,
	SUMMARY_PREFIX,
	stripCodexPrefix,
} from "../src/modules/codex-compaction/prompt.ts";

function messageEntry(id: string, role: "user" | "assistant" | "toolResult", text: string): SessionEntry {
	const content = role === "toolResult" ? [{ type: "text", text }] : [{ type: "text", text }];
	return {
		type: "message",
		id,
		timestamp: 1,
		message:
			role === "toolResult"
				? { role, toolCallId: `call-${id}`, toolName: "read", content, isError: false, timestamp: 1 }
				: { role, content, timestamp: 1 },
	} as unknown as SessionEntry;
}

function compactionEntry(id: string, firstKeptEntryId: string): SessionEntry {
	return {
		type: "compaction",
		id,
		timestamp: 1,
		summary: "old",
		tokensBefore: 1,
		firstKeptEntryId,
	} as unknown as SessionEntry;
}

describe("planUserRetention", () => {
	it("keeps the default plan when the kept region already covers the budget", () => {
		const entries = [messageEntry("u1", "user", "hi"), messageEntry("u2", "user", "there")];
		const plan = planUserRetention(entries, "u2", 1);
		deepStrictEqual(plan, { firstKeptEntryId: undefined, summarizeEntries: undefined });
	});

	it("moves the cut back so recent user messages survive verbatim", () => {
		const entries = [
			messageEntry("u1", "user", "a".repeat(797)),
			messageEntry("a1", "assistant", "b".repeat(401)),
			messageEntry("u2", "user", "c".repeat(401)),
		];
		// Default cut keeps only u2; the budget forces u1 back into the kept region.
		const plan = planUserRetention(entries, "u2", 300);
		strictEqual(plan.firstKeptEntryId, "u1");
		strictEqual(plan.summarizeEntries?.length, 0);
	});

	it("summarizes from the previous compaction boundary, never re-reading summarized entries", () => {
		const entries = [
			messageEntry("u0", "user", "x".repeat(798)),
			compactionEntry("c1", "u1"),
			messageEntry("u1", "user", "y".repeat(401)),
			messageEntry("u2", "user", "y".repeat(401)),
			messageEntry("u3", "user", "z".repeat(202)),
		];
		// The cut moves back to u2; the summarize set starts at the previous
		// compaction's boundary (u1) and excludes the already-summarized u0.
		const plan = planUserRetention(entries, "u3", 150);
		strictEqual(plan.firstKeptEntryId, "u2");
		deepStrictEqual(
			plan.summarizeEntries?.map((entry) => entry.id),
			["u1"],
		);
	});

	it("never snaps the cut onto a tool-result-only entry", () => {
		const entries = [
			messageEntry("u1", "user", "x".repeat(798)),
			messageEntry("r1", "toolResult", "y".repeat(401)),
			messageEntry("u2", "user", "z".repeat(202)),
		];
		const plan = planUserRetention(entries, "u2", 300);
		strictEqual(plan.firstKeptEntryId, "u1");
	});

	it("moves the cut to the first entry and summarizes nothing when the budget covers the whole session", () => {
		const entries = [messageEntry("u1", "user", "a"), messageEntry("u2", "user", "b")];
		const plan = planUserRetention(entries, "u2", DEFAULT_USER_RETAIN_TOKENS);
		// The empty summarize set makes runCodexCompaction return undefined, so
		// the default compaction runs.
		strictEqual(plan.firstKeptEntryId, "u1");
		deepStrictEqual(plan.summarizeEntries, []);
	});
});

describe("codex summary framing", () => {
	it("assembles, recognizes, and strips the handoff prefix", () => {
		const summary = assembleCodexSummary("the summary");
		strictEqual(isCodexSummary(summary), true);
		strictEqual(isCodexSummary("plain"), false);
		strictEqual(stripCodexPrefix(summary), "the summary");
		strictEqual(stripCodexPrefix(`no-prefix`), "no-prefix");
		strictEqual(summary.startsWith(`${SUMMARY_PREFIX}\n`), true);
	});
});

describe("Key Facts refs", () => {
	it("builds stable refs and maps them back to the stored entry id", () => {
		const entries = [messageEntry("u1", "user", "build a cache"), messageEntry("a1", "assistant", "done")];
		const facts = collectCheckpointFacts(entries, 2);
		deepStrictEqual(
			facts.map((f) => f.ref),
			["c2r0", "c2r1"],
		);
		deepStrictEqual(
			facts.map((f) => f.entryId),
			["u1", "a1"],
		);
		strictEqual(factRef(0, 0), "c0r0");
	});

	it("formats a Key Facts block that round-trips through the summary text", () => {
		const facts = collectCheckpointFacts([messageEntry("u7", "user", "first line\nsecond line")], 0);
		const block = formatKeyFacts(facts);
		strictEqual(block.includes("## Key Facts"), true);
		strictEqual(block.includes("c0r0: first line"), true);
		strictEqual(findEntryIdForRef(block, "c0r0"), "u7");
		strictEqual(findEntryIdForRef(block, "c0r9"), undefined);
	});

	it("omits system messages and caps the fact list", () => {
		const entries = [
			{ type: "message", id: "sys", timestamp: 1, message: { role: "system", content: "you are helpful" } },
			...Array.from({ length: 40 }, (_, i) => messageEntry(`m${i}`, "user", `message ${i}`)),
		];
		const facts = collectCheckpointFacts(entries as unknown as SessionEntry[], 0);
		strictEqual(facts.length, 30);
		strictEqual(facts[0].entryId, "m0");
	});
});
