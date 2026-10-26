import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./check-merge-result.mjs", import.meta.url));

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

function commit(cwd, files, message) {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(cwd, path)), { recursive: true });
		writeFileSync(join(cwd, path), `${content}\n`);
	}
	git(cwd, ["add", "-A"]);
	git(cwd, ["commit", "-q", "--no-gpg-sign", "-m", message]);
}

async function repo(t, name) {
	const root = await mkdtemp(join(tmpdir(), `nanopi-merge-result-${name}-`));
	t.after(() => rm(root, { force: true, recursive: true }));
	git(root, ["init", "-q", "--initial-branch=main"]);
	git(root, ["config", "user.name", "Test"]);
	git(root, ["config", "user.email", "test@example.com"]);
	git(root, ["checkout", "-q", "-b", "topic"]);
	return root;
}

function check(cwd, base = "main") {
	return spawnSync(process.execPath, [script, "--base", base], { cwd, encoding: "utf8", env: gitEnv });
}

test("a branch that only adds files passes", async (t) => {
	const cwd = await repo(t, "add");
	commit(cwd, { "a.txt": "one" }, "base");
	git(cwd, ["branch", "-f", "main", "HEAD"]);
	commit(cwd, { "b.txt": "two" }, "add b");

	const result = check(cwd);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /no file from main disappears/);
});

// 关键用例：树被换回旧快照。父链是连着的（分支从 base 出发），只有内容消失。
test("a stale tree that drops a newer file is reported", async (t) => {
	const cwd = await repo(t, "stale");
	commit(cwd, { "a.txt": "one" }, "base");
	commit(cwd, { "keep.txt": "three" }, "newer work on the base");
	git(cwd, ["branch", "-f", "main", "HEAD"]);
	git(cwd, ["reset", "-q", "--hard", "HEAD~1"]);
	commit(cwd, { "b.txt": "two" }, "work on the stale branch");

	const result = check(cwd);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /drops 1 file/);
	assert.match(result.stderr, /keep\.txt/);
});

// 检查按路径比内容，改名会被当成删除：旧版本数 `D` 状态，同内容的改名是 `R`，
// 所以放行。判据是「main 的文件还在不在」，改名后旧路径确实没了。
test("a rename is reported, not waved through", async (t) => {
	const cwd = await repo(t, "rename");
	commit(cwd, { "a.txt": "same content so git pairs it as a rename" }, "base");
	git(cwd, ["branch", "-f", "main", "HEAD"]);
	git(cwd, ["mv", "a.txt", "b.txt"]);
	git(cwd, ["commit", "-q", "--no-gpg-sign", "-m", "rename"]);

	const result = check(cwd);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /a\.txt/);
});

test("a missing base fails instead of passing silently", async (t) => {
	const cwd = await repo(t, "missing");
	commit(cwd, { "a.txt": "one" }, "base");

	const result = check(cwd, "does-not-exist");
	assert.equal(result.status, 2);
	assert.match(result.stderr, /is missing/);
});
