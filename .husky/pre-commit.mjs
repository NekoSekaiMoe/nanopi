#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// Pre-commit gate: catch a stale upstream first, then format/lint/type-check,
// then a browser smoke test when the staged changes touch the packages that can
// affect rendering.

function run(script) {
	const result = spawnSync("pnpm", ["run", script], { stdio: "inherit", shell: process.platform === "win32" });
	return result.status === 0;
}

function git(args) {
	return spawnSync("git", args, { encoding: "utf8" });
}

// 本地分支落后远端 main 时直接停下。git commit 只是引用 HEAD 的父树，`git pull`
// 回来会重新指向远端 tip，把「还没 push 的提交」从分支上摘掉 —— 工作区内容还在，
// 提交本身只剩 reflog 能救。检查放在这里，是因为这是唯一能拦住它的地方。
// AGENTS.md 的 Git 一节写着同一条规矩。
const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
if (upstream.status === 0) {
	const counts = git(["rev-list", "--left-right", "--count", `${upstream.stdout.trim()}...HEAD`]);
	const behind = counts.status === 0 ? Number(counts.stdout.trim().split(/\s+/)[0]) : 0;
	if (behind > 0) {
		process.stderr.write(
			`Local ${upstream.stdout.trim().replace(/^[^/]+\//, "")} is ${behind} commit(s) behind ${upstream.stdout.trim()}.\n` +
				"Committing now risks losing the commit on the next pull; run `git pull --ff-only` first.\n",
		);
		process.exit(1);
	}
}

const staged = git(["diff", "--cached", "--name-only"]);
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
