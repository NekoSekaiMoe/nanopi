import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "vitest";
import type { SessionEntry } from "../src/index.ts";
import compactionRecallExtension from "../src/modules/compaction-recall/index.ts";
import {
	describeRecallRegions,
	formatRecallAppendix,
	RECALL_SECTION_HEADER,
	resolveRecallRef,
} from "../src/modules/compaction-recall/recall.ts";

function messageEntry(id: string, role: "user" | "assistant" | "toolResult", text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-11-17T00:00:00.000Z",
		message:
			role === "toolResult"
				? {
						role,
						toolCallId: `call-${id}`,
						toolName: "read",
						content: [{ type: "text", text }],
						isError: false,
						timestamp: 1,
					}
				: { role, content: [{ type: "text", text }], timestamp: 1 },
	} as unknown as SessionEntry;
}

function compactionEntry(id: string, firstKeptEntryId: string, summary = "old summary"): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId: null,
		timestamp: "2026-11-17T00:00:10.000Z",
		summary,
		tokensBefore: 100,
		firstKeptEntryId,
	} as unknown as SessionEntry;
}

/**
 * A branch the way `appendCompaction` writes one: the summary is inserted as the parent of
 * the first kept entry, so it sits *before* the kept range in leaf order, and everything
 * ahead of that point was replaced.
 */
function compactedBranch(): SessionEntry[] {
	return [
		messageEntry("u1", "user", "first question"),
		messageEntry("a1", "assistant", "first answer"),
		compactionEntry("c1", "u2"),
		messageEntry("u2", "user", "second question"),
		messageEntry("a2", "assistant", "second answer"),
	];
}

describe("describeRecallRegions", () => {
	it("lists one region per replaced turn, numbered from 1", () => {
		const branch = [
			messageEntry("u1", "user", "first question"),
			messageEntry("a1", "assistant", "first answer"),
			messageEntry("u2", "user", "second question"),
			messageEntry("a2", "assistant", "second answer"),
			compactionEntry("c1", "u3"),
			messageEntry("u3", "user", "kept"),
		];
		const regions = describeRecallRegions(branch, 8_000);
		deepStrictEqual(
			regions.map((region) => region.ref),
			["E1", "E3"],
		);
		// A region opens at a user turn and runs to the next one, so a ref covers a
		// stretch of work instead of a single reply without its prompt.
		strictEqual(regions[0].from, 1);
		strictEqual(regions[0].to, 2);
		strictEqual(regions[0].preview, "first question");
		strictEqual(regions[0].startEntryId, "u1");
		strictEqual(regions[0].endEntryId, "a1");
		strictEqual(regions[1].startEntryId, "u2");
		strictEqual(regions[1].endEntryId, "a2");
	});

	it("splits a region that grows past the token budget", () => {
		const branch = [
			messageEntry("u1", "user", "a".repeat(400)),
			messageEntry("a1", "assistant", "b".repeat(400)),
			messageEntry("u2", "user", "c".repeat(400)),
			messageEntry("a2", "assistant", "d".repeat(400)),
			compactionEntry("c1", "u3"),
			messageEntry("u3", "user", "kept"),
		];
		const regions = describeRecallRegions(branch, 250);
		deepStrictEqual(
			regions.map((region) => region.ref),
			["E1", "E3"],
		);
		// Every region stays under the budget, so one recall cannot refill the context
		// the summary just freed.
		for (const region of regions) strictEqual(region.tokens <= 250, true);
	});

	it("lists nothing when the compaction kept the whole branch", () => {
		const branch = [compactionEntry("c1", "c1"), messageEntry("u1", "user", "kept")];
		deepStrictEqual(describeRecallRegions(branch, 8_000), []);
	});
});

describe("resolveRecallRef", () => {
	it("returns the entries a ref covers", () => {
		const region = resolveRecallRef(compactedBranch(), "e1", 8_000);
		strictEqual(region?.ref, "E1");
		deepStrictEqual(
			region?.entries.map((entry) => entry.id),
			["u1", "a1"],
		);
	});

	it("answers nothing for a ref the branch does not carry", () => {
		strictEqual(resolveRecallRef(compactedBranch(), "E9", 8_000), undefined);
	});
});

describe("formatRecallAppendix", () => {
	it("prints one line per region, headed by the recall section", () => {
		const appendix = formatRecallAppendix(describeRecallRegions(compactedBranch(), 8_000));
		strictEqual(appendix.startsWith(`\n\n${RECALL_SECTION_HEADER}\n`), true);
		const lines = appendix.split("\n").filter((line) => line.startsWith("- "));
		strictEqual(lines.length, 1);
		strictEqual(lines[0].includes("E1"), true);
	});

	it("prints nothing when a summary replaced nothing", () => {
		strictEqual(formatRecallAppendix([]), "");
	});
});

describe("compaction recall hook", () => {
	function pluginSurface() {
		const handlers: Array<(event: unknown) => unknown> = [];
		const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
		const surface = {
			events: { on: () => () => {}, emit: () => {} },
			on: (_event: string, handler: (event: unknown) => unknown) => {
				handlers.push(handler);
				return () => {};
			},
			registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => {
				tools.set(tool.name, tool);
			},
		};
		return { surface, handlers, tools };
	}

	it("appends the region table to the summary it is handed", async () => {
		const { surface, handlers } = pluginSurface();
		compactionRecallExtension(surface as never);
		const result = (await handlers[0]({
			type: "session_before_compact",
			branchEntries: compactedBranch(),
			replacedSummary: "the summary",
		})) as { compaction?: { summary: string; details?: unknown } } | undefined;
		strictEqual(
			result?.compaction?.summary.startsWith("the summary\n\n## Replaced Context (recallable)\n- E1:"),
			true,
		);
		strictEqual(JSON.stringify(result?.compaction?.details).includes('"ref":"E1"'), true);
	});

	it("does nothing on the pass that runs before a summary exists", async () => {
		const { surface, handlers } = pluginSurface();
		compactionRecallExtension(surface as never);
		strictEqual(await handlers[0]({ type: "session_before_compact", branchEntries: compactedBranch() }), undefined);
	});

	it("answers recall_context with the entries a ref covers", async () => {
		const { surface, tools } = pluginSurface();
		compactionRecallExtension(surface as never);
		const tool = tools.get("recall_context");
		strictEqual(tool !== undefined, true);
		const result = await tool!.execute("call-1", { ref: "E1" }, undefined, undefined, {
			sessionManager: { getBranch: () => compactedBranch() },
		});
		strictEqual(result.content[0].text.includes("first question"), true);
		strictEqual(result.details.entries, 2);
	});

	it("refuses a ref the branch does not carry", async () => {
		const { surface, tools } = pluginSurface();
		compactionRecallExtension(surface as never);
		const tool = tools.get("recall_context");
		let message = "";
		try {
			await tool!.execute("call-1", { ref: "E9" }, undefined, undefined, {
				sessionManager: { getBranch: () => compactedBranch() },
			});
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		strictEqual(message.includes("E9"), true);
	});
});
