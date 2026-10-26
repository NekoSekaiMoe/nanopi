#!/usr/bin/env node

// 检查「这次改动合进去会不会悄悄回退 main 上已有的内容」。
//
// Usage:
//   node scripts/check-merge-result.mjs [--base <ref>]
//
// 默认 base 是 refs/remotes/origin/main，需要一个包含远端 main 的 checkout
// （`actions/checkout` 的 fetch-depth: 0 或 CNB 的完整 clone 都满足）。
//
// 背景：#241 之前，`b3ffe400` 是一个「父是远端 tip、树是本地旧 HEAD」的合成提交，
// 它把 main 的树整体换回了旧快照，#235 的四处改动随之消失。父链没断，`git log`
// 看不出任何痕迹，只有下一个动到同一片代码的人会发现。
//
// 这里检查的是本次改动相对 base 的净效果：base 有的文件，结果树里必须还在，
// 名字与内容都不变。改名与显式删除都会命中，它们确实让 base 的路径消失了，
// 该由 PR 描述说明，而不是让检查替它们猜。
//
// 反过来算（结果 -> base）会把 PR 新增的文件当成删除，所以路径只能从 base 起算：
// 拿 base 的树列文件，再看每个文件在结果里还在不在。

import { execFileSync } from "node:child_process";

function git(args) {
	return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim();
}

function parseArgs(argv) {
	let base = "refs/remotes/origin/main";
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === "--base") base = argv[index + 1];
	}
	return { base };
}

const { base } = parseArgs(process.argv.slice(2));
const head = git(["rev-parse", "HEAD"]);

// 没有可比的 base（浅 clone、刚建的分支）时不能静默放过：这正是要查的东西。
try {
	git(["rev-parse", "--verify", `${base}^{commit}`]);
} catch {
	console.error(`${base} is missing; fetch it first (shallow clones cannot spot a revert)`);
	process.exit(2);
}

// 逐文件比对内容，而不是数 `git diff --raw` 的状态：`A`/`D` 的方向由参数顺序决定，
// 与「改名」混在一起时读起来太容易反。`ls-tree -r` 给的是 `<mode> <type> <blob>\t<path>`。
const filesIn = (tree) => {
	const entries = new Map();
	for (const line of git(["ls-tree", "-r", "--full-tree", tree]).split("\n")) {
		if (!line) continue;
		const [meta, path] = line.split("\t");
		entries.set(path, meta.split(" ")[2]);
	}
	return entries;
};

const before = filesIn(`${base}^{tree}`);
const after = filesIn(`${head}^{tree}`);
const removed = [];
for (const [path, blob] of before) {
	// 改名在两侧是不同路径，会命中这里：删掉旧名、留下新名，正是检查要拦的那类改动
	// （回退 main 上的内容时，被盖掉的文件连新名字都没有）。
	if (after.get(path) !== blob) removed.push(path);
}

if (removed.length === 0) {
	console.log(`no file from ${base} disappears in ${head}`);
	process.exit(0);
}

console.error(`this change drops ${removed.length} file(s) that ${base} still has:`);
for (const path of removed.slice(0, 40)) console.error(`  ${path}`);
if (removed.length > 40) console.error(`  ... and ${removed.length - 40} more`);
console.error("");
console.error("A merge result that removes files older than the branch is usually a stale tree");
console.error("overwriting newer work, not an intended deletion. Rebase or merge the base into this");
console.error("branch and rerun. If the deletion is intended, say so in the PR description.");
process.exit(1);
