#!/usr/bin/env node

import { createReadStream, existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// Migrates sessions from ~/.nanopi/agent/*.jsonl to proper session directories.
// This fixes sessions created by the bug in v0.30.0 where sessions were saved to
// ~/.nanopi/agent/ instead of ~/.nanopi/agent/sessions/<encoded-cwd>/.
//
// Usage: node migrate-sessions.mjs [--dry-run]

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
	process.stdout.write("Usage: node migrate-sessions.mjs [--dry-run]\n");
	process.exit(0);
}
const dryRun = args.includes("--dry-run");

const agentDirectory = process.env.NANOPI_AGENT_DIR || join(homedir(), ".nanopi", "agent");

if (dryRun) {
	process.stdout.write("Dry run mode - no files will be moved\n\n");
}

// Only files directly in the agent directory; sessions already migrated live
// under sessions/ and must not be touched again.
const sessions = existsSync(agentDirectory)
	? readdirSync(agentDirectory, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.map((entry) => join(agentDirectory, entry.name))
	: [];

if (sessions.length === 0) {
	process.stdout.write(`No session files found in ${agentDirectory}\n`);
	process.exit(0);
}
process.stdout.write(`Found ${sessions.length} session file(s) to migrate\n\n`);

/** Reads just the first line; session headers are small and files can be large. */
function firstLine(path) {
	const stream = createReadStream(path, { encoding: "utf8", end: 64 * 1024 });
	return new Promise((resolveLine, rejectLine) => {
		let buffer = "";
		stream.on("data", (chunk) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			stream.destroy();
			resolveLine(buffer.slice(0, newline));
		});
		stream.on("end", () => resolveLine(buffer.split("\n")[0]));
		stream.on("error", rejectLine);
	});
}

// Must match getDefaultSessionDirPath in src/core/session-manager.ts.
function encodeDirectory(workingDirectory) {
	return `--${workingDirectory.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

let migrated = 0;
let skipped = 0;

for (const session of sessions) {
	const fileName = basename(session);
	let header;
	try {
		header = await firstLine(session);
	} catch {
		process.stdout.write(`SKIP: ${fileName} - cannot read file\n`);
		skipped += 1;
		continue;
	}

	let workingDirectory;
	try {
		workingDirectory = JSON.parse(header).cwd;
	} catch {
		process.stdout.write(`SKIP: ${fileName} - invalid JSON\n`);
		skipped += 1;
		continue;
	}

	if (typeof workingDirectory !== "string" || workingDirectory === "") {
		process.stdout.write(`SKIP: ${fileName} - no cwd in session header\n`);
		skipped += 1;
		continue;
	}

	const targetDirectory = join(agentDirectory, "sessions", encodeDirectory(workingDirectory));
	const target = join(targetDirectory, fileName);
	if (existsSync(target)) {
		process.stdout.write(`SKIP: ${fileName} - target already exists\n`);
		skipped += 1;
		continue;
	}

	process.stdout.write(`MIGRATE: ${fileName}\n    cwd: ${workingDirectory}\n    to:  ${targetDirectory}/\n`);
	if (!dryRun) {
		mkdirSync(targetDirectory, { recursive: true });
		if (!statSync(session, { throwIfNoEntry: false })?.isFile()) {
			process.stdout.write(`SKIP: ${fileName} - vanished before it could be moved\n`);
			skipped += 1;
			continue;
		}
		renameSync(session, target);
	}
	migrated += 1;
	process.stdout.write("\n");
}

process.stdout.write(`---\nMigrated: ${migrated}\nSkipped:  ${skipped}\n`);
if (dryRun && migrated > 0) process.stdout.write("\nRun without --dry-run to perform the migration\n");
