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

async function fixture(t, { source = false, sidecars = false } = {}) {
	const root = await mkdtemp(join(tmpdir(), "nanopi-atomgit-test-"));
	t.after(() => rmSync(root, { force: true, recursive: true }));

	const remote = join(root, "assets.git");
	git(root, ["init", "-q", "--bare", remote]);

	const input = join(root, "input");
	mkdirSync(input);
	for (const name of ["nanopi.js", "nanopi-base.js", "nanopi-minimal.js"]) writeFileSync(join(input, name), `${name}\n`);
	if (source) writeFileSync(join(input, "nanopi-20261031.1.0-source.tar.gz"), "source\n");
	if (sidecars) writeFileSync(join(input, SIDECARS), "sidecars\n");
	return { root, remote, input, work: join(root, "work") };
}

// 每次发布都要说清楚「这批资产是哪个提交构建出来的」：nightly 的 release notes
// 与 README 都写着它，没这个参数就产不出可复现的说法。
const COMMIT = "c8da551859c6aefcb598716e9968dfd3c8116e08";
// Named after the TUI package version, which is what the bundle's sidecar
// manifest appends to the mirror URL.
const SIDECARS = "nanopi-sidecars-20261031.1.0.tgz";

function publish(fixture, args, extraEnv = {}) {
	return spawnSync(
		process.execPath,
		[script, "--commit", COMMIT, "--input", fixture.input, "--work", fixture.work, "--remote", `file://${fixture.remote}`, ...args],
		{ encoding: "utf8", env: { ...gitEnv, ...extraEnv } },
	);
}

test("nightly publishes the three bundles with checksums and moves its tag", async (t) => {
	const fixturePaths = await fixture(t);

	const first = publish(fixturePaths, ["--tag", "nightly", "--token-env", "ATOMGIT_KEY", "--push"]);
	assert.equal(first.status, 0, first.stderr);

	const files = git(fixturePaths.remote, ["ls-tree", "-r", "--name-only", "refs/heads/main"]).split("\n");
	assert.deepEqual(files, [
		"README.md",
		"assets/RELEASE_NOTES.md",
		"assets/SHA256SUMS",
		"assets/nanopi-base.js",
		"assets/nanopi-minimal.js",
		"assets/nanopi.js",
	]);

	// SHA256SUMS 是 install.js 的校验入口，格式错了安装会直接失败。
	const sums = git(fixturePaths.remote, ["show", "refs/heads/main:assets/SHA256SUMS"]).split("\n").filter(Boolean);
	assert.equal(sums.length, 3);
	for (const line of sums) {
		const [hash, name] = line.split(/\s+/);
		assert.equal(hash, createHash("sha256").update(readFileSync(join(fixturePaths.input, name))).digest("hex"), name);
	}

	const readme = git(fixturePaths.remote, ["show", "refs/heads/main:README.md"]);
	assert.match(readme, new RegExp(`Current: \\*\\*nightly\\*\\* built from ${COMMIT}`));
	assert.match(git(fixturePaths.remote, ["show", "refs/heads/main:assets/RELEASE_NOTES.md"]), new RegExp(`Nightly build of ${COMMIT}`));
	assert.match(readme, /nanopi\/releases-assets\/raw\/main\/nightly\/nanopi\.js/);

	// 同一天重跑：新提交叠在上面，tag 挪过去，主分支不出现 force。
	writeFileSync(join(fixturePaths.input, "nanopi.js"), "rebuilt\n");
	const second = publish(fixturePaths, ["--tag", "nightly", "--token-env", "ATOMGIT_KEY", "--push"]);
	assert.equal(second.status, 0, second.stderr);
	assert.equal(git(fixturePaths.remote, ["rev-list", "--count", "refs/heads/main"]), "2");
	const tagged = git(fixturePaths.remote, ["rev-parse", "refs/tags/nightly^{commit}"]);
	assert.equal(tagged, git(fixturePaths.remote, ["rev-parse", "refs/heads/main"]));
});

