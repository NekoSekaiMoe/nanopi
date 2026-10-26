#!/usr/bin/env node
/**
 * Where does a flavor's memory go? Issue #177 asked for numbers instead of the
 * "the catalog is probably it" guess, and the answer is not one number.
 *
 * The probe imports a single-file build in a child process (`import` executes the
 * entry, which is what the interactive mode pays before it renders anything),
 * reads `RssAnon` around the import, and repeats. It then re-measures the same
 * build with every generated catalog table flattened to `{}` and prints the
 * difference: that is the model-data share. What is left scales with the source
 * text of the entry, so a flavor that carries more JS pays again even with no
 * model data at all.
 *
 * Usage:
 *   pnpm run mem:attribution                 # build full/base/minimal, then measure
 *   node scripts/mem-attribution.mjs --skip-build
 *   node scripts/mem-attribution.mjs --runs 5 --json
 *
 * Requires the workspace build (`pnpm run build`) before `--skip-build`, and the
 * single-file build script for each flavor otherwise.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const singleFileScript = join(repoRoot, "scripts", "build-coding-agent-single-file.mjs");
const singleFileOutput = join(repoRoot, "packages", "coding-agent", "binaries", "nanopi.js");

const FLAVORS = ["minimal", "base", "full"];

function parseArgs(argv) {
	const options = { flavors: FLAVORS, runs: 3, build: true, json: false };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--skip-build") options.build = false;
		else if (arg === "--json") options.json = true;
		else if (arg === "--runs") options.runs = Number.parseInt(argv[++index], 10);
		else if (arg === "--flavors") options.flavors = argv[++index].split(",").filter(Boolean);
		else if (arg === "--help" || arg === "-h") {
			console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n/, ""));
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	if (!Number.isFinite(options.runs) || options.runs < 1) throw new Error("--runs must be a positive integer");
	for (const flavor of options.flavors) {
		if (!FLAVORS.includes(flavor)) throw new Error(`Unknown flavor: ${flavor}`);
	}
	return options;
}

/** RssAnon + RssFile of the current process, in MiB. */
function readMemoryStatus() {
	const status = readFileSync("/proc/self/status", "utf8");
	const value = (key) => {
		const match = new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(status);
		return match ? Number.parseInt(match[1], 10) / 1024 : undefined;
	};
	return { anon: value("RssAnon"), file: value("RssFile"), rss: value("VmRSS") };
}

