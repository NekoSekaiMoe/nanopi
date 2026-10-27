import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// 入口层的契约：子命令选对了脚本，判定失败要以非零退出码传出去。判定本身由
// mirror-main.test.mjs / mirror-tags.test.mjs 覆盖。
const script = fileURLToPath(new URL("./mirror.mjs", import.meta.url));

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

function mirror(cwd, args, extraEnv = {}) {
	return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", env: { ...gitEnv, ...extraEnv } });
}

async function fixture(t, name) {
	const root = await mkdtemp(join(tmpdir(), `nanopi-mirror-entry-${name}-`));
	t.after(() => rm(root, { force: true, recursive: true }));

	const remote = join(root, "remote.git");
	git(root, ["init", "-q", "--bare", remote]);

	const seed = join(root, "seed");
	git(root, ["init", "-q", "--initial-branch=main", seed]);
	git(seed, ["config", "user.name", "Test"]);
	git(seed, ["config", "user.email", "test@example.com"]);
	writeFileSync(join(seed, "a.txt"), "one\n");
	git(seed, ["add", "a.txt"]);
	git(seed, ["commit", "-q", "--no-gpg-sign", "-m", "init"]);
	git(seed, ["push", "--quiet", remote, "main:refs/heads/main"]);

	const local = join(root, "local");
	git(root, ["clone", "-q", remote, local]);
	git(local, ["checkout", "--quiet", "-B", "main", "origin/main"]);
	git(local, ["config", "user.name", "Test"]);
	git(local, ["config", "user.email", "test@example.com"]);
	return { local, remote, root };
}

test("no subcommand prints usage and exits 2", () => {
	const result = mirror(process.cwd(), ["--remote", "https://example.invalid/x.git"]);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /Usage: node scripts\/mirror\.mjs <main\|tags> --remote <url>/);
});

test("an unknown subcommand prints usage and exits 2", () => {
	const result = mirror(process.cwd(), ["everything", "--remote", "https://example.invalid/x.git"]);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /Usage: node scripts\/mirror\.mjs <main\|tags> --remote <url>/);
});

test("main without --remote prints usage and exits 2", () => {
	const result = mirror(process.cwd(), ["main"]);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /Usage: node scripts\/mirror\.mjs <main\|tags> --remote <url>/);
});

test("main mirrors the checkout, tags is a no-op when there is nothing to send", async (t) => {
	const { local, remote } = await fixture(t, "dispatch");

	const main = mirror(local, ["main", "--remote", remote]);
	assert.equal(main.status, 0, main.stderr);
	assert.match(main.stdout, /fast-forward|already has this tree/);

	const tags = mirror(local, ["tags", "--remote", remote]);
	assert.equal(tags.status, 0, tags.stderr);
	assert.match(tags.stdout, /no new annotated tags to mirror/);
});

// 判定失败不是异常：mirrorMain / mirrorTags 返回 false，入口把它翻成退出码 1，
// 否则 CI 会当成镜像成功。
test("a refusal from the tag mirror surfaces as exit code 1", async (t) => {
	const { local, remote } = await fixture(t, "refusal");

	git(local, ["tag", "-a", "v0", "-m", "v0"]);
	assert.equal(mirror(local, ["tags", "--remote", remote]).status, 0);
	// 同一条历史上来回改：本地 tag 指向新提交，远端仍指向旧提交。
	writeFileSync(join(local, "a.txt"), "two\n");
	git(local, ["commit", "-q", "--no-gpg-sign", "-am", "second"]);
	git(local, ["tag", "-f", "-a", "v0", "-m", "v0 again"]);

	const result = mirror(local, ["tags", "--remote", remote]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /tag v0 points to different commits on both sides/);
});

// 凭据由入口自己落盘：workflow 只给环境变量名。缺 token 时不静默走匿名，
// 因为匿名推送到 GitHub / CNB 只会拿回 401，报错信息里看不出是漏了 secret。
test("a missing token environment variable is a usage error", () => {
	const env = { ...gitEnv };
	delete env.MIRROR_TEST_TOKEN;
	const result = spawnSync(
		process.execPath,
		[script, "main", "--remote", "https://example.invalid/x.git", "--token-user", "cnb", "--token-env", "MIRROR_TEST_TOKEN"],
		{ cwd: process.cwd(), encoding: "utf8", env },
	);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /MIRROR_TEST_TOKEN is unset/);
});

test("--token-user and --token-env must come together", () => {
	const result = mirror(process.cwd(), ["main", "--remote", "https://example.invalid/x.git", "--token-env", "MIRROR_TEST_TOKEN"]);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /Usage: node scripts\/mirror\.mjs <main\|tags> --remote <url>/);
});

// token 不能出现在输出里，临时凭据目录也不能留下：镜像失败的路径同样要清掉。
test("a failed mirror neither prints the token nor leaves the credential dir behind", async (t) => {
	// example.invalid 解析不了，fetch 必然失败；这里只关心失败路径也清干净。
	const run = mirror(process.cwd(), [
		"main",
		"--remote",
		"https://example.invalid/x.git",
		"--token-user",
		"cnb",
		"--token-env",
		"MIRROR_TEST_TOKEN",
	], { MIRROR_TEST_TOKEN: "s3cret" });
	assert.notEqual(run.status, 0);
	assert.doesNotMatch(run.stdout + run.stderr, /s3cret/);

	const leaked = spawnSync("bash", ["-c", "ls -d /tmp/nanopi-mirror-credentials-* 2>/dev/null | wc -l"], { encoding: "utf8" });
	assert.equal(leaked.stdout.trim(), "0");
});
