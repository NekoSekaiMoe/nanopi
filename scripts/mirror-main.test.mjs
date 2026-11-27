import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./mirror.mjs", import.meta.url));
// 镜像的唯一入口是 scripts/mirror.mjs，两个子命令共用一个文件。
const COMMAND = "main";

// 隔离 fixture 仓库与开发者的全局 git 配置（签名、hooks、模板），保证提交可复现。
const gitEnv = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_TERMINAL_PROMPT: "0",
};

function git(cwd, args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

async function scratch(t, name) {
	const root = await mkdtemp(join(tmpdir(), `nanopi-mirror-${name}-`));
	t.after(() => rm(root, { force: true, recursive: true }));
	return root;
}

// 远端必须是裸仓库：往非裸仓库的当前分支推会被 receive.denyCurrentBranch
// 拒绝，那不是本脚本要处理的情形。
async function createFixture(t, name) {
	const root = await scratch(t, name);
	const remote = join(root, "remote.git");
	git(root, ["init", "-q", "--bare", remote]);
	return { remote, root };
}

function clone(t, root, remote, name) {
	const cwd = join(root, name);
	git(root, ["clone", "-q", remote, cwd]);
	// 裸仓库没有 HEAD 指向，clone 出来的工作区停在空分支上，显式切到 main。
	git(cwd, ["checkout", "--quiet", "-B", "main", "origin/main"]);
	git(cwd, ["config", "user.name", "Test"]);
	git(cwd, ["config", "user.email", "test@example.com"]);
	return cwd;
}

// 空仓库没有 main，先造一条历史推上去，再 clone 出被测仓库。
function seedRepo(t, root, remote) {
	const seed = join(root, "seed");
	git(root, ["init", "-q", "--initial-branch=main", seed]);
	git(seed, ["config", "user.name", "Test"]);
	git(seed, ["config", "user.email", "test@example.com"]);
	commit(seed, "a.txt", "one", "init");
	git(seed, ["push", "--quiet", remote, "main:refs/heads/main"]);
}

function commit(cwd, file, content, message) {
	writeFileSync(join(cwd, file), `${content}\n`);
	git(cwd, ["add", file]);
	git(cwd, ["commit", "-q", "--no-gpg-sign", "-m", message]);
}

function mirror(cwd, remote) {
	return spawnSync(process.execPath, [script, COMMAND, "--remote", remote], { cwd, encoding: "utf8", env: gitEnv });
}

test("fast-forward mirror lands the tree, then converges to a no-op", async (t) => {
	const { remote, root } = await createFixture(t, "ff");
	seedRepo(t, root, remote);
	const local = clone(t, root, remote, "local");
	commit(local, "b.txt", "two", "second");

	const first = mirror(local, remote);
	assert.equal(first.status, 0, first.stderr);
	assert.match(first.stdout, /fast-forward/);
	assert.equal(git(remote, ["rev-parse", "main^{tree}"]), git(local, ["rev-parse", "HEAD^{tree}"]));

	const second = mirror(local, remote);
	assert.equal(second.status, 0, second.stderr);
	assert.match(second.stdout, /already has this tree/);
});

test("diverged histories push a single-parent commit with the local tree", async (t) => {
	const { remote, root } = await createFixture(t, "diverged");
	seedRepo(t, root, remote);
	const local = clone(t, root, remote, "local");
	// 远端被另一条历史覆盖（对端收到的是合成提交），本地仍是原历史。
	const other = clone(t, root, remote, "other");
	commit(other, "a.txt", "rewritten", "rewrite on the remote side");
	git(other, ["push", "--quiet", "--force", remote, "HEAD:refs/heads/main"]);

	commit(local, "a.txt", "local", "local rewrite");

	const result = mirror(local, remote);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /diverged histories/);

	assert.equal(git(remote, ["rev-parse", "main^{tree}"]), git(local, ["rev-parse", "HEAD^{tree}"]));
	// 合成提交必须是单父：合并提交会把待推区间重新通告给 push protection。
	assert.equal(git(remote, ["rev-list", "--count", "--merges", "main", "--not", "main~1"]), "0");
	assert.equal(git(remote, ["rev-parse", "main^"]), git(other, ["rev-parse", "HEAD"]));
});

test("a missing remote fails instead of reporting success", async (t) => {
	const { root } = await createFixture(t, "missing");
	const local = join(root, "local");
	git(root, ["init", "-q", "--initial-branch=main", local]);
	git(local, ["config", "user.name", "Test"]);
	git(local, ["config", "user.email", "test@example.com"]);
	commit(local, "a.txt", "one", "init");

	const result = mirror(local, join(root, "does-not-exist.git"));
	assert.notEqual(result.status, 0);
});

// 远端在本地这份树之后又往前走了：合成提交拿旧树落下去就等于回退。父链看不出来
// （父仍是远端 tip），丢的只有内容，所以必须在推送前拒绝。
test("a diverged remote with newer content is refused instead of reverted", async (t) => {
	const { remote, root } = await createFixture(t, "revert");
	seedRepo(t, root, remote);
	const local = clone(t, root, remote, "local");

	// 对端改写了 a.txt 并新增了只有它才有的 c.txt —— 历史分叉，树也不同。
	const other = clone(t, root, remote, "other");
	commit(other, "a.txt", "rewritten", "rewrite on the remote side");
	commit(other, "c.txt", "three", "remote-only file");
	git(other, ["push", "--quiet", remote, "HEAD:refs/heads/main"]);

	commit(local, "b.txt", "two", "second");

	const result = mirror(local, remote);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /refusing to overwrite/);
	assert.match(result.stderr, /c\.txt/);
	// 远端没被动过。
	assert.equal(git(remote, ["rev-parse", "main"]), git(other, ["rev-parse", "HEAD"]));
});