test("a release tag carries the source archive and keeps the official notes", async (t) => {
	const fixturePaths = await fixture(t, { source: true });
	// 正式版的 RELEASE_NOTES.md 由 release-notes.mjs 生成，这里只验证它被原样带上。
	writeFileSync(join(fixturePaths.input, "RELEASE_NOTES.md"), "### Changed\n\n- something\n");

	const result = publish(fixturePaths, ["--tag", "v20261031.1.0", "--token-env", "ATOMGIT_KEY", "--push"]);
	assert.equal(result.status, 0, result.stderr);

	const files = git(fixturePaths.remote, ["ls-tree", "-r", "--name-only", "refs/tags/v20261031.1.0"]).split("\n");
	assert.ok(files.includes("assets/nanopi-20261031.1.0-source.tar.gz"));
	assert.equal(
		git(fixturePaths.remote, ["show", "refs/tags/v20261031.1.0:assets/RELEASE_NOTES.md"]),
		"### Changed\n\n- something",
	);
	assert.match(git(fixturePaths.remote, ["show", "refs/heads/main:README.md"]), /Current: \*\*v20261031\.1\.0\*\*/);
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
	assert.equal(existsSync(join(fixturePaths.work, "assets", "nanopi.js")), true);
	assert.equal(spawnSync("git", ["for-each-ref", "--count=1"], { cwd: fixturePaths.remote, encoding: "utf8", env: gitEnv }).stdout.trim(), "");
});

// full 不再内嵌原生 sidecar，安装时唯一能下载到的就是这份 tgz：漏发等于把
// 剪贴板/图片那条加速留在 GitHub 上，而 bundle 里的 URL 已经指向镜像。
test("the TUI prebuild tarball is published beside the bundles", async (t) => {
	const fixturePaths = await fixture(t, { sidecars: true });

	const result = publish(fixturePaths, ["--tag", "nightly", "--token-env", "ATOMGIT_KEY", "--push"]);
	assert.equal(result.status, 0, result.stderr);

	const files = git(fixturePaths.remote, ["ls-tree", "-r", "--name-only", "refs/heads/main"]).split("\n");
	assert.ok(files.includes(`assets/${SIDECARS}`), files.join(", "));

	// 校验和文件是 install.js 与 sidecar 下载共用的入口，tgz 必须在里面。
	const sums = git(fixturePaths.remote, ["show", "refs/heads/main:assets/SHA256SUMS"]).split("\n").filter(Boolean);
	const line = sums.find((entry) => entry.endsWith(`  ${SIDECARS}`));
	assert.ok(line, "sidecars tarball is not listed in SHA256SUMS");
	assert.equal(
		line.split(/\s+/)[0],
		createHash("sha256").update(readFileSync(join(fixturePaths.input, SIDECARS))).digest("hex"),
	);

	// README 与 release notes 都要写明它在哪，否则镜像地址只存在于 bundle 里。
	const readme = git(fixturePaths.remote, ["show", "refs/heads/main:README.md"]);
	assert.match(readme, new RegExp(`raw/main/nightly/${SIDECARS.replaceAll(".", "\\.")}`));
	assert.match(
		git(fixturePaths.remote, ["show", "refs/heads/main:assets/RELEASE_NOTES.md"]),
		new RegExp(`raw/main/nightly/${SIDECARS.replaceAll(".", "\\.")}`),
	);
});

test("a release payload without the tarball still publishes the bundles", async (t) => {
	// 正式发布由 build-binaries.yml 上传资产，那份 tgz 是否在 artifact 里由流水线
	// 断言；这里只钉住「没有它不算错误」，免得补发时因为一个可选文件卡住整批。
	const fixturePaths = await fixture(t, { source: true });

	const result = publish(fixturePaths, ["--tag", "v20261031.1.0", "--token-env", "ATOMGIT_KEY", "--push"]);
	assert.equal(result.status, 0, result.stderr);
	const tagged = git(fixturePaths.remote, ["ls-tree", "-r", "--name-only", "refs/tags/v20261031.1.0"]).split("\n");
	assert.ok(tagged.includes("assets/nanopi.js"), tagged.join(", "));
	assert.equal(tagged.filter((name) => name.includes("sidecars")).length, 0);
});
