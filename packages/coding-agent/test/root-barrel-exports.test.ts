import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/** The repo-level entry-graph checker has no type declarations; its shape is asserted below. */
interface EntryGraphChecker {
	findViolations(budgets: Record<string, Record<string, unknown>>): string[];
}

const { findViolations } = (await import(
	pathToFileURL(fileURLToPath(new URL("../../../scripts/check-entry-graphs.mjs", import.meta.url))).href
)) as EntryGraphChecker;

/**
 * `src/index.ts` is the package's public entry (`package.json` `exports["."]`). It was 546 lines of
 * hand-maintained whitelists over 45 sources, and that state had already rotted: `ExecOptions`,
 * `copyToClipboard`, `main` and others were listed as public while their sources no longer exported
 * them, and two sources declared `CompactionSettings` / `MessageRunRenderOptions` under the same
 * name, which only compiled because a named re-export arbitrarily picked one.
 *
 * It is now one `export *` per source, and nothing else: no named block survives. A name exported
 * through two barrel paths is the same symbol (TypeScript 5.0+), and TS2308 was never the silent
 * drop the runtime gives, so `export *` resolves what used to need naming by hand.
 */
const barrelPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));

function reExports(): { star: string[]; named: string[] } {
	const source = readFileSync(barrelPath, "utf8");
	const star = [...source.matchAll(/^export \* from "([^"]+)";$/gm)].map((match) => match[1]);
	const named = [...source.matchAll(/^export \{([\s\S]*?)\} from "([^"]+)";$/gm)].map((match) => match[2]);
	return { star, named };
}

describe("package root barrel", () => {
	it("re-exports every source with `export *`", () => {
		const { star } = reExports();
		expect(star.length).toBe(43);
		expect(star).toContain("./core/compaction/index.ts");
		expect(star).toContain("./core/modules/index.ts");
		expect(star).toContain("./modes/index.ts");
	});

	it("names nothing: every name arrives through `export *`", () => {
		// `core/tools/index.ts` forwards `createReadTool` from `read.ts` and `core/sdk.ts` forwards it
		// again; both point at the one declaration, so `export *` over both barrels is unambiguous.
		const { named } = reExports();
		expect(named).toEqual([]);
	});

	it("keeps the package-internal helpers out of the public surface", () => {
		// `export *` copies a module's export table, so a paired `export { ... }` at the bottom of
		// a source still reaches the root and a symbol stays public however late it is named. The
		// boundary is the declaration, and these are the shapes that moved there: steps inside a
		// public entry point (`getPromptsDir`, `findTurnStartIndex`, `ResolveProjectTrustedOptions`),
		// storage seams (`SettingsStorage`), and file-format details (`POWERSHELL_ARGS`).
		//
		// Checked by reading the sources rather than by importing the root, so the test fails on the
		// edit that breaks the rule and not on a missing build.
		const sources = reExports().star.map((spec) =>
			readFileSync(fileURLToPath(new URL(`../src/${spec.replace(/\.\//, "")}`, import.meta.url)), "utf8"),
		);
		const declaredAt = sources.join("\n");
		for (const name of [
			"DEFAULT_COMPACTION_SETTINGS",
			"findTurnStartIndex",
			"getLastAssistantUsage",
			"IN_CONTEXT_COMPACTION_PROMPT",
			"supportsInContextCompaction",
			"SettingsStorage",
			"InMemorySettingsStorage",
			"QuietStartup",
			"ImageSettings",
			"getPromptsDir",
			"findNodePackageDir",
			"ResolveProjectTrustedOptions",
			"CreateModelRuntimeOptions",
			"BUILTIN_MODULES",
			"LoadSkillsFromDirOptions",
			"SkillFrontmatter",
			"getToolsDir",
			"POWERSHELL_ARGS",
		]) {
			const exported = new RegExp(
				`^export (?:declare )?(?:const|let|var|function|class|interface|type) ${name}\\b`,
				"m",
			);
			expect(exported.test(declaredAt), `${name} is exported from a source the root re-exports`).toBe(false);
		}
	});

	it("counts sources, not the generated model catalogs", () => {
		// #761: the root also reaches `models.generated.ts` and one `<provider>.models.ts` shard per
		// provider, and that number follows models.dev plus the build flavor that generated last
		// (16 shards after a `base` run, 302 after a `full` one). Counting them made the budget a
		// function of a gitignored build product, so a legitimate tree failed after regenerating.
		const providers = fileURLToPath(new URL("../../ai/src/providers", import.meta.url));
		const shards = existsSync(providers) ? readdirSync(providers).filter((name) => name.endsWith(".models.ts")) : [];
		expect(shards.length, "run `pnpm run ensure:model-catalogs` to make this test meaningful").toBeGreaterThan(0);
		const [violation] = findViolations({ "packages/coding-agent": { ".": { maxFiles: 1 } } });
		const listed = violation
			.split("\n")
			.slice(1)
			.map((line) => line.trim());
		expect(listed.length).toBeGreaterThan(400);
		expect(
			listed.filter((file) =>
				/packages\/ai\/src\/(?:models\.generated\.ts|providers\/[^/]+\.models\.ts)$/.test(file),
			),
		).toEqual([]);
	});

	it("stays inside the entry graph budget the root now has", () => {
		// 550 counted files (498 today): the budget counts the sources the root reaches, not the
		// generated model catalogs, whose number follows models.dev and the last build flavor (#761).
		expect(
			findViolations({
				"packages/coding-agent": { ".": { maxFiles: 550 } },
			}),
		).toEqual([]);
	});
});
