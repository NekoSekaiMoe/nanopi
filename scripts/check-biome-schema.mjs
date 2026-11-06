#!/usr/bin/env node

// biome 版本升了、biome.json 的 $schema 没跟上时让 CI 红。
//
// 为什么需要这一层：biome 只把 schema 版本不匹配当 info 打，退出码 0（实测 2.6.5 的
// CLI 读 2.6.4 的 schema，`biome check` 仍返回 0），所以「版本对了、schema 落后」能
// 一直绿到有人肉眼看日志。Renovate 那边由 renovate.json 的 customManager 负责把
// $schema 里的版本号当成 @biomejs/biome 的依赖一起升；这一层兜住托管版 Renovate 不
// 跑 postUpgradeTasks、或别人手工改 package.json 的情况。
//
// 取版本的方式是跑 `biome --version`（走 PATH 上的 pnpm bin 垫片），不是读
// node_modules：pnpm 的 node_modules/@biomejs/biome 是链到 .pnpm 的软链，靠包目录
// 反推版本比直接问 CLI 更容易和实际执行的是不是同一个版本对不上。

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SCHEMA_URL = /^https:\/\/biomejs\.dev\/schemas\/(\d+\.\d+\.\d+)\/schema\.json$/;

function fail(message) {
	console.error(message);
	console.error("修复：pnpm exec biome migrate --write");
	process.exit(1);
}

const { $schema } = JSON.parse(readFileSync("biome.json", "utf8"));
const schemaMatch = typeof $schema === "string" ? SCHEMA_URL.exec($schema) : null;
if (!schemaMatch) {
	fail(`biome.json: $schema 必须是 https://biomejs.dev/schemas/<版本>/schema.json，当前是 ${JSON.stringify($schema)}`);
}

let installed;
try {
	const versionOutput = execFileSync("biome", ["--version"], { encoding: "utf8" });
	installed = versionOutput.trim().replace(/^Version:\s*/, "");
} catch (error) {
	fail(`读不到本地 biome 的版本（biome --version 失败）：${error.message}`);
}

if (installed !== schemaMatch[1]) {
	fail(`biome.json: $schema 指向 ${schemaMatch[1]}，本地装的 biome 是 ${installed}`);
}
