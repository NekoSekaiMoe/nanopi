#!/usr/bin/env node

// 检查「这次改动合进去会不会悄悄回退 base 上已有的内容」。
//
// Usage:
//   node scripts/check-merge-result.mjs [--base <ref>] [--description-file <path>] [--commit <ref>]
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
//   删掉 base 的路径（删除、改名）—— 退出码 1，除非删除有据可查（见下）。
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
//
// #296：路径消失也不再一律红。删除有两种来源，一是这次改动真的要删，二是合并动作
// 本身把一棵好树变成了「没了」（回退）。两者在结果树上没有区别，得另外找证据，
// 而证据只能来自「删除有没有方向」。三种形态各有各的证据：
//
//   C 合并提交里的删除：HEAD 的父多于一个时，删除来自 head^1..head 这一跳。
//     这一跳是 `git merge` 写出来的，方向由 git 保证（把 PR 分支合进来就只会产生
//     PR 侧的改动），所以这一跳里状态为 D 的路径算「这次改动删的」。
//   B 普通提交里的删除：HEAD 只有一个父，head^1..head 就是这个提交本身，D 与
//     「谁想删」无关——回退型的提交也是 D。这里只认 A。
//   A 有据可查：PR 描述或提交消息里逐条列出的 `deletes: <path>`。
//
// A 是唯一「意图被记下来」的证据，B/C 只提供方向。C 看着最贴题，但它单独用会把
// `b3ffe400` 那种「整棵树换回旧快照」也放行（CNB 侧所有 PR 都是合并提交），所以
// C 只负责给「改名的旧路径」和「普通删除」分类，不负责放行。
//
// 判据只用 git 对象加调用方传进来的文本：脚本不联网、不读 API，PR 描述由 CI 写进
// 文件用 --description-file 传（GitHub 侧用 GITHUB_EVENT_PATH，CNB 侧用
// CNB_PULL_REQUEST_DESC，没有就现取）。

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function git(args) {
	return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim();
}

function gitOk(args) {
	try {
		git(args);
		return true;
	} catch {
		return false;
	}
}

function parseArgs(argv) {
	let base;
	let descriptionFile;
	let commit;
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === "--base") base = argv[index + 1];
		else if (argv[index] === "--description-file") descriptionFile = argv[index + 1];
		else if (argv[index] === "--commit") commit = argv[index + 1];
	}
	return { base, descriptionFile, commit };
}

const { base: explicitBase, descriptionFile, commit } = parseArgs(process.argv.slice(2));
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
	// 改名在两侧是不同路径，会命中这里：删掉旧名、留下新名。
	const now = after.get(path);
	if (now === undefined) removed.push(path);
	else if (now !== blob) rewritten.push(path);
}

// 这条检查的意义在于「合并动作把好树变成了坏树」，所以第一父之外还有父时，说明
// 结果是一个合并提交，可以让 git 自己说 head^1..head 这一跳干了什么。
const parents = git(["rev-list", "--parents", "-n", "1", head]).split(" ").slice(1);
const isMerge = parents.length > 1;

// 这一跳的 D 状态。显式 `-M -l0`：默认配置下 diff 会做改名检测，删掉旧名变成
// `R100` 而不是 `D`；`-l0` 关掉改名上限，免得大改动退化掉配对。
const droppedInMerge = new Set();
if (isMerge) {
	const raw = git(["diff", "--raw", "-M", "-l0", `${head}^1`, head]);
	for (const line of raw.split("\n")) {
		// `:100644 000000 <src> <dst> D\t<path>`；改名是 `R100\t<old>\t<new>`
		const match = /^:\d+ \d+ [0-9a-f]+ [0-9a-f]+ (\S)\t(.+)$/.exec(line);
		if (!match || match[1] !== "D") continue;
		droppedInMerge.add(match[2]);
	}
}

// A：PR 描述里逐条列出的 `deletes: <path>`。逐条列是为了让意图留在 PR 里、事后
// 能查；写成 `deletes: *` 之类的通配不算数，那等于关掉这条检查。
const claimed = new Set();
if (descriptionFile) {
	let text = "";
	try {
		text = readFileSync(descriptionFile, "utf8");
	} catch {
		console.error(`${descriptionFile} is unreadable; continuing without any deletes: claim`);
	}
	for (const match of text.matchAll(/^\s*deletes:\s*(\S.*)$/gim)) {
		for (const raw of match[1].split(",")) {
			const path = raw.trim().replace(/^`|`$/g, "");
			if (path) claimed.add(path);
		}
	}
}

// 提交消息也算「有据可查」：CNB 上 PR 描述的变量不一定在，而 NPC 提交时会把说明
// 写进提交消息。只看 PR 自己的提交（^1..HEAD），不翻 base 的历史。
if (commit) {
	for (const line of git(["log", "--format=%B", `${commit}^1..${commit}`]).split("\n")) {
		const match = /^\s*deletes:\s*(\S.*)$/i.exec(line);
		if (!match) continue;
		for (const raw of match[1].split(",")) {
			const path = raw.trim().replace(/^`|`$/g, "");
			if (path) claimed.add(path);
		}
	}
}

const excused = [];
const blocked = [];
for (const path of removed) {
	// 合并提交里被这一跳删掉的、或者 PR 描述里认领过的，算有据可查。普通提交
	// （单父）只有认领这一条路：这一跳本身就是「回退」最常见的形态，方向说明
	// 不了任何事。
	if (claimed.has(path) || (isMerge && droppedInMerge.has(path))) excused.push(path);
	else blocked.push(path);
}

if (rewritten.length > 0) {
	console.log(`this change rewrites ${rewritten.length} file(s) that ${base} has (modification, not a deletion):`);
	for (const path of rewritten.slice(0, 40)) console.log(`  ${path}`);
	if (rewritten.length > 40) console.log(`  ... and ${rewritten.length - 40} more`);
}

if (excused.length > 0) {
	const how = isMerge ? "deletes: claim or a D in head^1..head" : "deletes: claim";
	console.log(`${excused.length} file(s) from ${base} are gone and accounted for (${how}):`);
	for (const path of excused.slice(0, 40)) console.log(`  ${path}`);
	if (excused.length > 40) console.log(`  ... and ${excused.length - 40} more`);
}

if (blocked.length === 0) {
	if (excused.length === 0) console.log(`no file from ${base} disappears in ${head}`);
	process.exit(0);
}

console.error(`this change drops ${blocked.length} file(s) that ${base} still has:`);
for (const path of blocked.slice(0, 40)) console.error(`  ${path}`);
if (blocked.length > 40) console.error(`  ... and ${blocked.length - 40} more`);
console.error("");
console.error("A merge result that removes files older than the branch is usually a stale tree");
console.error("overwriting newer work, not an intended deletion. Rebase or merge the base into this");
console.error("branch and rerun. If the deletion is intended, list each path on its own line in");
console.error("the PR description as `deletes: <path>`.");
process.exit(1);
