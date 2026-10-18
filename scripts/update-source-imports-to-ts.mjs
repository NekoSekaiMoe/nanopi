#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot } from "./lib/node-runner.mjs";

// Rewrites relative source import specifiers in package source directories from
// .js to .ts. TypeScript's rewriteRelativeImportExtensions option rewrites them
// back to .js in emitted output.
//
// The rewrite stays in Perl: it is a single pass over every source file, while
// reading, regexing, and writing each file from Node costs an order of magnitude
// more. This wrapper only supplies the file list.

const packagesDirectory = join(repositoryRoot, "packages");
const sourceDirectories = [];
for (const entry of readdirSync(packagesDirectory, { withFileTypes: true })) {
	const sourceDirectory = join(packagesDirectory, entry.name, "src");
	try {
		if (entry.isDirectory() && readdirSync(sourceDirectory).length > 0) sourceDirectories.push(sourceDirectory);
	} catch {
		// Package without a src directory.
	}
}
if (sourceDirectories.length === 0) {
	process.stderr.write("No package sources found; run this from the repository root\n");
	process.exit(1);
}

const find = spawnSync("find", [...sourceDirectories, "-type", "f", "-name", "*.ts", "-print0"], { cwd: repositoryRoot });
if (find.error || find.status !== 0) {
	process.stderr.write(`find failed: ${find.error?.message ?? `exit ${find.status}`}\n`);
	process.exit(1);
}
const files = find.stdout.toString().split("\0").filter(Boolean);

const expression = [
	String.raw`s/(\b(?:from|import)\b\s*\(?\s*["\x27])(\.{1,2}\/[^"\x27\r\n]+)\.js(["\x27]\s*\)?)/$1$2.ts$3/g`,
	String.raw`s/(\bdeclare\s+module\s+["\x27])(\.{1,2}\/[^"\x27\r\n]+)\.js(["\x27])/$1$2.ts$3/g`,
	String.raw`s/(\bimportNodeOnlyProvider\(\s*["\x27])(\.{1,2}\/[^"\x27\r\n]+)\.js(["\x27]\s*\))/$1$2.ts$3/g`,
].join("; ");

// -0 matches the NUL-separated file list, so paths with spaces and newlines survive.
const perl = spawnSync("perl", ["-0pi", "-e", expression, ...files], { cwd: repositoryRoot, stdio: "inherit" });
if (perl.error) {
	process.stderr.write(`perl is required to rewrite imports: ${perl.error.message}\n`);
	process.exit(1);
}
process.exit(perl.status ?? 1);
