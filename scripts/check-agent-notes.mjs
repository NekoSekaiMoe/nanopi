#!/usr/bin/env node

// 提醒「这次改动可能该配一篇笔记」，提醒完就放行。
//
// Usage:
//   node scripts/check-agent-notes.mjs [--base <ref>] [--notes <dir>] [--quiet]
//
// 判定在 .agents/skills/write-notes-like-deepseek/SKILL.md 的「四问」里，那部分只有
// 读 diff 的人才答得了，脚本不替它答。脚本只回答一个更窄的问题：diff 大到不像机械
// 改动、又一行笔记都没碰，就打印一行让人回去过一遍四问。退出码永远是 0——
// 这套判定还没被验证过，先当提示收集证据（提示了几十次都没人写，说明规则本身不
// 成立），别急着让它红。
//
// 基线怎么取：
//   --base <ref>  给定 ref 时用 <ref>...HEAD（CI / PR 场景），没有 merge-base 就退回两点 diff
//   默认          工作区未提交的改动 + HEAD~1..HEAD，覆盖「改完还没提交」和「刚提交」
//
// 两条判据都作用在已经发生的事实上，不需要判断：
//   1. 改了 packages/*/src/** 且行数到阈值
//   2. 提交里新增了回归测试（test 下改动的用例），且没碰 archived/ 之外的笔记
// 命中任意一条、且 diff 里没有任何笔记改动，就打印提示。

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// 80 行：够装下一个默认值改动、一次小重构、一次接口收窄之外的杂活；也够让
// 「顺手改的一行」保持安静。数字本身没有依据，先让它低到能看见噪声。
const LINE_THRESHOLD = 80;
// 公开面改动最容易漏笔记，也最容易吓到人，单独给一个更低的阈值。
const PUBLIC_SURFACE_THRESHOLD = 40;

const PUBLIC_SURFACE = /^packages\/(agent|coding-agent)\/src\//;
const SOURCE = /^packages\/[^/]+\/src\//;
const NOTES = /^\.agents\/notes\//;
const TEST = /^packages\/[^/]+\/test\//;

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
	const options = { base: undefined, quiet: false };
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === "--base") options.base = argv[index + 1];
		else if (argv[index] === "--quiet") options.quiet = true;
	}
	return options;
}

// 一个 ref 可能只是远端跟踪分支还存在，也可能在只带 FETCH_HEAD 的工作树里根本
// 解析不到：解析不到就当没给基线，退回本地默认范围，而不是把整条提示判死。
function hasRef(ref) {
	return gitOk(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
}

function numstat(args) {
	const out = git(["diff", "--numstat", "--no-renames", ...args]);
	const files = [];
	for (const line of out.split("\n").filter(Boolean)) {
		const [added, removed, path] = line.split("\t");
		// 二进制文件的行数是 "-"，按 0 算。
		files.push({ path, lines: (Number(added) || 0) + (Number(removed) || 0) });
	}
	return files;
}

// 新文件在 `git diff` 里是 untracked，不出现。写 Agent 常常是先落一堆新文件再
// 提交，只看 tracked 的话这条提示在最该响的时候恰好吃静音。
function untrackedFiles() {
	return git(["ls-files", "--others", "--exclude-standard"])
		.split("\n")
		.filter(Boolean)
		.map((path) => ({ path, lines: readFileSync(path, "utf8").split("\n").length - 1 }));
}

// 每个范围各自算一遍再取最大值：几个范围覆盖的是同一批改动（工作区、刚提交的、
// 整条分支），叠加会把同一行数算两次。
function ranges(options) {
	const ranges = [];
	if (options.base && hasRef(options.base)) {
		// 没有 merge-base 说明两边没有共同历史，三点 diff 会直接报错，退回两点。
		ranges.push(gitOk(["merge-base", options.base, "HEAD"]) ? `${options.base}...HEAD` : [options.base, "HEAD"]);
	}
	ranges.push([]);
	if (hasRef("HEAD~1")) ranges.push(["HEAD~1", "HEAD"]);
	return ranges;
}

function summarize(files) {
	const source = files.filter((file) => SOURCE.test(file.path));
	const publicSurface = source.filter((file) => PUBLIC_SURFACE.test(file.path));
	return {
		lines: source.reduce((sum, file) => sum + file.lines, 0),
		publicLines: publicSurface.reduce((sum, file) => sum + file.lines, 0),
		tests: files.filter((file) => TEST.test(file.path)).length,
		notes: files.filter((file) => NOTES.test(file.path)).length,
	};
}

const options = parseArgs(process.argv.slice(2));
const totals = { lines: 0, publicLines: 0, tests: 0, notes: 0 };

for (const range of ranges(options)) {
	const summary = summarize([
		...numstat(Array.isArray(range) ? range : [range]),
		...(range.length === 0 ? untrackedFiles() : []),
	]);
	totals.lines = Math.max(totals.lines, summary.lines);
	totals.publicLines = Math.max(totals.publicLines, summary.publicLines);
	totals.tests = Math.max(totals.tests, summary.tests);
	totals.notes = Math.max(totals.notes, summary.notes);
}

const reasons = [];

if (totals.notes === 0) {
	if (totals.publicLines >= PUBLIC_SURFACE_THRESHOLD) {
		reasons.push(`${totals.publicLines} line(s) under packages/{agent,coding-agent}/src`);
	}
	if (totals.lines >= LINE_THRESHOLD) reasons.push(`${totals.lines} line(s) under packages/*/src`);
	if (totals.tests > 0) reasons.push("regression tests");
}

if (options.quiet || reasons.length === 0) process.exit(0);

process.stdout.write(
	[
		"",
		"This change touches no note under .agents/notes/, but it is:",
		...reasons.map((reason) => `  - ${reason}`),
		"",
		"Re-run the four questions in .agents/skills/write-notes-like-deepseek/SKILL.md section 4.",
		"Not a failure: nothing about this check blocks a commit or a build yet.",
		"",
	].join("\n"),
);
process.exit(0);
