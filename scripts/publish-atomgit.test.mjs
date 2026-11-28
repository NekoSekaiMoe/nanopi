import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// 发行仓库的契约：主分支只带最新一份，tag 跟着走，SHA256SUMS 列的就是发出去
// 的那几个文件。真机推送（https + token）留给流水线验证，这里用本地 bare 仓库
// 钉住「发了什么」。
const script = fileURLToPath(new URL("./publish-atomgit.mjs", import.meta.url));

const gitEnv = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_TERMINAL_PROMPT: "0",
	// 推送要一个非空的 token；file:// 的 bare 仓库不校验它，脚本只要求它在。
	ATOMGIT_KEY: "test-token",
};

function git(cwd, args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

async function fixture(t, { source = false, seed = false, deb = "nanopi_20261128.0.0+nightly.20261129_all.deb" } = {}) {
	const root = await mkdtemp(join(tmpdir(), "nanopi-atomgit-test-"));
	t.after(() => rmSync(root, { force: true, recursive: true }));

	const remote = join(root, "assets.git");
	git(root, ["init", "-q", "--bare", remote]);
	if (seed) {
		// The assets repository already holds a previous publish: the case a
		// release meets on its second day of life, not a virgin bare repo.
		const seedDir = join(root, "seed");
		mkdirSync(seedDir);
		git(seedDir, ["init", "-q", "--initial-branch=main"]);
		writeFileSync(join(seedDir, "README.md"), "previous publish\n");
		git(seedDir, ["add", "-A"]);
		git(seedDir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed"]);
		git(seedDir, ["push", "-q", "file://" + remote, "HEAD:refs/heads/main"]);
		rmSync(seedDir, { force: true, recursive: true });
	}

	const input = join(root, "input");
	mkdirSync(input);
	for (const name of ["nanopi.js", "nanopi-base.js", "nanopi-minimal.js"]) writeFileSync(join(input, name), `${name}\n`);
	if (deb) writeFileSync(join(input, deb), `${deb}\n`);
	if (source) writeFileSync(join(input, "nanopi-20261031.1.0-source.tar.gz"), "source\n");
	return { root, remote, input, work: join(root, "work") };
}

// 每次发布都要说清楚「这批资产是哪个提交构建出来的」：nightly 的 release notes
// 与 README 都写着它，没这个参数就产不出可复现的说法。
const COMMIT = "c8da551859c6aefcb598716e9968dfd3c8116e08";
function publish(fixture, args, extraEnv = {}) {
	return spawnSync(
		process.execPath,
		[script, "--commit", COMMIT, "--input", fixture.input, "--work", fixture.work, "--remote", `file://${fixture.remote}`, ...args],
		{ encoding: "utf8", env: { ...gitEnv, ...extraEnv } },
	);
}

test("nightly publishes the three bundles and deb package with checksums and moves its tag", async (t) => {
	const fixturePaths = await fixture(t);

	const first = publish(fixturePaths, ["--tag", "nightly", "--token-env", "ATOMGIT_KEY", "--push"]);
	assert.equal(first.status, 0, first.stderr);

	const files = git(fixturePaths.remote, ["ls-tree", "-r", "--name-only", "refs/heads/main"]).split("\n");
	assert.deepEqual(files, [
		"README.md",
		"nightly/RELEASE_NOTES.md",
		"nightly/SHA256SUMS",
		"nightly/nanopi-base.js",
		"nightly/nanopi-minimal.js",
		"nightly/nanopi.js",
		"nightly/nanopi_20261128.0.0+nightly.20261129_all.deb",
	]);

	// SHA256SUMS 是 install.js 的校验入口，格式错了安装会直接失败。
	const sums = git(fixturePaths.remote, ["show", "refs/heads/main:nightly/SHA256SUMS"]).split("\n").filter(Boolean);
	assert.equal(sums.length, 4);
	for (const line of sums) {
		const [hash, name] = line.split(/\s+/);
		assert.equal(hash, createHash("sha256").update(readFileSync(join(fixturePaths.input, name))).digest("hex"), name);
	}

	const readme = git(fixturePaths.remote, ["show", "refs/heads/main:README.md"]);
	assert.match(readme, new RegExp(`Current: \\*\\*nightly\\*\\* built from ${COMMIT}`));
	assert.match(git(fixturePaths.remote, ["show", "refs/heads/main:nightly/RELEASE_NOTES.md"]), new RegExp(`Nightly build of ${COMMIT}`));
	assert.match(readme, /nanopi\/releases-assets\/raw\/main\/nightly\/nanopi\.js/);
	assert.match(readme, /nanopi\/releases-assets\/raw\/main\/nightly\/nanopi_20261128\.0\.0\+nightly\.20261129_all\.deb/);

	// 同一天重跑：新提交叠在上面，tag 挪过去，主分支不出现 force。
	writeFileSync(join(fixturePaths.input, "nanopi.js"), "rebuilt\n");
	const second = publish(fixturePaths, ["--tag", "nightly", "--token-env", "ATOMGIT_KEY", "--push"]);
	assert.equal(second.status, 0, second.stderr);
	assert.equal(git(fixturePaths.remote, ["rev-list", "--count", "refs/heads/main"]), "2");
	const tagged = git(fixturePaths.remote, ["rev-parse", "refs/tags/nightly^{commit}"]);
	assert.equal(tagged, git(fixturePaths.remote, ["rev-parse", "refs/heads/main"]));
});

// The checkout used to start with `git init`, which makes a root commit: every
// publish after the repository's first one was rejected as a non-fast-forward,
// so the mirror stayed on the previous release while the workflow failed.
test("publishing over an existing assets repository is a fast-forward", async (t) => {
	const fixturePaths = await fixture(t, { source: true, seed: true });
	const before = git(fixturePaths.remote, ["rev-parse", "refs/heads/main"]);

	const result = publish(fixturePaths, ["--tag", "v20261031.1.0", "--token-env", "ATOMGIT_KEY", "--push"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(git(fixturePaths.remote, ["rev-parse", "refs/heads/main^"]), before, "the new commit must sit on the published main");
	assert.equal(git(fixturePaths.remote, ["rev-list", "--count", "refs/heads/main"]), "2");
});

test("a release tag carries the source archive and keeps the official notes", async (t) => {
	const fixturePaths = await fixture(t, { source: true });
	// 正式版的 RELEASE_NOTES.md 由 release-notes.mjs 生成，这里只验证它被原样带上。
	writeFileSync(join(fixturePaths.input, "RELEASE_NOTES.md"), "### Changed\n\n- something\n");

	const result = publish(fixturePaths, ["--tag", "v20261031.1.0", "--token-env", "ATOMGIT_KEY", "--push"]);
	assert.equal(result.status, 0, result.stderr);

	const files = git(fixturePaths.remote, ["ls-tree", "-r", "--name-only", "refs/tags/v20261031.1.0"]).split("\n");
	assert.ok(files.includes("v20261031.1.0/nanopi-20261031.1.0-source.tar.gz"));
	assert.equal(
		git(fixturePaths.remote, ["show", "refs/tags/v20261031.1.0:v20261031.1.0/RELEASE_NOTES.md"]),
		"### Changed\n\n- something",
	);
	assert.match(git(fixturePaths.remote, ["show", "refs/heads/main:README.md"]), /Current: \*\*v20261031\.1\.0\*\*/);
});

// The bundle bakes its own download URL at build time and a date release tag
// carries no patch part: v20261114 must land in v20261114.0.0/, the directory
// the shipped bundle asks for, or the mirror answers 404 forever.
test("a date tag lands in the directory the bundle asks for", async (t) => {
	const fixturePaths = await fixture(t, { deb: "nanopi_20261114.0.0_all.deb" });
	writeFileSync(join(fixturePaths.input, "nanopi-20261114-source.tar.gz"), "source\n");

	const result = publish(fixturePaths, ["--tag", "v20261114", "--token-env", "ATOMGIT_KEY", "--push"]);
	assert.equal(result.status, 0, result.stderr);

	const files = git(fixturePaths.remote, ["ls-tree", "-r", "--name-only", "refs/heads/main"]);
	assert.match(files, /^v20261114\.0\.0\/nanopi\.js$/m);
	assert.match(files, /^v20261114\.0\.0\/nanopi_20261114\.0\.0_all\.deb$/m);
	assert.match(git(fixturePaths.remote, ["show", "refs/heads/main:README.md"]), /raw\/main\/v20261114\.0\.0\/nanopi\.js/);
});

test("a missing or ambiguous deb package fails fast", async (t) => {
	const missingDeb = await fixture(t, { deb: null });
	const missingResult = publish(missingDeb, ["--tag", "nightly", "--token-env", "ATOMGIT_KEY", "--push"]);
	assert.equal(missingResult.status, 1);
	assert.match(missingResult.stderr, /Debian package .* is missing/);

	const multiDeb = await fixture(t);
	writeFileSync(join(multiDeb.input, "nanopi_20261128.0.0_all.deb"), "extra\n");
	const multiResult = publish(multiDeb, ["--tag", "nightly", "--token-env", "ATOMGIT_KEY", "--push"]);
	assert.equal(multiResult.status, 1);
	assert.match(multiResult.stderr, /Multiple Debian packages found/);
});

test("a missing flavor is an error, not a silently smaller release", async (t) => {
	const fixturePaths = await fixture(t);
	rmSync(join(fixturePaths.input, "nanopi-base.js"));

	const result = publish(fixturePaths, ["--tag", "nightly", "--token-env", "ATOMGIT_KEY", "--push"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /nanopi-base\.js is missing/);
	assert.equal(existsSync(fixturePaths.remote), true);
});

test("--push without --token-env fails before reaching git", async (t) => {
	const fixturePaths = await fixture(t);

	const result = publish(fixturePaths, ["--tag", "nightly", "--push"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /--push needs --token-env/);
	assert.equal(spawnSync("git", ["for-each-ref", "--count=1"], { cwd: fixturePaths.remote, encoding: "utf8", env: gitEnv }).stdout.trim(), "");
});

test("--push with an unset token variable names it", async (t) => {
	const fixturePaths = await fixture(t);

	const result = publish(fixturePaths, ["--tag", "nightly", "--token-env", "ATOMGIT_KEY", "--push"], { ATOMGIT_KEY: "" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /ATOMGIT_KEY is unset/);
});

test("--commit is required: a nightly nobody can trace back is not worth publishing", async (t) => {
	const fixturePaths = await fixture(t);

	const result = spawnSync(
		process.execPath,
		[script, "--tag", "nightly", "--input", fixturePaths.input, "--work", fixturePaths.work, "--remote", `file://${fixturePaths.remote}`],
		{ encoding: "utf8", env: gitEnv },
	);
	assert.equal(result.status, 2);
	assert.match(result.stdout, /--commit <sha>/);
});

test("without --push nothing is uploaded", async (t) => {
	const fixturePaths = await fixture(t);
	const result = publish(fixturePaths, ["--tag", "nightly"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /pass --push to upload/);
	assert.equal(existsSync(join(fixturePaths.work, "nightly", "nanopi.js")), true);
	assert.equal(spawnSync("git", ["for-each-ref", "--count=1"], { cwd: fixturePaths.remote, encoding: "utf8", env: gitEnv }).stdout.trim(), "");
});
