#!/usr/bin/env node

// 返回到目前 main 落后/领先多少个提交，给提交前的远端同步用。
//
// Usage:
//   node scripts/git-upstream.mjs [--remote origin] [--branch main]
//
// 输出一行 JSON：{"behind": n, "ahead": n}。拉不到远端时退出码非零。

import { execFileSync } from "node:child_process";

const FETCH_TIMEOUT_MS = 60_000;

function git(args) {
	return execFileSync("git", args, {
		encoding: "utf8",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		timeout: FETCH_TIMEOUT_MS,
	}).trim();
}

function parseArgs(argv) {
	let remote = "origin";
	let branch = "main";
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === "--remote") remote = argv[index + 1];
		if (argv[index] === "--branch") branch = argv[index + 1];
	}
	return { remote, branch };
}

const { remote, branch } = parseArgs(process.argv.slice(2));

git(["fetch", "--quiet", remote, branch]);

// 没有上游分支（本地新建的仓库、没 push 过的分支）就不算落后。
const upstream = `${remote}/${branch}`;
let behind = 0;
let ahead = 0;
try {
	const [behindText, aheadText] = git(["rev-list", "--left-right", "--count", `${upstream}...HEAD`]).split(/\s+/);
	behind = Number(behindText);
	ahead = Number(aheadText);
} catch {
	// rev-list 失败说明上游分支不存在，behind/ahead 保持 0。
}

process.stdout.write(`${JSON.stringify({ behind, ahead })}\n`);
