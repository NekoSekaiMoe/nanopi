#!/usr/bin/env node
/**
 * Entry points are cost contracts.
 *
 * A package's `exports` map is the only place that says which modules are public, and one stray
 * `export *` can silently make a narrow entry drag an entire barrel: importing a 1-file pure
 * function through a barrel costs ~37 MB of evaluated module graph, and nothing fails until someone
 * measures a process. This walks the value-import graph of every declared entry point and enforces a
 * budget per entry, so that regression fails at commit time instead.
 *
 * Only value imports count. `import type` / `export type` are erased before Node sees them.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Workspace package name -> its source root, so cross-package imports are followed. */
const WORKSPACE = {
	"@nanopi/pi-ai": "packages/ai/src",
	"@nanopi/pi-agent-core": "packages/agent/src",
	"@nanopi/pi-tui": "packages/tui/src",
};

/**
 * Budgets are deliberate. Entries with no budget remain unbounded; each listed entry states the
 * graph it is allowed to reach.
 */
const BUDGETS = {
	"packages/ai": {
		"./models": {
			maxFiles: 15,
			forbid: ["providers/", "models.generated.ts", "index.ts", "utils/validation.ts", "utils/typebox-helpers.ts"],
		},
		"./utils/*": { maxFiles: 3, forbid: ["providers/", "api/", "index.ts"] },
	},
	// The two narrow doors a module author walks through. They exist so that
	// writing a module does not pull the package root's 476-file graph; the
	// budgets hold that promise, and the package root is forbidden in both so a
	// wildcard export cannot quietly turn them back into the root barrel.
	"packages/coding-agent": {
		// The public root: 43 lines of `export *`, so nothing in the file says how expensive it is.
		// Every source it names is public, and a source that grows an import grows this graph.
		//
		// Measured at 498 counted files (323 `coding-agent`, 122 `pi-ai`, 46 `pi-tui`, 7 `agent`),
		// 388 of which `./modules` does not reach. The biggest chunk is `ai/src/providers` (58
		// checked-in files): the SDK hands out `createAgentSession`, which resolves models, so the
		// provider layer is behind the root by design — that is what a coding agent is. The budget is
		// here to catch the next subsystem that hangs itself off the root, not to forbid what is
		// already there.
		//
		// The 300-odd generated catalogs the root also reaches are not in that number, see
		// `GENERATED_MODEL_CATALOG`. The headroom (10%) is the one the 780 carried over 707.
		".": { maxFiles: 550 },
		"./modules": { maxFiles: 110, forbid: ["coding-agent/src/index.ts"] },
		"./ui": { maxFiles: 170, forbid: ["coding-agent/src/index.ts"] },
		// Not an entry point, so no `exports` lookup: `sourcePath` budgets the source file itself.
		// This barrel holds both the core summarization helpers and the Codex-style compaction
		// module. The module needs session entry reads and module surfaces, so unlike the old
		// summarizer-only barrel it reaches `core/session-manager.ts` by design. Headroom is
		// deliberate: a summarizer that grows past this has started importing the model runtime
		// again. Split the module rather than raise the number.
		"core/compaction/index.ts": {
			sourcePath: true,
			maxFiles: 110,
			forbid: ["modes/interactive/", "pi-ai/src/providers/"],
		},
	},
};

const SPEC = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)([^;]*?\sfrom\s*)?["']([^"']+)["']/g;

/**
 * The generated model catalogs: `models.generated.ts` plus one `<provider>.models.ts` shard per
 * provider, both gitignored build products of `pnpm run generate-models`.
 *
 * They stay in the graph — a `forbid` pattern still has to see them — but they are not counted,
 * because their count is not a property of this tree. The generator writes one shard per provider
 * models.dev lists, narrowed by the build flavor that ran last, so the same source measured 801
 * files after a `full` generation and 515 after a `base` one, and only the first one failed the
 * budget (#761). A number that moves when nothing in the repository moved cannot guard anything.
 */
const GENERATED_MODEL_CATALOG = /^packages\/ai\/src\/(?:models\.generated\.ts|providers\/[^/]+\.models\.ts)$/;

