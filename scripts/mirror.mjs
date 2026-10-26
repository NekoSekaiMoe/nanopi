#!/usr/bin/env node

// main / tag 镜像的唯一入口。.cnb.yml 的 push 阶段与
// .github/workflows/sync-to-cnb.yml 都只调这一条命令，唯一的差别是远端 URL 里
// 怎么带凭据——那由各 workflow 的 secret 决定，脚本不该知道。
//
// Usage:
//   node scripts/mirror.mjs main --remote <url>
//   node scripts/mirror.mjs tags --remote <url>
//
// 具体判定在 mirror-main.mjs 与 mirror-tags.mjs（两个方向共用同一份逻辑），
// 这里只做参数解析和所有 git 调用都要的环境准备。

import { mirrorMain } from "./mirror-main.mjs";
import { mirrorTags } from "./mirror-tags.mjs";

function parseArgs(argv) {
	const [command, ...rest] = argv;
	if (command !== "main" && command !== "tags") {
		console.error("Usage: node scripts/mirror.mjs <main|tags> --remote <url>");
		process.exit(2);
	}

	let remote;
	for (let index = 0; index < rest.length; index += 1) {
		if (rest[index] === "--remote") remote = rest[index + 1];
	}
	if (!remote) {
		console.error(`Usage: node scripts/mirror.mjs ${command} --remote <url>`);
		process.exit(2);
	}

	return { command, remote };
}

// 认证失败时直接报错，不要挂在交互提示上（CI 没有 tty）。
process.env.GIT_TERMINAL_PROMPT = "0";

const { command, remote } = parseArgs(process.argv.slice(2));

// 两个脚本都以返回值说结果：判定失败（内容会回退、tag 分叉、推送后比对不上）
// 时返回 false，由这里统一转成退出码，避免在库代码里撒 process.exit。
const ok = command === "main" ? mirrorMain(remote) : mirrorTags(remote);
if (ok === false) process.exit(1);
