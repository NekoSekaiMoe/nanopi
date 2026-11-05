import { readFileSync } from "node:fs";
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
 * It is now one `export *` per source. Nothing here pins the public surface itself — the point of
 * `export *` is that it follows the sources — except for the names `export *` cannot resolve: a
 * source, or a chain of sources, exporting one name twice with different bodies.
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

	it("names only the tool factories that two roots disagree about", () => {
		const { named } = reExports();
		// `core/tools/index.ts` declares `createReadTool(cwd)` and also re-exports `read.ts`'s
		// `createReadToolDefinition(cwd, options)`; `core/sdk.ts` re-exports the same factory, and
		// `core/tools/index.ts` owns a second, options-only `createReadTool`. `export *` would drop
		// the name silently and fail the typecheck, so these eleven are re-exported by name.
		expect(named).toEqual(["./core/tools/index.ts"]);
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

	it("stays inside the entry graph budget the root now has", () => {
		expect(
			findViolations({
				"packages/coding-agent": { ".": { maxFiles: 780 } },
			}),
		).toEqual([]);
	});
});
