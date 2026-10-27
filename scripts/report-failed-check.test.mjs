import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// 钩子在每条 pipeline 的 endStages 里跑，所以「不该报的时候一根手指都不动」比
// 「该报的时候报了」更重要：它把构建状态当输入，把自己写 Issue 当副作用。
// 这里用假 cnb 记录每次调用，断言的就是这两件事。
const script = fileURLToPath(new URL("./report-failed-check.mjs", import.meta.url));

// 假 cnb：按 tool 名回放 canned 响应，并把调用记进 calls.json。
function fakeCnb(root, responses) {
	const file = join(root, "fake-cnb.mjs");
	const calls = join(root, "calls.json");
	writeFileSync(
		file,
		`import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const calls = ${JSON.stringify(calls)};
let log = [];
try { log = JSON.parse(readFileSync(calls, "utf8")); } catch {}
log.push(process.argv.slice(2));
writeFileSync(calls, JSON.stringify(log));
const responses = ${JSON.stringify(responses)};
// argv 是 [execPath, 脚本, ...参数]：tool 在 [3]，和真实 cnb 的命令行位置一致。
const hit = responses[process.argv[3]] ?? { data: null };
process.stdout.write(JSON.stringify({ data: hit.data }));
`,
	);
	chmodSync(file, 0o755);
	return { file, calls };
}

async function fixture(t, name, responses) {
	const root = await mkdtemp(join(tmpdir(), `nanopi-report-${name}-`));
	t.after(() => rm(root, { force: true, recursive: true }));

	const { file, calls } = fakeCnb(root, responses);
	// cnb 是脚本按名字调的命令，靠 PATH 注入假的。
	const bin = join(root, "bin");
	spawnSync("mkdir", ["-p", bin]);
	writeFileSync(
		join(bin, "cnb"),
		`#!/bin/sh\nexec ${process.execPath} ${file} "$@"\n`,
	);
	chmodSync(join(bin, "cnb"), 0o755);

	const run = (env) =>
		spawnSync(process.execPath, [script], {
			cwd: root,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
				CNB_REPO_NAMESPACE: "shinytale/nanopi",
				CNB_PIPELINE_ID: "cnb-test-1",
				CNB_COMMIT: "1111111111111111111111111111111111111111",
				CNB_EVENT: "pull_request.target",
				CNB_PULL_REQUEST_BRANCH: "fix/1-something",
				CNB_BRANCH: "main",
				CNB_COMMIT_MESSAGE_TITLE: "fix: something",
				...env,
			},
		});

	const calls_ = () => {
		try {
			return JSON.parse(readFileSync(calls, "utf8"));
		} catch {
			return [];
		}
	};

	return { root, run, calls: calls_ };
}

const failedBuild = { data: { data: [{ status: "error" }] } };
const okBuild = { data: { data: [{ status: "success" }] } };

// 绿色构建不该碰 Issue：否则每条流水线都会在仓库里留一条噪音。
test("a successful build reports nothing", async (t) => {
	const { run, calls } = await fixture(t, "green", { "get-build-logs": okBuild });
	const result = run();
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /succeeded/);
	assert.equal(calls().some((call) => call[1] === "create-issue" || call[1] === "post-issue-comment"), false);
});

// 失败且还没有人报过：开一条带 @CodeBuddy 的 Issue。
test("a failed build opens an issue that mentions the NPC", async (t) => {
	const { run, calls } = await fixture(t, "open", {
		"get-build-logs": failedBuild,
		"list-issues": { data: [] },
		"create-issue": { data: { number: "42" } },
	});
	const result = run();
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /opened issue #42/);

	const created = calls().find((call) => call[1] === "create-issue");
	assert.ok(created, "create-issue must be called");
	assert.equal(created[created.indexOf("--title") + 1], "CI 红：fix/1-something");
	const body = readFileSync(created[created.indexOf("--body-file") + 1], "utf8");
	assert.match(body, /@CodeBuddy/);
	assert.match(body, /1111111111111111111111111111111111111111/);
	assert.match(body, /cnb-test-1/);
});

// 同一个提交失败多次（多个 event、重试）只报一次：标记写在正文里。
test("the same commit is not reported twice", async (t) => {
	const { run, calls } = await fixture(t, "dedupe", {
		"get-build-logs": failedBuild,
		"list-issues": { data: [{ number: "42", title: "CI 红：fix/1-something" }] },
		"list-issue-comments": { data: [{ body: "<!-- failed-check 1111111111111111111111111111111111111111 -->" }] },
	});
	const result = run();
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /already reports/);
	assert.equal(
		calls().some((call) => call[1] === "post-issue-comment" || call[1] === "create-issue"),
		false,
	);
});

// 新提交又失败：在同一条 Issue 上追加，不另开一条。
test("a new failing commit appends to the existing issue", async (t) => {
	const { run, calls } = await fixture(t, "append", {
		"get-build-logs": failedBuild,
		"list-issues": { data: [{ number: "42", title: "CI 红：fix/1-something" }] },
		"list-issue-comments": { data: [{ body: "<!-- failed-check 0000000000000000000000000000000000000000 -->" }] },
		"post-issue-comment": { data: {} },
	});
	const result = run();
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /appended/);
	const comment = calls().find((call) => call[1] === "post-issue-comment");
	assert.equal(comment[comment.indexOf("--number") + 1], "42");
});

// 读不到构建状态（令牌不够、API 抖动）时不动手：报错工具没有资格替构建下结论。
test("an unreadable build is left alone", async (t) => {
	const { run, calls } = await fixture(t, "unreadable", { "get-build-logs": { data: null } });
	const result = run();
	assert.equal(result.status, 0, result.stderr);
	assert.equal(calls().some((call) => call[1] === "create-issue"), false);
});

// 没有源分支的事件（手动触发之类）也不报：标题里没有分支就定位不了。
test("an event without a source branch reports nothing", async (t) => {
	const { run, calls } = await fixture(t, "no-branch", { "get-build-logs": failedBuild });
	const result = run({ CNB_PULL_REQUEST_BRANCH: "", CNB_BRANCH: "", CNB_EVENT: "web_trigger" });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /no source branch/);
	assert.equal(calls().some((call) => call[1] === "create-issue"), false);
});
