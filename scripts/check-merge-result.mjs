#!/usr/bin/env node

// 检查「这次改动合进去会不会悄悄回退 main 上已有的内容」。
//
// Usage:
//   node scripts/check-merge-result.mjs [--base <ref>]
//
// 默认 base 是 HEAD 的第一父提交，也就是「把分支合进来之前的目标分支 tip」：
// 脚本的用法总是「HEAD 是合并结果，它的第一父是基线」。指定 --base 时以参数为准
// （`actions/checkout` 的 fetch-depth: 0 或 CNB 的完整 clone 才能用 refs/remotes/origin/main）。
//
// 不用 refs/remotes/origin/main 当默认值：那要求基线与合并结果同时可得，而
// check-merge-result-cnb.mjs 里合并提交的第一父本来就是合并前抓到的目标分支 tip。
// #279 用远端 main 当基线时，PR 分支自己历史里的删除（在分支上先加后撤的笔记）
// 被算成了「这次合进 main 会丢掉 main 上的文件」——那个文件 main 上从来没有过。
//
// 背景：#241 之前，`b3ffe400` 是一个「父是远端 tip、树是本地旧 HEAD」的合成提交，
// 它把 main 的树整体换回了旧快照，#235 的四处改动随之消失。父链没断，`git log`
// 看不出任何痕迹，只有下一个动到同一片代码的人会发现。
//
// 这里检查的是本次改动相对 base 的净效果，分两档：
//
//   删掉 base 的路径（删除、改名）—— 退出码 1。
//   改了 base 文件的内容 —— 打印提醒，不改退出码。
//
// 内容改动必须放行：git 不存「谁改过谁」，分支上正常的修改与回退（把 base 的 blob
// 原样搬回旧值）在树里长得一模一样。PR #253 只改了 AGENTS.md 与
// syntax-highlight-disabled.ts，就被按内容判成删掉这两个文件。真正的内容回退由
// scripts/mirror-main.mjs 在推送那侧拦（它手上有两条历史，能分）与代码评审兜住。
//
// 反过来算（结果 -> base）会把 PR 新增的文件当成删除，所以路径只能从 base 起算：
// 拿 base 的树列文件，再看每个文件在结果里还在不在。
//
// 谁当 base 由调用方决定，这里只认「base 是基线、HEAD 是结果」。CI 里基线是目标
// 分支（main）的 tip，结果是把 PR 分支合进来之后的树——两个不能倒过来（#255：
// 拿 PR 分支当基线时，PR 自己新增的文件全成了「被删掉」）。

import { execFileSync } from "node:child_process";

function git(args) {
	return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim();
}

function parseArgs(argv) {
	let base;
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === "--base") base = argv[index + 1];
	}
	return { base };
}

const { base: explicitBase } = parseArgs(process.argv.slice(2));
const head = git(["rev-parse", "HEAD"]);
// 第一父恒为基线：合并提交记的原始 tip 就是它，父链上不可能出现「分支自己合进
// 自己」的假象，也躲开了远端 main 可能已被别人推进的问题。
const base = explicitBase ?? git(["rev-parse", `${head}^1`]);

// 没有可比的 base（浅 clone、刚建的分支）时不能静默放过：这正是要查的东西。
try {
	git(["rev-parse", "--verify", `${base}^{commit}`]);
} catch {
	console.error(`${base} is missing; fetch it first (shallow clones cannot spot a revert)`);
	process.exit(2);
}

// 逐路径比对，而不是数 `git diff --raw` 的状态：`A`/`D` 的方向由参数顺序决定，
// 与「改名」混在一起时读起来太容易反。`ls-tree -r` 给的是 `<mode> <type> <blob>\t<path>`，
// blob 只用来区分「还在」与「还在但被改了」。
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
const rewritten = [];
for (const [path, blob] of before) {
	// 改名在两侧是不同路径，会命中这里：删掉旧名、留下新名，正是检查要拦的那类改动
	// （回退 main 上的内容时，被盖掉的文件连新名字都没有）。
	const now = after.get(path);
	if (now === undefined) removed.push(path);
	else if (now !== blob) rewritten.push(path);
}

if (rewritten.length > 0) {
	console.log(`this change rewrites ${rewritten.length} file(s) that ${base} has (modification, not a deletion):`);
	for (const path of rewritten.slice(0, 40)) console.log(`  ${path}`);
	if (rewritten.length > 40) console.log(`  ... and ${rewritten.length - 40} more`);
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