function resolveSpec(spec, fromFile) {
	if (spec.startsWith("node:")) return null;
	if (spec.startsWith(".")) {
		const base = resolve(dirname(fromFile), spec);
		for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
			if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
		}
		return null;
	}
	for (const [name, src] of Object.entries(WORKSPACE)) {
		if (spec === name) return resolve(ROOT, src, "index.ts");
		if (!spec.startsWith(`${name}/`)) continue;
		const tail = spec.slice(name.length + 1);
		for (const candidate of [`${tail}.ts`, `${tail}/index.ts`, tail]) {
			const file = resolve(ROOT, src, candidate);
			if (existsSync(file) && statSync(file).isFile()) return file;
		}
	}
	return null; // external dependency: not part of the workspace graph
}

function walk(entryFile) {
	const seen = new Set();
	const queue = [entryFile];
	while (queue.length > 0) {
		const file = queue.pop();
		if (seen.has(file) || file.endsWith(".json")) continue;
		seen.add(file);
		for (const match of readFileSync(file, "utf8").matchAll(SPEC)) {
			const target = resolveSpec(match[2], file);
			if (target) queue.push(target);
		}
	}
	return seen;
}

/** `./dist/harness/context.js` in the exports map is `src/harness/context.ts` on disk. */
function sourceFor(pkgDir, distPath) {
	const rel = distPath.replace(/^\.\/dist\//, "").replace(/\.js$/, ".ts");
	const file = resolve(ROOT, pkgDir, "src", rel);
	return existsSync(file) ? file : undefined;
}

function expand(pkgDir, entry, target) {
	if (!entry.includes("*")) return [[entry, target]];
	const dir = resolve(ROOT, pkgDir, "src", dirname(target.replace(/^\.\/dist\//, "")));
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".ts"))
		.map((name) => [entry.replace("*", name.replace(/\.ts$/, "")), target.replace("*", name.replace(/\.ts$/, ""))]);
}

/** Enforces one budget against one source file: the graph size and every forbidden pattern. */
function checkGraph(pkgDir, label, source, budget, report) {
	if (!existsSync(source)) {
		report(`${pkgDir} ${label} has no source file at ${relative(ROOT, source)}`);
		return;
	}
	const graph = [...walk(source)].map((file) => relative(ROOT, file));
	const counted = graph.filter((file) => !GENERATED_MODEL_CATALOG.test(file));
	if (counted.length > budget.maxFiles) {
		report(
			`${pkgDir} "${label}" reaches ${counted.length} files, budget ${budget.maxFiles}\n` +
				counted.map((file) => `    ${file}`).join("\n"),
		);
	}
	for (const pattern of budget.forbid ?? []) {
		const hit = graph.filter((file) => file.includes(pattern));
		if (hit.length > 0) {
			report(`${pkgDir} "${label}" must not reach ${pattern}:\n${hit.map((f) => `    ${f}`).join("\n")}`);
		}
	}
}

/** Every budget violation, as one message per violation. The CLI below prints them and exits. */
export function findViolations(budgets = BUDGETS) {
	const violations = [];
	for (const [pkgDir, entries] of Object.entries(budgets)) {
		const manifest = JSON.parse(readFileSync(resolve(ROOT, pkgDir, "package.json"), "utf8"));
		for (const [entry, budget] of Object.entries(entries)) {
			// A source path rather than an entry point: the budget holds the graph behind a barrel
			// the package reaches internally, so there is no `exports` entry to look up.
			if (budget.sourcePath) {
				checkGraph(pkgDir, entry, resolve(ROOT, pkgDir, "src", entry), budget, (message) =>
					violations.push(message),
				);
				continue;
			}
			const declared = manifest.exports?.[entry];
			if (!declared) {
				violations.push(`${pkgDir} declares no export "${entry}" but a budget exists for it`);
				continue;
			}
			const target = typeof declared === "string" ? declared : declared.import;
			for (const [name, distPath] of expand(pkgDir, entry, target)) {
				const source = sourceFor(pkgDir, distPath);
				if (!source) {
					violations.push(`${pkgDir} export "${name}" points at ${distPath}, which has no source file`);
					continue;
				}
				checkGraph(pkgDir, name, source, budget, (message) => violations.push(message));
			}
		}
	}
	return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const violations = findViolations();
	for (const violation of violations) console.error(violation);
	if (violations.length > 0) {
		console.error(`\n${violations.length} entry-point budget violation(s).`);
		process.exit(1);
	}
	console.log("Entry point graphs are within budget.");
}
