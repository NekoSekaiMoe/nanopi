#!/usr/bin/env node
/**
 * What does a subagent child actually load, and what does that cost?
 *
 * `pi-subagent-mini` spawns `nanopi --mode json -p` children with the parent's
 * module list minus `CHILD_MODULE_SKIP`. Issue #177 asked whether maintaining
 * that second module table is worth it, and the earlier 29 MiB/module estimate
 * came from a synthetic 1000-module process, not from this repository's modules.
 *
 * This probe spawns the real CLI the way the subagent tool does, samples
 * `RssAnon` until it exits, and repeats for module sets that differ only in the
 * skipped modules. The child's tool list is fixed (`read,bash,grep,find,ls`), so
 * the difference between rows is the skipped modules and nothing else.
 *
 * Usage:
 *   pnpm run mem:child                 # build first, then measure
 *   node scripts/mem-child-probe.mjs --skip-build --runs 3
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const cliPath = join(repoRoot, "packages", "coding-agent", "dist", "bundle", "cli.js");
const skipSource = join(repoRoot, "packages", "coding-agent", "src", "extras", "pi-subagent-mini", "src", "index.ts");

/** Modules a child must not load, read from the source of truth in pi-subagent-mini. */
function readChildModuleSkip() {
	const source = readFileSync(skipSource, "utf8");
	const match = /const CHILD_MODULE_SKIP = new Set\(\[([^\]]*)\]\)/.exec(source);
	if (!match) throw new Error("CHILD_MODULE_SKIP not found in pi-subagent-mini");
	return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

/** Every built-in module this build registers. */
function readBuiltinModules() {
	const modulesUrl = new URL("../packages/coding-agent/dist/modules/index.js", import.meta.url);
	return import(modulesUrl.href).then((module) => module.enabledModules().map((entry) => entry.name));
}

function parseArgs(argv) {
	const options = { runs: 3, build: true, json: false };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--skip-build") options.build = false;
		else if (arg === "--json") options.json = true;
		else if (arg === "--runs") options.runs = Number.parseInt(argv[++index], 10);
		else if (arg === "--help" || arg === "-h") {
			console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n/, ""));
			process.exit(0);
		} else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!Number.isFinite(options.runs) || options.runs < 1) throw new Error("--runs must be a positive integer");
	return options;
}

function sampleProcess(pid) {
	try {
		const status = readFileSync(`/proc/${pid}/status`, "utf8");
		const anon = /^RssAnon:\s+(\d+) kB/m.exec(status);
		const rss = /^VmRSS:\s+(\d+) kB/m.exec(status);
		return anon && rss ? { anon: Number.parseInt(anon[1], 10) / 1024, rss: Number.parseInt(rss[1], 10) / 1024 } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Spawn one child and return its peak sample. The child needs no API key: it
 * fails after loading the module table, which is exactly the state we measure.
 */
function measureChild(agentDir, modules) {
	const args = [cliPath, "--mode", "json", "-p", "ok"];
	if (modules !== undefined) args.push("--modules", modules.join(","));
	const child = spawn(process.execPath, args, {
		env: { ...process.env, NANOPI_CODING_AGENT_DIR: agentDir, NANOPI_OFFLINE: "1", NANOPI_SKIP_VERSION_CHECK: "1" },
		stdio: ["ignore", "ignore", "ignore"],
	});
	const samples = [];
	const timer = setInterval(() => {
		const sample = sampleProcess(child.pid);
		if (sample) samples.push(sample);
	}, 100);
	return new Promise((resolve) => {
		child.on("exit", () => {
			clearInterval(timer);
			const peak = samples.reduce((best, sample) => (!best || sample.anon > best.anon ? sample : best), undefined);
			resolve({ peak, samples: samples.length });
		});
	});
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (process.platform !== "linux") throw new Error("RssAnon is a /proc field; this probe only runs on Linux");
	if (options.build) {
		// The published entry is the bundle; the modules manifest it reads comes
		// from `pnpm run build`, so both have to come from the same build.
		execFileSync("pnpm", ["run", "build"], { cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"] });
	}
	const skipped = readChildModuleSkip();
	const builtin = await readBuiltinModules();
	const inherited = builtin.filter((name) => !skipped.includes(name));
	const rows = [
		{ label: "child as spawned", modules: inherited },
		{ label: "every module", modules: builtin },
		{ label: "no modules (--modules '')", modules: [] },
	];
	const agentDir = mkdtempSync(join(tmpdir(), "nanopi-child-probe-"));
	const results = [];
	try {
		for (const row of rows) {
			const peaks = [];
			for (let run = 0; run < options.runs; run++) {
				const { peak } = await measureChild(agentDir, row.modules);
				if (peak) peaks.push(peak);
			}
			results.push({
				label: row.label,
				modules: row.modules.length,
				anon: peaks.length ? median(peaks.map((peak) => peak.anon)) : undefined,
				rss: peaks.length ? median(peaks.map((peak) => peak.rss)) : undefined,
			});
		}
	} finally {
		rmSync(agentDir, { force: true, recursive: true });
	}

	if (options.json) {
		console.log(JSON.stringify({ runs: options.runs, skipped, results }, null, 2));
		return;
	}
	console.log(`Subagent child (\`--mode json -p\`, peak RssAnon, median of ${options.runs} runs, MiB)\n`);
	console.log("module set                     modules   anon    rss");
	for (const result of results) {
		const anon = result.anon === undefined ? "n/a" : result.anon.toFixed(1);
		const rss = result.rss === undefined ? "n/a" : result.rss.toFixed(1);
		console.log(`${result.label.padEnd(30)} ${String(result.modules).padStart(7)} ${anon.padStart(6)} ${rss.padStart(6)}`);
	}
	console.log(
		[
			"",
			`CHILD_MODULE_SKIP drops: ${skipped.join(", ")}`,
			"The difference between row 1 and row 2 is what the skip table saves; the difference to",
			"row 3 includes the modules the skip table keeps on purpose (mcp-tool support, fingerprints).",
		].join("\n"),
	);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
