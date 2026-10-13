#!/usr/bin/env node

// Checks the commit range a push introduced for the Change-Id trailer this repo
// asks for. The local `.husky/commit-msg` hook can only cover clones (CNB does
// not run hooks and exposes no API to amend commit messages), so CI is the
// place to report what slipped through.
//
// Usage:
//   node scripts/check-commit-trailers.mjs <before> <after>
//
// `<before>` is the previous tip reported by the push event. The first push to
// a branch reports zeros; that means "no known tip", so the range degrades to
// the root commits (`--max-parents=0`) and the check still starts at Init.

import { execFileSync } from "node:child_process";

const ZERO_SHA = /^0+$/;
const UNSET_BEFORE = /^0{7,40}$/;

function git(args) {
	return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function parseArgs(argv) {
	const [before, after] = argv;
	if (!after) {
		console.error("Usage: node scripts/check-commit-trailers.mjs <before> <after>");
		process.exit(2);
	}
	return { before, after };
}

function resolveCommits({ before, after }) {
	if (UNSET_BEFORE.test(before ?? "") || !before) {
		return git(["rev-list", "--max-parents=0", after]).split("\n").filter(Boolean);
	}

	// A force push can drop the previous tip from history; the range is then
	// unbounded on the left, so fall back to the same root-commit range.
	try {
		git(["merge-base", "--is-ancestor", before, after]);
	} catch {
		console.log(`Previous tip ${before} is not an ancestor of ${after}; checking root commits instead`);
		return git(["rev-list", "--max-parents=0", after]).split("\n").filter(Boolean);
	}

	return git(["rev-list", "--no-merges", `${before}..${after}`]).split("\n").filter(Boolean);
}

function trailersOf(sha) {
	const message = git(["log", "-1", "--format=%B", sha]);
	return { subject: message.split("\n", 1)[0], message };
}

const CHANGE_ID = /^Change-Id: I[0-9a-f]{40}$/m;

const { before, after } = parseArgs(process.argv.slice(2));
const commits = resolveCommits({ before, after });

if (commits.length === 0) {
	console.log(`No commits to check in ${before}..${after}`);
	process.exit(0);
}

const missing = [];
for (const sha of commits) {
	const { subject, message } = trailersOf(sha);
	if (!CHANGE_ID.test(message)) missing.push({ sha, subject });
}

console.log(`Checked ${commits.length} commit(s); ${missing.length} without Change-Id`);

if (missing.length === 0) process.exit(0);

// Reporting only. A missing Change-Id cannot be fixed from CI (no API amends
// commit messages), and for a direct CNB push the committer is the only one who
// can add it, so a hard failure would only block pushes nobody can repair here.
console.log("");
console.log("Commits without a Change-Id trailer:");
for (const { sha, subject } of missing) {
	console.log(`  ${sha.slice(0, 12)} ${subject}`);
}
console.log("");
console.log("To add one to the tip commit:");
console.log("  git commit --amend -s   # .husky/commit-msg adds Change-Id + Signed-off-by");
process.exit(0);
