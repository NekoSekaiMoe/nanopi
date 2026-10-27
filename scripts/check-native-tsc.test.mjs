// Issue #322: the `tsc` we invoke must be the native TS 7 compiler, not the
// JavaScript one. TypeScript 7 ships a thin `tsc` launcher that execve's
// `@typescript/typescript-<platform>-<arch>/lib/tsc`; TypeScript 5.x ships
// `lib/tsc.js`. Both are reachable under the same bin name, so the installed
// package layout is the only thing telling them apart.
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";

// Start the lookup where tsc's launcher starts: typescript's own lib directory.
// The platform package is a dependency of typescript, not of this repo.
const typescriptRequire = createRequire(join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "lib", "getExePath.js"));

test("typescript resolves to the native compiler", () => {
	const manifest = typescriptRequire("typescript/package.json");
	assert.deepEqual(Object.keys(manifest.bin ?? {}), ["tsc"], "typescript must only expose the tsc bin");

	const platformPackage = `@typescript/typescript-${process.platform}-${process.arch}`;
	const platformManifestPath = typescriptRequire.resolve(`${platformPackage}/package.json`);
	const executable = join(dirname(platformManifestPath), "lib", "tsc");
	assert.ok(existsSync(executable), `${platformPackage} must ship lib/tsc`);
	if (process.platform !== "win32") {
		assert.ok(statSync(executable).mode & 0o111, `${executable} must be executable`);
	}
});
