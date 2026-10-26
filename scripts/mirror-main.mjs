#!/usr/bin/env node

// 把当前 checkout 的 main 内容镜像到对端仓库。两个方向的镜像（CNB -> GitHub
// 见 .cnb.yml，GitHub -> CNB 见 .github/workflows/sync-to-cnb.yml）调用同一份
// 逻辑，各自只负责取凭据。
//
// Usage: 见 scripts/mirror.mjs（唯一入口）；本文件只导出 mirrorMain，
// 供它按子命令调用。
//
// 判定按内容做，不按 sha：两侧的历史早已分叉（一侧收到的是「对方 tip 上的合成
// 提交」），祖先关系不可靠，树相同就等于镜像完成。
//
// 树相同不等于可以覆盖：本地这份树是「本地 HEAD 那一刻」的快照，远端可能已经
// 在这之后往前走了。用旧树盖掉远端新提交，被盖掉的那些提交在 `git log` 里没有
// 任何痕迹（父链没断，丢的只是内容），只有下一轮合并的人才会发现问题。所以远端
// 有新提交时必须证明「它带的东西本地树里都还在」，否则拒绝推送。

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

// 远端 tip 相对本地树删掉的文件。判定按文件内容做：本地树里有同名文件但内容不同
// 不算「带过来了」，因为那多半正是要回退的那个改动。
//
//   git diff --raw <远端 tip> <本地树>
//
// 输出每行形如 `:<old mode> <new mode> <old blob> <new blob> <status>\t<path>`，
// 状态首字母 `D` 表示该文件在本地树里不存在。
function removalsOf(remoteTip, localTree) {
	const raw = git(["diff", "--raw", "--no-abbrev", remoteTip, localTree]);
	const removals = [];
	for (const line of raw.split("\n")) {
		if (!line) continue;
		const [meta, ...pathParts] = line.split("\t");
		const status = meta.split(" ").at(-1);
		const path = pathParts.join("\t");
		if (status === "D") removals.push(path);
	}
	return removals;
}

export function mirrorMain(remote) {
	const head = git(["rev-parse", "HEAD"]);
	const localTree = treeOf("HEAD");

	withRetry("git fetch", () => git(["fetch", "--quiet", remote, "main"]));

	if (treeOf("FETCH_HEAD") === localTree) {
		console.log(`remote main already has this tree: ${localTree}`);
		return;
	}

	// 远端 tip 是 HEAD 的祖先时快进，历史连贯。否则推一个「父是远端 tip、树是本地
	// HEAD 的」单父合成提交：合并提交（-p HEAD -p FETCH_HEAD）会把整个待推区间带进
	// 通告，GitHub 的 push protection 会因此重新扫描历史里的提交，等于白推。
	const fastForward = git(["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"], { allowFailure: true }) !== null;

	// 合成提交只搬内容，被它落下的远端提交在历史上留不下痕迹。非快进时必须先证明
	// 那些提交的文件本地树仍然都有，否则就是一次内容回退（#242：b3ffe400 用旧树
	// 盖掉了 c897cdf2 的 #235 改动）。
	if (!fastForward) {
		const removals = removalsOf("FETCH_HEAD", localTree);
		if (removals.length > 0) {
			console.error(`refusing to overwrite ${remote} main: ${removals.length} file(s) from its tip are absent locally`);
			for (const path of removals.slice(0, 20)) console.error(`  ${path}`);
			if (removals.length > 20) console.error(`  ... and ${removals.length - 20} more`);
			console.error("merge the remote main into this branch and rerun; the mirror never reverts content");
			return false;
		}
	}

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
		return false;
	}

	console.log(`mirrored ${head}: ${remoteTree}`);
}

