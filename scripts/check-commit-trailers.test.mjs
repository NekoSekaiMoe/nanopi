import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./check-commit-trailers.mjs", import.meta.url));
const ZERO = "0".repeat(40);

// Isolate the fixture repos from the developer's global git config (signing,
// hooks, templates) so commit creation is reproducible.
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

async function createRepo(t) {
	const root = await mkdtemp(join(tmpdir(), "nanopi-commit-trailers-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	git(root, ["init", "-q", "--initial-branch=main"]);
	git(root, ["config", "user.name", "Test"]);
	git(root, ["config", "user.email", "test@example.com"]);
	return root;
}

function commit(root, file, message) {
	writeFileSync(join(root, file), `${message}\n`);
	git(root, ["add", file]);
	git(root, ["commit", "-q", "--no-gpg-sign", "-m", message]);
	return git(root, ["rev-parse", "HEAD"]);
}

function check(root, before, after) {
	return spawnSync(process.execPath, [script, before, after], { cwd: root, encoding: "utf8" });
}

// #3: CI cannot amend pushed commits, so a missing Change-Id is reported, not failed.
test("reports commits without a Change-Id without failing", async (t) => {
	const root = await createRepo(t);
	const first = commit(root, "a", "feat: first");
	const second = commit(root, "b", "feat: second");

	const result = check(root, first, second);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /Checked 1 commit\(s\); 1 without Change-Id/);
});

test("accepts a commit that carries the Change-Id trailer", async (t) => {
	const root = await createRepo(t);
	const first = commit(root, "a", "feat: first");
	const second = commit(root, "b", "feat: second\n\nChange-Id: I0000000000000000000000000000000000000000");

	const result = check(root, first, second);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /Checked 1 commit\(s\); 0 without Change-Id/);
});

// The first push reports an all-zero tip; the range must start at Init instead of
// degrading to "nothing to check".
test("falls back to root commits when the previous tip is unset", async (t) => {
	const root = await createRepo(t);
	const first = commit(root, "a", "feat: first");
	commit(root, "b", "feat: second");
	const tip = git(root, ["rev-parse", "HEAD"]);

	const result = check(root, ZERO, tip);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /Checked 1 commit\(s\)/);
	assert.match(result.stdout, new RegExp(first.slice(0, 12)));
});

test("skips merge commits", async (t) => {
	const root = await createRepo(t);
	const first = commit(root, "a", "feat: first");
	git(root, ["checkout", "-q", "-b", "topic"]);
	commit(root, "b", "feat: topic");
	git(root, ["checkout", "-q", "main"]);
	commit(root, "c", "feat: main");
	git(root, ["merge", "-q", "--no-ff", "--no-gpg-sign", "-m", "Merge topic", "topic"]);
	const tip = git(root, ["rev-parse", "HEAD"]);

	const result = check(root, first, tip);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /Checked 2 commit\(s\)/);
});
