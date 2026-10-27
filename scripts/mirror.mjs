#!/usr/bin/env node

// main / tag 镜像的唯一入口。.cnb.yml 的 push 阶段与
// .github/workflows/sync-to-cnb.yml 都只调这一条命令：远端 URL 不带凭据，
// token 由 --token-env 指的环境变量给，各 workflow 只负责把 secret 放进去。
//
// Usage:
//   node scripts/mirror.mjs main --remote <url> [--token-user <name> --token-env <VAR>]
//   node scripts/mirror.mjs tags --remote <url> [--token-user <name> --token-env <VAR>]
//
// 具体判定在 mirror-main.mjs 与 mirror-tags.mjs（两个方向共用同一份逻辑），
// 这里只做参数解析、凭据落盘和所有 git 调用都要的环境准备。

import { mirrorMain } from "./mirror-main.mjs";
import { mirrorTags } from "./mirror-tags.mjs";
import { clearCredential, installCredential } from "./mirror-credentials.mjs";

const USAGE = "Usage: node scripts/mirror.mjs <main|tags> --remote <url> [--token-user <name> --token-env <VAR>]";

function parseArgs(argv) {
	const [command, ...rest] = argv;
	if (command !== "main" && command !== "tags") {
		console.error(USAGE);
		process.exit(2);
	}

	const options = {};
	for (let index = 0; index < rest.length; index += 1) {
		const key = rest[index];
		if (key === "--remote" || key === "--token-user" || key === "--token-env") {
			options[key.slice(2)] = rest[index + 1];
			index += 1;
		}
	}

	const { remote, "token-env": tokenEnv, "token-user": tokenUser } = options;
	if (!remote || (tokenEnv === undefined) !== (tokenUser === undefined)) {
		console.error(USAGE);
		process.exit(2);
	}
	return { command, remote, tokenEnv, tokenUser };
}

// 认证失败时直接报错，不要挂在交互提示上（CI 没有 tty）。
process.env.GIT_TERMINAL_PROMPT = "0";

const { command, remote, tokenEnv, tokenUser } = parseArgs(process.argv.slice(2));

if (tokenEnv) {
	const token = process.env[tokenEnv];
	if (!token) {
		console.error(`${tokenEnv} is unset; the mirror needs it to authenticate against ${remote}`);
		process.exit(2);
	}
	installCredential(remote, tokenUser, token);
	// 删凭据挂在 exit 上：成功、判定失败（退出码 1）、异常都覆盖。
	process.on("exit", clearCredential);
}

// 两个脚本都以返回值说结果：判定失败（内容会回退、tag 分叉、推送后比对不上）
// 时返回 false，由这里统一转成退出码，避免在库代码里撒 process.exit。
const ok = command === "main" ? mirrorMain(remote) : mirrorTags(remote);
if (ok === false) process.exit(1);
