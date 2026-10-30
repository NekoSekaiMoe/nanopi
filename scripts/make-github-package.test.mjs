import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./make-github-package.mjs", import.meta.url));
const repoRoot = resolve(dirname(script), "..");
const packageDir = join(repoRoot, "packages", "coding-agent");
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));

// Issue #278: GitHub Packages only accepts publisher-scoped names, so the
// release tarball is repacked as @nekosekaimoe/nanopi while the bin stays nanopi.
test("repacks the coding-agent build under the GitHub Packages name", (t) => {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "nanopi-github-package-test-"));
	t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
	// only `dist` is required, so a bundle-shaped stub stands in for the build
	mkdirSync(join(packageDir, "dist", "bundle"), { recursive: true });
	writeFileSync(join(packageDir, "dist", "bundle", "cli.js"), "#!/usr/bin/env node\n");

	const outDir = join(temporaryRoot, "out");
	execFileSync(process.execPath, [script, "--out", outDir], { stdio: "pipe" });

	const repacked = JSON.parse(readFileSync(join(outDir, "package.json"), "utf8"));
	assert.equal(repacked.name, "@nekosekaimoe/nanopi");
	assert.equal(repacked.version, manifest.version);
	assert.deepEqual(repacked.bin, manifest.bin);
	assert.equal(repacked.publishConfig, undefined);
	assert.equal(repacked.scripts, undefined);
	assert.equal(readFileSync(join(outDir, "dist", "bundle", "cli.js"), "utf8"), "#!/usr/bin/env node\n");
	// the remaining `files` entries ship from the source tree; dist is the stub and
	// the generated containerization.md may be absent in a checkout
	for (const entry of manifest.files) {
		if (entry === "dist" || entry === "containerization.md") continue;
		const path = join(outDir, entry);
		if (statSync(path).isFile()) readFileSync(path, "utf8");
	}
});

// Nightly releases publish a date-suffixed prerelease of the next version, so the
// repack has to accept a version override.
test("repacks with a version override for nightly builds", (t) => {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "nanopi-github-package-nightly-test-"));
	t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
	mkdirSync(join(packageDir, "dist", "bundle"), { recursive: true });
	writeFileSync(join(packageDir, "dist", "bundle", "cli.js"), "#!/usr/bin/env node\n");

	const outDir = join(temporaryRoot, "out");
	execFileSync(process.execPath, [script, "--out", outDir, "--version", "20260101.0.0-nightly.20260101"], {
		stdio: "pipe",
	});

	const repacked = JSON.parse(readFileSync(join(outDir, "package.json"), "utf8"));
	assert.equal(repacked.name, "@nekosekaimoe/nanopi");
	assert.equal(repacked.version, "20260101.0.0-nightly.20260101");
});
