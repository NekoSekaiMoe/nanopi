#!/usr/bin/env node

// 把当前 checkout 的 main 内容镜像到对端仓库。两个方向的镜像（CNB -> GitHub
// 见 .cnb.yml，GitHub -> CNB 见 .github/workflows/sync-to-cnb.yml）调用同一份
// 逻辑，各自只负责取凭据。
//
// Usage:
//   node scripts/mirror-main.mjs --remote <url>
//
// 判定按内容做，不按 sha：两侧的历史早已分叉（一侧收到的是「对方 tip 上的合成
// 提交」），祖先关系不可靠，树相同就等于镜像完成。

import { execFileSync } from "node:child_process";

// 单次远端操作的超时。对端是 GitHub / CNB 的公网入口，连接被中途掐断时拿到的
// 是 GnuTLS 层的 "connection was non-properly terminated"（返回码 128），
// 和「认证失败」「非 fast-forward」不是一类问题，所以单独重试。
const REMOTE_TIMEOUT_MS = 60_000;
const ATTEMPTS = 3;
const BACKOFF_MS = 5_000;

function git(args, { allowFailure = false } = {}) {
	try {
		return execFileSync("git", args, {
			encoding: "utf8",
			// 认证失败时直接报错，不要挂在交互提示上（CI 没有 tty）。
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			timeout: REMOTE_TIMEOUT_MS,
		}).trim();
	} catch (error) {
		if (!allowFailure) throw error;
		return null;
	}
}

function parseArgs(argv) {
	let remote;
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === "--remote") remote = argv[index + 1];
	}
	if (!remote) {
		console.error("Usage: node scripts/mirror-main.mjs --remote <url>");
		process.exit(2);
	}
	return { remote };
}

function sleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function treeOf(revision) {
	return git(["rev-parse", `${revision}^{tree}`]);
}

// 只重试传输层失败。本地判定（树相同、非快进）不走这里，它们重试也没用。
function withRetry(label, action) {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return action();
		} catch (error) {
			if (attempt >= ATTEMPTS) throw error;
			const detail = (error.stderr ?? "").toString().trim().split("\n").at(-1) ?? error.message;
			console.log(`${label} failed (attempt ${attempt}/${ATTEMPTS}): ${detail}`);
			sleep(BACKOFF_MS * attempt);
		}
	}
}

const { remote } = parseArgs(process.argv.slice(2));

const head = git(["rev-parse", "HEAD"]);
const localTree = treeOf("HEAD");

withRetry("git fetch", () => git(["fetch", "--quiet", remote, "main"]));

if (treeOf("FETCH_HEAD") === localTree) {
	console.log(`remote main already has this tree: ${localTree}`);
	process.exit(0);
}

// 远端 tip 是 HEAD 的祖先时快进，历史连贯。否则推一个「父是远端 tip、树是本地
// HEAD 的」单父合成提交：合并提交（-p HEAD -p FETCH_HEAD）会把整个待推区间带进
// 通告，GitHub 的 push protection 会因此重新扫描历史里的提交，等于白推。
const fastForward = git(["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"], { allowFailure: true }) !== null;
const target = fastForward ? head : git(["commit-tree", localTree, "-p", "FETCH_HEAD", "-m", `Merge CNB main ${head}`]);

if (fastForward) {
	console.log(`fast-forward: ${head} is ahead of ${remote} main`);
} else {
	console.log(`diverged histories; pushing ${target} (tree of ${head} on the remote tip)`);
}

withRetry("git push", () => git(["push", "--quiet", remote, `${target}:refs/heads/main`]));

// 退出码不足以证明内容落地，回读远端树逐字节比一次。
withRetry("git fetch (verify)", () => git(["fetch", "--quiet", remote, "main"]));

const remoteTree = treeOf("FETCH_HEAD");
if (remoteTree !== localTree) {
	console.error("tree mismatch after push:");
	console.error(`  local  ${localTree}`);
	console.error(`  remote ${remoteTree}`);
	console.error(git(["diff", "--stat", localTree, remoteTree], { allowFailure: true }) ?? "");
	process.exit(1);
}

console.log(`mirrored ${head}: ${remoteTree}`);
