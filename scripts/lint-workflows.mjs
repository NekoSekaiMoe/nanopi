#!/usr/bin/env node

// 用 actionlint + shellcheck 检查 .github/workflows/*.yml。
//
// Usage:
//   node scripts/lint-workflows.mjs [--quiet] [path...]
//
// 这条门禁原本只活在 checks.yml 的 `Lint workflows` 步骤里，靠 `curl` 从 GitHub
// Releases 现下两个静态二进制（shinytale/nanopi#569 落地）。下载那一步把门禁挂在了
// 第三方 CDN 的可用性上：shinytale/nanopi#607 里两个 tarball 连续 504，`curl -f` 重试
// 完就 `exit 22`，必选检查 build-check-test 变红——而工作流一个字都没错。也就是
// 「写坏工作流 10 秒内红」变成了「GitHub 抖一下 PR 全红」。
//
// 现在两个检查器都从 npm 装，跟着 `pnpm install --frozen-lockfile` 一起进来：
//
//   import { createLinter } from "actionlint";          // rhysd/actionlint 编译成 wasm
//   import { createShellCheck } from "shellcheck-wasm"; // ShellCheck 0.11.0 的 wasm
//
// 两个都是纯 wasm，runner 上不需要预装二进制、也不需要访问任何外部地址。为什么选
// 这两个包、放弃了什么，见
// `.agents/notes/implemented/process/2026-11-07-actionlint-gates-workflows.md`。
//
// 检查器自己不做的事，这里补上：
//   1. actionlint 的 wasm 只暴露 `RunActionlint(input, path)`，不 spawn 外部进程，
//      所以 `run:` 块要自己切出来交给 shellcheck-wasm；
//   2. 切块用仓库本来就有的 `yaml` 依赖，不手写缩进解析；
//   3. 不写 `shell:` 时 GitHub 用 `bash -e {0}`，所以 `run:` 块按 bash 口径检查，
//      `shell: pwsh` 之类的跳过；
//   4. `${{ }}` 先换成同长的下划线，否则 shellcheck 把 `...${{ github.sha }}` 看成
//      `${ ...`，报 SC2296。换成下划线保留长度，行号列号一一对应。
//
// 两个 wasm 都有「同一个实例不能连着用」的毛病，所以每份输入单独起一个 node 子进程：
//   - shellcheck-wasm 是 GHC wasm，同一实例里第二次 lint 会撞上运行时自己的
//     「schedule: re-entered unsafely」，之后整个实例废掉；
//   - actionlint 的 JS 绑定在 `RunActionlint` 之后先 `WasmFree` 再读结果字符串，
//     读的是已释放的线性内存：下一次调用往前挪了堆，上一次的结论就被冲掉（实测第一个
//     文件报的错，第二个文件读成「无问题」）。这不是本仓库能改的，只能让每次调用
//     拿到一块干净的内存。
// 代价是每个文件/每个 run 块约 100ms 的进程启动；仓库现在 12 个工作流、60 个 run
// 块，整体十几秒，与原来下载两个 tarball 是同一量级，而且不再依赖网络。

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";

const WORKFLOW_DIRECTORY = ".github/workflows";
const WORKER_FLAG = "--lint-worker";

const script = fileURLToPath(import.meta.url);

// 子进程一侧：从 stdin 读 JSON 任务，跑对应的 wasm 检查器，把结果打到 stdout。
// 用子进程而不是 worker_threads：两个 wasm 的实例状态都在模块级，一旦坏掉只能整进程
// 丢掉，worker 也救不回来。
if (process.argv[2] === WORKER_FLAG) {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	const job = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (job.kind === "shellcheck") {
		const { createShellCheck } = await import("shellcheck-wasm");
		const shellcheck = await createShellCheck();
		const results = await shellcheck.lintWithOptions(job.script, {
			shell: "bash",
			severity: "style",
		});
		process.stdout.write(JSON.stringify(results));
	} else {
		const { createLinter } = await import("actionlint");
		const lint = await createLinter();
		process.stdout.write(JSON.stringify(lint(job.text, job.path)));
	}
	process.exit(0);
}

