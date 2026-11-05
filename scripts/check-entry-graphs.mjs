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
		"./modules": { maxFiles: 110, forbid: ["coding-agent/src/index.ts"] },
		"./ui": { maxFiles: 170, forbid: ["coding-agent/src/index.ts"] },
		// Not an entry point, so no `exports` lookup: `sourcePath` budgets the source file itself.
		// This barrel is what a summarizer imports. It used to reach 181 files because it dragged
		// the transcript, the theme and the session file I/O along; the transcript and the session
		// projection are out, so what is left is the compaction code plus `pi-ai/compat`.
		//
		// The ceiling has a floor under it: `pi-ai/compat` is 111 files on its own, because it
		// re-exports the built-in provider catalog (`providers/all.ts` imports every
		// `<provider>.models.ts`). Nothing on this side can get below that, so 20 is not a promise
		// about today's graph, it is the size the graph becomes once `compat` stops exporting the
		// catalog. Until then this budget fails and prints the 123-file graph; making it pass is
		// the next piece of work, changing the number is not.
		"core/compaction/index.ts": {
			sourcePath: true,
			maxFiles: 20,
			forbid: ["modes/interactive/", "core/session-manager.ts", "pi-ai/src/providers/"],
		},
	},
};

const SPEC = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)([^;]*?\sfrom\s*)?["']([^"']+)["']/g;

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

let failures = 0;

/** Enforces one budget against one source file: the graph size and every forbidden pattern. */
function checkGraph(pkgDir, label, source, budget) {
	if (!existsSync(source)) {
		console.error(`${pkgDir} ${label} has no source file at ${relative(ROOT, source)}`);
		failures += 1;
		return;
	}
	const graph = [...walk(source)].map((file) => relative(ROOT, file));
	if (graph.length > budget.maxFiles) {
		console.error(
			`${pkgDir} "${label}" reaches ${graph.length} files, budget ${budget.maxFiles}\n` +
				graph.map((file) => `    ${file}`).join("\n"),
		);
		failures += 1;
	}
	for (const pattern of budget.forbid ?? []) {
		const hit = graph.filter((file) => file.includes(pattern));
		if (hit.length > 0) {
			console.error(`${pkgDir} "${label}" must not reach ${pattern}:\n${hit.map((f) => `    ${f}`).join("\n")}`);
			failures += 1;
		}
	}
}

for (const [pkgDir, budgets] of Object.entries(BUDGETS)) {
	const manifest = JSON.parse(readFileSync(resolve(ROOT, pkgDir, "package.json"), "utf8"));
	for (const [entry, budget] of Object.entries(budgets)) {
		// A source path rather than an entry point: the budget holds the graph behind a barrel
		// the package reaches internally, so there is no `exports` entry to look up.
		if (budget.sourcePath) {
			checkGraph(pkgDir, entry, resolve(ROOT, pkgDir, "src", entry), budget);
			continue;
		}
		const declared = manifest.exports?.[entry];
		if (!declared) {
			console.error(`${pkgDir} declares no export "${entry}" but a budget exists for it`);
			failures += 1;
			continue;
		}
		const target = typeof declared === "string" ? declared : declared.import;
		for (const [name, distPath] of expand(pkgDir, entry, target)) {
			const source = sourceFor(pkgDir, distPath);
			if (!source) {
				console.error(`${pkgDir} export "${name}" points at ${distPath}, which has no source file`);
				failures += 1;
				continue;
			}
			checkGraph(pkgDir, name, source, budget);
		}
	}
}

if (failures > 0) {
	console.error(`\n${failures} entry-point budget violation(s).`);
	process.exit(1);
}
console.log("Entry point graphs are within budget.");
