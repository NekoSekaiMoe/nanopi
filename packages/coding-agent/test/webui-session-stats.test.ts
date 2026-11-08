import { describe, expect, test } from "vitest";
import { readSessionMessages } from "../src/modes/webui/webui-server.ts";

// Issue #596: the webui had per-turn `done.stats` and a session-wide
// `getSessionStats()` and showed neither. The read path now reports both from
// the transcript, and this file pins the two things a raw file sum gets wrong:
// a tree has branches, and a compaction already accounts for the span it
// summarized.

interface Line {
	type: string;
	id: string;
	parentId: string | null;
	message?: unknown;
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	};
	summary?: string;
	firstKeptEntryId?: string;
	tokensBefore?: number;
	kind?: string;
	provider?: string;
	model?: string;
}

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0, total = 0.01) {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
	};
}

function user(id: string, parentId: string | null, text: string): Line {
	return {
		type: "message",
		id,
		parentId,
		message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
	};
}

function assistant(id: string, parentId: string | null, input: number, output: number, cacheRead = 0): Line {
	return {
		type: "message",
		id,
		parentId,
		message: {
			role: "assistant",
			provider: "faux",
			model: "alpha",
			content: [{ type: "text", text: "done" }],
			usage: usage(input, output, cacheRead),
			stopReason: "stop",
			timestamp: Date.now(),
		},
	};
}

/** A session file: one JSON object per line, the last one is the leaf. */
function transcript(lines: Line[]): string {
	return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

describe("webui session usage", () => {
	test("sums the branch the file ends on, not every sibling", () => {
		const content = transcript([
			user("u1", null, "start"),
			assistant("a1", "u1", 1000, 100, 400),
			// An abandoned retry of the same prompt: same parent, never the leaf.
			assistant("a2", "u1", 9000, 900),
			user("u2", "a1", "keep going"),
			assistant("a3", "u2", 2000, 200, 800),
		]);

		expect(readSessionMessages(content).stats).toEqual({
			input: 3000,
			output: 300,
			cache_read: 1200,
			cache_write: 0,
			cost: 0.02,
		});
	});

	test("counts the usage entries the agent writes off-context", () => {
		const content = transcript([
			user("u1", null, "start"),
			assistant("a1", "u1", 1000, 100),
			{
				type: "usage",
				id: "x1",
				parentId: "a1",
				kind: "title",
				provider: "faux",
				model: "alpha",
				usage: usage(50, 10),
			},
		]);

		expect(readSessionMessages(content).stats).toEqual({
			input: 1050,
			output: 110,
			cache_read: 0,
			cache_write: 0,
			cost: 0.02,
		});
	});

	test("withholds totals once a compaction packed a span into one entry", () => {
		// The summary entry carries the usage of everything it replaced, and the
		// replaced messages stay in the file as its ancestors, so a sum would
		// charge the summarized span twice. The live session knows the split; the
		// read path says why it cannot answer instead.
		const content = transcript([
			user("u1", null, "start"),
			assistant("a1", "u1", 1000, 100),
			{
				type: "compaction",
				id: "c1",
				parentId: "a1",
				summary: "earlier work",
				firstKeptEntryId: "c1",
				tokensBefore: 1100,
				usage: usage(1000, 100),
			},
			user("u2", "c1", "after the summary"),
			assistant("a2", "u2", 500, 50),
		]);
		const detail = readSessionMessages(content);

		expect(detail.stats).toBeUndefined();
		expect(detail.stats_unavailable).toBe("compacted");
	});

	test("reports nothing for a session that never billed", () => {
		const content = transcript([user("u1", null, "start")]);
		const detail = readSessionMessages(content);

		expect(detail.stats).toBeUndefined();
		expect(detail.stats_unavailable).toBeUndefined();
	});

	test("names what each reply was billed for", () => {
		const content = transcript([user("u1", null, "start"), assistant("a1", "u1", 1000, 100, 400)]);
		const [reply] = readSessionMessages(content).messages.filter((message) => message.role === "assistant");

		// `context` is what the request sent: fresh input plus what a cache served.
		expect(reply?.usage).toEqual({
			input: 1000,
			output: 100,
			cache_read: 400,
			cache_write: 0,
			cost: 0.01,
			context: 1400,
		});
	});
});
