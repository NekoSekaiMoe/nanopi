import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/** The repo-level entry-graph checker has no type declarations; its shape is asserted below. */
interface EntryGraphChecker {
	findViolations(budgets: Record<string, Record<string, unknown>>): string[];
}

/**
 * The compaction barrel is `export *` so that a name can never go missing quietly: a hand-written
 * whitelist dropped `getSummarizationFailure` and nothing failed, because only `compaction.ts` and
 * `branch-summarization.ts` import it, and they import the source file directly.
 *
 * What holds the barrel's cost instead is `core/compaction/index.ts` in
 * `scripts/check-entry-graphs.mjs`: 19 files, 20 allowed.
 */
const barrelPath = fileURLToPath(new URL("../src/core/compaction/index.ts", import.meta.url));
const { findViolations } = (await import(
	pathToFileURL(fileURLToPath(new URL("../../../scripts/check-entry-graphs.mjs", import.meta.url))).href
)) as EntryGraphChecker;

describe("compaction barrel", () => {
	it("re-exports its modules with `export *`, not a list that can drop a name", async () => {
		const source = readFileSync(barrelPath, "utf8");
		const exports = [...source.matchAll(/^export (?:type )?\* from "\.\/([^"]+)";$/gm)].map((match) => match[1]);
		expect(exports).toEqual(["branch-summarization.ts", "compaction.ts", "utils.ts"]);
	});

	it("stays inside the entry graph budget that replaced the whitelist", () => {
		expect(
			findViolations({
				"packages/coding-agent": {
					"core/compaction/index.ts": {
						sourcePath: true,
						maxFiles: 20,
						forbid: ["modes/interactive/", "core/session-manager.ts", "pi-ai/src/providers/"],
					},
				},
			}),
		).toEqual([]);
	});
});
