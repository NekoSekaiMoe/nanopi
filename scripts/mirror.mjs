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

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mirrorMain } from "./mirror-main.mjs";
import { mirrorTags } from "./mirror-tags.mjs";

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

// 凭据只活到本进程退出：每次运行一个私有临时目录，退出时删掉。原先的写法是
// workflow 往 ~/.git-credentials 里写一行再调这个脚本，那份文件比这次推送活得
// 久，只能靠 runner 一次性兜底；现在写入与删除在同一处，也不依赖 $HOME 的布局。
// 远端 URL 始终不带 token，所以 token 不会出现在任何一条 git 命令的 argv 或报错里。
let credentialDir;

function clearCredentials() {
	if (credentialDir) rmSync(credentialDir, { force: true, recursive: true });
	credentialDir = undefined;
}

function installCredential(remote, user, token) {
	let origin;
	try {
		origin = new URL(remote);
	} catch {
		console.error(`--remote is not a URL, cannot attach credentials: ${remote}`);
		process.exit(2);
	}
	if (!origin.username) origin.username = user;
	origin.password = token;

	credentialDir = mkdtempSync(join(tmpdir(), "nanopi-mirror-credentials-"));
	const store = join(credentialDir, "git-credentials");
	writeFileSync(store, `${origin.href}\n`, { mode: 0o600 });
	chmodSync(store, 0o600);

	// store helper 认的凭据文件是 $XDG_CONFIG_HOME/git/credentials（默认 ~/.config 下），
	// 改用临时地址，文件就随进程删。GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM 都指文件
	// （系统级那个仍拼 <path>/gitconfig，所以指一个不存在的文件等于没有系统级配置），
	// 免得调用方的全局配置把 credential.helper 又改回别处。
	process.env.GIT_CONFIG_GLOBAL = join(credentialDir, "gitconfig");
	process.env.GIT_CONFIG_SYSTEM = join(credentialDir, "gitconfig");
	writeFileSync(process.env.GIT_CONFIG_GLOBAL, "[credential]\n\thelper = store\n");
	process.env.XDG_CONFIG_HOME = credentialDir;
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
}

// 传 --token-env 时上面已把 HOME 之类的变量换到临时目录，钩子与继承来的分支
// 不做别的改动；凭据删除挂在这里，两个脚本都以返回值说结果，异常也算退出。
process.on("exit", clearCredentials);

// 两个脚本都以返回值说结果：判定失败（内容会回退、tag 分叉、推送后比对不上）
// 时返回 false，由这里统一转成退出码，避免在库代码里撒 process.exit。
const ok = command === "main" ? mirrorMain(remote) : mirrorTags(remote);
if (ok === false) process.exit(1);
