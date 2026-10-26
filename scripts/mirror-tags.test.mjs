import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./mirror.mjs", import.meta.url));
// 镜像的唯一入口是 scripts/mirror.mjs，两个子命令共用一个文件。
const COMMAND = "tags";

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
	const root = await mkdtemp(join(tmpdir(), `nanopi-mirror-tags-${name}-`));
	t.after(() => rm(root, { force: true, recursive: true }));
	return root;
}

// 远端必须是裸仓库：往非裸仓库的当前分支推会被 receive.denyCurrentBranch 拒绝。
async function createFixture(t, name) {
	const root = await scratch(t, name);
	const remote = join(root, "remote.git");
	git(root, ["init", "-q", "--bare", remote]);
	return { remote, root };
}

function seedRepo(t, root, remote) {
	const seed = join(root, "seed");
	git(root, ["init", "-q", "--initial-branch=main", seed]);
	git(seed, ["config", "user.name", "Test"]);
	git(seed, ["config", "user.email", "test@example.com"]);
	commit(seed, "a.txt", "one", "init");
	git(seed, ["push", "--quiet", remote, "main:refs/heads/main"]);
	return seed;
}

function clone(t, root, remote, name) {
	const cwd = join(root, name);
	git(root, ["clone", "-q", remote, cwd]);
	git(cwd, ["checkout", "--quiet", "-B", "main", "origin/main"]);
	git(cwd, ["config", "user.name", "Test"]);
	git(cwd, ["config", "user.email", "test@example.com"]);
	return cwd;
}

function commit(cwd, file, content, message) {
	writeFileSync(join(cwd, file), `${content}\n`);
	git(cwd, ["add", file]);
	git(cwd, ["commit", "-q", "--no-gpg-sign", "-m", message]);
}

function mirror(cwd, remote) {
	return spawnSync(process.execPath, [script, COMMAND, "--remote", remote], { cwd, encoding: "utf8", env: gitEnv });
}

test("a new annotated tag is mirrored, then converges to a no-op", async (t) => {
	const { remote, root } = await createFixture(t, "new");
	seedRepo(t, root, remote);
	const local = clone(t, root, remote, "local");
	git(local, ["tag", "-a", "v20261026", "-m", "release"]);

	const first = mirror(local, remote);
	assert.equal(first.status, 0, first.stderr);
	assert.equal(git(remote, ["rev-parse", "refs/tags/v20261026"]), git(local, ["rev-parse", "refs/tags/v20261026"]));

	const second = mirror(local, remote);
	assert.equal(second.status, 0, second.stderr);
	assert.match(second.stdout, /no new annotated tags/);
});

test("a lightweight local tag is not mirrored", async (t) => {
	const { remote, root } = await createFixture(t, "lightweight");
	seedRepo(t, root, remote);
	const local = clone(t, root, remote, "local");
	git(local, ["tag", "v20261026"]);

	const result = mirror(local, remote);
	assert.equal(result.status, 0, result.stderr);
	const tags = spawnSync("git", ["for-each-ref", "--format=%(refname)", "refs/tags"], { cwd: remote, encoding: "utf8", env: gitEnv });
	assert.equal(tags.stdout.trim(), "");
});

test("a remote tag on the same commit is left alone, even if the object differs", async (t) => {
	const { remote, root } = await createFixture(t, "same-commit");
	seedRepo(t, root, remote);
	const local = clone(t, root, remote, "local");
	git(local, ["tag", "-a", "v20261026", "-m", "release"]);
	assert.equal(mirror(local, remote).status, 0);

	// 另一侧在同名 tag 上手写了一个指向同一 commit 的 annotated tag：提交相同，对象不同。
	const other = clone(t, root, remote, "other");
	git(other, ["tag", "-f", "-a", "v20261026", "-m", "other release"]);
	git(other, ["push", "--quiet", "--force", remote, "refs/tags/v20261026:refs/tags/v20261026"]);
	const remoteObject = git(remote, ["rev-parse", "refs/tags/v20261026"]);
	assert.notEqual(remoteObject, git(local, ["rev-parse", "refs/tags/v20261026"]));

	const result = mirror(local, remote);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /not rewriting it/);
	assert.equal(git(remote, ["rev-parse", "refs/tags/v20261026"]), remoteObject);
});

test("tags pointing to different commits on both sides fail instead of force-pushing", async (t) => {
	const { remote, root } = await createFixture(t, "diverged");
	seedRepo(t, root, remote);
	const local = clone(t, root, remote, "local");
	git(local, ["tag", "-a", "v20261026", "-m", "release"]);

	// 远端已经有了同名 tag，但指向另一个 commit。
	const other = clone(t, root, remote, "other");
	commit(other, "b.txt", "two", "second");
	git(other, ["tag", "-a", "v20261026", "-m", "other release"]);
	git(other, ["push", "--quiet", remote, "HEAD:refs/heads/main", "refs/tags/v20261026:refs/tags/v20261026"]);

	const result = mirror(local, remote);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /refusing to overwrite/);
});
