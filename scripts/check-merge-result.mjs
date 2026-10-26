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
// 名字与内容都不变。改名不算回退（删除与新增成对出现时 `git diff --raw`
// 报的是 R，不是 D），显式删除文件的人会在 CI 里看到这条报错。

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

// `git diff` 的输出格式：`:<old mode> <new mode> <old blob> <new blob> <status>\t<path>`。
// 状态 `D` 表示文件在结果里不存在；`R<score>` 是改名，不算丢内容。
const raw = git(["diff", "--raw", "--no-abbrev", `${base}^{tree}`, `${head}^{tree}`]);
const removed = [];
for (const line of raw.split("\n")) {
	if (!line) continue;
	const [meta, ...pathParts] = line.split("\t");
	const status = meta.split(" ").at(-1);
	if (status === "D") removed.push(pathParts[0]);
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
