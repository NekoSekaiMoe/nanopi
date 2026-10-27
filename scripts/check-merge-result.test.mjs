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

function git(cwd, args, extra = {}) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv, ...extra });
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

// 基线一律用 tag 钉住，不拿分支名当基线：fixture 里 main 与 topic 会一起往前走，
// 靠 ref 名当基线等于把分支的移动一起带跑。
function pinBase(cwd) {
	git(cwd, ["tag", "base"]);
	return "base";
}

// 目标分支在分叉之后得有自己的一跳，否则它是 topic 的祖先，合并直接快进，
// 没有合并提交可看（git 不会为一个空动作造提交）。
const advanceTarget = (cwd, files = { "on-target.txt": "landed after the fork" }) =>
	commit(cwd, files, "work on the target after the fork");

// CNB 的现场：工作树是目标分支 tip，把 PR 分支合进来，结果就是合并提交。
// 基线取合并提交的第一父，与 check-merge-result-cnb.mjs 的默认一致——不能拿 ref
// 名当基线：合并之后 target 与 topic 同树，拿 topic 当基线时「base 有的路径」在
// 结果里当然都还在，删除是看不见的。
function targetAheadOfFork(cwd) {
	// 提交身份用 `commit-tree` 造，不碰工作树。树是「分支起点 + on-target.txt」：
	// 这个 ref 起点是 topic 的第一父（`main` 这个名字在 fixture 里还不存在）。
	// HEAD 在 topic 上时 `checkout -B main` 只是给 main 换个名字，main 跟着 topic
	// 一起走，两边还是同一条历史，合并就退化成快进了——所以树要显式造出来。
	const parent = git(cwd, ["rev-parse", "topic^1"]);
	const blob = git(cwd, ["hash-object", "-w", "--stdin"], { input: "landed\n" });
	const index = `${git(cwd, ["ls-tree", "-r", `${parent}^{tree}`])}\n100644 blob ${blob}\ton-target.txt\n`;
	const tree = git(cwd, ["mktree"], { input: index });
	const commitId = git(cwd, ["commit-tree", tree, "-p", parent, "-m", "target work after the fork"]);
	git(cwd, ["checkout", "-q", "-B", "main", commitId]);
	return commitId;
}

function mergeIntoTarget(cwd) {
	targetAheadOfFork(cwd);
	git(cwd, ["merge", "-q", "--no-edit", "--no-gpg-sign", "topic"]);
	return check(cwd, "HEAD^1");
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

function check(cwd, base = "main", extra = []) {
	return spawnSync(process.execPath, [script, "--base", base, ...extra], { cwd, encoding: "utf8", env: gitEnv });
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

// 判据是「main 的路径还在不在」：改掉一个 base 上的文件与把它回退成旧内容，在树里
// 长得一模一样（git 不存「谁改过谁」），所以内容改动只能放行，否则每个正常的修改
// 都会变红（#253）。
test("a file the branch rewrites is a modification, not a deletion", async (t) => {
	const cwd = await repo(t, "modify");
	commit(cwd, { "a.txt": "one" }, "base");
	git(cwd, ["branch", "-f", "main", "HEAD"]);
	commit(cwd, { "a.txt": "one, but longer" }, "reword a");

	const result = check(cwd);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /rewrites 1 file/);
	assert.match(result.stdout, /a\.txt/);
	assert.match(result.stdout, /no file from main disappears/);
});

// 改名是一次提交里的删除：单个父的那一跳说明不了意图（回退型的提交也是 D），
// 所以旧路径消失仍然要红，只有 `deletes:` 能放行。旧版本数 `D` 状态，同内容的改名
// 是 `R`，所以放行；按路径比对才拦得住（#296 之后 `D` 只在合并提交里当证据用）。
test("a rename in a single-parent commit is reported, not waved through", async (t) => {
	const cwd = await repo(t, "rename");
	commit(cwd, { "a.txt": "same content so git pairs it as a rename" }, "base");
	git(cwd, ["branch", "-f", "main", "HEAD"]);
	git(cwd, ["mv", "a.txt", "b.txt"]);
	git(cwd, ["commit", "-q", "--no-gpg-sign", "-m", "rename"]);

	const result = check(cwd);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /a\.txt/);
	assert.doesNotMatch(result.stderr, /accounted for/);
});

// #296 A：PR 描述里逐条列出的 `deletes:` 是唯一「意图被记下来」的证据，
// 单父提交上也只有它能放行。
test("a deletes: claim in the description excuses the path on a single-parent commit", async (t) => {
	const cwd = await repo(t, "claim");
	commit(cwd, { "a.txt": "one" }, "base");
	const base = pinBase(cwd);
	git(cwd, ["rm", "-q", "a.txt"]);
	git(cwd, ["commit", "-q", "--no-gpg-sign", "-m", "drop a"]);

	const claim = join(cwd, "desc.txt");
	writeFileSync(claim, "drop a, it is dead\n\ndeletes: a.txt\n");
	const result = check(cwd, base, ["--description-file", claim]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /1 file\(s\) from base are gone and accounted for/);
	assert.match(result.stdout, /a\.txt/);
});

// 白名单是逐条的：只写一半就还是红，写 `*` 不算数（那等于关掉检查）。
test("a deletes: claim only covers the paths it names", async (t) => {
	const cwd = await repo(t, "claim-partial");
	commit(cwd, { "a.txt": "one", "b.txt": "two" }, "base");
	const base = pinBase(cwd);
	git(cwd, ["rm", "-q", "a.txt", "b.txt"]);
	git(cwd, ["commit", "-q", "--no-gpg-sign", "-m", "drop both"]);

	const claim = join(cwd, "desc.txt");
	writeFileSync(claim, "deletes: a.txt\n");
	const result = check(cwd, base, ["--description-file", claim]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /b\.txt/);
	assert.doesNotMatch(result.stderr, /a\.txt/);

	writeFileSync(claim, "deletes: *\n");
	const wildcard = check(cwd, base, ["--description-file", claim]);
	assert.equal(wildcard.status, 1);
	assert.match(wildcard.stderr, /a\.txt/);
	assert.match(wildcard.stderr, /b\.txt/);
});

