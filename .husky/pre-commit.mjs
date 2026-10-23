#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// Pre-commit gate: format/lint/type-check, plus a browser smoke test when the
// staged changes touch the packages that can affect rendering.

function run(script) {
	const result = spawnSync("pnpm", ["run", script], { stdio: "inherit", shell: process.platform === "win32" });
	return result.status === 0;
}

const staged = spawnSync("git", ["diff", "--cached", "--name-only"], { encoding: "utf8" });
if (staged.status !== 0) process.exit(1);

const files = staged.stdout.split("\n").filter(Boolean);

process.stdout.write("Running formatting, linting, and type checking...\n");
if (!run("check")) {
	process.stderr.write("Checks failed. Please fix the errors before committing.\n");
	process.exit(1);
}

const needsBrowserSmoke = files.some(
	(file) =>
		file.startsWith("packages/ai/") ||
		file.startsWith("packages/web-ui/") ||
		file === "package.json" ||
		file === "pnpm-lock.yaml",
);

if (needsBrowserSmoke) {
	process.stdout.write("Running browser smoke check...\n");
	if (!run("check:browser-smoke")) {
		process.stderr.write("Browser smoke check failed.\n");
		process.exit(1);
	}
}

// Formatting may have rewritten staged files; stage them again so the commit
// contains what was checked. Deleted files no longer exist and are skipped.
for (const file of files) {
	if (existsSync(file)) spawnSync("git", ["add", file], { stdio: "inherit" });
}

process.stdout.write("All pre-commit checks passed.\n");
