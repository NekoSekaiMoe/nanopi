import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./mirror-main.mjs", import.meta.url));

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
	return spawnSync(process.execPath, [script, "--remote", remote], { cwd, encoding: "utf8", env: gitEnv });
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
