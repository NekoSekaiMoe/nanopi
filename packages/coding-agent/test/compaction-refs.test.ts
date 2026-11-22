import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "vitest";
import { IN_CONTEXT_COMPACTION_PROMPT, SUMMARIZATION_SYSTEM_PROMPT } from "../src/core/compaction/index.ts";
import { citedRefIndexes, parseSummaryRefs } from "../src/modules/context-recall/resolve.ts";

const SUMMARY = `## Progress
- bash_bg 的交接测试有时序竞争 [r1]
- 修法是在测试里等 run record 落地，而不是 sleep [r2]

<refs>
- [r1] entry-1
- [r2] entry-2 entry-3
</refs>`;

describe("summary references", () => {
	it("reads the refs block into tag to entry-id mapping", () => {
		const refs = parseSummaryRefs(SUMMARY);
		deepStrictEqual([...refs.keys()], [1, 2]);
		deepStrictEqual(refs.get(1), ["entry-1"]);
		deepStrictEqual(refs.get(2), ["entry-2", "entry-3"]);
	});

	it("cites tags in the body only, not the definitions in the refs block", () => {
		deepStrictEqual(citedRefIndexes(SUMMARY), [1, 2]);
	});

	it("returns nothing for a summary without a refs block", () => {
		strictEqual(parseSummaryRefs("## Goal\n- nothing cited here").size, 0);
		deepStrictEqual(citedRefIndexes("no tags at all"), []);
	});

	it("treats a (none) block as citing nothing", () => {
		const summary = "## Goal\n- plain summary\n\n<refs>\n(none)\n</refs>";
		strictEqual(parseSummaryRefs(summary).size, 0);
		deepStrictEqual(citedRefIndexes(summary), []);
	});
});

describe("summarization rules", () => {
	it("requires open objectives and verbatim-or-marked user wording", () => {
		// Both compaction paths share this system prompt, so a rule here is the
		// only place that reaches the default and the Codex summarizer alike.
		strictEqual(SUMMARIZATION_SYSTEM_PROMPT.includes("Every open objective"), true);
		strictEqual(SUMMARIZATION_SYSTEM_PROMPT.includes("unfinished and not superseded"), true);
		strictEqual(SUMMARIZATION_SYSTEM_PROMPT.includes("Reproduce user requests"), true);
		strictEqual(SUMMARIZATION_SYSTEM_PROMPT.includes("mark it as a paraphrase"), true);
	});
});

describe("reference instruction wiring", () => {
	it("carries the reference rules in the prompt that can produce a summary", () => {
		// The rules are what make a [rN] exist at all, so a prompt that can produce a summary
		// without them silently disables recall for that path.
		strictEqual(IN_CONTEXT_COMPACTION_PROMPT.includes("## Recoverable references"), true);
		// The system prompt stays short: the rules ride on the user turn.
		strictEqual(SUMMARIZATION_SYSTEM_PROMPT.includes("Recoverable references"), false);
	});
});
