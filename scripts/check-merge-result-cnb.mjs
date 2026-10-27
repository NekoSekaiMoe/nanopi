#!/usr/bin/env node

// 在 CNB 的 pull_request.target 事件里，把 PR 分支合进目标分支，再交给
// scripts/check-merge-result.mjs 比对。判定本身在那里，本脚本只负责造出它要的
// 两个提交。
//
// Usage:
//   node scripts/check-merge-result-cnb.mjs [--remote <name>]
//
// 需要环境变量 CNB_PULL_REQUEST_BRANCH（CNB 提供）。
//
// 为什么不能直接用事件给的提交：pull_request.target 用的是合并前目标分支的最新
// 提交（pull_request 给的是预合并结果，按定义已含 main 的树，回退永远查不出来，
// #242 的 b3ffe400 就是这样过去的），而它拿不到 PR 的代码，所以源分支得自己
// fetch 进来自合一次。
//
// 方向：工作树是目标分支 tip，合并后 HEAD 是结果，HEAD 的第一父是基线。反过来把
// PR 分支当基线会让 PR 新增的每个文件都成为「被删掉」（#255）。基线不往外传，
// check-merge-result.mjs 自己取第一父（#279：那里默认拿远端 main 当基线，会把
// PR 分支历史上的删除误判成回退）。

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 被调用的脚本按本文件的路径取，不按 cwd：cwd 是工作树，CNB 上 checkout 出来
// 的确实是这个仓库，但换成别处的 checkout 就该按脚本自己的位置找。
const CHECK = join(dirname(fileURLToPath(import.meta.url)), "check-merge-result.mjs");

function git(args) {
	return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function parseArgs(argv) {
	let remote = "origin";
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === "--remote") remote = argv[index + 1];
	}
	return { remote };
}

const { remote } = parseArgs(process.argv.slice(2));
const branch = process.env.CNB_PULL_REQUEST_BRANCH;

if (!branch) {
	console.error("CNB_PULL_REQUEST_BRANCH is unset; this script only runs on CNB pull_request.target builds");
	process.exit(2);
}

// 两侧都是 CNB 上的仓库，checkout 自带的只读令牌够用。落到独立命名空间，
// 不碰 refs/heads/。
git(["fetch", "--no-tags", remote, `+refs/heads/${branch}:refs/remotes/pr/head`]);

// 合并身份用仓库级配置：runner 是一次性的，而且容器里没有全局 user.name 时
// `git merge` 会直接拒绝提交。写成 env 只对 git 自己生效，不影响别的命令。
execFileSync("git", ["merge", "--no-edit", "refs/remotes/pr/head"], {
	stdio: "inherit",
	env: { ...process.env, GIT_AUTHOR_NAME: "npc", GIT_AUTHOR_EMAIL: "npc@cnb.cool", GIT_COMMITTER_NAME: "npc", GIT_COMMITTER_EMAIL: "npc@cnb.cool" },
});

execFileSync(process.execPath, [CHECK], { stdio: "inherit" });