/** Flatten every generated catalog table in a single-file build to `{}`. */
function stripCatalogs(source) {
	const re = /var ([A-Za-z_$][\w$]*)=\{"[a-z0-9-]+":\{"(?:chat|image|classifier):/g;
	const tables = [];
	let match;
	while ((match = re.exec(source)) !== null) {
		const open = source.indexOf("{", match.index);
		let depth = 0;
		let end = -1;
		for (let index = open; index < source.length; index++) {
			if (source[index] === "{") depth++;
			else if (source[index] === "}") {
				depth--;
				if (depth === 0) {
					end = index + 1;
					break;
				}
			}
		}
		if (end < 0) throw new Error(`Unterminated catalog table ${match[1]}`);
		tables.push({ start: match.index, end, name: match[1] });
	}
	let stripped = source;
	for (const table of tables.reverse()) {
		stripped = `${stripped.slice(0, table.start)}var ${table.name}={}${stripped.slice(table.end)}`;
	}
	return { text: stripped, tables: tables.length };
}

/**
 * The entry runs `main()` when imported, so the measurement has to stop it. The
 * probe sets `process.exit` to a thrower and restores nothing: the child ends.
 */
function probeSource() {
	return `import { readFileSync, writeSync } from "node:fs";
const read = () => {
	const status = readFileSync("/proc/self/status", "utf8");
	const value = (key) => {
		const match = new RegExp("^" + key + ":\\\\s+(\\\\d+) kB", "m").exec(status);
		return match ? Number.parseInt(match[1], 10) / 1024 : undefined;
	};
	return { anon: value("RssAnon"), file: value("RssFile"), rss: value("VmRSS") };
};
const before = read();
process.exit = () => {
	throw new Error("exit");
};
try {
	await import(process.argv[2]);
} catch {}
const after = read();
writeSync(1, JSON.stringify({
	anon: after.anon - before.anon,
	file: after.file - before.file,
	rss: after.rss - before.rss,
}) + "\\n");
process.reallyExit?.(0);
`;
}

function measure(probePath, target) {
	const output = execFileSync(process.execPath, [probePath, pathToFileURL(target).href], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	const line = output.split("\n").find((entry) => entry.startsWith("{"));
	if (!line) throw new Error(`Probe produced no measurement for ${target}`);
	return JSON.parse(line);
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function summarize(runs, key) {
	const values = runs.map((run) => run[key]).filter((value) => value !== undefined);
	return values.length === 0 ? undefined : median(values);
}

/** Full builds regenerate every catalog shard; a trimmed build only writes its own set. */
function hydrateModelData() {
	execFileSync("pnpm", ["run", "hydrate:model-data"], { cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"] });
}

function buildFlavor(flavor) {
	execFileSync(process.execPath, [singleFileScript, "--flavor", flavor], {
		cwd: repoRoot,
		stdio: ["ignore", "ignore", "inherit"],
	});
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	if (process.platform !== "linux") {
		throw new Error("RssAnon is a /proc field; this probe only runs on Linux");
	}
	const scratch = mkdtempSync(join(tmpdir(), "nanopi-mem-attribution-"));
	const probePath = join(scratch, "probe.mjs");
	writeFileSync(probePath, probeSource());
	const rows = [];
	try {
		// Catalogs are generated per flavor, and each generation rewrites the set:
		// measuring `full` right after `minimal` would report "no catalog data" for
		// the full entry. Restore the full set before every flavor, then build.
		if (options.build) hydrateModelData();
		for (const [index, flavor] of options.flavors.entries()) {
			if (options.build) {
				if (index > 0) hydrateModelData();
				buildFlavor(flavor);
			}
			const buildPath = join(scratch, `nanopi-${flavor}.js`);
			const source = readFileSync(singleFileOutput, "utf8");
			writeFileSync(buildPath, source);
			const { text: stripped, tables } = stripCatalogs(source);
			const strippedPath = join(scratch, `nanopi-${flavor}-no-catalogs.js`);
			writeFileSync(strippedPath, stripped);

			const plainRuns = Array.from({ length: options.runs }, () => measure(probePath, buildPath));
			const strippedRuns = Array.from({ length: options.runs }, () => measure(probePath, strippedPath));
			rows.push({
				flavor,
				bytes: statSync(buildPath).size,
				catalogTables: tables,
				anon: summarize(plainRuns, "anon"),
				anonWithoutCatalogs: summarize(strippedRuns, "anon"),
				file: summarize(plainRuns, "file"),
			});
		}
	} finally {
		rmSync(scratch, { force: true, recursive: true });
	}

	if (options.json) {
		console.log(JSON.stringify({ runs: options.runs, rows }, null, 2));
		return;
	}
	console.log(`RssAnon of \`import <single-file build>\` (median of ${options.runs} runs, MiB)\n`);
	console.log("flavor    entry     anon   model data   code+graph   file");
	for (const row of rows) {
		const entry = `${(row.bytes / 1048576).toFixed(1)} MiB`;
		const anon = `${row.anon.toFixed(1)}`;
		const data = row.anon - row.anonWithoutCatalogs;
		const code = row.anonWithoutCatalogs;
		console.log(
			`${row.flavor.padEnd(9)} ${entry.padStart(7)} ${anon.padStart(7)} ${data.toFixed(1).padStart(10)} ${code.toFixed(1).padStart(12)} ${row.file.toFixed(1).padStart(6)}`,
		);
	}
	console.log(
		[
			"",
			"model data = anon with the generated catalog tables flattened minus the entry as built.",
			"code+graph = the same entry with no catalog data; it tracks source text, not provider count.",
			"catalog tables per flavor: " + rows.map((row) => `${row.flavor} ${row.catalogTables}`).join(", "),
		].join("\n"),
	);
}

main();
