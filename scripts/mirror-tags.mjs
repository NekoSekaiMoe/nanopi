#!/usr/bin/env node

// 把当前 checkout 的 annotated tag 镜像到对端仓库，配套 scripts/mirror-main.mjs。
// 两个方向（CNB -> GitHub 见 .cnb.yml，GitHub -> CNB 见
// .github/workflows/sync-to-cnb.yml）调用同一份逻辑，各自只负责取凭据。
//
// Usage: 见 scripts/mirror.mjs（唯一入口）；本文件只导出 mirrorTags，
// 供它按子命令调用。
//
// 判定是「远端已存在且指向同一 commit 就跳过、指向不同 commit 就报错」，不是对象
// id 不等就报错：同名轻量 tag 在另一侧是 annotated 不算冲突。两个方向都不 force，
// 所以 tag 一旦在两侧分叉就会永久卡住，需要人介入。

import { execFileSync } from "node:child_process";

// 远端 tag 落到独立命名空间，不写 refs/tags/：写进去之后下面的循环会把 fetch 来的
// 远端 tag 当成「本地也有」，远端不存在的 tag 就永远判不出来。（也不能用
// --prune-tags，那会按本地的 tag 名单去清远端。）
const REMOTE_TAGS_PREFIX = "refs/remote-tags/tags/";
const REMOTE_TAGS_REFSPEC = `refs/tags/*:${REMOTE_TAGS_PREFIX}*`;

// 与 mirror-main.mjs 一致：单次远端操作 60s 超时，传输层失败重试，本地判定不重试。
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

function fetchRemoteTags(remote) {
	withRetry("git fetch (tags)", () => git(["fetch", "--quiet", "--force", remote, REMOTE_TAGS_REFSPEC]));
}

// 只处理本地的 annotated tag，即能 peel 成 commit 的那类：轻量 tag 只是指向某个
// commit 的别名，本地若有同名 annotated tag 则它已在列表里。
function localAnnotatedTags() {
	const listing = git(["for-each-ref", "--format=%(objectname) %(objecttype) %(refname)", "refs/tags"]);
	return listing
		.split("\n")
		.map((line) => line.split(" "))
		.filter(([, type]) => type === "tag")
		.map(([object, , ref]) => ({ name: ref.slice("refs/tags/".length), object }));
}

function remoteObjectOf(name) {
	return git(["rev-parse", "--verify", "--quiet", REMOTE_TAGS_PREFIX + name], { allowFailure: true });
}

export function mirrorTags(remote) {
	fetchRemoteTags(remote);

	const pending = [];
	for (const { name, object } of localAnnotatedTags()) {
		const remoteObject = remoteObjectOf(name);
		if (remoteObject === object) continue;
		if (remoteObject) {
			const localCommit = git(["rev-parse", `${object}^{commit}`]);
			const remoteCommit = git(["rev-parse", `${remoteObject}^{commit}`]);
			if (localCommit !== remoteCommit) {
				console.error(`tag ${name} points to different commits on both sides; refusing to overwrite:`);
				console.error(`  local  ${object} (${localCommit})`);
				console.error(`  remote ${remoteObject} (${remoteCommit})`);
				return false;
			}
			console.log(`tag ${name} exists on the remote (${remoteObject}); not rewriting it`);
			continue;
		}
		pending.push(name);
	}

	if (pending.length === 0) {
		console.log("no new annotated tags to mirror");
		return;
	}

	// 不带 force：两个方向都不覆盖已有 tag，分叉在上面已经拦住了。
	for (const name of pending) {
		withRetry(`git push ${name}`, () => git(["push", "--quiet", remote, `refs/tags/${name}:refs/tags/${name}`]));
	}

	// push 的退出码不足以证明落上去的是本地这个对象，重新 fetch 后逐个比一次。
	fetchRemoteTags(remote);
	for (const name of pending) {
		const localObject = git(["rev-parse", `refs/tags/${name}`]);
		const remoteObject = remoteObjectOf(name);
		if (localObject !== remoteObject) {
			console.error(`tag ${name} mismatch after push: local ${localObject} remote ${remoteObject}`);
			return false;
		}
		console.log(`mirrored tag ${name}: ${remoteObject}`);
	}
}