const options = { quiet: false, paths: [] };
for (const argument of process.argv.slice(2)) {
	if (argument === "--quiet") options.quiet = true;
	else options.paths.push(argument);
}

function worker(job) {
	const result = spawnSync(process.execPath, [script, WORKER_FLAG], {
		input: JSON.stringify(job),
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(
			`lint worker failed (exit ${result.status}): ${result.stderr.trim() || "(no stderr)"}`,
		);
	}
	return JSON.parse(result.stdout);
}

function workflowPaths() {
	if (options.paths.length > 0) return options.paths.sort();
	return readdirSync(WORKFLOW_DIRECTORY)
		.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
		.sort()
		.map((name) => join(WORKFLOW_DIRECTORY, name));
}

// `run:` 块只出现在 `jobs.<id>.steps[*]`、可复用工作流里，位置不固定；这里只问
// 「这一层的 key 叫不叫 run、值是不是一段字符串」，成立就当 shell，不校验整份
// 工作流的结构——结构问题交给 actionlint。
function collectRunBlocks(text) {
	const document = parseDocument(text);
	if (document.errors.length > 0) return [];
	const blocks = [];
	const visit = (node, shell) => {
		if (isMap(node)) {
			// 同一个 step 里 `shell:` 与 `run:` 是兄弟节点，把 shell 往下传：
			// `shell: pwsh` 的块交给 shellcheck 只会得到一屏假报错。
			let current = shell;
			const runPairs = [];
			for (const pair of node.items) {
				if (!isScalar(pair.key)) continue;
				if (pair.key.value === "shell" && isScalar(pair.value))
					current = pair.value.value;
				else runPairs.push(pair);
			}
			for (const pair of runPairs) {
				if (
					pair.key.value === "run" &&
					isScalar(pair.value) &&
					typeof pair.value.value === "string"
				) {
					// range[0] 是相对整份文件的偏移，算出该块第一行的行号，shellcheck 报的
					// 相对行号才能加回工作流里的真实行号。
					const line = pair.value.range
						? text.slice(0, pair.value.range[0]).split("\n").length
						: 0;
					blocks.push({ shell: pair.value.value, line, dialect: current });
				} else visit(pair.value, current);
			}
			return;
		}
		if (isSeq(node)) {
			for (const item of node.items) visit(item, shell);
		}
	};
	visit(document.contents, undefined);
	return blocks;
}

const failures = [];

for (const path of workflowPaths()) {
	const text = readFileSync(path, "utf8");

	for (const finding of worker({ kind: "actionlint", text, path })) {
		failures.push(
			`${finding.file}:${finding.line}:${finding.column}: ${finding.message} [${finding.kind}]`,
		);
	}

	for (const block of collectRunBlocks(text)) {
		if (block.dialect !== undefined && block.dialect !== "bash") continue;
		// `${{ ... }}` 在脚本交给 bash 之前就被 GitHub 展开了，shellcheck 该看到的是展开后
		// 的结果。按「一个同长的动作输入」处理：下划线不含 shell 元字符，不会额外触发
		// SC2086，长度不变也让列号对得上。
		const preprocessed = block.shell.replaceAll(/\$\{\{.*?\}\}/gs, (match) =>
			match.replaceAll(/[^\n]/g, "_"),
		);
		for (const result of worker({ kind: "shellcheck", script: preprocessed })) {
			const line = block.line + result.line - 1;
			failures.push(
				`${path}:${line}:${result.column}: SC${result.code}: ${result.message}`,
			);
		}
	}
}

if (failures.length > 0) {
	for (const failure of failures) console.error(failure);
	console.error(`\n共 ${failures.length} 条工作流/shell 报错。`);
	process.exit(1);
}

if (!options.quiet) console.log("workflow lint ok");
