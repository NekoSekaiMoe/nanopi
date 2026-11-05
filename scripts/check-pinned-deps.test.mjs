import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./check-pinned-deps.mjs", import.meta.url));

// Fixture repos are tiny: only the package.json files under test are created, so
// the script's recursive walk stays inside the temp directory.
async function check(t, manifests) {
	const root = await mkdtemp(join(tmpdir(), "nanopi-pinned-deps-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const [path, manifest] of Object.entries(manifests)) {
		const fullPath = join(root, path);
		await mkdir(join(fullPath, ".."), { recursive: true });
		await writeFile(fullPath, JSON.stringify(manifest));
	}
	return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
}

// #516: a Renovate grouped PR rewrote every engines.node to v26.13.0 and still
// merged green. The CI assertion must catch that rewrite.
test("accepts engines.node pinned to the runtime floor", async (t) => {
	const result = await check(t, {
		"package.json": { name: "root", engines: { node: ">=24.0.0" } },
		"packages/a/package.json": { name: "a", engines: { node: ">=24.0.0" } },
	});
	assert.equal(result.status, 0, result.stderr);
});

test("rejects engines.node rewritten to an exact version", async (t) => {
	const result = await check(t, {
		"package.json": { name: "root", engines: { node: "v26.13.0" } },
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /engines\.node must be >=24\.0\.0, found v26\.13\.0/);
});

test("rejects engines.node rewritten to a different range", async (t) => {
	const result = await check(t, {
		"package.json": { name: "root", engines: { node: ">=26.0.0" } },
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /engines\.node must be >=24\.0\.0, found >=26\.0\.0/);
});

test("reports every offending package.json", async (t) => {
	const result = await check(t, {
		"package.json": { name: "root", engines: { node: ">=24.0.0" } },
		"packages/a/package.json": { name: "a", engines: { node: "v26.13.0" } },
		"packages/b/package.json": { name: "b", engines: { node: ">=25.0.0" } },
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /packages[\\/]a[\\/]package\.json: engines\.node/);
	assert.match(result.stderr, /packages[\\/]b[\\/]package\.json: engines\.node/);
});

test("a package.json without engines is not forced to declare one", async (t) => {
	const result = await check(t, {
		"package.json": { name: "root" },
		"packages/a/package.json": { name: "a", engines: { node: ">=24.0.0" } },
	});
	assert.equal(result.status, 0, result.stderr);
});

test("engines failures are reported alongside unpinned dependencies", async (t) => {
	const result = await check(t, {
		"package.json": {
			name: "root",
			dependencies: { loose: "^1.0.0" },
			engines: { node: "v26.13.0" },
		},
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /dependencies\.loose must be pinned/);
	assert.match(result.stderr, /engines\.node must be >=24\.0\.0/);
});
