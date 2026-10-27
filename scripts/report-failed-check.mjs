#!/usr/bin/env node

// 把一次失败的 CNB 构建报成一条带 `@CodeBuddy` 的 Issue（#319）。
//
// Usage: node scripts/report-failed-check.mjs
//
// 问题：CNB 上唯一的状态检查是 `merge-result`（`pull_request.target`），它挂在 PR 的
// 合并预演结果上，说的不是源分支自己的毛病。结论写不到源分支上，就只能等下一个
// 动这条分支的 NPC 会话顺手重跑，于是 PR 合并之后那个红还挂在 PR 上。
//
// 做法：把「哪条分支、哪个提交、哪次构建」写进一条带 `@CodeBuddy` 的普通 Issue。
// 投递点只可能是 Issue：CNB 的 NPC 只由 Issue/PR 的评论触发，而这个仓库的 NPC
// 依赖（pnpm install + git hooks）承载不了 PR 的源分支。理由见
// .agents/notes/implemented/process/2026-10-27-failed-checks-report-into-issues.md。
//
// 调用点在 .cnb.yml 每条 pipeline 的 endStages：它跑完 stages 就会跑，且自己的结论
// 不影响构建状态。所以「要不要报」得自己判（读构建状态），「报过没有」也得自己判
// （Issue 里按提交打标记）。判定失败一律以成功退出：钩子不该改掉别人的结论。

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TITLE_PREFIX = "CI 红：";
// 评论里贴的日志窗口：失败信息通常就在末尾，但从大片安装日志里挑那几行很费劲。
// 够看出结论，又不至于让评论长到没人读。
const LOG_TAIL_LINES = 30;

function run(command, args) {
	return execFileSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

// cnb 的摘要输出是 YAML，字段随命令变；--verbose 给原始响应，这里要的是 `.data`。
function api(module, tool, args) {
	return JSON.parse(run("cnb", [module, tool, ...args, "--verbose"])).data ?? {};
}

function writeBody(body) {
	const file = join(mkdtempSync(join(tmpdir(), "failed-check-")), "body.md");
	writeFileSync(file, body);
	return file;
}

const repo = process.env.CNB_REPO_NAMESPACE ?? process.env.CNB_REPO_SLUG ?? "";
const sn = process.env.CNB_PIPELINE_ID ?? process.env.CNB_BUILD_ID ?? "";

function buildStatus() {
	if (!sn) return "";
	try {
		const rows = api("build", "get-build-logs", ["--repo", repo, "--sn", sn]).data ?? [];
		const row = rows[0] ?? {};
		return row.status ?? row.pipelines?.[0]?.status ?? "";
	} catch (error) {
		console.log(`cannot read build ${sn} (${error.message.split("\n")[0]}); nothing to report`);
		return "";
	}
}

function sourceBranch() {
	const fromEvent = { push: process.env.CNB_TARGET_REF, "pull_request.target": process.env.CNB_PULL_REQUEST_BRANCH };
	return (fromEvent[process.env.CNB_EVENT] ?? process.env.CNB_BRANCH ?? "").replace(/^refs\/heads\//, "");
}

function logTail() {
	try {
		return run("cnb", ["pulls", "get-ci-logs", "--sn", sn])
			.split("\n")
			.map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").trimEnd())
			.filter((line) => line.trim())
			.slice(-LOG_TAIL_LINES)
			.join("\n");
	} catch {
		return "";
	}
}

const status = buildStatus();
if (!status) {
	console.log(`build ${sn} has no readable status; nothing to report`);
	process.exit(0);
}
if (status === "success") {
	console.log(`build ${sn} succeeded; nothing to report`);
	process.exit(0);
}

const branch = sourceBranch();
if (!branch) {
	console.log("this event carries no source branch; nothing to report");
	process.exit(0);
}

const sha = process.env.CNB_COMMIT ?? "";
const marker = `<!-- failed-check ${sha || sn} -->`;
const builder = `[\`${sn}\`](https://cnb.cool/${repo}/-/build/logs/${sn})`;
const title = process.env.CNB_COMMIT_MESSAGE_TITLE ?? "";

const issueBody = [
	`@CodeBuddy \`${branch}\` 的 CNB 构建失败了，来修一下。`,
	"",
	`- 分支：\`${branch}\``,
	`- 提交：\`${sha}\`${title ? `（${title}）` : ""}`,
	`- 构建：${builder}（\`${process.env.CNB_EVENT ?? ""}\`）`,
	"",
	"修完推到这条分支上，CNB 会重跑。这个是自动开的 Issue，修好后手动关掉即可。",
	"",
	marker,
].join("\n");

const found = api("issues", "list-issues", ["--repo", repo, "--state", "open", "--page-size", "100", "--keyword", branch]);
const existing = found.find((issue) => issue.title === `${TITLE_PREFIX}${branch}`);

if (!existing) {
	const created = api("issues", "create-issue", [
		"--repo",
		repo,
		"--title",
		`${TITLE_PREFIX}${branch}`,
		"--body-file",
		writeBody(issueBody),
	]);
	console.log(`opened issue #${created.number} for ${branch}`);
	process.exit(0);
}

const comments = api("issues", "list-issue-comments", ["--repo", repo, "--number", String(existing.number), "--page-size", "100"]);
if (comments.some((comment) => (comment.body ?? "").includes(marker))) {
	console.log(`issue #${existing.number} already reports ${sha || sn}; nothing to do`);
	process.exit(0);
}

const log = logTail();
const commentBody = [`又失败了一次：${builder}。`, "", ...(log ? ["日志末尾：", "", "```", log, "```"] : []), marker].join("\n");
api("issues", "post-issue-comment", ["--repo", repo, "--number", String(existing.number), "--body-file", writeBody(commentBody)]);
console.log(`appended another failure to issue #${existing.number}`);
