#!/usr/bin/env node

// 把一次构建的 bundle 发到 AtomGit 的发行仓库（默认 nanopi/releases-assets），
// 让国内用户不必绕 GitHub Releases。
//
// Usage:
//   node scripts/publish-atomgit.mjs --tag <tag> --commit <sha> --input <dir> \
//     --work <dir> [--remote <url>] [--repo-slug <owner>/<repo>] \
//     [--token-env <VAR>] [--token-user <name>] [--push]
//
// 这条脚本只做「组装」和「推送」两件事，构建本身留在调用方（GitHub Actions 的
// nightly.yml 用 build-single-file.mjs，正式版的资产直接取 build-binaries.yml
// 的 artifact）：它决定发什么、怎么命名、校验和对不对得上，以及推到哪里。

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";

const DEFAULT_REMOTE = "https://atomgit.com/nanopi/releases-assets.git";
const DEFAULT_SLUG = "nanopi/releases-assets";
// 与 .github/workflows/build-binaries.yml 的资产集同名，install.js 的 --sku
// 才能从两个来源取到同一个文件名。
const BUNDLES = ["nanopi.js", "nanopi-base.js", "nanopi-minimal.js"];
const CHECKSUMS = "SHA256SUMS";
const NOTES = "RELEASE_NOTES.md";

const { values } = parseArgs({
	options: {
		tag: { type: "string" },
		commit: { type: "string" },
		input: { type: "string" },
		work: { type: "string" },
		remote: { type: "string", default: DEFAULT_REMOTE },
		"repo-slug": { type: "string", default: DEFAULT_SLUG },
		"token-env": { type: "string" },
		"token-user": { type: "string" },
		push: { type: "boolean", default: false },
		help: { type: "boolean", default: false },
	},
});

if (values.help || !values.tag || !values.commit || !values.input || !values.work) {
	process.stdout.write(`Usage: node scripts/publish-atomgit.mjs --tag <tag> --commit <sha> --input <dir> --work <dir>

  --tag <tag>          Release tag in the assets repository (v20261031.1.0, nightly)
  --commit <sha>       Commit the assets were built from; recorded in the README and
                       in the nightly release notes, so "which main" is answerable
  --input <dir>        Directory holding the built bundles (and optional nanopi-<version>-source.tar.gz)
  --work <dir>         Assets repository checkout; created and reused between runs
  --remote <url>       Assets repository URL (default: ${DEFAULT_REMOTE})
  --repo-slug <slug>   <owner>/<repo> used to build asset download URLs (default: ${DEFAULT_SLUG})
  --token-env <VAR>    Environment variable holding the push token (required by --push)
  --token-user <name>  User name the token authenticates as (default: atomgit)
  --push               Push the branch and the tag; without it the checkout is only assembled
`);
	process.exit(values.help ? 0 : 2);
}

const ASSETS = join(values.work, "assets");
const TAG = values.tag;
const remote = values.remote;
const slug = values["repo-slug"];
// Raw file base in the assets repository. The bundle names the sidecar tarball
// after the package version, so it has to build the same URL by name.
const rawBase = `https://atomgit.com/${slug}/raw/main/${TAG}`;

function run(command, args, options = {}) {
	return execFileSync(command, args, { encoding: "utf8", stdio: options.capture ? "pipe" : "inherit", ...options });
}

// 所有 git 调用都在发行仓库的 checkout 里跑，并且不读调用方的全局配置：CI 上
// 那台机器可能根本没有配置过 user.name。
function git(args, { env } = {}) {
	return run(
		"git",
		[
			"-C",
			values.work,
			"-c",
			"user.name=nanopi-release",
			"-c",
			"user.email=nanopi-release@users.noreply.github.com",
			"-c",
			"commit.gpgsign=false",
			...args,
		],
		{ env },
	);
}

// 下载 URL 写进 README 与 bundle 的 sidecar 清单，所以资产名在这里就是契约：
// 少一个都意味着安装路径断了。
function assetsOf(input, tag) {
	const bundles = BUNDLES.map((name) => {
		const path = join(input, name);
		if (!existsSync(path)) throw new Error(`${name} is missing from ${input}; build every flavor before publishing`);
		return name;
	});
	// 源包只对正式版本有意义：nightly 的源码就是当天的 main，Git tag 是正式
	// 版本的身份证。
	const source = tag.startsWith("v") ? `nanopi-${tag.slice(1)}-source.tar.gz` : undefined;
	if (source && !existsSync(join(input, source))) throw new Error(`${source} is missing from ${input}`);
	return { bundles, source };
}

// 只发最新一份：发行仓库的主分支只服务「最新 nightly / 最新正式版」这条读取
// 路径，历史版本留在 Assets/AssetsHistory/<tag> 里备查，不进主分支。
function clearAssets() {
	if (existsSync(ASSETS)) rmSync(ASSETS, { recursive: true, force: true });
	mkdirSync(ASSETS, { recursive: true });
}

function writeAssets(input, { bundles, source }) {
	const names = [...bundles];
	if (source) names.push(source);
	for (const name of names) copyFileSync(join(input, name), join(ASSETS, name));
	// `sha256sum -c SHA256SUMS` 是 install.js 与用户共用的校验入口，格式就得是
	// 它认的那一种：`<hash>  <name>`，按文件名排序。
	const sums = [...names]
		.sort()
		.map((name) => `${createHash("sha256").update(readFileSync(join(ASSETS, name))).digest("hex")}  ${name}`)
		.join("\n");
	writeFileSync(join(ASSETS, CHECKSUMS), `${sums}\n`);
}

