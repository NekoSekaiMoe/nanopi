import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// 这个脚本只提醒、不拦截，所以断言分两半：该出声的时候 stdout 里要有那条路径，
// 不该出声的时候一个字都没有；退出码在两种情况下都必须是 0，否则它就不是提示了。
const script = fileURLToPath(new URL("./check-agent-notes.mjs", import.meta.url));

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

async function repo(t, name) {
	const root = await mkdtemp(join(tmpdir(), `nanopi-agent-notes-${name}-`));
	t.after(() => rm(root, { force: true, recursive: true }));
	const cwd = join(root, "repo");
	mkdirSync(cwd);
	git(cwd, ["init", "-q", "--initial-branch=main", "."]);
	git(cwd, ["config", "user.name", "Test"]);
	git(cwd, ["config", "user.email", "test@example.com"]);
	// 初始提交只放一个无关文件，后面每个用例各自铺自己的目录。
	writeFileSync(join(cwd, "README.md"), "x\n");
	git(cwd, ["add", "README.md"]);
	git(cwd, ["commit", "-q", "--no-gpg-sign", "-m", "init"]);
	return cwd;
}

function write(cwd, path, content) {
	mkdirSync(join(cwd, path, ".."), { recursive: true });
	writeFileSync(join(cwd, path), content);
}

function commit(cwd, message) {
	git(cwd, ["add", "-A"]);
	git(cwd, ["commit", "-q", "--no-gpg-sign", "-m", message]);
}

function run(cwd, args = []) {
	return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", env: gitEnv });
}

test("a small source patch stays quiet", async (t) => {
	const cwd = await repo(t, "small");
	write(cwd, "packages/ai/src/a.ts", "y\n");
	commit(cwd, "tweak");

	const result = run(cwd);
	assert.equal(result.status, 0);
	assert.equal(result.stdout, "");
});

// 公开面阈值（40）先于总行数阈值（80）触发，所以这里只写 45 行。
test("a public-surface patch over the lower threshold is reported", async (t) => {
	const cwd = await repo(t, "public");
	write(cwd, "packages/coding-agent/src/a.ts", "y\n".repeat(45));
	commit(cwd, "change the surface");

	const result = run(cwd);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /45 line\(s\) under packages\/\{agent,coding-agent\}\/src/);
	assert.doesNotMatch(result.stdout, /packages\/\*\/src/);
});

test("a large patch outside the public surface is reported by total lines", async (t) => {
	const cwd = await repo(t, "total");
	write(cwd, "packages/ai/src/a.ts", "y\n".repeat(90));
	commit(cwd, "big provider patch");

	const result = run(cwd);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /90 line\(s\) under packages\/\*\/src/);
	assert.doesNotMatch(result.stdout, /packages\/\{agent,coding-agent\}/);
});

test("regression tests are reported on their own", async (t) => {
	const cwd = await repo(t, "tests");
	write(cwd, "packages/ai/src/a.ts", "y\n");
	write(cwd, "packages/ai/test/a.test.ts", "t\n");
	commit(cwd, "fix plus regression test");

	const result = run(cwd);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /regression tests/);
});

test("a note in the same commit silences the reminder", async (t) => {
	const cwd = await repo(t, "noted");
	write(cwd, "packages/coding-agent/src/a.ts", "y\n".repeat(120));
	write(cwd, "packages/coding-agent/test/a.test.ts", "t\n");
	write(cwd, ".agents/notes/implemented/feature/2026-11-05-thing.md", "# Agent Note: x\n\nStatus: implemented\n");
	commit(cwd, "feature plus note");

	const result = run(cwd);
	assert.equal(result.status, 0);
	assert.equal(result.stdout, "");
});

// --base 是 CI 那条路：本地 HEAD 之前的分支基点未必是 HEAD~1。
test("--base looks at the whole branch, not just the tip commit", async (t) => {
	const cwd = await repo(t, "base");
	write(cwd, "packages/coding-agent/src/a.ts", "y\n".repeat(60));
	commit(cwd, "change the surface");
	write(cwd, "packages/coding-agent/src/b.ts", "y\n");
	commit(cwd, "follow-up");

	const result = run(cwd, ["--base", "HEAD~2"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /61 line\(s\) under packages\/\{agent,coding-agent\}\/src/);
});

// 基线解析不到时退回本地范围，不能因为一个不存在的 ref 让提示整条消失或报错。
test("an unresolvable base falls back to the local range", async (t) => {
	const cwd = await repo(t, "no-base");
	write(cwd, "packages/coding-agent/src/a.ts", "y\n".repeat(45));
	commit(cwd, "change the surface");

	const result = run(cwd, ["--base", "does-not-exist"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /45 line\(s\)/);
});

test("uncommitted changes are reported too", async (t) => {
	const cwd = await repo(t, "worktree");
	write(cwd, "packages/coding-agent/src/a.ts", "y\n".repeat(45));

	const result = run(cwd);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /45 line\(s\)/);
});

test("--quiet never prints", async (t) => {
	const cwd = await repo(t, "quiet");
	write(cwd, "packages/coding-agent/src/a.ts", "y\n".repeat(120));
	commit(cwd, "big change");

	const result = run(cwd, ["--quiet"]);
	assert.equal(result.status, 0);
	assert.equal(result.stdout, "");
});
