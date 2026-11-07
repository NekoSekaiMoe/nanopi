#!/usr/bin/env node

// biome.json 的 $schema 必须指向安装包自带的那份 schema，不能是带版本号的 URL。
//
// 带版本号的写法（https://biomejs.dev/schemas/<版本>/schema.json）把 CLI 版本在仓库里
// 记了第二遍，而 Renovate 升 @biomejs/biome 只改 package.json 与 lockfile，那条 URL
// 不会跟着动（shinytale/nanopi#545、#561）。错位还不会自己暴露：biome 只把 schema
// 版本不匹配当 info 打、退出码 0（实测 2.6.5 的 CLI 读 2.6.4 的 schema，`biome check`
// 仍返回 0），于是「版本升了、schema 落后」一路绿到有人翻日志。#545 的做法是让
// Renovate 用 customManager 把那个数字也一起改，但那条规则自带 groupName，就自成了
// 一条 renovate/biome-schema 分支，在 branchConcurrentLimit/prConcurrentLimit 都是 1
// 时排不进 npm 组所在的 PR，照样漏。
//
// 指向 ./node_modules/@biomejs/biome/configuration_schema.json 之后版本号只剩一处：
// lockfile 里装的是哪个版本，校验按的就是哪个版本，没有第二份要同步的事实。biome
// 官方文档的 $schema 一节把这种写法列在第一位。

import { readFileSync } from "node:fs";

const LOCAL_SCHEMA = "./node_modules/@biomejs/biome/configuration_schema.json";

const { $schema } = JSON.parse(readFileSync("biome.json", "utf8"));
if ($schema !== LOCAL_SCHEMA) {
	console.error(`biome.json: $schema 必须是 ${LOCAL_SCHEMA}，当前是 ${JSON.stringify($schema)}`);
	console.error("带版本号的 URL 会与 @biomejs/biome 的实际版本各自漂移，改成本地路径即可。");
	process.exit(1);
}
