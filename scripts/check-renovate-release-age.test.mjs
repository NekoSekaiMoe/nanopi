import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./check-renovate-release-age.mjs", import.meta.url));

const npmRule = (extra = {}) => ({
	matchManagers: ["npm"],
	groupName: "npm dependencies",
	minimumReleaseAge: "1 day",
	minimumReleaseAgeBuffer: "30 minutes",
	...extra,
});

async function check(t, { pnpmAge, rules }) {
	const root = await mkdtemp(join(tmpdir(), "nanopi-renovate-age-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "pnpm-workspace.yaml"), `packages:\n  - "."\nminimumReleaseAge: ${pnpmAge}\n`);
	await writeFile(join(root, "renovate.json"), JSON.stringify({ packageRules: rules }));
	return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
}

// #568: Renovate 提议 @biomejs/biome@2.6.6（发布 13 小时内），pnpm 的 1440 分钟冷却期
// 拒绝写 lockfile，PR 上表现为 Artifact update problem。
test("accepts a Renovate cooldown that outlasts pnpm's", async (t) => {
	const result = await check(t, { pnpmAge: 1440, rules: [npmRule()] });
	assert.equal(result.status, 0, result.stderr);
});

test("rejects a Renovate cooldown shorter than pnpm's", async (t) => {
	const result = await check(t, {
		pnpmAge: 1440,
		rules: [npmRule({ minimumReleaseAge: "1 hour", minimumReleaseAgeBuffer: "0 minutes" })],
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /冷却期不对齐/);
});

test("counts the buffer towards the wait", async (t) => {
	const result = await check(t, {
		pnpmAge: 1440,
		rules: [npmRule({ minimumReleaseAge: "23 hours", minimumReleaseAgeBuffer: "2 hours" })],
	});
	assert.equal(result.status, 0, result.stderr);
});

test("rejects a unitless duration", async (t) => {
	const result = await check(t, { pnpmAge: 1440, rules: [npmRule({ minimumReleaseAge: "1440" })] });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /must carry a unit/);
});

test("rejects a missing npm rule", async (t) => {
	const result = await check(t, { pnpmAge: 1440, rules: [{ matchManagers: ["docker"], minimumReleaseAge: "1 day" }] });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /npm 组的 packageRule 不见了/);
});

test("rejects an npm rule that never set a cooldown", async (t) => {
	const result = await check(t, { pnpmAge: 1440, rules: [npmRule({ minimumReleaseAge: undefined })] });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /缺少 minimumReleaseAge/);
});

test("rejects a pnpm cooldown that is not a number of minutes", async (t) => {
	const result = await check(t, { pnpmAge: '"1 day"', rules: [npmRule()] });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /pnpm 的单位是分钟/);
});
