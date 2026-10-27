import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// 这个脚本的价值全在「基线是目标分支的 tip、结果是合完 PR 的树」这个方向上，
// 所以测试按 CNB 的现场搭：一个裸 origin，main 和 PR 分支各有一条历史。
const script = fileURLToPath(new URL("./check-merge-result-cnb.mjs", import.meta.url));

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

async function fixture(t, name) {
	const root = await mkdtemp(join(tmpdir(), `nanopi-merge-result-cnb-${name}-`));
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

	return { root, remote, seed };
}

// 工作树是目标分支（main）的 tip，与 CNB 的 pull_request.target checkout 一致。
function checkoutMain(t, root, remote, name) {
	const cwd = join(root, name);
	git(root, ["clone", "-q", remote, cwd]);
	git(cwd, ["checkout", "--quiet", "-B", "main", "origin/main"]);
	// 故意不配 user.name/user.email：脚本必须自己带上合并身份，容器里通常没有全局配置。
	return cwd;
}

// 工作树里要有 scripts/ 下的两个脚本：被测脚本按自己的位置找判定脚本，而这棵
// 树是 fixture 仓库（没有 scripts/）。真实 CI 里脚本本来就在仓库里。
function installScripts(cwd, files) {
	mkdirSync(join(cwd, "scripts"), { recursive: true });
	for (const file of files) copyFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), join(cwd, "scripts", file));
	return cwd;
}

function pushBranch(root, seed, remote, branch) {
	git(seed, ["push", "--quiet", remote, `HEAD:refs/heads/${branch}`]);
}

function run(cwd, env) {
	installScripts(cwd, ["check-merge-result.mjs"]);
	return spawnSync(process.execPath, [script], {
		cwd,
		encoding: "utf8",
		env: { ...gitEnv, ...env },
	});
}

test("a PR that only adds files passes", async (t) => {
	const { root, remote, seed } = await fixture(t, "adds");
	git(seed, ["checkout", "--quiet", "-b", "pr"]);
	writeFileSync(join(seed, "b.txt"), "two\n");
	git(seed, ["add", "b.txt"]);
	git(seed, ["commit", "-q", "--no-gpg-sign", "-m", "add b"]);
	pushBranch(root, seed, remote, "pr");
	const cwd = checkoutMain(t, root, remote, "work");

	const result = run(cwd, { CNB_PULL_REQUEST_BRANCH: "pr" });
	assert.equal(result.status, 0, result.stderr);
	// 基线由脚本自己取（合并提交的第一父），所以这里只能断言「没丢东西」，
	// 不能写死某个 ref 名：写死 HEAD~1 的那版在 #279 把基线改成第一父之后就红了。
	assert.match(result.stdout, /no file from [0-9a-f]{40} disappears/);
});

// #255 现场：把方向反过来时，PR 新增的文件会被读成「删除」。这里正着跑，只要
// 不出现那句就说明基线没搞反。
test("a PR that rewrites an existing file still passes", async (t) => {
	const { root, remote, seed } = await fixture(t, "rewrites");
	git(seed, ["checkout", "--quiet", "-b", "pr"]);
	writeFileSync(join(seed, "a.txt"), "rewritten\n");
	git(seed, ["commit", "-q", "--no-gpg-sign", "-am", "rewrite a"]);
	pushBranch(root, seed, remote, "pr");
	const cwd = checkoutMain(t, root, remote, "work");

	const result = run(cwd, { CNB_PULL_REQUEST_BRANCH: "pr" });
	assert.equal(result.status, 0, result.stderr);
	// 同理，只断言「改写了 1 个文件」这件事本身。
	assert.match(result.stdout, /rewrites 1 file\(s\) that [0-9a-f]{40} has/);
	assert.doesNotMatch(result.stderr, /drops \d+ file/);
});

// PR 分支在基线上删了文件，就是真的删除，要红（判定在被调用的脚本里）。
test("a PR that deletes a file from the target branch fails", async (t) => {
	const { root, remote, seed } = await fixture(t, "deletes");
	git(seed, ["checkout", "--quiet", "-b", "pr"]);
	git(seed, ["rm", "-q", "a.txt"]);
	git(seed, ["commit", "-q", "--no-gpg-sign", "-m", "drop a"]);
	pushBranch(root, seed, remote, "pr");
	const cwd = checkoutMain(t, root, remote, "work");

	const result = run(cwd, { CNB_PULL_REQUEST_BRANCH: "pr" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /a\.txt/);
});

// #296 A：PR 描述里的 `deletes:` 由本脚本落地成临时文件交给判定脚本，判定本身不联网。
test("a deletes: claim in CNB_PULL_REQUEST_DESC excuses the deletion", async (t) => {
	const { root, remote, seed } = await fixture(t, "claimed");
	git(seed, ["checkout", "--quiet", "-b", "pr"]);
	git(seed, ["rm", "-q", "a.txt"]);
	git(seed, ["commit", "-q", "--no-gpg-sign", "-m", "drop a"]);
	pushBranch(root, seed, remote, "pr");
	const cwd = checkoutMain(t, root, remote, "work");

	const result = run(cwd, {
		CNB_PULL_REQUEST_BRANCH: "pr",
		CNB_PULL_REQUEST_DESC: "drop the dead fixture\n\ndeletes: a.txt\n",
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /a\.txt/);
	assert.match(result.stdout, /accounted for/);
});

test("a missing CNB_PULL_REQUEST_BRANCH exits 2 instead of passing", async (t) => {
	const { root, remote } = await fixture(t, "unset");
	const cwd = checkoutMain(t, root, remote, "work");

	const result = run(cwd, { CNB_PULL_REQUEST_BRANCH: "" });
	assert.equal(result.status, 2);
	assert.match(result.stderr, /CNB_PULL_REQUEST_BRANCH is unset/);
});

// 目标分支在 PR 之后又往前走了：合并结果里必须还留着它新加的文件。
test("content pushed to the target branch after the PR branched is kept", async (t) => {
	const { root, remote, seed } = await fixture(t, "advanced");
	git(seed, ["checkout", "--quiet", "-b", "pr"]);
	writeFileSync(join(seed, "b.txt"), "two\n");
	git(seed, ["add", "b.txt"]);
	git(seed, ["commit", "-q", "--no-gpg-sign", "-m", "add b"]);
	pushBranch(root, seed, remote, "pr");

	// 目标分支上的新提交：PR 分支没有它，合并结果必须带上。
	git(seed, ["checkout", "--quiet", "main"]);
	writeFileSync(join(seed, "c.txt"), "three\n");
	git(seed, ["add", "c.txt"]);
	git(seed, ["commit", "-q", "--no-gpg-sign", "-m", "add c on main"]);
	git(seed, ["push", "--quiet", remote, "main:refs/heads/main"]);

	const cwd = checkoutMain(t, root, remote, "work");
	const result = run(cwd, { CNB_PULL_REQUEST_BRANCH: "pr" });
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /drops/);
});