// C：合并提交里被这一跳删掉的路径（`:100644 000000 ... D`）算有方向，放行。
// 这就是 #294 的现场形态：CNB 把 PR 的所有改动折进一个 `git merge` 提交。
test("a deletion made by the merge commit itself is accounted for", async (t) => {
	const cwd = await repo(t, "merge-delete");
	commit(cwd, { "keep.txt": "one", "gone.txt": "two" }, "base");
	git(cwd, ["rm", "-q", "gone.txt"]);
	git(cwd, ["commit", "-q", "--no-gpg-sign", "-m", "drop gone"]);

	const result = mergeIntoTarget(cwd);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /gone\.txt/);
	assert.match(result.stdout, /accounted for/);
});

// 但合并提交不是免死金牌：合并结果里没了 target 上已有的文件，而 `head^1..head`
// 里没有它的 D（回退不会在合并那一跳留下 D），仍然是红。C 单独用会把 #241 那类
// 回退放行。
test("a stale tree merged over newer work is still reported", async (t) => {
	const cwd = await repo(t, "merge-stale");
	commit(cwd, { "a.txt": "one" }, "base");
	pinBase(cwd);
	commit(cwd, { "b.txt": "two" }, "work on the topic");
	// 目标分支在分叉之后自己往前走（见 targetAheadOfFork）。PR 那一跳里没有
	// on-target.txt，合并按老规矩「删除优先」。先按正常方向把合并做出来，再按 #241
	// 的 b3ffe400 造那个合成提交——父是目标分支 tip（合并的第一父），树是「结果
	// minus on-target.txt」。
	targetAheadOfFork(cwd);
	assert.match(git(cwd, ["ls-tree", "-r", "--name-only", "HEAD"]), /on-target\.txt/, "the target branch must carry on-target.txt before the merge");
	git(cwd, ["merge", "-q", "--no-edit", "--no-gpg-sign", "topic"]);
	const merged = git(cwd, ["rev-parse", "HEAD^{tree}"]);
	assert.match(git(cwd, ["ls-tree", "-r", "--name-only", "HEAD"]), /on-target\.txt/, "the merge result must still carry on-target.txt");
	const withoutTarget = git(cwd, ["ls-tree", "-r", "HEAD"])
		.split("\n")
		.filter((line) => !line.endsWith("\ton-target.txt"))
		.join("\n");
	const staleTree = git(cwd, ["mktree"], { input: `${withoutTarget}\n` });
	const head = git(cwd, [
		"commit-tree",
		staleTree,
		"-p",
		git(cwd, ["rev-parse", "HEAD^1"]),
		"-m",
		"synthetic merge result that lost target work",
	]);
	assert.notEqual(merged, staleTree);
	git(cwd, ["update-ref", "HEAD", head]);
	const result = check(cwd, "HEAD^1");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /on-target\.txt/);
	assert.doesNotMatch(result.stderr, /accounted for/);
});

// 合并提交里的改名：旧路径在这一跳里是 R100，不是 D，仍然要红。与
// `a rename in a single-parent commit is reported` 配对，钉住「只认 D」。
test("a rename inside a merge commit is still a deletion", async (t) => {
	const cwd = await repo(t, "merge-rename");
	commit(cwd, { "a.txt": "same content so git pairs it as a rename" }, "base");
	git(cwd, ["mv", "a.txt", "b.txt"]);
	git(cwd, ["commit", "-q", "--no-gpg-sign", "-m", "rename"]);

	const result = mergeIntoTarget(cwd);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /a\.txt/);
});

// #296 的不对称：`head^1..head` 只有在这一跳确实是合并动作时才说明方向。单父提交上
// 它就是提交自己，D 与意图无关。所以同一个删除允许两种结局，但差别必须由「这一跳
// 是不是合并动作」解释；`deletes:` 认领过之后必须一致——那才是有据可查的那条。
test("the same deletion is judged by its claim, not by its parent count", async (t) => {
	const cwd = await repo(t, "symmetry");
	commit(cwd, { "keep.txt": "one", "gone.txt": "two" }, "base");
	const base = pinBase(cwd);
	git(cwd, ["rm", "-q", "gone.txt"]);
	git(cwd, ["commit", "-q", "--no-gpg-sign", "-m", "drop gone"]);

	const single = check(cwd, base);
	assert.equal(single.status, 1);
	assert.match(single.stderr, /gone\.txt/);

	// 同一个删除挂在合并提交上：这一跳里它是 D，方向自证成立，放行。
	const merged = mergeIntoTarget(cwd);
	assert.equal(merged.status, 0, merged.stderr);
	assert.match(merged.stdout, /accounted for/);

	// 单父形态加一条认领，必须和合并形态一样绿。
	const claim = join(cwd, "desc.txt");
	writeFileSync(claim, "deletes: gone.txt\n");
	const claimed = check(cwd, base, ["--description-file", claim]);
	assert.equal(claimed.status, 0, claimed.stderr);
});

test("a missing base fails instead of passing silently", async (t) => {
	const cwd = await repo(t, "missing");
	commit(cwd, { "a.txt": "one" }, "base");

	const result = check(cwd, "does-not-exist");
	assert.equal(result.status, 2);
	assert.match(result.stderr, /is missing/);
});
