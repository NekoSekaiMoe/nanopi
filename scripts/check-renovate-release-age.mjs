#!/usr/bin/env node

// Renovate 提议的版本必须已经老过 pnpm 的冷却期，否则 Artifact 步骤必然失败。
//
// pnpm-workspace.yaml 的 minimumReleaseAge 只管「装」，Renovate 不读它：Renovate 拿
// registry 的发布列表自己判定候选版本，把刚发布几分钟的版本写进 package.json，然后
// 用 pnpm 去刷 lockfile——那一步会被 pnpm 的冷却期拒绝，rename 成 PR 上的一条
// "Artifact update problem"，CI 里则是一条 ERR_PNPM_OUTDATED_LOCKFILE
// （NekoSekaiMoe/nanopi#23、shinytale/nanopi#568）。两边冷却期必须对齐。
//
// 判据：Renovate 的 minimumReleaseAge + minimumReleaseAgeBuffer >= pnpm 的
// minimumReleaseAge。buffer 不是装饰：同一版本的主包与平台子包常常差几分钟发布
// （biome 2.6.6 的 cli-linux-x64 比主包晚 3 分钟），Renovate 只按主包的时间算年龄，
// 子包仍在 pnpm 窗内时 lockfile 就写不下去。所以 buffer 计入总等待时间。
//
// 单位各有各的坑：pnpm 是分钟（默认 1440 = 1 天），Renovate 是时长字符串（"1 day"）。
// 写错的两种方式是「1440」被 Renovate 按毫秒解释、以及「30 minutes」写进 pnpm 直接
// 被 pnpm 判为无效。这里只接受带单位的 Renovate 时长，pnpm 那侧只接受数字。

import { readFileSync } from "node:fs";
import { parse } from "yaml";

const UNIT_MINUTES = {
	ms: 1 / 60_000,
	millisecond: 1 / 60_000,
	milliseconds: 1 / 60_000,
	s: 1 / 60,
	sec: 1 / 60,
	second: 1 / 60,
	seconds: 1 / 60,
	m: 1,
	min: 1,
	minute: 1,
	minutes: 1,
	h: 60,
	hr: 60,
	hour: 60,
	hours: 60,
	d: 1440,
	day: 1440,
	days: 1440,
	w: 10080,
	week: 10080,
	weeks: 10080,
};

const DURATION_PART = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i;

// "1 day 30 minutes" 这种复合写法按空格切开逐段累加；纯数字（"1440"）没有单位，
// 会被 ms 库当成毫秒，Renovate 文档里只用带单位的写法，这里直接把无单位判为错误，
// 免得以后有人看着 pnpm 的数字照抄一份。
function durationMinutes(value, label) {
	if (typeof value !== "string") return { error: `${label} must be a duration string, found ${JSON.stringify(value)}` };
	const parts = value.trim().split(/\s+(?=\d)/);
	let total = 0;
	for (const part of parts) {
		const match = DURATION_PART.exec(part);
		if (!match) return { error: `${label} must carry a unit (e.g. "1 day"), found ${JSON.stringify(value)}` };
		const unit = match[2].toLowerCase();
		const factor = UNIT_MINUTES[unit];
		if (factor === undefined) return { error: `${label} has unknown unit "${match[2]}" in ${JSON.stringify(value)}` };
		total += Number(match[1]) * factor;
	}
	return { minutes: total };
}

const workspace = parse(readFileSync("pnpm-workspace.yaml", "utf8")) ?? {};
const renovate = JSON.parse(readFileSync("renovate.json", "utf8"));

const pnpmAge = workspace.minimumReleaseAge;
const npmRule = (renovate.packageRules ?? []).find((rule) => (rule.matchManagers ?? []).includes("npm"));
if (!npmRule) {
	console.error('renovate.json: npm 组的 packageRule 不见了，冷却期无从对齐');
	process.exit(1);
}

const failures = [];

if (typeof pnpmAge !== "number" || !Number.isFinite(pnpmAge)) {
	failures.push(`pnpm-workspace.yaml: minimumReleaseAge 必须是分钟数（pnpm 的单位是分钟），当前是 ${JSON.stringify(pnpmAge)}`);
} else if (npmRule.minimumReleaseAge === undefined) {
	failures.push('renovate.json: npm 组缺少 minimumReleaseAge，Renovate 会提议刚发布的版本，pnpm 随后拒绝写 lockfile');
}

if (failures.length === 0) {
	const base = durationMinutes(npmRule.minimumReleaseAge, "renovate.json 的 minimumReleaseAge");
	const buffer = durationMinutes(npmRule.minimumReleaseAgeBuffer ?? "0 minutes", "renovate.json 的 minimumReleaseAgeBuffer");
	if (base.error) failures.push(base.error);
	if (buffer.error) failures.push(buffer.error);
	if (failures.length === 0 && base.minutes + buffer.minutes < pnpmAge) {
		failures.push(
			`冷却期不对齐：Renovate 等 ${npmRule.minimumReleaseAge}${npmRule.minimumReleaseAgeBuffer ? ` + ${npmRule.minimumReleaseAgeBuffer}` : ""} = ${base.minutes + buffer.minutes} 分钟，` +
				`pnpm 要 ${pnpmAge} 分钟。Renovate 会在版本还没出冷却窗时就提 PR，Artifact 步骤必然红。`,
		);
	}
}

if (failures.length > 0) {
	for (const failure of failures) console.error(failure);
	console.error('两边一起改：pnpm-workspace.yaml 的 minimumReleaseAge（分钟）与 renovate.json 里 npm 组的 minimumReleaseAge + buffer。');
	process.exit(1);
}
