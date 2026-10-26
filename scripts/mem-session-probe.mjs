#!/usr/bin/env node
/**
 * How much memory does a running session hold, and how fast does it grow?
 *
 * Issue #177 lists the transcript as the only thing that grows without a bound.
 * This probe feeds the real `SessionManager` synthetic turns and prints retained
 * `RssAnon` per turn count, so a change to compaction or to the retained range
 * can be compared against a number instead of an opinion.
 *
 * The synthetic text is deliberately incompressible (unique tokens per message):
 * V8 interns repeated strings, so `"x".repeat(n)` makes a large transcript look
 * free and the probe would report nothing.
 *
 * Usage:
 *   pnpm run mem:session                      # 100 / 300 / 1000 turns
 *   node scripts/mem-session-probe.mjs --turns 200,2000 --bytes 4000 --json
 *
 * Requires `pnpm run build` (it imports the compiled session manager).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

function parseArgs(argv) {
	const options = { turns: [100, 300, 1000], bytes: 4000, build: true, json: false };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--skip-build") options.build = false;
		else if (arg === "--json") options.json = true;
		else if (arg === "--turns") options.turns = argv[++index].split(",").map((value) => Number.parseInt(value, 10));
		else if (arg === "--bytes") options.bytes = Number.parseInt(argv[++index], 10);
		else if (arg === "--help" || arg === "-h") {
			console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n/, ""));
			process.exit(0);
		} else throw new Error(`Unknown argument: ${arg}`);
	}
	if (options.turns.some((turns) => !Number.isFinite(turns) || turns < 1)) throw new Error("--turns values must be positive");
	if (!Number.isFinite(options.bytes) || options.bytes < 1) throw new Error("--bytes must be positive");
	return options;
}

function anonMiB() {
	const status = readFileSync("/proc/self/status", "utf8");
	const match = /^RssAnon:\s+(\d+) kB/m.exec(status);
	if (!match) throw new Error("RssAnon is unavailable; this probe only runs on Linux");
	return Number.parseInt(match[1], 10) / 1024;
}

/** Unique text per message: repeated strings would be interned and cost nothing. */
function messageBody(index, bytes) {
	const parts = [];
	let length = 0;
	for (let offset = 0; length < bytes; offset++) {
		const piece = `${index}-${offset}-${(index * (offset + 7)) % 9973}`;
		parts.push(piece);
		length += piece.length + 1;
	}
	return parts.join(" ");
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.build) {
		execFileSync("pnpm", ["run", "build"], { cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"] });
	}
	const { SessionManager } = await import(
		pathToFileURL(join(repoRoot, "packages", "coding-agent", "dist", "core", "session-manager.js")).href
	);
	const rows = [];
	for (const turns of options.turns) {
		const session = SessionManager.inMemory(".");
		const before = anonMiB();
		for (let turn = 0; turn < turns; turn++) {
			session.appendMessage({ role: "user", content: messageBody(turn, options.bytes), timestamp: turn });
		}
		rows.push({
			turns,
			entries: session.getEntryCount(),
			textMiB: (turns * options.bytes) / 1048576,
			anon: anonMiB() - before,
		});
	}

	if (options.json) {
		console.log(JSON.stringify({ bytes: options.bytes, rows }, null, 2));
		return;
	}
	console.log(`SessionManager retained RssAnon (${options.bytes} B per message)\n`);
	console.log("turns    entries   text      anon    anon/entry");
	for (const row of rows) {
		console.log(
			`${String(row.turns).padStart(5)} ${String(row.entries).padStart(10)} ${row.textMiB.toFixed(2).padStart(6)} MiB ${row.anon.toFixed(1).padStart(7)} MiB ${((row.anon * 1024) / row.entries).toFixed(1).padStart(9)} KiB`,
		);
	}
	console.log("");
	console.log("Growth is per message object plus its content text; compaction is the only");
	console.log("mechanism that drops either, and it keeps the tail it was asked to keep.");
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
