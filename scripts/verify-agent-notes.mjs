#!/usr/bin/env node

// 笔记校验的唯一入口：三条 verify 脚本 + 一条软提醒（#728）。
//
// Usage:
//   node scripts/verify-agent-notes.mjs [--base <ref>] [--quiet]
//
// 为什么要有这一层：`.github/workflows/checks.yml` 与 `.cnb.yml` 是两套平台，
// 各自写一遍三条 `node <skill>/scripts/verify-*.ts` 就一定会漂（路径、顺序、
// 基线变量名）。命令只在这里定义一次，两边都只调本文件。
//
// 门禁还是提醒的分野（#728 第 1 条）：
//   - tree / format / archived 失败 → 红的。它们判的是「文件放错目录、头部写错、
//     封印被改」，机械可判，没有人在回路里做判断的余地。
//   - 四问那条（`scripts/check-agent-notes.mjs`）仍然只提醒、退出码恒 0：它判的
//     是「这次 diff 该不该配一篇笔记」，脚本答不了，见
//     .agents/notes/implemented/process/2026-11-05-note-triggers-are-four-questions.md。
//
// 基线（归档 append-only 用）：--base 优先，其次 AGENT_NOTE_ARCHIVE_BASE_REF。
// 两边 CI 各自把「变更前的提交」传进来——GH 用 pull_request.base.sha，
// CNB 的 pull_request.target 用 CNB_PULL_REQUEST_TARGET_SHA。不传时
// verify-archived 会退化成哈希自校验（等于不查 append-only），所以这里要出声。

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillScripts = join(repositoryRoot, ".agents/skills/write-notes-like-deepseek/scripts");
// 顺序就是报告顺序：结构先于格式（放错目录的笔记，头部规范无从谈起），
// 归档最后（它只看 archived/ 与 manifest，与活跃树无关）。
const VERIFIERS = [
	["tree", join(skillScripts, "verify-agent-note-tree.ts")],
	["format", join(skillScripts, "verify-agent-note-format.ts")],
	["archived", join(skillScripts, "verify-archived-agent-notes.ts")],
];
const REMINDER = join(repositoryRoot, "scripts/check-agent-notes.mjs");

function parseArgs(argv) {
	const options = { base: undefined, quiet: false };
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === "--base") options.base = argv[++index];
		else if (argv[index] === "--quiet") options.quiet = true;
	}
	return options;
}

// Debian 的 node 构建没有类型剥离（process.features.typescript === false），
// 而 CNB 上的 node 正是 apt 装的那个。ts-import.mjs 用 esbuild 补这层，代价是
// 需要装过依赖；装不上的时候报清楚，不要让人对着 `Unknown file extension ".ts"` 猜。
function typescriptArguments(script) {
	if (process.features.typescript) return [script];
	const preload = join(repositoryRoot, "ts-import.mjs");
	if (existsSync(preload)) {
		try {
			createRequire(import.meta.url).resolve("esbuild");
			return ["--import", preload, script];
		} catch {
			// esbuild 没装，落到下面的报错。
		}
	}
	return null;
}

// 基线只认「变更前真实存在过的那个 commit」。两件常见的事会让它不是：
// 新分支的 push 给全 0（不是提交），PR 的第一父也偶尔落在只带 FETCH_HEAD 的工作树里。
// 解析不到就当没给——verify-archived 的 append-only 会退化成哈希自校验，那比拿一个
// 不存在的 ref 去 `git show`、然后以为「基线里没有 manifest」要诚实。
function usableBase(ref) {
	if (!ref) return "";
	if (/^0+$/.test(ref)) return "";
	const resolved = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
		cwd: repositoryRoot,
		encoding: "utf8",
	});
	return resolved.status === 0 ? ref : "";
}

const options = parseArgs(process.argv.slice(2));
const requestedBase = options.base ?? process.env.AGENT_NOTE_ARCHIVE_BASE_REF ?? "";
const base = usableBase(requestedBase);
const environment = { ...process.env };
if (base) environment.AGENT_NOTE_ARCHIVE_BASE_REF = base;
else delete environment.AGENT_NOTE_ARCHIVE_BASE_REF;

const failures = [];

// 本地随手一跑没有「变更前的提交」可言，静默降级；CI 上漏传就是漏了一道检查，
// 要在日志里留下痕迹。
const inCi = Boolean(process.env.CI ?? process.env.CNB_BUILD_ID);
if (!base && inCi) {
	const got = requestedBase ? ` (got ${JSON.stringify(requestedBase)})` : "";
	process.stderr.write(
		`warning: no usable baseline ref${got}; archived seals are only checked against disk\n`,
	);
}

for (const [name, script] of VERIFIERS) {
	const argv = typescriptArguments(script);
	if (argv === null) {
		failures.push(`${name}: needs a node with type stripping (>=24) or esbuild for ts-import.mjs`);
		continue;
	}
	const result = spawnSync(process.execPath, argv, { cwd: repositoryRoot, stdio: "inherit", env: environment });
	if (result.error) failures.push(`${name}: ${result.error.message}`);
	else if (result.status !== 0) failures.push(`${name}: exited ${result.status}`);
}

// 四问那条是提醒：跑，但它的结论不进口径。`--quiet` 只压这条，不压门禁。
const reminderArguments = [REMINDER];
if (base) reminderArguments.push("--base", base);
if (options.quiet) reminderArguments.push("--quiet");
// 提醒的输出只在它自己跑干净时全量转发：它要读 git，在没有 git 的工作树里会带着
// 一整屏 `git diff` 用法崩掉，把门禁的失败信息挤到看不见的地方。
const reminder = spawnSync(process.execPath, reminderArguments, { cwd: repositoryRoot, encoding: "utf8" });
if (reminder.status === 0) process.stdout.write(reminder.stdout ?? "");

if (failures.length > 0) {
	process.stderr.write(`\nAgent notes failed to verify (${relative(repositoryRoot, import.meta.filename)}):\n`);
	for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
	process.stderr.write("\nSee .agents/skills/write-notes-like-deepseek/references/verification.md\n");
	process.exit(1);
}

if (reminder.error || reminder.status !== 0) {
	// 提醒自己崩了不能把门禁变红，但也不能装作没事。
	const reason = reminder.error?.message ?? `exit ${reminder.status}`;
	const firstLine = (reminder.stderr ?? "").split("\n").find((line) => line.trim() !== "") ?? "";
	process.stderr.write(`warning: agent-note reminder did not run cleanly (${reason})${firstLine ? `: ${firstLine}` : ""}\n`);
}
