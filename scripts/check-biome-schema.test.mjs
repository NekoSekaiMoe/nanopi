import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./check-biome-schema.mjs", import.meta.url));

async function check(t, biomeConfig) {
	const root = await mkdtemp(join(tmpdir(), "nanopi-biome-schema-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "biome.json"), JSON.stringify(biomeConfig));
	return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
}

test("accepts a $schema that points at the installed package", async (t) => {
	const result = await check(t, {
		$schema: "./node_modules/@biomejs/biome/configuration_schema.json",
	});
	assert.equal(result.status, 0, result.stderr);
});

// #561: Renovate bumped @biomejs/biome and the lockfile but left the versioned
// $schema URL behind, and biome only reports the mismatch as info.
test("rejects a versioned biomejs.dev $schema URL", async (t) => {
	const result = await check(t, {
		$schema: "https://biomejs.dev/schemas/2.6.5/schema.json",
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /必须是 \.\/node_modules\/@biomejs\/biome\/configuration_schema\.json/);
});

test("rejects a missing $schema", async (t) => {
	const result = await check(t, { linter: { enabled: true } });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /当前是 undefined/);
});
