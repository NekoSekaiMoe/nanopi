// 一次 mirror 进程的凭据：写入 mkdtemp 私有目录，退出时整目录删掉。
//
// 远端 URL 始终不带 token，token 也不经过 argv，所以它不会出现在任何一条 git
// 命令的报错里。要让它真正生效，三件事得同时到位：
//   - 凭据文件放在 $XDG_CONFIG_HOME/git/credentials，这是 store helper 的默认读路径；
//   - 全局 gitconfig 里一行 credential.helper = store；
//   - 系统级 gitconfig 指向不存在的路径，等于没有系统级配置。
// 少任何一条，远端都退回匿名，表现是第一条 push 就 "could not read Username
// for 'https://github.com': terminal prompts disabled"。

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let directory;

export function installCredential(remote, user, token) {
	let origin;
	try {
		origin = new URL(remote);
	} catch {
		console.error(`--remote is not a URL, cannot attach credentials: ${remote}`);
		process.exit(2);
	}
	if (!origin.username) origin.username = user;
	origin.password = token;

	directory = mkdtempSync(join(tmpdir(), "nanopi-mirror-credentials-"));
	mkdirSync(join(directory, "git"), { mode: 0o700 });

	// store helper 读的是 $XDG_CONFIG_HOME/git/credentials，不是目录根的
	// git-credentials：写错地方时文件都在，helper 一个字段都取不到。
	const store = join(directory, "git", "credentials");
	writeFileSync(store, `${origin.href}\n`, { mode: 0o600 });
	chmodSync(store, 0o600);

	// 配置直接写文件，不要 `git config --global`：它解析的是已设好的
	// GIT_CONFIG_GLOBAL，先设变量再调用，文件反而写不成。系统级变量 git 仍拼成
	// <dir>/gitconfig，指一个不存在的路径就是空配置。
	process.env.XDG_CONFIG_HOME = directory;
	process.env.GIT_CONFIG_GLOBAL = join(directory, "gitconfig");
	process.env.GIT_CONFIG_SYSTEM = join(directory, "gitconfig");
	writeFileSync(process.env.GIT_CONFIG_GLOBAL, "[credential]\n\thelper = store\n", { mode: 0o600 });
}

export function clearCredential() {
	if (directory) rmSync(directory, { force: true, recursive: true });
	directory = undefined;
}
