import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./check-aws-sdk-version-line.mjs", import.meta.url));

// Only the `packages:` section matters: the script reads resolved versions, not
// the dependency graph, so a fixture is a list of keys.
async function check(t, packageKeys) {
	const root = await mkdtemp(join(tmpdir(), "nanopi-aws-version-line-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const lines = packageKeys.map((key) => `  '${key}': {}`).join("\n");
	await writeFile(join(root, "pnpm-lock.yaml"), `lockfileVersion: '9.0'\n\npackages:\n${lines}\n`);
	return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
}

// #709: 一次依赖升级把大部分 aws-sdk 包推到 @smithy/core@3.40.0，只有一份过期快照
// 还钉着 3.39.0，单文件产物里于是有两份 @smithy/core，full flavor 从 8.8 涨到 9.2 MiB。
test("accepts a single smithy/core across the aws-sdk family", async (t) => {
	const result = await check(t, ["@smithy/core@3.40.0", "@smithy/node-http-handler@4.14.2", "@aws-sdk/core@3.980.0"]);
	assert.equal(result.status, 0, result.stderr);
});

test("rejects two smithy/core versions", async (t) => {
	const result = await check(t, ["@smithy/core@3.39.0", "@smithy/core@3.40.0"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /@smithy\/core: 3\.39\.0, 3\.40\.0/);
});

test("rejects a forked token-providers", async (t) => {
	const result = await check(t, ["@aws-sdk/token-providers@3.1162.0", "@aws-sdk/token-providers@3.1167.0"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /@aws-sdk\/token-providers/);
});

// The exact-pinned siblings fork on every upstream release. Listing them would
// mean minting an override per package per release, and a trimmed build drops
// them by API set anyway.
test("ignores the exact-pinned siblings upstream deliberately forks", async (t) => {
	const result = await check(t, [
		"@aws-sdk/credential-provider-sso@3.973.25",
		"@aws-sdk/credential-provider-sso@3.973.28",
		"@aws-sdk/core@3.980.0",
		"@aws-sdk/core@3.981.0",
	]);
	assert.equal(result.status, 0, result.stderr);
});