function writeNotes(input, tag) {
	const notes = join(input, NOTES);
	if (tag.startsWith("v") && existsSync(notes)) cpSync(notes, join(ASSETS, NOTES));
	else {
		writeFileSync(
			join(ASSETS, NOTES),
			[
				`Nightly build of ${values.commit}.`,
				"",
				`Bundles are raw files in this repository: ${rawBase}/nanopi.js, ${rawBase}/nanopi-base.js, ${rawBase}/nanopi-minimal.js.`,
				`Verify with ${rawBase}/${CHECKSUMS}.`,
				"",
				"The official release lives on GitHub Releases; this repository mirrors the bundles for readers in mainland China.",
			].join("\n") + "\n",
		);
	}
}

function writeReadme({ bundles, source }) {
	const tag = TAG;
	const lines = [
		`# ${slug}`,
		"",
		"Bundle distribution for [NanoPi](https://atomgit.com/NanoPi/NanoPi). The official",
		"release, changelog and source archive live on GitHub",
		"([NekoSekaiMoe/nanopi](https://github.com/NekoSekaiMoe/nanopi)). This repository",
		"only carries the single-file bundles, so readers in mainland China do not have to",
		"reach GitHub Releases.",
		"",
		`Current: **${tag}** built from ${values.commit}.`,
		"",
		"## Download",
		"",
		"Raw files, no API, no login:",
		"",
		"```bash",
		`curl -fsSLO ${rawBase}/nanopi.js`,
		"```",
		"",
		"| Bundle | File | Carries |",
		"|---|---|---|",
		`| full | ${rawBase}/nanopi.js | everything, what the npm packages ship |`,
		`| base | ${rawBase}/nanopi-base.js | core CLI, standard tools, curated model catalog |`,
		`| minimal | ${rawBase}/nanopi-minimal.js | the bash tool alone, one endpoint shape |`,
		"",
		"```bash",
		`curl -fsSLO ${rawBase}/${CHECKSUMS}`,
		`sha256sum -c ${CHECKSUMS} --ignore-missing`,
		"```",
		"",
		"## Install",
		"",
		"`install.js` can fetch from here, which also installs the `nanopi` shim beside",
		"the bundle:",
		"",
		"```bash",
		"# bundle from this repository as ~/.local/bin/nanopi.js plus the shim",
		`curl -fsSL https://atomgit.com/NanoPi/NanoPi/raw/main/install.js | node - --mirror=${rawBase}`,
		"",
		"# a smaller bundle",
		`curl -fsSL https://atomgit.com/NanoPi/NanoPi/raw/main/install.js | node - --mirror=${rawBase} --sku=minimal`,
		"```",
		"",
		"Check `RELEASE_NOTES.md` for what changed.",
		"",
	];
	writeFileSync(join(values.work, "README.md"), lines.join("\n"));
}

function publish() {
	git(["add", "-A"]);
	git(["commit", "-q", "-m", `chore: publish ${TAG}`]);
	// 同一 tag 重跑（nightly 的当天重跑、正式版的手动补发）就把 tag 挪到新的
	// 提交上，只用 force 更新这个 tag，主分支始终是快进。
	git(["tag", "-f", "-a", TAG, "-m", TAG]);
	if (!values.push) {
		process.stdout.write(`Assembled ${relative(process.cwd(), ASSETS)}; pass --push to upload\n`);
		return;
	}
	// 没有 token 就推不上去。用 URL 里的用户名当口令登录会静默失败（AtomGit 的
	// https 打开凭据提示，GIT_TERMINAL_PROMPT=0 把它变成一句难懂的错误），所以在
	// 这里直接拒绝，让人看到该加哪个环境变量。
	const tokenEnv = values["token-env"];
	if (!tokenEnv) throw new Error(`--push needs --token-env <VAR>; the push token is never read from the environment implicitly`);
	const token = process.env[tokenEnv];
	if (!token) throw new Error(`${tokenEnv} is unset; it is needed to push to ${remote}`);

	// token 走 GIT_ASKPASS 而不是 URL：argv 与报错里都不会出现它，这份配置也
	// 只活在这个进程里。
	const user = values["token-user"] ?? "atomgit";
	const askpass = join(values.work, ".askpass");
	writeFileSync(askpass, `#!/bin/sh\ncase "$1" in\n  *sername*) printf '%s\\n' '${user}' ;;\n  *) printf '%s\\n' '${token}' ;;\nesac\n`, { mode: 0o700 });
	const globalConfig = join(values.work, ".gitconfig");
	writeFileSync(globalConfig, "[credential]\n\thelper = \n");
	const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: askpass, GIT_CONFIG_GLOBAL: globalConfig };
	const url = new URL(remote);
	const authenticated = new URL(remote);
	authenticated.username = user;
	const withToken = (args) =>
		git(["-c", "credential.helper=", "-c", `url.${authenticated.href}.insteadOf=${url.origin}${url.pathname}`, ...args], { env });
	withToken(["push", "--quiet", "origin", `HEAD:refs/heads/main`]);
	// 同一 tag 重跑（nightly 的当天重跑、正式版的手动补发）要把 tag 挪到新提交
	// 上：只 force 这一个 tag，主分支始终是快进。
	withToken(["push", "--quiet", "origin", `+refs/tags/${TAG}:refs/tags/${TAG}`]);
	process.stdout.write(`Published ${TAG} to ${slug}\n`);
}

function main() {
	mkdirSync(values.work, { recursive: true });
	if (!existsSync(join(values.work, ".git"))) {
		run("git", ["init", "-q", "--initial-branch=main", values.work]);
		git(["remote", "add", "origin", remote]);
	}
	const layout = assetsOf(values.input, TAG);
	clearAssets();
	writeAssets(values.input, layout);
	writeNotes(values.input, TAG);
	writeReadme(layout);
	publish();
}

main();