// 分叉但远端的新提交本地树里都还带着（例如本地用别的历史重做了同样的改动），
// 合成提交不丢内容，照旧放行。
test("a diverged remote whose content survives locally is still mirrored", async (t) => {
	const { remote, root } = await createFixture(t, "subset");
	seedRepo(t, root, remote);
	const local = clone(t, root, remote, "local");

	const other = clone(t, root, remote, "other");
	commit(other, "c.txt", "three", "remote-only file");
	git(other, ["push", "--quiet", remote, "HEAD:refs/heads/main"]);

	// 本地把同样的内容也加进来（另一次提交），但还多了一个远端没有的文件，
	// 树因此不同，走的是合成提交那条路。
	commit(local, "c.txt", "three", "add c.txt on the local side");
	commit(local, "d.txt", "four", "local-only file");

	const result = mirror(local, remote);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /diverged histories/);
	assert.equal(git(remote, ["rev-parse", "main^{tree}"]), git(local, ["rev-parse", "HEAD^{tree}"]));
});

// A local pre-push hook moves the remote ref after the script's fetch and exits
// non-zero, so git rejects the first push. This reproduces the compare-and-swap
// failure from CI: the mirror must refetch and recompute, not replay the stale
// ref.
test("a remote that advances between fetch and push is recomputed", async (t) => {
	const { remote, root } = await createFixture(t, "race");
	seedRepo(t, root, remote);
	const local = clone(t, root, remote, "local");
	const other = clone(t, root, remote, "other");

	commit(local, "a.txt", "local", "local change");
	assert.equal(mirror(local, remote).status, 0);
	const firstLocal = git(local, ["rev-parse", "HEAD"]);

	commit(local, "a.txt", "shared", "shared tree on local side");
	commit(local, "race.txt", "shared", "shared content on local side");
	git(other, ["fetch", "--quiet", remote, "main"]);
	git(other, ["reset", "--hard", "FETCH_HEAD"]);
	commit(other, "a.txt", "shared", "shared tree on remote side");
	commit(other, "race.txt", "shared", "shared content on remote side");
	assert.equal(git(local, ["rev-parse", "HEAD^{tree}"]), git(other, ["rev-parse", "HEAD^{tree}"]));

	git(remote, ["fetch", "--quiet", local, `${firstLocal}:refs/heads/local-base`]);
	git(remote, ["update-ref", "refs/heads/main", "refs/heads/local-base"]);
	git(remote, ["fetch", "--quiet", other, "main:refs/heads/push-target"]);

	const hook = join(local, ".git", "hooks", "pre-push");
	writeFileSync(hook, `#!/bin/sh
cat >/dev/null
git --git-dir="${remote}" update-ref refs/heads/main refs/heads/push-target
echo "simulated race: remote advanced" >&2
exit 1
`);
	chmodSync(hook, 0o755);

	const result = mirror(local, remote);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /simulated race: remote advanced/);
	assert.match(result.stdout, /remote main advanced during push/);
	assert.match(result.stdout, /already has this tree/);
	assert.equal(git(remote, ["rev-parse", "main^{tree}"]), git(local, ["rev-parse", "HEAD^{tree}"]));
});

// CI can start from a checkout that is already behind source main (two back-to-back
// pushes). Mirroring that stale tree as-is makes the guard treat files added by the
// newer source commit as a removal, so the mirror must follow source main first.
test("a stale local checkout mirrors the latest source tree", async (t) => {
	const root = await scratch(t, "stale-checkout");
	const sourceRepo = join(root, "source.git");
	git(root, ["init", "-q", "--bare", sourceRepo]);

	const local = join(root, "local");
	git(root, ["init", "-q", "--initial-branch=main", local]);
	git(local, ["config", "user.name", "Test"]);
	git(local, ["config", "user.email", "test@example.com"]);
	commit(local, "base.txt", "base", "init");
	const staleHead = git(local, ["rev-parse", "HEAD"]);
	git(local, ["remote", "add", "origin", sourceRepo]);
	git(local, ["push", "-q", sourceRepo, "HEAD:refs/heads/main"]);

	// Advance source main with a commit that adds a file the stale checkout lacks.
	const source = clone(t, root, sourceRepo, "source");
	commit(source, "source-only.txt", "source", "newer source commit");
	const sourceHead = git(source, ["rev-parse", "HEAD"]);
	git(source, ["push", "-q", sourceRepo, "HEAD:refs/heads/main"]);
	// Simulate a CI checkout pinned to the old commit while the source branch
	// has advanced: HEAD stays at the old commit.
	git(local, ["symbolic-ref", "HEAD", "refs/heads/detached-main"]);
	git(local, ["update-ref", "refs/heads/detached-main", staleHead]);

	const result = spawnSync(process.execPath, [script, COMMAND, "--remote", sourceRepo], {
		cwd: local,
		encoding: "utf8",
		env: { ...gitEnv, MIRROR_SOURCE_REMOTE: sourceRepo },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /checkout is behind main/);
	assert.equal(git(sourceRepo, ["rev-parse", "main"]), sourceHead);
	assert.equal(git(sourceRepo, ["rev-parse", "main^{tree}"]), git(source, ["rev-parse", "HEAD^{tree}"]));
	assert.notEqual(git(sourceRepo, ["rev-parse", "main"]), staleHead);
});
